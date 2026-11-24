// Mobile activity log (api.activity-log): the activity the daily cleanup workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { ActivityLogService } from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.log.service';

@Injectable()
@Activity()
export class ActivityLogActivity {
  constructor(private _activityLogService: ActivityLogService) {}

  // Deletes every activity batch received more than 90 days ago; answers how many went.
  @ActivityMethod()
  async deleteExpired(): Promise<{ deleted: number }> {
    return this._activityLogService.deleteExpired();
  }
}
