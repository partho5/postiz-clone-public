import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { AiCaptionsService } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';

// The steps of the AI captions workflow (ai.video-captions). An activity on main can never change its
// parameters, so every one takes a single object: the state lives on the caption record, and a field can be
// added to the object without a new activity.
@Injectable()
@Activity()
export class AiCaptionsActivity {
  constructor(private _aiCaptionsService: AiCaptionsService) {}

  // Transcribes the audio, keeps the transcript and deletes the audio.
  @ActivityMethod()
  async transcribeCaption({ captionId }: { captionId: string }) {
    return this._aiCaptionsService.transcribeCaption(captionId);
  }

  // Writes the text of every channel; `noSpeech` says the job ended without any (credits given back).
  @ActivityMethod()
  async generateCaption({ captionId }: { captionId: string }) {
    return this._aiCaptionsService.generateCaption(captionId);
  }

  // Commits the credits and marks the caption READY.
  @ActivityMethod()
  async finishCaption({ captionId }: { captionId: string }) {
    return this._aiCaptionsService.finishCaption(captionId);
  }

  // Ends a job that did not finish; "error" is a text written for the customer to read.
  @ActivityMethod()
  async failCaption({
    captionId,
    error,
  }: {
    captionId: string;
    error?: string;
  }) {
    return this._aiCaptionsService.failCaption(captionId, error);
  }
}
