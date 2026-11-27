// Mobile direct upload (api.mobile-direct-upload): the activity the hourly sweep workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { MobileUploadService } from '@gitroom/nestjs-libraries/database/prisma/mobile-upload/mobile.upload.service';

@Injectable()
@Activity()
export class MobileUploadActivity {
  constructor(private _mobileUploadService: MobileUploadService) {}

  // Expires the abandoned uploads and frees their R2 side; answers how many went and how many failed.
  @ActivityMethod()
  async expireStale(): Promise<{ expired: number; failed: number }> {
    return this._mobileUploadService.sweep();
  }
}
