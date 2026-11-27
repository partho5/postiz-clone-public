// Daily PayPal poll (G-012): paypalPollWorkflow waits for 04:00 UTC, runs the poll, and repeats.
//
// Runs the built workflow (pnpm run build:orchestrator) on a real Temporal server with the real
// PaypalPollActivity over a ReversalsService that answers `dailyPoll` as its contract declares
// (the service itself is covered by reversals.service.spec.ts). There is no time-skipping server,
// so the 04:00 wait is read from the workflow history, and the loop runs from a bundle whose wait
// is one second. Run from the repo root:
//   TEST_DATABASE_URL=... TEST_TEMPORAL_ADDRESS=127.0.1.1:7233 npx jest -c libraries/nestjs-libraries/jest.config.cjs \
//     paypal.poll.workflow --roots '<rootDir>/apps/orchestrator/src'
// relative: the jest config maps no @gitroom/orchestrator alias
import { PaypalPollActivity } from '../activities/paypal.poll.activity';
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
  '../../dist/apps/orchestrator/src/workflows/paypal.poll.workflow.js'
);

const HOUR = 60 * 60 * 1000;

describeRun('paypalPollWorkflow (Temporal)', () => {
  const counts = { replayed: 2, checked: 3, lapsed: 1 };
  const dailyPoll = jest.fn(async () => counts);
  const activity = new PaypalPollActivity({ dailyPoll } as any);
  let client: Client;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let running: { worker: Worker; done: Promise<void> };
  let fastRunning: { worker: Worker; done: Promise<void> };
  const taskQueue = 'paypal-poll-' + randomUUID();
  const fastQueue = 'paypal-poll-fast-' + randomUUID();
  const started: string[] = [];

  // A worker on the queue, running the real activity.
  const startWorker = async (
    queue: string,
    options: { workflowsPath: string } | { workflowBundle: { code: string } }
  ) => {
    const created = await Worker.create({
      connection: nativeConnection,
      taskQueue: queue,
      ...options,
      activities: { dailyPoll: activity.dailyPoll.bind(activity) },
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
    // The same workflow with only its wait to 04:00 replaced by one second.
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

  it('answers the counts of the poll: events replayed, subscriptions checked, accounts lapsed', async () => {
    expect(await activity.dailyPoll()).toEqual(counts);
  });

  it('waits until the next 04:00 UTC before its first run', async () => {
    const workflowId = 'paypal-poll-' + randomUUID();
    const before = dailyPoll.mock.calls.length;
    const handle = await client.workflow.start('paypalPollWorkflow', {
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
    expect(fires.getUTCHours()).toBe(4);
    expect(fires.getUTCMinutes()).toBe(0);
    expect(fires.getUTCSeconds()).toBeLessThanOrEqual(1);
    // it does not run at start: the poll waits for its hour first
    expect(dailyPoll.mock.calls.length).toBe(before);
  });

  it('runs the poll on every round', async () => {
    dailyPoll.mockClear();
    const workflowId = 'paypal-poll-fast-' + randomUUID();
    await client.workflow.start('paypalPollWorkflow', {
      taskQueue: fastQueue,
      workflowId,
    });
    started.push(workflowId);

    expect(
      await eventually(async () => dailyPoll.mock.calls.length >= 2, 60)
    ).toBe(true);
  }, 90000);
});
