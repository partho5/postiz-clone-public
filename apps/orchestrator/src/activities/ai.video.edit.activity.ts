import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { AiVideoEditsService } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.service';

// The steps of the AI video edit workflow (ai.video-editing). An activity on main can never change its parameters,
// so every one takes a single object: the state lives on the edit record, and a field can be added to the object
// without a new activity.
@Injectable()
@Activity()
export class AiVideoEditActivity {
  constructor(private _aiVideoEditsService: AiVideoEditsService) {}

  // Gets the words (caption or transcription), keeps them and deletes the audio; `noSpeech` says the job ended
  // without enough of them (credits given back).
  @ActivityMethod()
  async transcribeEdit({ editId }: { editId: string }) {
    return this._aiVideoEditsService.transcribeEdit(editId);
  }

  // Scores the proxy pieces (Standard and Heavy).
  @ActivityMethod()
  async perceiveEdit({ editId }: { editId: string }) {
    return this._aiVideoEditsService.perceiveEdit(editId);
  }

  // Writes the Heavy texts.
  @ActivityMethod()
  async writeEdit({ editId }: { editId: string }) {
    return this._aiVideoEditsService.writeEdit(editId);
  }

  // Plans and validates the edit and keeps the plan.
  @ActivityMethod()
  async planEdit({ editId }: { editId: string }) {
    return this._aiVideoEditsService.planEdit(editId);
  }

  // Commits the credits and marks the edit READY.
  @ActivityMethod()
  async finishEdit({ editId }: { editId: string }) {
    return this._aiVideoEditsService.finishEdit(editId);
  }

  // Ends a job that did not finish; "error" is a text written for the customer to read.
  @ActivityMethod()
  async failEdit({ editId, error }: { editId: string; error?: string }) {
    return this._aiVideoEditsService.failEdit(editId, error);
  }
}
