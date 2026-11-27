// Nightly credit reconciliation (G-007): creditsReconcileWorkflow waits for 03:00 UTC, then checks
// every ledger and releases reservations held for dead work, and repeats.
//
// Runs the built workflow (pnpm run build:orchestrator) on a real Temporal server with the real
// CreditsReconcileActivity on a real Postgres (worker role). There is no time-skipping server, so
// the 03:00 wait is read from the workflow history, and the loop body runs from a bundle whose
// wait is one second. Run from the repo root:
//   TEST_DATABASE_URL=... TEST_TEMPORAL_ADDRESS=127.0.1.1:7233 npx jest -c libraries/nestjs-libraries/jest.config.cjs \
//     credits.reconcile.workflow --roots '<rootDir>/apps/orchestrator/src'
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
// relative: the jest config maps no @gitroom/orchestrator alias
import { CreditsReconcileActivity } from '../activities/credits.reconcile.activity';
import { Client, Connection } from '@temporalio/client';
import {
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
  bundleWorkflowCode,
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
  '../../dist/apps/orchestrator/src/workflows/credits.reconcile.workflow.js'
);

const HOUR = 60 * 60 * 1000;

describeRun('creditsReconcileWorkflow (Temporal + Postgres)', () => {
  let prisma: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let credits: CreditsService;
  let activity: CreditsReconcileActivity;
  let client: Client;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let running: { worker: Worker; done: Promise<void> };
  let fastRunning: { worker: Worker; done: Promise<void> };
  const taskQueue = 'credits-reconcile-' + randomUUID();
  const fastQueue = 'credits-reconcile-fast-' + randomUUID();
  const started: string[] = [];
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // A worker on the queue, running the real activity over the real service.
  const startWorker = async (
    queue: string,
    options: { workflowsPath: string } | { workflowBundle: { code: string } }
  ) => {
    const created = await Worker.create({
      connection: nativeConnection,
      taskQueue: queue,
      ...options,
      activities: {
        reconcileAll: activity.reconcileAll.bind(activity),
        releaseStale: activity.releaseStale.bind(activity),
      },
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
    await new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      credits,
      accounts
    ).sync();

    connection = await Connection.connect({ address });
    client = new Client({ connection });
    nativeConnection = await NativeConnection.connect({ address });
    // Stands in for TemporalService: the activity only lists workflows through the raw client.
    const temporal: any = { client: { getRawClient: () => client } };
    activity = new CreditsReconcileActivity(
      new CreditsReconcileService(
        credits,
        new CreditsReconcileRepository(moneyScope, repo),
        temporal
      )
    );

    running = await startWorker(taskQueue, { workflowsPath });
    // The same workflow with only its wait to 03:00 replaced by one second.
    const { code } = await bundleWorkflowCode({ workflowsPath });
    const fast = code.replace(/untilNextRun\(Date\.now\(\)\)/g, '1000');
    expect(fast).not.toBe(code);
    fastRunning = await startWorker(fastQueue, {
      workflowBundle: { code: fast },
    });
  });

  afterAll(async () => {
    for (const workflowId of started) {
      await client.workflow
        .getHandle(workflowId)
        .terminate('test over')
        .catch(() => undefined);
    }
    running?.worker.shutdown();
    fastRunning?.worker.shutdown();
    await running?.done;
    await fastRunning?.done;
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

  // A workspace billed to its owner's account, holding credits.
  const workspace = async () => {
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
    await credits.grant(accountId, { type: 'GRANT', amount: 10 });
    return { organizationId: org.id, accountId };
  };

  // An AI reservation held since `age` ms ago.
  const reserveAi = async (organizationId: string, age: number) => {
    const key = `ai:${randomUUID()}`;
    await credits.reserve({
      organizationId,
      actionKey: 'ai.text',
      idempotencyKey: key,
    });
    await worker.creditLedger.update({
      where: { idempotencyKey: key },
      data: { updatedAt: new Date(Date.now() - age) },
    });
    return key;
  };

  // Polls until check passes or `seconds` have gone. A run visits every account in the
  // database, so the runs that scan it get minutes, not seconds.
  const eventually = async (check: () => Promise<boolean>, seconds = 30) => {
    for (let i = 0; i < seconds * 10; i++) {
      if (await check()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  it('answers the counts of a run: accounts checked, accounts with drift, reservations released', async () => {
    const ws = await workspace();
    const bucket = await worker.creditBucket.findFirstOrThrow({
      where: { accountId: ws.accountId },
    });
    await worker.creditBucket.update({
      where: { id: bucket.id },
      data: { remaining: { increment: 4 } },
    });
    const stale = await reserveAi(ws.organizationId, 30 * HOUR);
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const check = await activity.reconcileAll();
    const release = await activity.releaseStale();

    expect(check.accounts).toBeGreaterThanOrEqual(1);
    expect(check.drifted).toBeGreaterThanOrEqual(1);
    expect(release.released).toBeGreaterThanOrEqual(1);
    expect(
      (
        await worker.creditLedger.findUniqueOrThrow({
          where: { idempotencyKey: stale },
        })
      ).status
    ).toBe('RELEASED');
    log.mockRestore();
  }, 300000);

  it('waits until the next 03:00 UTC before its first run', async () => {
    const workflowId = 'credits-reconcile-' + randomUUID();
    const handle = await client.workflow.start('creditsReconcileWorkflow', {
      taskQueue,
      workflowId,
    });
    started.push(workflowId);

    let first: { startedAt: number; wait: number } | undefined;
    await eventually(async () => {
      const events = (await handle.fetchHistory()).events || [];
      const task = events.find((e) => e.workflowTaskStartedEventAttributes);
      const timer = events.find((e) => e.timerStartedEventAttributes);
      if (!task || !timer) {
        return false;
      }
      const at = task.eventTime!;
      const duration = timer.timerStartedEventAttributes!.startToFireTimeout!;
      first = {
        startedAt:
          Number(at.seconds) * 1000 + Math.round((at.nanos || 0) / 1e6),
        wait:
          Number(duration.seconds || 0) * 1000 +
          Math.round((duration.nanos || 0) / 1e6),
      };
      return true;
    });

    expect(first).toBeDefined();
    const fires = new Date(first!.startedAt + first!.wait);
    expect(first!.wait).toBeGreaterThan(0);
    expect(first!.wait).toBeLessThanOrEqual(24 * HOUR);
    // the workflow reads the clock at its first task; the event is stamped a few ms later
    expect(fires.getUTCHours()).toBe(3);
    expect(fires.getUTCMinutes()).toBe(0);
    expect(fires.getUTCSeconds()).toBeLessThanOrEqual(1);
  });

  it('checks the ledgers, then releases stale reservations, and does both again on the next round', async () => {
    const ws = await workspace();
    const bucket = await worker.creditBucket.findFirstOrThrow({
      where: { accountId: ws.accountId },
    });
    await worker.creditBucket.update({
      where: { id: bucket.id },
      data: { remaining: { decrement: 2 } },
    });
    const stale = await reserveAi(ws.organizationId, 30 * HOUR);
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const alerts = () =>
      log.mock.calls.filter(([line]) => String(line).includes(ws.accountId))
        .length;

    const workflowId = 'credits-reconcile-fast-' + randomUUID();
    await client.workflow.start('creditsReconcileWorkflow', {
      taskQueue: fastQueue,
      workflowId,
    });
    started.push(workflowId);

    const released = await eventually(
      async () =>
        (
          await worker.creditLedger.findUniqueOrThrow({
            where: { idempotencyKey: stale },
          })
        ).status === 'RELEASED',
      240
    );
    expect(released).toBe(true);
    expect(alerts()).toBeGreaterThanOrEqual(1);
    // a second round runs the check again: the drift is still there (never repaired)
    expect(await eventually(async () => alerts() >= 2, 240)).toBe(true);
    expect(
      (
        await worker.creditBucket.findUniqueOrThrow({
          where: { id: bucket.id },
        })
      ).remaining
    ).toBe(bucket.remaining - 2);
    log.mockRestore();
  }, 600000);
});
