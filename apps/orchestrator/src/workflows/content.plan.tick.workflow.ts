// Content plan tick: every hour, advance every ACTIVE plan (carry the leftovers, write the new week, top up the roadmap).
import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { ContentPlanActivity } from '@gitroom/orchestrator/activities/content.plan.activity';

// A tick works on plans four at a time and each plan makes a few calls to the model; running it again is safe
const { contentPlanTick } = proxyActivities<ContentPlanActivity>({
  startToCloseTimeout: '55 minute',
  retry: {
    maximumAttempts: 2,
  },
});

// Waits an hour, runs the tick, and repeats; after 24 runs it starts again so the history stays small.
export async function contentPlanTickWorkflow() {
  for (let run = 0; run < 24; run += 1) {
    await sleep(3600000);
    await contentPlanTick({});
  }
  await continueAsNew<typeof contentPlanTickWorkflow>();
}
