// Daily PayPal poll (G-012): every day at 04:00 UTC, replay PayPal's recent events and sync every
// PayPal subscription, so a lost webhook never leaves a refund or a lapse unapplied.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { PaypalPollActivity } from '@gitroom/orchestrator/activities/paypal.poll.activity';

const { dailyPoll } = proxyActivities<PaypalPollActivity>({
  startToCloseTimeout: '30 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '5 minutes',
  },
});

const DAY = 24 * 60 * 60 * 1000;
const RUN_HOUR_UTC = 4;

// Milliseconds from `now` to the next 04:00 UTC (a full day when it is 04:00 exactly).
function untilNextRun(now: number) {
  const today = now - (now % DAY) + RUN_HOUR_UTC * 60 * 60 * 1000;
  return today > now ? today - now : today + DAY - now;
}

// Waits for 04:00 UTC, runs the poll, and repeats; each run is idempotent.
export async function paypalPollWorkflow() {
  while (true) {
    await sleep(untilNextRun(Date.now()));
    await dailyPoll();
  }
}
