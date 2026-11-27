// Web handoff (B2): the public route the app asks for a link that opens a web page already signed in.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Organization, User } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ScopeGuard } from '@gitroom/backend/services/auth/scopes/scope.guard';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';
import { WebLinkRequestDto } from '@gitroom/nestjs-libraries/dtos/web-handoff/web.link.request.dto';

// `POST /public/v1/web-link`. Only a device token acts for a user: the route names no scope, so the
// scope guard refuses every API key, and an OAuth-app token, which has no user, is refused here.
@ApiTags('Public API')
@Controller('/public/v1')
@UseGuards(ScopeGuard)
export class PublicWebLinkController {
  // Receives the service that creates the links.
  constructor(private _webHandoffService: WebHandoffService) {}

  // A one-time link (60 s) that opens a provider's credentials panel or connect flow, an AI caption's page,
  // or the plans page on a tier, on the web, signed in as the device token's user, in the request's
  // workspace (the plans page: in a workspace whose account the user owns).
  @Post('/web-link')
  @HttpCode(200)
  async createWebLink(
    @GetOrgFromRequest() org: Organization,
    @Body() body: WebLinkRequestDto,
    @Req() req: Request,
    @GetUserFromRequest() user?: User
  ) {
    Sentry.metrics.count('public_api-request', 1);
    if (!user) {
      throw new HttpException({ msg: 'A signed-in user is required' }, 403);
    }
    return this._webHandoffService.createLink(
      user.id,
      org.id,
      (req as Request & { sessionId?: string }).sessionId,
      body.target,
      body.identifier ?? ''
    );
  }
}
