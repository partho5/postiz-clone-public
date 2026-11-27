// Content plan job: one piece of work the owner or the tick asked for (a proposal, a week, some days, one day or a
// replan), started with a workflow id that names the job so it cannot run twice.
import { CancellationScope, proxyActivities } from '@temporalio/workflow';
import { ContentPlanActivity } from '@gitroom/orchestrator/activities/content.plan.activity';
import { PlanJob } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';

// A job is a few calls to the model that save their result in one write; running it again writes the same thing
const { contentPlanRunJob } = proxyActivities<ContentPlanActivity>({
  startToCloseTimeout: '10 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '5 second',
  },
});

// Freeing the plan, week or day is idempotent: ride out an outage of a few minutes
const { contentPlanJobFailed } = proxyActivities<ContentPlanActivity>({
  startToCloseTimeout: '2 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 10,
    backoffCoefficient: 2,
    initialInterval: '10 seconds',
    maximumInterval: '2 minutes',
  },
});

// One plan job. A job that fails or is cancelled is closed in a scope that cannot be cancelled, so the plan is never
// left busy.
export async function contentPlanJobWorkflow(job: PlanJob) {
  try {
    await contentPlanRunJob(job);
  } catch (err) {
    await CancellationScope.nonCancellable(() =>
      contentPlanJobFailed({ kind: job.kind, id: job.id })
    );
  }
}
