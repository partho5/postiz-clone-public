// Mobile activity log (api.activity-log): what the super admin reads about the app's users: who was active
// and, for one user or phone, the timeline of what they did.
import {
  Controller,
  Get,
  HttpException,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Response } from 'express';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import {
  ActivityLogService,
  ActivityTimelineQuery,
  ActivityUsersQuery,
} from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.log.service';

// `GET /activity/timeline` and `GET /activity/users`, behind the web login; only a super admin may read them.
@ApiTags('Activity')
@Controller('/activity')
export class ActivityTimelineController {
  // Receives the service that builds the list and the timelines.
  constructor(private _activityLogService: ActivityLogService) {}

  // Answers 403 unless the signed-in user is a super admin (the same rule as the admin errors list).
  private assertSuperAdmin(user: User) {
    if (!user?.isSuperAdmin) {
      throw new HttpException({ msg: 'Unauthorized' }, 403);
    }
  }

  // Who was active in the last days (users with all their devices, and phones nobody signed in on), newest first.
  @Get('/users')
  async users(
    @GetUserFromRequest() user: User,
    @Query() query: ActivityUsersQuery
  ) {
    this.assertSuperAdmin(user);
    return this._activityLogService.users(query);
  }

  // The timeline of one user (by id or email) or one phone: text by default, data with `?format=json`.
  @Get('/timeline')
  async timeline(
    @GetUserFromRequest() user: User,
    @Query() query: ActivityTimelineQuery,
    @Res({ passthrough: true }) response: Response
  ) {
    this.assertSuperAdmin(user);
    if (query.format === 'json') {
      return this._activityLogService.timelineJson(query);
    }
    response.type('text/plain; charset=utf-8');
    return this._activityLogService.timeline(query);
  }
}
