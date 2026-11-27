import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  proxyActivities,
} from '@temporalio/workflow';
import { AiVideoEditActivity } from '@gitroom/orchestrator/activities/ai.video.edit.activity';

// Transcribing waits on the speech-to-text service for up to 10 minutes of audio; running it again only costs the
// call and overwrites the same words (a caption's words are only read)
const { transcribeEdit } = proxyActivities<AiVideoEditActivity>({
  startToCloseTimeout: '15 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '1 minute',
  },
});

// Perception and the writer are calls to models, a few at a time; running them again writes the same fields
const { perceiveEdit, writeEdit } = proxyActivities<AiVideoEditActivity>({
  startToCloseTimeout: '10 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '1 minute',
  },
});

// Planning is pure computation over the kept words; running it again plans the same edit in one write
const { planEdit } = proxyActivities<AiVideoEditActivity>({
  startToCloseTimeout: '2 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '30 seconds',
  },
});

// Settling the credits is idempotent: ride out an outage of a few minutes
const { finishEdit, failEdit } = proxyActivities<AiVideoEditActivity>({
  startToCloseTimeout: '2 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 10,
    backoffCoefficient: 2,
    initialInterval: '10 seconds',
    maximumInterval: '2 minutes',
  },
});

// The workflow only sees the activity failure wrapper; the reason is its cause. Only an "ai_video_edit_stop" was
// written for the customer, anything else (a provider's answer, a timeout) is for the logs
const customerError = (err: any) => {
  const cause = err instanceof ActivityFailure ? err.cause : err;
  return cause instanceof ApplicationFailure &&
    cause.type === 'ai_video_edit_stop'
    ? cause.message
    : undefined;
};

// One AI edit job: words, perception, writer, plan, commit. A job that fails or is cancelled is closed in a scope
// that cannot be cancelled, so its credits are always given back (unless the plan was already kept)
export async function aiVideoEditWorkflow({ editId }: { editId: string }) {
  try {
    const { noSpeech } = await transcribeEdit({ editId });
    // a job without speech was closed and refunded by the step that found it
    if (noSpeech) {
      return;
    }
    await perceiveEdit({ editId });
    await writeEdit({ editId });
    await planEdit({ editId });
    await finishEdit({ editId });
  } catch (err: any) {
    await CancellationScope.nonCancellable(() =>
      failEdit({ editId, error: customerError(err) })
    );
  }
}
