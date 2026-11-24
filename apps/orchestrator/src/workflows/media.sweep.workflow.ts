// Media retention (api.media-retention, RET-B3): once a day, free the R2 objects of soft-deleted media
// nothing needs and delete the objects no media row names. Both are a dry run until MEDIA_SWEEP_DELETE=true.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { MediaSweepActivity } from '@gitroom/orchestrator/activities/media.sweep.activity';

const { sweepDeletedMedia, sweepOrphanObjects } =
  proxyActivities<MediaSweepActivity>({
    startToCloseTimeout: '20 minute',
    retry: {
      maximumAttempts: 3,
      backoffCoefficient: 1,
      initialInterval: '5 minutes',
    },
  });

// Rounds of each sweep per day: one round reads a bounded batch (500 rows, or up to 3000 keys), a round
// that reached the end hands back a null cursor and the day's rounds stop there.
const ROUNDS_PER_DAY = 4;

// Runs the sweeps, then again every 24 hours; each run is idempotent and carries its cursor.
export async function mediaSweepWorkflow() {
  let deletedCursor: string | null = null;
  let orphanCursor: string | null = null;
  while (true) {
    for (let round = 0; round < ROUNDS_PER_DAY; round++) {
      deletedCursor = (await sweepDeletedMedia(deletedCursor)).cursor;
      if (deletedCursor === null) {
        break;
      }
    }
    for (let round = 0; round < ROUNDS_PER_DAY; round++) {
      orphanCursor = (await sweepOrphanObjects(orphanCursor)).cursor;
      if (orphanCursor === null) {
        break;
      }
    }
    await sleep('24 hours');
  }
}
