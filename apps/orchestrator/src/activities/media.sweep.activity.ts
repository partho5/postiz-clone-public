// Media retention (api.media-retention, RET-B3): the activities the nightly media sweep workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import {
  DeletedSweepResult,
  MediaSweepService,
  OrphanSweepResult,
} from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.sweep.service';

@Injectable()
@Activity()
export class MediaSweepActivity {
  constructor(private _mediaSweepService: MediaSweepService) {}

  // Frees the R2 object of the soft-deleted media rows nothing needs, reading on from `cursor` (the
  // cursor the previous run answered, null from the start). A dry run unless MEDIA_SWEEP_DELETE=true.
  @ActivityMethod()
  async sweepDeletedMedia(
    cursor: string | null = null
  ): Promise<DeletedSweepResult> {
    return this._mediaSweepService.sweepDeleted(new Date(), cursor);
  }

  // Deletes the R2 objects no media row or table names, listing on after `cursor` (the last key the
  // previous run finished, null from the start). A dry run unless MEDIA_SWEEP_DELETE=true.
  @ActivityMethod()
  async sweepOrphanObjects(
    cursor: string | null = null
  ): Promise<OrphanSweepResult> {
    return this._mediaSweepService.sweepOrphans(new Date(), cursor);
  }
}
