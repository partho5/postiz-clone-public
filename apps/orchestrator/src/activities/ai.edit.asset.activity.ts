// AI video editing (ai.video-editing), assets: the activity the daily purge workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { EditAssetsService } from '@gitroom/nestjs-libraries/ai-video-edit/assets/edit.assets.service';

@Injectable()
@Activity()
export class AiEditAssetActivity {
  constructor(private _editAssetsService: EditAssetsService) {}

  // Deletes the cached icon and mp4 files not used for AI_EDIT_ASSET_RETENTION_DAYS days; answers how many went
  // and how many could not be deleted (they are tried again the next day).
  @ActivityMethod()
  async purgeUnusedAssets(): Promise<{ purged: number; failed: number }> {
    return this._editAssetsService.purgeUnused();
  }
}
