// Idempotency-Key (G-018): every day at 02:00 UTC, delete the records whose 24 hours are over.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { IdempotencyActivity } from '@gitroom/orchestrator/activities/idempotency.activity';

const { deleteExpired } = proxyActivities<IdempotencyActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '5 minutes',
  },
});

const DAY = 24 * 60 * 60 * 1000;
const RUN_HOUR_UTC = 2;

// Milliseconds from `now` to the next 02:00 UTC (a full day when it is 02:00 exactly).
function untilNextRun(now: number) {
  const today = now - (now % DAY) + RUN_HOUR_UTC * 60 * 60 * 1000;
  return today > now ? today - now : today + DAY - now;
}

// Waits for 02:00 UTC, deletes the expired records, and repeats; each run is idempotent.
export async function idempotencyCleanupWorkflow() {
  while (true) {
    await sleep(untilNextRun(Date.now()));
    await deleteExpired();
  }
}
