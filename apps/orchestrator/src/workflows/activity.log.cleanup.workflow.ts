// Mobile activity log (api.activity-log): every day at 03:00 UTC, delete the batches past their 90 days.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { ActivityLogActivity } from '@gitroom/orchestrator/activities/activity.log.activity';

const { deleteExpired } = proxyActivities<ActivityLogActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '5 minutes',
  },
});

const DAY = 24 * 60 * 60 * 1000;
const RUN_HOUR_UTC = 3;

// Milliseconds from `now` to the next 03:00 UTC (a full day when it is 03:00 exactly).
function untilNextRun(now: number) {
  const today = now - (now % DAY) + RUN_HOUR_UTC * 60 * 60 * 1000;
  return today > now ? today - now : today + DAY - now;
}

// Waits for 03:00 UTC, deletes the expired batches, and repeats; each run is idempotent.
export async function activityLogCleanupWorkflow() {
  while (true) {
    await sleep(untilNextRun(Date.now()));
    await deleteExpired();
  }
}
