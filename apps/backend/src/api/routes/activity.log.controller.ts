// Mobile activity log (api.activity-log): where the app uploads its batches of user-action events.
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ThrottlerRealIpGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { ActivityLogService } from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.log.service';
import { ActivityBatchDto } from '@gitroom/nestjs-libraries/dtos/activity-log/activity.batch.dto';

// `POST /activity/batches`. Not behind the authentication middleware: a user who has not signed in
// must be able to upload, so a device access token is read here and a missing or bad one is anonymous.
@ApiTags('Activity')
@Controller('/activity')
export class ActivityLogController {
  // Receives the token service that reads the optional Bearer token and the service that stores batches.
  constructor(
    private _tokenService: TokenService,
    private _activityLogService: ActivityLogService
  ) {}

  // Stores a batch of events, as the token's user when it has a valid one, else anonymously.
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 60, ttl: 3600000 } })
  @Post('/batches')
  @HttpCode(204)
  async upload(
    @Body() body: ActivityBatchDto,
    @Headers('authorization') authorization?: string
  ) {
    await this._activityLogService.store(
      body,
      await this.userIdOf(authorization)
    );
  }

  // The user of a valid device access token in the header; undefined for no token or any bad one.
  private async userIdOf(authorization?: string) {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '')?.[1];
    if (!token) {
      return undefined;
    }
    try {
      return (await this._tokenService.verifyAccess(token)).userId;
    } catch {
      return undefined;
    }
  }
}
