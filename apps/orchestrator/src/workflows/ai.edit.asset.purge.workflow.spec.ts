// AI video editing, assets: aiEditAssetPurgeWorkflow waits for 03:00 UTC, purges the cached icon files
// unused for AI_EDIT_ASSET_RETENTION_DAYS days, and repeats.
//
// Runs the built workflow (pnpm run build:orchestrator) on a real Temporal server with a stand-in
// activity that counts its calls. There is no time-skipping server, so the 03:00 wait is read from the
// workflow history, and the loop body runs from a bundle whose wait is one second. Run from the repo root:
//   TEST_TEMPORAL_ADDRESS=127.0.1.1:7233 npx jest -c libraries/nestjs-libraries/jest.config.cjs \
//     ai.edit.asset.purge.workflow --roots '<rootDir>/apps/orchestrator/src'
import { Client, Connection } from '@temporalio/client';
import {
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
  bundleWorkflowCode,
} from '@temporalio/worker';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';

const address = process.env.TEST_TEMPORAL_ADDRESS;
const describeRun = address ? describe : describe.skip;

// The workflow as the orchestrator bundles it in production.
const workflowsPath = resolve(
  __dirname,
  '../../dist/apps/orchestrator/src/workflows/ai.edit.asset.purge.workflow.js'
);

const HOUR = 60 * 60 * 1000;

describeRun('aiEditAssetPurgeWorkflow (Temporal)', () => {
  let client: Client;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let running: { worker: Worker; done: Promise<void> };
  let fastRunning: { worker: Worker; done: Promise<void> };
  const taskQueue = 'ai-edit-asset-purge-' + randomUUID();
  const fastQueue = 'ai-edit-asset-purge-fast-' + randomUUID();
  const started: string[] = [];
  let calls = 0;

  // A worker on the queue, running a stand-in activity that counts its calls.
  const startWorker = async (
    queue: string,
    options: { workflowsPath: string } | { workflowBundle: { code: string } }
  ) => {
    const created = await Worker.create({
      connection: nativeConnection,
      taskQueue: queue,
      ...options,
      activities: {
        purgeUnusedAssets: async () => {
          calls++;
          return { purged: 0, failed: 0 };
        },
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

    connection = await Connection.connect({ address });
    client = new Client({ connection });
    nativeConnection = await NativeConnection.connect({ address });

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

  it('waits until the next 03:00 UTC before its first run', async () => {
    const workflowId = 'ai-edit-asset-purge-' + randomUUID();
    const handle = await client.workflow.start('aiEditAssetPurgeWorkflow', {
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

  it('purges on a run, and again on the next round', async () => {
    const workflowId = 'ai-edit-asset-purge-fast-' + randomUUID();
    await client.workflow.start('aiEditAssetPurgeWorkflow', {
      taskQueue: fastQueue,
      workflowId,
    });
    started.push(workflowId);

    expect(await eventually(async () => calls >= 2)).toBe(true);
  }, 120000);
});
