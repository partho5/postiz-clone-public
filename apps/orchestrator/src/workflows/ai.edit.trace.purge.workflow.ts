// AI video editing (ai.video-editing), tracing: every day at 03:00 UTC, delete the trace rows older than
// AI_EDIT_TRACE_DAYS days.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { AiEditTraceActivity } from '@gitroom/orchestrator/activities/ai.edit.trace.activity';

const { purgeExpiredTraces } = proxyActivities<AiEditTraceActivity>({
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

// Waits for 03:00 UTC, purges the old trace rows, and repeats; each run is idempotent.
export async function aiEditTracePurgeWorkflow() {
  while (true) {
    await sleep(untilNextRun(Date.now()));
    await purgeExpiredTraces();
  }
}
