// AI video editing (ai.video-editing), tracing: the activity the daily trace purge workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { TraceService } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.service';

@Injectable()
@Activity()
export class AiEditTraceActivity {
  constructor(private _traceService: TraceService) {}

  // Deletes the trace rows older than AI_EDIT_TRACE_DAYS days; answers how many went.
  @ActivityMethod()
  async purgeExpiredTraces(): Promise<{ deleted: number }> {
    return this._traceService.deleteExpired();
  }
}
