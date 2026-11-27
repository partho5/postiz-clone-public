// Workspace app credentials (T4): the App credentials page, where a workspace's admins enter the
// keys of their own developer app for each provider. Secrets are never answered back.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import {
  AppCredentialsProviderView,
  AppCredentialsService,
  canManageAppCredentials,
} from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.service';
import { SaveAppCredentialsDto } from '@gitroom/nestjs-libraries/dtos/app-credentials/save.app.credentials.dto';

// The caller is a member of the workspace but not an admin of it.
class AdminRequiredException extends HttpException {
  // Answers 403 ADMIN_REQUIRED.
  constructor() {
    super({ statusCode: 403, code: 'ADMIN_REQUIRED' }, 403);
  }
}

// The `/app-credentials` endpoints: list the providers and what is set, save or clear one provider's keys.
@ApiTags('App credentials')
@Controller('/app-credentials')
export class AppCredentialsController {
  // Receives the service that owns the workspace's app credentials.
  constructor(private _appCredentialsService: AppCredentialsService) {}

  // Every provider that needs app credentials, its callback URL and which keys this workspace has set.
  @Get('/')
  list(
    @GetOrgFromRequest() org: Organization
  ): Promise<AppCredentialsProviderView[]> {
    this.assertAdmin(org);
    return this._appCredentialsService.list(org.id);
  }

  // Sets, replaces or removes keys of one provider in the calling workspace.
  @Put('/:identifier')
  @HttpCode(204)
  async save(
    @GetOrgFromRequest() org: Organization,
    @Param('identifier') identifier: string,
    @Body() body: SaveAppCredentialsDto
  ): Promise<void> {
    this.assertAdmin(org);
    await this._appCredentialsService.save(org.id, identifier, body.values);
  }

  // Removes every key of one provider from the calling workspace.
  @Delete('/:identifier')
  @HttpCode(204)
  async clear(
    @GetOrgFromRequest() org: Organization,
    @Param('identifier') identifier: string
  ): Promise<void> {
    this.assertAdmin(org);
    await this._appCredentialsService.clear(org.id, identifier);
  }

  // Refuses a member who is not an admin of the workspace; the policy guard no longer tells roles apart.
  private assertAdmin(org: Organization) {
    const role = (org as Organization & { users?: { role: string }[] })
      .users?.[0]?.role;
    if (!canManageAppCredentials(role)) {
      throw new AdminRequiredException();
    }
  }
}
