// Nightly credit reconciliation (G-007): every day at 03:00 UTC, check the ledgers and release
// the reservations held for dead work.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { CreditsReconcileActivity } from '@gitroom/orchestrator/activities/credits.reconcile.activity';

const { reconcileAll, releaseStale } =
  proxyActivities<CreditsReconcileActivity>({
    startToCloseTimeout: '30 minute',
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

// Waits for 03:00 UTC, runs both checks, and repeats; each run is idempotent.
export async function creditsReconcileWorkflow() {
  while (true) {
    await sleep(untilNextRun(Date.now()));
    await reconcileAll();
    await releaseStale();
  }
}
