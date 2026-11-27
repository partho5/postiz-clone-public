// Media retention (api.media-retention): the activity the hourly purge workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { MediaRetentionService } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.service';

@Injectable()
@Activity()
export class MediaRetentionActivity {
  constructor(private _mediaRetentionService: MediaRetentionService) {}

  // Deletes the R2 file of every phone media whose retention has run out, reading on from `cursor`
  // (the cursor the previous run answered, null from the start); answers how many went, were kept and
  // failed, and the cursor of the next run (null once the end was reached).
  @ActivityMethod()
  async purgeDueMedia(cursor: string | null = null): Promise<{
    scanned: number;
    purged: number;
    kept: number;
    failed: number;
    cursor: string | null;
  }> {
    return this._mediaRetentionService.purgeDue(new Date(), cursor);
  }
}
