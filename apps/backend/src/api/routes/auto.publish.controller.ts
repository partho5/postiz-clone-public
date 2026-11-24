// Mobile auto-publish (api.mobile-auto-publish): the web app's routes for choosing which Set the
// phone app publishes new recordings with (with none, it publishes in automatic mode).
import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { AutoPublishService } from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.service';
import { AutoPublishPresetDto } from '@gitroom/nestjs-libraries/dtos/auto-publish/auto.publish.preset.dto';

// The `/auto-publish` endpoints of the web app: read, choose and clear the workspace's preset.
@ApiTags('Auto publish')
@Controller('/auto-publish')
export class AutoPublishController {
  // Receives the service that owns the preset.
  constructor(private _autoPublishService: AutoPublishService) {}

  // The workspace's preset as { preset }, which is null when no Set is chosen (automatic mode).
  @Get('/')
  async getPreset(@GetOrgFromRequest() org: Organization) {
    return { preset: await this._autoPublishService.getPreset(org.id) };
  }

  // Makes one of the workspace's Sets the preset, with its timing; answers { preset }.
  @Put('/')
  async setPreset(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AutoPublishPresetDto
  ) {
    return {
      preset: await this._autoPublishService.setPreset(
        org.id,
        body.setId,
        body.timing
      ),
    };
  }

  // Stops using the Set: back to automatic mode; the channels switched off in the app stay off.
  @Delete('/')
  clearPreset(@GetOrgFromRequest() org: Organization) {
    return this._autoPublishService.clearPreset(org.id);
  }
}
