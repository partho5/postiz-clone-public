import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  proxyActivities,
} from '@temporalio/workflow';
import { AiCaptionsActivity } from '@gitroom/orchestrator/activities/ai.captions.activity';

// Transcribing waits on the speech-to-text service for up to an hour of audio, one piece after the other;
// running it again only costs the pieces and overwrites the same transcript
const { transcribeCaption } = proxyActivities<AiCaptionsActivity>({
  startToCloseTimeout: '15 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '1 minute',
  },
});

// Writing is up to a few calls to the model per platform, a few platforms at a time; running it again
// writes the same set in one write
const { generateCaption } = proxyActivities<AiCaptionsActivity>({
  startToCloseTimeout: '10 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '1 minute',
  },
});

// Settling the credits is idempotent: ride out an outage of a few minutes
const { finishCaption, failCaption } = proxyActivities<AiCaptionsActivity>({
  startToCloseTimeout: '2 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 10,
    backoffCoefficient: 2,
    initialInterval: '10 seconds',
    maximumInterval: '2 minutes',
  },
});

// The workflow only sees the activity failure wrapper; the reason is its cause. Only an "ai_captions_stop"
// was written for the customer, anything else (a provider's answer, a timeout) is for the logs
const customerError = (err: any) => {
  const cause = err instanceof ActivityFailure ? err.cause : err;
  return cause instanceof ApplicationFailure &&
    cause.type === 'ai_captions_stop'
    ? cause.message
    : undefined;
};

// One caption job: transcribe, write, commit. A job that fails or is cancelled is closed in a scope that
// cannot be cancelled, so its credits are always given back (unless the texts were already written)
export async function aiCaptionsWorkflow({ captionId }: { captionId: string }) {
  try {
    await transcribeCaption({ captionId });
    const { noSpeech } = await generateCaption({ captionId });
    // a job without speech was closed and refunded by the step that found it
    if (!noSpeech) {
      await finishCaption({ captionId });
    }
  } catch (err: any) {
    await CancellationScope.nonCancellable(() =>
      failCaption({ captionId, error: customerError(err) })
    );
  }
}
