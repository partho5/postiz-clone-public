// Nightly credit reconciliation: drift is reported and never repaired; reservations held
// for dead work are released, reservations held for live or scheduled work are not.
//
// Runs against a real Postgres, migrated and given the API role by the jest global setup. The
// publish cases also need a real Temporal server for workflow visibility (TEST_TEMPORAL_ADDRESS).
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
import { CreditsReconcileRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/reconcile/credits.reconcile.repository';
import { CreditsReconcileService } from '@gitroom/nestjs-libraries/database/prisma/credits/reconcile/credits.reconcile.service';
import * as Sentry from '@sentry/nestjs';
import { Client, Connection } from '@temporalio/client';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

jest.mock('@sentry/nestjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
const address = process.env.TEST_TEMPORAL_ADDRESS;
const describeDb = url ? describe : describe.skip;
const describeTemporal = url && address ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Registers the `postId` search attribute the post workflows carry, when the server lacks it.
const addSearchAttributes = async (connection: Connection) => {
  const { customAttributes } =
    await connection.operatorService.listSearchAttributes({
      namespace: 'default',
    });
  if (!customAttributes.postId) {
    await connection.operatorService.addSearchAttributes({
      namespace: 'default',
      searchAttributes: { postId: 1 },
    });
  }
};

interface Services {
  credits: CreditsService;
  reconcile: CreditsReconcileService;
}

describeDb('CreditsReconcileService (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let client: Client | undefined;
  let connection: Connection | undefined;
  const started: string[] = [];
  const roles: Record<'api' | 'worker', Services> = {} as any;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // The services on a given client, wired as the database module wires them; `temporal`
  // answers workflow visibility (none: the Temporal client is not available).
  const servicesOn = (prisma: PrismaService, withTemporal = true): Services => {
    const repo = new PrismaRepository<any>(prisma);
    const accountsService = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const moneyScope = new MoneyScope(
      new PrismaTransaction(prisma),
      accountsService
    );
    const credits = new CreditsService(
      new CreditsRepository(moneyScope, repo, repo, repo),
      accountsService,
      moneyScope
    );
    const temporal: any = {
      client:
        withTemporal && client ? { getRawClient: () => client } : undefined,
    };
    return {
      credits,
      reconcile: new CreditsReconcileService(
        credits,
        new CreditsReconcileRepository(moneyScope, repo),
        temporal
      ),
    };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerService = new PrismaService();
    expect(api.role).toBe('api');
    expect(workerService.role).toBe('worker');
    await workerService.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    if (address) {
      connection = await Connection.connect({ address });
      client = new Client({ connection });
      await addSearchAttributes(connection);
    }
    roles.api = servicesOn(api);
    roles.worker = servicesOn(workerService);
    const repo = new PrismaRepository<any>(api);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    await new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      roles.api.credits,
      accounts
    ).sync();
  });

  afterAll(async () => {
    for (const workflowId of started) {
      await client?.workflow
        .getHandle(workflowId)
        .terminate('test over')
        .catch(() => undefined);
    }
    await connection?.close();
    await api.$disconnect();
    await workerService.$disconnect();
    await worker.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // A workspace billed to its owner's account, holding credits, with one channel.
  const workspace = async (credits = 20) => {
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
    await roles.worker.credits.grant(accountId, {
      type: 'GRANT',
      amount: credits,
    });
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
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  // A post on the workspace's channel.
  const post = (ws: Workspace, data: Record<string, unknown> = {}) =>
    worker.post.create({
      data: {
        organizationId: ws.organizationId,
        integrationId: ws.integrationId,
        group: randomUUID(),
        content: '<p>post</p>',
        publishDate: new Date(Date.now() - DAY),
        state: 'ERROR',
        ...data,
      },
    });

  // Reserves `post.publish` for a post, held since `age` ms ago.
  const reservePublish = async (
    ws: Workspace,
    postId: string,
    age: number,
    occurrence = 1
  ) => {
    const key = `post:${postId}:integration:${ws.integrationId}:publish${
      occurrence === 1 ? '' : `:${occurrence}`
    }`;
    await roles.worker.credits.reserve({
      organizationId: ws.organizationId,
      actionKey: 'post.publish',
      idempotencyKey: key,
      metadata: { postId, integrationId: ws.integrationId, occurrence },
    });
    await holdSince(key, age);
    return key;
  };

  // Reserves an AI action (no post), held since `age` ms ago.
  const reserveAi = async (ws: Workspace, age: number) => {
    const key = `ai:${randomUUID()}`;
    await roles.worker.credits.reserve({
      organizationId: ws.organizationId,
      actionKey: 'ai.text',
      idempotencyKey: key,
      metadata: { kind: 'text' },
    });
    await holdSince(key, age);
    return key;
  };

  // Makes a reservation look as if it was made `age` ms ago.
  const holdSince = (key: string, age: number) =>
    worker.creditLedger.update({
      where: { idempotencyKey: key },
      data: { updatedAt: new Date(Date.now() - age) },
    });

  const statusOf = async (key: string) =>
    (
      await worker.creditLedger.findUniqueOrThrow({
        where: { idempotencyKey: key },
      })
    ).status;
  const balance = (ws: Workspace) =>
    roles.api.credits.balance(ws.organizationId);

  // Everything the money tables hold for an account, for "nothing was written" checks.
  const snapshot = async (accountId: string) =>
    JSON.stringify(
      await Promise.all([
        worker.creditBucket.findMany({
          where: { accountId },
          orderBy: { id: 'asc' },
        }),
        worker.creditLedger.findMany({
          where: { accountId },
          orderBy: { id: 'asc' },
        }),
        worker.creditEntry.findMany({
          where: { accountId },
          orderBy: { id: 'asc' },
        }),
      ])
    );

  describe.each(['api', 'worker'] as const)(
    'reconcileAll on the %s role',
    (role) => {
      const s = () => roles[role];

      it('reports zero drift for accounts whose ledger and buckets agree', async () => {
        const ws = await workspace();
        await s().credits.reserve({
          organizationId: ws.organizationId,
          actionKey: 'ai.text',
          idempotencyKey: `ai:${randomUUID()}`,
        });

        const result = await s().reconcile.reconcileAll();

        expect(result.accounts).toBeGreaterThanOrEqual(1);
        expect(result.drifted.map((d) => d.accountId)).not.toContain(
          ws.accountId
        );
        expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            extra: expect.objectContaining({ accountId: ws.accountId }),
          })
        );
      });

      it('reports a drifted account once with its counts, logs one error line, and changes nothing', async () => {
        const ws = await workspace();
        const clean = await workspace();
        const ledger = await s().credits.reserve({
          organizationId: ws.organizationId,
          actionKey: 'ai.text',
          idempotencyKey: `ai:${randomUUID()}`,
        });
        const bucket = await worker.creditBucket.findFirstOrThrow({
          where: { accountId: ws.accountId },
        });
        await worker.creditBucket.update({
          where: { id: bucket.id },
          data: { remaining: { increment: 7 } },
        });
        await worker.creditLedger.update({
          where: { id: ledger.id },
          data: { reserved: { increment: 1 } },
        });
        const before = await snapshot(ws.accountId);
        const log = jest
          .spyOn(console, 'error')
          .mockImplementation(() => undefined);

        const result = await s().reconcile.reconcileAll();

        expect(
          result.drifted.filter((d) => d.accountId === ws.accountId)
        ).toEqual([{ accountId: ws.accountId, buckets: 1, ledgers: 1 }]);
        expect(result.drifted.map((d) => d.accountId)).not.toContain(
          clean.accountId
        );
        const events = (Sentry.captureMessage as jest.Mock).mock.calls.filter(
          ([, options]) => options?.extra?.accountId === ws.accountId
        );
        expect(events).toHaveLength(1);
        expect(events[0][1].extra).toMatchObject({ buckets: 1, ledgers: 1 });
        expect(
          log.mock.calls.filter(([line]) => String(line).includes(ws.accountId))
        ).toHaveLength(1);
        expect(await snapshot(ws.accountId)).toBe(before);
        log.mockRestore();
      });

      it('carries on with the next account when one account fails, and reports the failure', async () => {
        const bad = await workspace();
        const drifted = await workspace();
        const bucket = await worker.creditBucket.findFirstOrThrow({
          where: { accountId: drifted.accountId },
        });
        await worker.creditBucket.update({
          where: { id: bucket.id },
          data: { remaining: { decrement: 3 } },
        });
        const real = s().credits.reconcile.bind(s().credits);
        const spy = jest
          .spyOn(s().credits, 'reconcile')
          .mockImplementation((id: string) =>
            id === bad.accountId ? Promise.reject(new Error('boom')) : real(id)
          );
        const log = jest
          .spyOn(console, 'error')
          .mockImplementation(() => undefined);

        const result = await s().reconcile.reconcileAll();

        expect(result.drifted.map((d) => d.accountId)).toContain(
          drifted.accountId
        );
        expect(result.drifted.map((d) => d.accountId)).not.toContain(
          bad.accountId
        );
        expect(Sentry.captureException).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'boom' }),
          expect.anything()
        );
        expect(
          log.mock.calls.some((args) => args.includes(bad.accountId))
        ).toBe(true);
        spy.mockRestore();
        log.mockRestore();
      });

      it('does not alert on drift that is gone when read again', async () => {
        const ws = await workspace();
        const real = s().credits.reconcile.bind(s().credits);
        let reads = 0;
        const spy = jest
          .spyOn(s().credits, 'reconcile')
          .mockImplementation((id: string) => {
            if (id === ws.accountId && reads++ === 0) {
              return Promise.resolve({
                buckets: [{ bucketId: 'b', remaining: 1, entries: 2 }],
                ledgers: [],
              });
            }
            return real(id);
          });

        const result = await s().reconcile.reconcileAll();

        expect(reads).toBe(2);
        expect(result.drifted.map((d) => d.accountId)).not.toContain(
          ws.accountId
        );
        spy.mockRestore();
      });
    }
  );

  describe.each(['api', 'worker'] as const)(
    'releaseStale on the %s role',
    (role) => {
      const s = () => roles[role];

      it('releases a non-publish reservation older than 24 hours and returns its credits, and keeps a younger one', async () => {
        const ws = await workspace(10);
        const old = await reserveAi(ws, 25 * HOUR);
        const young = await reserveAi(ws, 23 * HOUR);
        const afterReserve = await balance(ws);

        const { released } = await s().reconcile.releaseStale();

        expect(released).toContain(old);
        expect(released).not.toContain(young);
        expect(await statusOf(old)).toBe('RELEASED');
        expect(await statusOf(young)).toBe('RESERVED');
        const after = await balance(ws);
        expect(after.reserved).toBe(afterReserve.reserved - 1);
        expect(after.available).toBe(afterReserve.available + 1);
      });

      it('never touches committed or already released reservations, and a second run releases nothing', async () => {
        const ws = await workspace(10);
        const committed = await reserveAi(ws, 30 * HOUR);
        await s().credits.commit(committed, undefined, ws.organizationId);
        const released = await reserveAi(ws, 30 * HOUR);
        await s().credits.release(released, ws.organizationId);
        const stale = await reserveAi(ws, 30 * HOUR);

        const first = await s().reconcile.releaseStale();
        const second = await s().reconcile.releaseStale();

        expect(first.released).toEqual([stale]);
        expect(second.released).toEqual([]);
        expect(await statusOf(committed)).toBe('COMMITTED');
      });

      it('releases a publish reservation nobody works on and keeps one under three days old', async () => {
        const ws = await workspace(10);
        const dead = await post(ws);
        const recent = await post(ws);
        const deadKey = await reservePublish(ws, dead.id, 4 * DAY);
        const recentKey = await reservePublish(ws, recent.id, 2 * DAY);
        const before = await balance(ws);

        const { released } = await s().reconcile.releaseStale();

        expect(released).toContain(deadKey);
        expect(released).not.toContain(recentKey);
        expect(await statusOf(deadKey)).toBe('RELEASED');
        expect(await statusOf(recentKey)).toBe('RESERVED');
        expect((await balance(ws)).available).toBe(before.available + 1);
      });
    }
  );

  it('keeps a reservation for a scheduled future post even when no workflow runs', async () => {
    const ws = await workspace(10);
    const scheduled = await post(ws, {
      state: 'QUEUE',
      publishDate: new Date(Date.now() + 10 * DAY),
    });
    const key = await reservePublish(ws, scheduled.id, 5 * DAY);

    const { released } = await roles.worker.reconcile.releaseStale();

    expect(released).not.toContain(key);
    expect(await statusOf(key)).toBe('RESERVED');
  });

  it('releases the reservation of a deleted post or a post that no longer exists', async () => {
    const ws = await workspace(10);
    const deleted = await post(ws, {
      state: 'QUEUE',
      publishDate: new Date(Date.now() + 10 * DAY),
      deletedAt: new Date(),
    });
    const deletedKey = await reservePublish(ws, deleted.id, 5 * DAY);
    const goneKey = await reservePublish(ws, randomUUID(), 5 * DAY);

    const { released } = await roles.worker.reconcile.releaseStale();

    expect(released).toEqual(expect.arrayContaining([deletedKey, goneKey]));
  });

  it('releases nothing for a post when Temporal visibility cannot be read, and still releases the rest', async () => {
    const offline = servicesOn(workerService, false);
    const ws = await workspace(10);
    const dead = await post(ws);
    const publishKey = await reservePublish(ws, dead.id, 4 * DAY);
    const aiKey = await reserveAi(ws, 30 * HOUR);
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const { released } = await offline.reconcile.releaseStale();

    expect(released).toContain(aiKey);
    expect(released).not.toContain(publishKey);
    expect(await statusOf(publishKey)).toBe('RESERVED');
    expect(Sentry.captureException).toHaveBeenCalled();
    log.mockRestore();
  });

  describeTemporal('with workflow visibility (Temporal)', () => {
    // Starts a workflow for the post that nobody runs: it stays Running in visibility.
    const startWorkflow = async (postId: string) => {
      const workflowId = 'reconcile-test-' + postId;
      await client!.workflow.start('neverRuns', {
        taskQueue: 'reconcile-test-' + randomUUID(),
        workflowId,
        searchAttributes: { postId: [postId] },
      });
      started.push(workflowId);
      await visible(`postId="${postId}" AND ExecutionStatus="Running"`);
      return workflowId;
    };

    // Waits until visibility lists a workflow for the query.
    const visible = async (query: string) => {
      for (let i = 0; i < 100; i++) {
        for await (const _ of client!.workflow.list({ query })) {
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('visibility never listed ' + query);
    };

    it('keeps the reservation of a post whose workflow is running, however old', async () => {
      const ws = await workspace(10);
      const live = await post(ws);
      const key = await reservePublish(ws, live.id, 30 * DAY);
      await startWorkflow(live.id);

      const { released } = await roles.worker.reconcile.releaseStale();

      expect(released).not.toContain(key);
      expect(await statusOf(key)).toBe('RESERVED');
    });

    it('keeps the next occurrence of a repeating post whose workflow is running', async () => {
      const ws = await workspace(10);
      const repeating = await post(ws, {
        state: 'PUBLISHED',
        intervalInDays: 1,
      });
      const key = await reservePublish(ws, repeating.id, 5 * DAY, 2);
      await startWorkflow(repeating.id);

      const { released } = await roles.worker.reconcile.releaseStale();

      expect(released).not.toContain(key);
    });

    it('waits three days after the workflow closed before it releases', async () => {
      const ws = await workspace(10);
      const closed = await post(ws);
      const key = await reservePublish(ws, closed.id, 4 * DAY);
      const workflowId = await startWorkflow(closed.id);
      await client!.workflow.getHandle(workflowId).terminate('done');
      await visible(`postId="${closed.id}" AND ExecutionStatus="Terminated"`);

      const soon = await roles.worker.reconcile.releaseStale();
      expect(soon.released).not.toContain(key);
      expect(await statusOf(key)).toBe('RESERVED');

      const later = await roles.worker.reconcile.releaseStale(
        new Date(Date.now() + 4 * DAY)
      );
      expect(later.released).toContain(key);
      expect(await statusOf(key)).toBe('RELEASED');
    });
  });
});
