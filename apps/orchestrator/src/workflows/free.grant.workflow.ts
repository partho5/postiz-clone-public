// Free monthly grant (G-009): grants every eligible account its month's free credits at
// start and every 24 hours; each run is idempotent.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { FreeGrantActivity } from '@gitroom/orchestrator/activities/free.grant.activity';

const { runMonthlyGrants } = proxyActivities<FreeGrantActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

// Grants the current month's free credits to every eligible account at start, then repeats
// every 24 hours so new months and lapsed-to-free accounts are picked up.
export async function freeGrantWorkflow() {
  await runMonthlyGrants();
  while (true) {
    await sleep('24 hours');
    await runMonthlyGrants();
  }
}
