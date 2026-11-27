// Publish workflow v1.1.3 (G-004, G-005): commits a published occurrence once, releases it on a
// permanent failure, keeps it on an unknown outcome, reserves each occurrence at its start.
//
// Runs the built workflow (pnpm run build:orchestrator) on a real Temporal server and the real
// charging activity on a real Postgres (worker role). The platform activities are stubs.
// Run from the repo root:
//   TEST_DATABASE_URL=... TEST_TEMPORAL_ADDRESS=localhost:7233 npx jest \
//     -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/orchestrator/src' post.workflow
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
// relative: the jest config maps no @gitroom/orchestrator alias
import { PublishChargingActivity } from '../../activities/publish.charging.activity';
import { Context, ApplicationFailure } from '@temporalio/activity';
import { Client, Connection } from '@temporalio/client';
import {
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
} from '@temporalio/worker';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';

const url = process.env.TEST_DATABASE_URL;
const address = process.env.TEST_TEMPORAL_ADDRESS;
const describeRun = url && address ? describe : describe.skip;

// The workflow as the orchestrator bundles it in production.
const workflowsPath = resolve(
  __dirname,
  '../../../dist/apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.3.js'
);

// How the stubbed platform answers a post's publish.
interface Scenario {
  publish: 'success' | 'bad_body' | 'unknown' | 'stop';
  disabled?: boolean;
  refreshNeeded?: boolean;
  intervalInDays?: number | null;
  // commit reaches the database, then the worker dies before reporting it
  dieAfterCommit?: boolean;
}

describeRun('postWorkflowV113 (Temporal + Postgres)', () => {
  let prisma: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let credits: CreditsService;
  let charging: PublishChargingService;
  let client: Client;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let running: { worker: Worker; done: Promise<void> };
  let unit: number;
  const taskQueue = 'publish-charging-' + randomUUID();
  const scenarios = new Map<string, Scenario>();
  const published: string[] = [];
  const notifications: { organizationId: string; subject: string }[] = [];
  const commitsLost = new Set<string>();
  const commitRuns = new Map<string, number>();
  let onCommitLost: (() => void) | undefined;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  const publishKey = (postId: string, integrationId: string, n = 1) =>
    `post:${postId}:integration:${integrationId}:publish${n === 1 ? '' : `:${n}`}`;
  const ledgerOf = (key: string) =>
    worker.creditLedger.findUnique({ where: { idempotencyKey: key } });

  const postWithIntegration = (id: string) =>
    worker.post.findUnique({ where: { id }, include: { integration: true } });

  // The platform side of PostActivity, answering per scenario; the database side is real.
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
      const scenario = scenarios.get(postId)!;
      return [
        {
          ...post,
          intervalInDays: scenario.intervalInDays ?? null,
          integration: {
            ...post.integration,
            disabled: !!scenario.disabled,
            refreshNeeded: !!scenario.refreshNeeded,
          },
        },
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
      notifications.push({ organizationId, subject });
    },
    async postSocialPending(_integration: any, posts: any[]) {
      const scenario = scenarios.get(posts[0].id)!;
      if (scenario.publish === 'bad_body') {
        throw ApplicationFailure.nonRetryable('rejected', 'bad_body');
      }
      if (scenario.publish === 'stop') {
        throw ApplicationFailure.nonRetryable('token expired', 'refresh_token');
      }
      if (scenario.publish === 'unknown') {
        throw new Error('connection reset');
      }
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

  // The worker's activities: stubbed platform, real charging (commit may "lose" its worker).
  const activities = () => {
    const real = new PublishChargingActivity(charging);
    return {
      ...postActivity,
      reservePublish: real.reservePublish.bind(real),
      releasePublish: real.releasePublish.bind(real),
      async commitPublish(postId: string, integrationId: string, n: number) {
        commitRuns.set(postId, (commitRuns.get(postId) || 0) + 1);
        await real.commitPublish(postId, integrationId, n);
        if (scenarios.get(postId)?.dieAfterCommit && !commitsLost.has(postId)) {
          commitsLost.add(postId);
          onCommitLost?.();
          // never reports: the worker is shut down under it
          await Context.current().cancelled;
        }
      },
    };
  };

  const startWorker = async () => {
    const created = await Worker.create({
      connection: nativeConnection,
      taskQueue,
      workflowsPath,
      activities: activities(),
      shutdownGraceTime: '100 ms',
    });
    return { worker: created, done: created.run() };
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
    running = await startWorker();
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

  // A post due now on the workspace's channel, reserved as scheduling reserves it unless told not to.
  const duePost = async (
    ws: Awaited<ReturnType<typeof workspace>>,
    scenario: Scenario,
    reserve = true
  ) => {
    const post = await worker.post.create({
      data: {
        organizationId: ws.organizationId,
        integrationId: ws.integrationId,
        group: randomUUID(),
        content: '<p>hello</p>',
        publishDate: new Date(Date.now() - 1000),
      },
    });
    scenarios.set(post.id, scenario);
    if (reserve) {
      await charging.reserveOccurrence(
        ws.organizationId,
        post.id,
        ws.integrationId,
        1
      );
    }
    return post;
  };

  const run = (organizationId: string, postId: string, postNow = false) =>
    client.workflow.execute('postWorkflowV113', {
      taskQueue,
      workflowId: `post_${postId}_${randomUUID()}`,
      args: [{ taskQueue, postId, organizationId, postNow }],
    });

  const stateOf = async (id: string) =>
    (await worker.post.findUniqueOrThrow({ where: { id } })).state;

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

  it('commits the reserved occurrence once the post is published', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, { publish: 'success' });

    await run(ws.organizationId, post.id);

    expect(published).toContain(post.id);
    expect(await stateOf(post.id)).toBe('PUBLISHED');
    expect(await ledgerOf(publishKey(post.id, ws.integrationId))).toMatchObject({
      status: 'COMMITTED',
      committed: unit,
    });
    expect(await credits.balance(ws.organizationId)).toEqual({
      available: 4 * unit,
      reserved: 0,
    });
  });

  it('a worker killed mid-publish, after the commit reached the database: the resumed run charges once', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, { publish: 'success', dieAfterCommit: true });
    const lost = new Promise<void>((r) => (onCommitLost = r));

    const result = run(ws.organizationId, post.id);
    await lost;
    running.worker.shutdown();
    await running.done;
    running = await startWorker();
    await result;

    // the commit ran on both workers: once before the kill, once after
    expect(commitRuns.get(post.id)).toBe(2);
    const ledger = await ledgerOf(publishKey(post.id, ws.integrationId));
    expect(ledger).toMatchObject({ status: 'COMMITTED', committed: unit });
    expect(
      await worker.creditLedger.count({ where: { accountId: ws.accountId } })
    ).toBe(1);
    expect(published.filter((id) => id === post.id)).toHaveLength(1);
    expect(await credits.balance(ws.organizationId)).toEqual({
      available: 4 * unit,
      reserved: 0,
    });
    expect(await credits.reconcile(ws.accountId)).toEqual({
      buckets: [],
      ledgers: [],
    });
  }, 180000);

  it.each([
    ['the platform rejects the body', { publish: 'bad_body' }],
    ['the token cannot be refreshed', { publish: 'stop' }],
    ['the channel is disabled', { publish: 'success', disabled: true }],
    ['the channel needs a reconnect', { publish: 'success', refreshNeeded: true }],
  ] as [string, Scenario][])(
    'releases the reservation in full when %s',
    async (_name, scenario) => {
      const ws = await workspace(5 * unit);
      const post = await duePost(ws, scenario);

      await run(ws.organizationId, post.id);

      expect(await stateOf(post.id)).toBe('ERROR');
      expect(published).not.toContain(post.id);
      expect((await ledgerOf(publishKey(post.id, ws.integrationId)))!.status).toBe(
        'RELEASED'
      );
      expect(await credits.balance(ws.organizationId)).toEqual({
        available: 5 * unit,
        reserved: 0,
      });
    }
  );

  it('keeps the reservation when the outcome is unknown', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, { publish: 'unknown' });

    await run(ws.organizationId, post.id);

    expect(await stateOf(post.id)).toBe('ERROR');
    expect((await ledgerOf(publishKey(post.id, ws.integrationId)))!.status).toBe(
      'RESERVED'
    );
    expect(await credits.balance(ws.organizationId)).toEqual({
      available: 4 * unit,
      reserved: unit,
    });
  });

  it('already posted: a committed charge stays, a held one is released', async () => {
    const ws = await workspace(5 * unit);
    const done = await duePost(ws, { publish: 'success' });
    await charging.commitOccurrence(done.id, ws.integrationId, 1);
    await worker.post.update({ where: { id: done.id }, data: { state: 'PUBLISHED' } });
    const errored = await duePost(ws, { publish: 'success' });
    await worker.post.update({ where: { id: errored.id }, data: { state: 'ERROR' } });

    await run(ws.organizationId, done.id);
    await run(ws.organizationId, errored.id);

    expect(published).not.toContain(done.id);
    expect(published).not.toContain(errored.id);
    expect((await ledgerOf(publishKey(done.id, ws.integrationId)))!.status).toBe(
      'COMMITTED'
    );
    expect((await ledgerOf(publishKey(errored.id, ws.integrationId)))!.status).toBe(
      'RELEASED'
    );
    expect(await credits.balance(ws.organizationId)).toEqual({
      available: 4 * unit,
      reserved: 0,
    });
  });

  it('a deleted post: the workflow releases nothing (the delete does)', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, { publish: 'success' });
    await worker.post.update({ where: { id: post.id }, data: { deletedAt: new Date() } });

    await run(ws.organizationId, post.id);

    expect(published).not.toContain(post.id);
    expect((await ledgerOf(publishKey(post.id, ws.integrationId)))!.status).toBe(
      'RESERVED'
    );
  });

  it('a queued post without a reservation is reserved at the start, then committed', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, { publish: 'success' }, false);

    await run(ws.organizationId, post.id);

    expect(await ledgerOf(publishKey(post.id, ws.integrationId))).toMatchObject({
      status: 'COMMITTED',
      committed: unit,
    });
    expect(await credits.balance(ws.organizationId)).toEqual({
      available: 4 * unit,
      reserved: 0,
    });
  });

  it('a released reservation is reserved again at the start', async () => {
    const ws = await workspace(5 * unit);
    const post = await duePost(ws, { publish: 'success' });
    await charging.releaseOccurrence(post.id, ws.integrationId, 1);

    await run(ws.organizationId, post.id);

    expect(await ledgerOf(publishKey(post.id, ws.integrationId))).toMatchObject({
      status: 'COMMITTED',
      committed: unit,
    });
  });

  it('an occurrence it cannot pay: ERROR "Not enough credits", a notification, no publish', async () => {
    const ws = await workspace(0);
    const post = await duePost(ws, { publish: 'success' }, false);

    expect(await run(ws.organizationId, post.id)).toBe(false);

    expect(published).not.toContain(post.id);
    const row = await worker.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.state).toBe('ERROR');
    expect(row.error).toBe('Not enough credits');
    expect(
      notifications.filter((n) => n.organizationId === ws.organizationId)
    ).toHaveLength(1);
    expect(await ledgerOf(publishKey(post.id, ws.integrationId))).toBeNull();
  });

  it('a repeat child reserves occurrence 2 at its start and commits it under its own key', async () => {
    // pays two occurrences; the third stops the chain
    const ws = await workspace(2 * unit);
    const post = await duePost(ws, {
      publish: 'success',
      intervalInDays: 1 / (24 * 60 * 60), // one second
    });
    const second = publishKey(post.id, ws.integrationId, 2);

    await run(ws.organizationId, post.id);
    await eventually(
      async () => (await ledgerOf(second))?.status === 'COMMITTED'
    );

    expect((await ledgerOf(publishKey(post.id, ws.integrationId)))!.status).toBe(
      'COMMITTED'
    );
    expect((await ledgerOf(second))!.metadata).toMatchObject({
      postId: post.id,
      integrationId: ws.integrationId,
      occurrence: 2,
    });
  });

  it('a repeat child it cannot pay stops the chain: ERROR, a notification, no publish', async () => {
    const ws = await workspace(unit);
    const post = await duePost(ws, {
      publish: 'success',
      intervalInDays: 1 / (24 * 60 * 60),
    });

    await run(ws.organizationId, post.id);
    await eventually(async () => (await stateOf(post.id)) === 'ERROR');

    expect(published.filter((id) => id === post.id)).toHaveLength(1);
    expect(await ledgerOf(publishKey(post.id, ws.integrationId, 2))).toBeNull();
    expect(
      notifications.filter(
        (n) =>
          n.organizationId === ws.organizationId &&
          n.subject.startsWith('Not enough credits')
      )
    ).toHaveLength(1);
  });
});
