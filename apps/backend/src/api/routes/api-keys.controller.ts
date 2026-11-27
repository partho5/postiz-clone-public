// Scoped API keys: the workspace's keys, created, listed and revoked by its admins.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import {
  ApiKeysService,
  ApiKeyView,
} from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.service';
import { CreateApiKeyDto } from '@gitroom/nestjs-libraries/dtos/api-keys/create.api.key.dto';

// The caller is a member of the workspace but not an admin of it.
class AdminRequiredException extends HttpException {
  // Answers 403 ADMIN_REQUIRED.
  constructor() {
    super({ statusCode: 403, code: 'ADMIN_REQUIRED' }, 403);
  }
}

// The `/workspace-keys` endpoints: create a key (shown once), list the keys, revoke one.
@ApiTags('API keys')
@Controller('/workspace-keys')
export class ApiKeysController {
  // Receives the service that owns the keys.
  constructor(private _apiKeysService: ApiKeysService) {}

  // Creates a key in the calling workspace and answers it once; the answer is written in two pieces
  // so the idempotency record keeps no body, and the secret never reaches the database in the clear.
  @Post('/')
  async create(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateApiKeyDto,
    @Res() res: Response
  ) {
    this.assertAdmin(org);
    const created = await this._apiKeysService.create(org.id, user.id, body);
    const json = JSON.stringify(created);
    const cut = json.indexOf('"key"');
    res.status(201).type('application/json');
    res.write(json.slice(0, cut));
    res.end(json.slice(cut));
  }

  // Lists the calling workspace's keys, revoked ones included; never a secret.
  @Get('/')
  async list(@GetOrgFromRequest() org: Organization): Promise<ApiKeyView[]> {
    this.assertAdmin(org);
    return this._apiKeysService.list(org.id);
  }

  // Revokes one of the calling workspace's keys; another workspace's key is 404.
  @Delete('/:id')
  @HttpCode(204)
  async revoke(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ): Promise<void> {
    this.assertAdmin(org);
    await this._apiKeysService.revoke(org.id, id);
  }

  // Refuses a member who is not an admin of the workspace; the policy guard no longer tells roles apart.
  private assertAdmin(org: Organization) {
    const role = (org as Organization & { users?: { role: string }[] })
      .users?.[0]?.role;
    if (role !== 'ADMIN' && role !== 'SUPERADMIN') {
      throw new AdminRequiredException();
    }
  }
}
