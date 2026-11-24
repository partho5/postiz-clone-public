// Idempotency-Key (G-018): idempotencyCleanupWorkflow waits for 02:00 UTC, deletes the idempotency
// records past their expiry, and repeats.
//
// Runs the built workflow (pnpm run build:orchestrator) on a real Temporal server with the real
// IdempotencyActivity on a real Postgres (worker role). There is no time-skipping server, so the
// 02:00 wait is read from the workflow history, and the loop body runs from a bundle whose wait is
// one second. Run from the repo root:
//   TEST_DATABASE_URL=... TEST_TEMPORAL_ADDRESS=127.0.1.1:7233 npx jest -c libraries/nestjs-libraries/jest.config.cjs \
//     idempotency.cleanup.workflow --roots '<rootDir>/apps/orchestrator/src'
import {
  PrismaRepository,
  PrismaService,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { IdempotencyRepository } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.repository';
import { IdempotencyService } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.service';
// relative: the jest config maps no @gitroom/orchestrator alias
import { IdempotencyActivity } from '../activities/idempotency.activity';
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
  '../../dist/apps/orchestrator/src/workflows/idempotency.cleanup.workflow.js'
);

const HOUR = 60 * 60 * 1000;

describeRun('idempotencyCleanupWorkflow (Temporal + Postgres)', () => {
  let prisma: PrismaService;
  let worker: PrismaClient;
  let activity: IdempotencyActivity;
  let client: Client;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let running: { worker: Worker; done: Promise<void> };
  let fastRunning: { worker: Worker; done: Promise<void> };
  const taskQueue = 'idempotency-cleanup-' + randomUUID();
  const fastQueue = 'idempotency-cleanup-fast-' + randomUUID();
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
      activities: { deleteExpired: activity.deleteExpired.bind(activity) },
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
    activity = new IdempotencyActivity(
      new IdempotencyService(
        new IdempotencyRepository(new PrismaRepository<any>(prisma))
      )
    );

    connection = await Connection.connect({ address });
    client = new Client({ connection });
    nativeConnection = await NativeConnection.connect({ address });

    running = await startWorker(taskQueue, { workflowsPath });
    // The same workflow with only its wait to 02:00 replaced by one second.
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

  // An answer record that expires at the given time.
  const record = (principal: string, key: string, expiresAt: Date) => ({
    principal,
    workspaceId: 'w',
    key,
    fingerprint: 'f',
    state: 'DONE' as const,
    expiresAt,
  });

  // Polls until check passes or `seconds` have gone.
  const eventually = async (check: () => Promise<boolean>, seconds = 30) => {
    for (let i = 0; i < seconds * 10; i++) {
      if (await check()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  it('answers how many records it deleted, expired ones only', async () => {
    const principal = 'cleanup-' + randomUUID();
    await worker.idempotencyRecord.createMany({
      data: [
        record(principal, 'old', new Date(Date.now() - HOUR)),
        record(principal, 'live', new Date(Date.now() + HOUR)),
      ],
    });

    const { deleted } = await activity.deleteExpired();

    expect(deleted).toBeGreaterThanOrEqual(1);
    const left = await worker.idempotencyRecord.findMany({
      where: { principal },
    });
    expect(left.map((r) => r.key)).toEqual(['live']);
    await worker.idempotencyRecord.deleteMany({ where: { principal } });
  });

  it('waits until the next 02:00 UTC before its first run', async () => {
    const workflowId = 'idempotency-cleanup-' + randomUUID();
    const handle = await client.workflow.start('idempotencyCleanupWorkflow', {
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
    expect(fires.getUTCHours()).toBe(2);
    expect(fires.getUTCMinutes()).toBe(0);
    expect(fires.getUTCSeconds()).toBeLessThanOrEqual(1);
  });

  it('deletes the expired records on a run, and again on the next round', async () => {
    const principal = 'cleanup-' + randomUUID();
    await worker.idempotencyRecord.create({
      data: record(principal, 'old-1', new Date(Date.now() - HOUR)),
    });

    const workflowId = 'idempotency-cleanup-fast-' + randomUUID();
    await client.workflow.start('idempotencyCleanupWorkflow', {
      taskQueue: fastQueue,
      workflowId,
    });
    started.push(workflowId);

    const first = await eventually(
      async () =>
        (await worker.idempotencyRecord.count({ where: { principal } })) === 0
    );
    expect(first).toBe(true);

    // a record that expires after the first run is taken by the next round
    await worker.idempotencyRecord.create({
      data: record(principal, 'old-2', new Date(Date.now() - 1000)),
    });
    const second = await eventually(
      async () =>
        (await worker.idempotencyRecord.count({ where: { principal } })) === 0
    );
    expect(second).toBe(true);
  }, 120000);
});
