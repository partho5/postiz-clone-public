// Activity tracker (api.activity-tracker): where the app uploads its batches of activities and errors.
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
import { TrackerService } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.service';
import { TrackerBatchDto } from '@gitroom/nestjs-libraries/dtos/activity-tracker/tracker.batch.dto';

// `POST /tracker/batches`. Not behind the authentication middleware: a user who has not signed in
// must be able to upload, so a device access token is read here and a missing or bad one is anonymous.
@ApiTags('Activity tracker')
@Controller('/tracker')
export class TrackerController {
  // Receives the token service that reads the optional Bearer token and the service that stores batches.
  constructor(
    private _tokenService: TokenService,
    private _trackerService: TrackerService
  ) {}

  // Stores a batch of activities, as the token's user when it has a valid one, else anonymously.
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 120, ttl: 3600000 } })
  @Post('/batches')
  @HttpCode(200)
  async upload(
    @Body() body: TrackerBatchDto,
    @Headers('authorization') authorization?: string
  ) {
    return this._trackerService.store(
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
