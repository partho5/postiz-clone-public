// Activity tracker (api.activity-tracker): the activity the daily tracker cleanup workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { TrackerService } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.service';

@Injectable()
@Activity()
export class TrackerCleanupActivity {
  constructor(private _trackerService: TrackerService) {}

  // Deletes the activity rows past their retention, keeping each device's newest rows; answers how many devices were handled and how many rows went.
  @ActivityMethod()
  async trackerDeleteExpired(): Promise<{ devices: number; deleted: number }> {
    return this._trackerService.deleteExpired();
  }
}
