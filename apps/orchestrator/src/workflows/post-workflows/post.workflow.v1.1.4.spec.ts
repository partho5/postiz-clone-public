// Publish workflow v1.1.4 (G-006): a repeating post reserves its next occurrence up to 7 days
// ahead, is flagged and warned while it can't be paid, retries every 24 h, and an occurrence
// still unpaid at its due time is skipped while the chain goes on.
//
// Runs the built workflow (pnpm run build:orchestrator) on a real Temporal server and the real
// charging activities on a real Postgres (worker role). The platform activities are stubs.
// Run from the repo root:
//   TEST_DATABASE_URL=... TEST_TEMPORAL_ADDRESS=localhost:7233 npx jest \
//     -c libraries/nestjs-libraries/jest.config.cjs post.workflow.v1.1.4 --roots '<rootDir>/apps/orchestrator/src'
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { PublishChargingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.repository';
import { PublishChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service';
import { RecurringChargingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.repository';
import { RecurringChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.service';
// relative: the jest config maps no @gitroom/orchestrator alias
import { PublishChargingActivity } from '../../activities/publish.charging.activity';
import { RecurringChargingActivity } from '../../activities/recurring.charging.activity';
import { Client, Connection, WorkflowHandle } from '@temporalio/client';
import { TypedSearchAttributes } from '@temporalio/common';
import {
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
} from '@temporalio/worker';
import { PrismaClient } from '@prisma/client';
import { postId as postIdSearchParam } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';

const url = process.env.TEST_DATABASE_URL;
const address = process.env.TEST_TEMPORAL_ADDRESS;
const describeRun = url && address ? describe : describe.skip;

// The workflow as the orchestrator bundles it in production.
const workflowsPath = resolve(
  __dirname,
  '../../../dist/apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.4.js'
);

const DAY = 24 * 60 * 60 * 1000;

describeRun('postWorkflowV114 (Temporal + Postgres)', () => {
  let prisma: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let credits: CreditsService;
  let charging: PublishChargingService;
  let recurring: RecurringChargingService;
  let client: Client;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let running: { worker: Worker; done: Promise<void> };
  let unit: number;
  const taskQueue = 'recurring-charging-' + randomUUID();
  // the repeat interval the platform side reports per post, in ms
  const intervals = new Map<string, number>();
  const published: string[] = [];
  const notifications: { organizationId: string; subject: string; at: number }[] = [];
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  const publishKey = (postId: string, integrationId: string, n = 1) =>
    `post:${postId}:integration:${integrationId}:publish${n === 1 ? '' : `:${n}`}`;
  const ledgerOf = (key: string) =>
    worker.creditLedger.findUnique({ where: { idempotencyKey: key } });
  const postWithIntegration = (id: string) =>
    worker.post.findUnique({ where: { id }, include: { integration: true } });

  // The platform side of PostActivity; the database side is real.
  const postActivity = {
    async getPost(orgId: string, postId: string) {
      const post = await postWithIntegration(postId);
      return !post || post.organizationId !== orgId || post.deletedAt
        ? false
        : post;
    },
    async getPostsList(orgId: string, postId: string) {
      const post = await postWithIntegration(postId);
      if (!post || post.deletedAt) {
        return [];
      }
      const interval = intervals.get(postId);
      return [
        { ...post, intervalInDays: interval ? interval / DAY : null },
      ];
    },
    async changeState(id: string, state: any, err?: any) {
      await worker.post.update({
        where: { id },
        data: { state, ...(err ? { error: String(err) } : {}) },
      });
    },
    async updatePost(id: string) {
      await worker.post.update({ where: { id }, data: { state: 'PUBLISHED' } });
    },
    async inAppNotification(organizationId: string, subject: string) {
      notifications.push({ organizationId, subject, at: Date.now() });
    },
    async postSocialPending(_integration: any, posts: any[]) {
      published.push(posts[0].id);
      return [
        {
          id: posts[0].id,
          postId: 'remote-' + posts[0].id,
          releaseURL: 'https://example.test/' + posts[0].id,
          status: 'success',
        },
      ];
    },
    async refreshTokenWithCause() {
      return false;
    },
    async isCommentable() {
      return false;
    },
    async sendWebhooks() {},
    async internalPlugs() {
      return [];
    },
    async globalPlugs() {
      return [];
    },
  };

  // The worker's activities: stubbed platform, real publish and recurring charging.
  const activities = () => {
    const publish = new PublishChargingActivity(charging);
    const next = new RecurringChargingActivity(recurring);
    return {
      ...postActivity,
      reservePublish: publish.reservePublish.bind(publish),
      commitPublish: publish.commitPublish.bind(publish),
      releasePublish: publish.releasePublish.bind(publish),
      reserveNextOccurrence: next.reserveNextOccurrence.bind(next),
      clearRecurringFlag: next.clearRecurringFlag.bind(next),
    };
  };

  beforeAll(async () => {
    if (!existsSync(workflowsPath)) {
      throw new Error(
        `Build the orchestrator first (pnpm run build:orchestrator): ${workflowsPath} is missing`
      );
    }
    Runtime.install({ logger: new DefaultLogger('WARN') });

    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    prisma = new PrismaService();
    expect(prisma.role).toBe('worker');
    await prisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(prisma);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const moneyScope = new MoneyScope(new PrismaTransaction(prisma), accounts);
    credits = new CreditsService(
      new CreditsRepository(moneyScope, repo, repo, repo),
      accounts,
      moneyScope
    );
    charging = new PublishChargingService(
      credits,
      new PublishChargingRepository(moneyScope, repo)
    );
    recurring = new RecurringChargingService(
      new RecurringChargingRepository(repo, repo),
      charging
    );
    await new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      credits,
      accounts
    ).sync();
    unit = (await credits.quote('post.publish', 1, 'FREE')).unitCost;

    connection = await Connection.connect({ address });
    client = new Client({ connection });
    const { customAttributes } =
      await connection.operatorService.listSearchAttributes({
        namespace: 'default',
      });
    const missing = ['organizationId', 'postId'].filter(
      (name) => !customAttributes[name]
    );
    if (missing.length) {
      await connection.operatorService.addSearchAttributes({
        namespace: 'default',
        searchAttributes: Object.fromEntries(missing.map((n) => [n, 1])),
      });
    }
    nativeConnection = await NativeConnection.connect({ address });
    const created = await Worker.create({
      connection: nativeConnection,
      taskQueue,
      workflowsPath,
      activities: activities(),
      shutdownGraceTime: '100 ms',
    });
    running = { worker: created, done: created.run() };
  });

  afterAll(async () => {
    running?.worker.shutdown();
    await running?.done;
    await nativeConnection?.close();
    await connection?.close();
    await prisma?.$disconnect();
    await worker?.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  // A workspace whose account holds credits, with one channel.
  const workspace = async (amount: number) => {
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: {
          create: {
            role: 'SUPERADMIN',
            user: {
              create: {
                email: randomUUID() + '@test.local',
                providerName: 'LOCAL',
                timezone: 0,
              },
            },
          },
        },
      },
    });
    const accountId = await accounts.getAccountIdForOrganization(org.id);
    if (amount > 0) {
      await credits.grant(accountId, { type: 'GRANT', amount });
    }
    const integration = await worker.integration.create({
      data: {
        organizationId: org.id,
        internalId: randomUUID(),
        name: 'channel-' + randomUUID(),
        picture: '/no-picture.jpg',
        providerIdentifier: 'bluesky',
        type: 'social',
        token: 'token',
      },
    });
    return { organizationId: org.id, accountId, integrationId: integration.id };
  };

  // A post due now, repeating every intervalMs as the platform side reports it (the row
  // repeats daily unless told otherwise), with occurrence 1 reserved as scheduling reserves it.
  const duePost = async (
    ws: Awaited<ReturnType<typeof workspace>>,
    intervalMs: number | null,
    rowInterval: number | null = 1
  ) => {
    const post = await worker.post.create({
      data: {
        organizationId: ws.organizationId,
        integrationId: ws.integrationId,
        group: randomUUID(),
        content: '<p>again</p>',
        publishDate: new Date(Date.now() - 1000),
        intervalInDays: intervalMs ? rowInterval : null,
      },
    });
    if (intervalMs) {
      intervals.set(post.id, intervalMs);
    }
    await charging.reserveOccurrence(ws.organizationId, post.id, ws.integrationId, 1);
    return post;
  };

  const start = (organizationId: string, postId: string) =>
    client.workflow.start('postWorkflowV114', {
      taskQueue,
      workflowId: `post_${postId}_${randomUUID()}`,
      args: [{ taskQueue, postId, organizationId }],
      typedSearchAttributes: new TypedSearchAttributes([
        { key: postIdSearchParam, value: postId },
      ]),
    });

  // Every workflow of the post still running is terminated (the delete path does the same).
  const stopChain = async (postId: string) => {
    await worker.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });
    for await (const info of client.workflow.list({
      query: `postId="${postId}" AND ExecutionStatus="Running"`,
    })) {
      await client.workflow.getHandle(info.workflowId).terminate().catch(() => undefined);
    }
  };

  // Durations of the timers a workflow started, in ms.
  const timers = async (handle: WorkflowHandle) => {
    const history = await handle.fetchHistory();
    return (history.events || [])
      .map((e) => e.timerStartedEventAttributes?.startToFireTimeout)
      .filter(Boolean)
      .map((d) => Number(d!.seconds || 0) * 1000 + Math.round((d!.nanos || 0) / 1e6));
  };

  const stateOf = async (id: string) =>
    (await worker.post.findUniqueOrThrow({ where: { id } })).state;

  const notificationsOf = (organizationId: string, subject: string) =>
    notifications.filter(
      (n) => n.organizationId === organizationId && n.subject.includes(subject)
    );

  // Polls until check passes or ~30 s have gone.
  const eventually = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('condition not met in time');
  };

  it('behaves as V113 for occurrence 1: commits it once published', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, null);

    await (await start(ws.organizationId, post.id)).result();

    expect(published).toContain(post.id);
    expect(await ledgerOf(publishKey(post.id, ws.integrationId))).toMatchObject({
      status: 'COMMITTED',
      committed: unit,
    });
  });

  it('reserves the next occurrence right away when it is due within 7 days; the child publishes and commits it', async () => {
    const ws = await workspace(2 * unit);
    const post = await duePost(ws, 4000);
    const second = publishKey(post.id, ws.integrationId, 2);

    await start(ws.organizationId, post.id);
    // the ledger is reserved before the row is recorded, so wait for both
    await eventually(
      async () =>
        (await worker.recurringCharge.findUnique({ where: { postId: post.id } }))
          ?.occurrence === 2 && (await ledgerOf(second))?.status === 'RESERVED'
    );
    const row = await worker.recurringCharge.findUniqueOrThrow({
      where: { postId: post.id },
    });

    // held before it was due, and nothing further ahead
    expect(row).toMatchObject({ occurrence: 2, flaggedAt: null });
    expect(Date.now()).toBeLessThan(row.dueAt.getTime());
    expect(await ledgerOf(publishKey(post.id, ws.integrationId, 3))).toBeNull();
    expect(published.filter((id) => id === post.id)).toHaveLength(1);

    await eventually(async () => (await ledgerOf(second))?.status === 'COMMITTED');
    expect(published.filter((id) => id === post.id)).toHaveLength(2);
    expect(await credits.balance(ws.organizationId)).toEqual({
      available: 0,
      reserved: 0,
    });
    await stopChain(post.id);
  }, 60000);

  it("can't pay the next occurrence: flagged and warned once before it is due, skipped at its due time, and a top-up pays the one after", async () => {
    const ws = await workspace(unit);
    const post = await duePost(ws, 5000);
    const second = publishKey(post.id, ws.integrationId, 2);
    const third = publishKey(post.id, ws.integrationId, 3);

    await start(ws.organizationId, post.id);
    await eventually(
      async () =>
        !!(await recurring.flagsForPosts(ws.organizationId, [post.id]))[post.id]
    );
    const flag = (await recurring.flagsForPosts(ws.organizationId, [post.id]))[post.id];
    expect(flag).toMatchObject({ occurrence: 2, reason: 'INSUFFICIENT_CREDITS' });
    expect(Date.now()).toBeLessThan(new Date(flag.dueAt).getTime());

    await eventually(async () => notificationsOf(ws.organizationId, 'was skipped').length === 1);
    const skippedAt = notificationsOf(ws.organizationId, 'was skipped')[0].at;
    // one warning for occurrence 2, however often it was retried, and never published unpaid
    expect(
      notificationsOf(ws.organizationId, "can't be paid").filter((n) => n.at <= skippedAt)
    ).toHaveLength(1);
    expect(skippedAt).toBeGreaterThanOrEqual(new Date(flag.dueAt).getTime() - 100);
    expect(await ledgerOf(second)).toBeNull();
    expect(published.filter((id) => id === post.id)).toHaveLength(1);
    // the flag stays after the skip
    expect(
      (await recurring.flagsForPosts(ws.organizationId, [post.id]))[post.id]
    ).toBeDefined();

    await credits.grant(ws.accountId, { type: 'GRANT', amount: unit });
    await eventually(async () => (await ledgerOf(third))?.status === 'COMMITTED');

    expect(await ledgerOf(second)).toBeNull();
    expect(published.filter((id) => id === post.id)).toHaveLength(2);
    await stopChain(post.id);
  }, 60000);

  it('waits until 7 days before a due time further out', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, 8 * DAY);
    const handle = await start(ws.organizationId, post.id);

    await eventually(async () => (await stateOf(post.id)) === 'PUBLISHED');
    await eventually(async () =>
      (await timers(handle)).some((ms) => ms > 0.99 * DAY && ms <= DAY)
    );

    expect(await ledgerOf(publishKey(post.id, ws.integrationId, 2))).toBeNull();
    await stopChain(post.id);
  });

  it("retries every 24 h while the next occurrence can't be paid", async () => {
    const ws = await workspace(unit);
    const post = await duePost(ws, 3 * DAY);
    const handle = await start(ws.organizationId, post.id);

    await eventually(
      async () =>
        !!(await recurring.flagsForPosts(ws.organizationId, [post.id]))[post.id]
    );
    await eventually(async () => (await timers(handle)).includes(DAY));

    expect(notificationsOf(ws.organizationId, "can't be paid")).toHaveLength(1);
    expect(await ledgerOf(publishKey(post.id, ws.integrationId, 2))).toBeNull();
    await stopChain(post.id);
  });

  it('a post that no longer repeats ends the chain: nothing held, no warning, no next publish', async () => {
    const ws = await workspace(5 * unit);
    // the platform run still sees the old interval; the row no longer repeats
    const post = await duePost(ws, 2000, null);

    await (await start(ws.organizationId, post.id)).result();

    expect(await ledgerOf(publishKey(post.id, ws.integrationId, 2))).toBeNull();
    expect(notificationsOf(ws.organizationId, "can't be paid")).toHaveLength(0);
    expect(notificationsOf(ws.organizationId, 'was skipped')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(published.filter((id) => id === post.id)).toHaveLength(1);
  });

  it('a new chain clears a flag left by an earlier one', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, null);
    await worker.post.update({ where: { id: post.id }, data: { intervalInDays: 1 } });
    await worker.recurringCharge.create({
      data: {
        postId: post.id,
        occurrence: 4,
        dueAt: new Date(Date.now() - DAY),
        flaggedAt: new Date(Date.now() - 2 * DAY),
      },
    });
    expect(
      (await recurring.flagsForPosts(ws.organizationId, [post.id]))[post.id]
    ).toBeDefined();

    await (await start(ws.organizationId, post.id)).result();

    expect(await recurring.flagsForPosts(ws.organizationId, [post.id])).toEqual({});
  });
});
