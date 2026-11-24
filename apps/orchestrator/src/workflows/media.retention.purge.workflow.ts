// Media retention (api.media-retention): every hour, purge the phone's media files whose retention
// has run out (MEDIA_RETENTION_DAYS=0 means right after the last URL, so the run is hourly).
import { proxyActivities, sleep } from '@temporalio/workflow';
import { MediaRetentionActivity } from '@gitroom/orchestrator/activities/media.retention.activity';

const { purgeDueMedia } = proxyActivities<MediaRetentionActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

// Runs a purge, then another every hour; each run is idempotent. A run that read a full 500 rows hands
// back a cursor and the next run continues after it, so no block of rows kept open can hide the rest;
// the cursor is null at the end of the rows, which wraps the next run to the oldest.
export async function mediaRetentionPurgeWorkflow() {
  let cursor = (await purgeDueMedia(null)).cursor;
  while (true) {
    await sleep('1 hour');
    cursor = (await purgeDueMedia(cursor)).cursor;
  }
}
