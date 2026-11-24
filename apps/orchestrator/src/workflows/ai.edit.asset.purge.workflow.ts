// AI video editing (ai.video-editing), assets: every day at 03:00 UTC, delete the cached icon and mp4 files that
// have not been used for AI_EDIT_ASSET_RETENTION_DAYS days.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { AiEditAssetActivity } from '@gitroom/orchestrator/activities/ai.edit.asset.activity';

const { purgeUnusedAssets } = proxyActivities<AiEditAssetActivity>({
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

// Waits for 03:00 UTC, purges the unused files, and repeats; each run is idempotent.
export async function aiEditAssetPurgeWorkflow() {
  while (true) {
    await sleep(untilNextRun(Date.now()));
    await purgeUnusedAssets();
  }
}
