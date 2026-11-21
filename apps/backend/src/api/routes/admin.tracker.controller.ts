// Activity tracker (api.activity-tracker): /admin/tracker, the super admin's read API for the Activity tab (overview, devices, replay).
// Session auth like every /admin route. Every handler answers 403 to anyone who is not a super admin.
import { Controller, Get, HttpException, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { TrackerService } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.service';

@ApiTags('Admin')
@Controller('/admin/tracker')
export class AdminTrackerController {
  // Receives the service that reads the tracker tables.
  constructor(private _trackerService: TrackerService) {}

  // The overview of the last `days` days (1 to 90, default 7): totals, top features, drop-off, entry sources and top errors.
  @Get('/overview')
  async overview(
    @GetUserFromRequest() user: User,
    @Query('days') days?: string
  ) {
    if (!user?.isSuperAdmin) {
      throw new HttpException({ msg: 'Unauthorized' }, 403);
    }
    return this._trackerService.overview(days);
  }

  // The devices, newest first, filtered by `q`, `hasErrors` and the `cursor` of the page before.
  @Get('/devices')
  async devices(
    @GetUserFromRequest() user: User,
    @Query('q') q?: string,
    @Query('hasErrors') hasErrors?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    if (!user?.isSuperAdmin) {
      throw new HttpException({ msg: 'Unauthorized' }, 403);
    }
    return this._trackerService.devices({ q, hasErrors, cursor, limit });
  }

  // One device's sessions, newest first. `deviceId` is required.
  @Get('/sessions')
  async sessions(
    @GetUserFromRequest() user: User,
    @Query('deviceId') deviceId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    if (!user?.isSuperAdmin) {
      throw new HttpException({ msg: 'Unauthorized' }, 403);
    }
    return this._trackerService.sessions({ deviceId, cursor, limit });
  }

  // One session's activities in replay order, with the gap to the one before. `sessionKey` is required.
  @Get('/timeline')
  async timeline(
    @GetUserFromRequest() user: User,
    @Query('sessionKey') sessionKey?: string
  ) {
    if (!user?.isSuperAdmin) {
      throw new HttpException({ msg: 'Unauthorized' }, 403);
    }
    return this._trackerService.timeline(sessionKey);
  }

  // One full activity by its id, for the error detail panel.
  @Get('/activity/:id')
  async activity(@GetUserFromRequest() user: User, @Param('id') id: string) {
    if (!user?.isSuperAdmin) {
      throw new HttpException({ msg: 'Unauthorized' }, 403);
    }
    return this._trackerService.activity(id);
  }
}
