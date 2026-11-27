// Mobile direct upload (api.mobile-direct-upload): every hour, expire the uploads nobody finished
// (pending past their expiry, completing for over 30 minutes) and free their R2 side.
import { proxyActivities, sleep } from '@temporalio/workflow';
import { MobileUploadActivity } from '@gitroom/orchestrator/activities/mobile.upload.activity';

const { expireStale } = proxyActivities<MobileUploadActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

// Runs a sweep, then another every hour; each run is idempotent.
export async function mobileUploadSweepWorkflow() {
  await expireStale();
  while (true) {
    await sleep('1 hour');
    await expireStale();
  }
}
