// Device sessions: lists the signed-in devices of the user and signs any of them out.
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { SessionsQueryDto } from '@gitroom/nestjs-libraries/dtos/auth/sessions.query.dto';
import {
  DeviceSessionView,
  TokenService,
} from '@gitroom/backend/services/auth/tokens/token.service';
import { clearSessionCookies } from '@gitroom/backend/services/auth/tokens/token.cookies';

// A device session as the list shows it: marked when it is the device making the request.
type CurrentDeviceSessionView = DeviceSessionView & { current: boolean };

// The `/auth/sessions` endpoints: list the user's devices, sign one out, sign out the others.
@ApiTags('Auth')
@Controller('/auth/sessions')
export class SessionsController {
  // Receives the token service that owns the sessions.
  constructor(private _tokenService: TokenService) {}

  // Lists the signed-in user's live sessions, newest activity first, the calling one marked.
  @Get('/')
  async list(@Req() req: Request): Promise<CurrentDeviceSessionView[]> {
    const sessions = await this._tokenService.listSessions(this.userIdOf(req));
    const sessionId = this.sessionIdOf(req);
    return sessions.map((session) => ({
      ...session,
      current: session.id === sessionId,
    }));
  }

  // Signs one of the user's own devices out; another user's or an unknown session is 404.
  @Delete('/:id')
  @HttpCode(204)
  async revoke(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response
  ): Promise<void> {
    const userId = this.userIdOf(req);
    const sessions = await this._tokenService.listSessions(userId);
    if (!sessions.some((session) => session.id === id)) {
      throw new NotFoundException();
    }
    await this._tokenService.revoke(id, userId);
    this.endCallingSession(response, id === this.sessionIdOf(req));
  }

  // Signs the user's devices out, all of them or, with `except=current`, all but the calling one.
  @Delete('/')
  @HttpCode(204)
  async revokeMany(
    @Query() query: SessionsQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response
  ): Promise<void> {
    const userId = this.userIdOf(req);
    const sessionId = this.sessionIdOf(req);
    const sessions = await this._tokenService.listSessions(userId);
    const ended = sessions.filter(
      (session) => query.except !== 'current' || session.id !== sessionId
    );
    await Promise.all(
      ended.map((session) => this._tokenService.revoke(session.id, userId))
    );
    this.endCallingSession(
      response,
      ended.some((session) => session.id === sessionId)
    );
  }

  // The user who signed in, which is the admin while a super admin impersonates.
  private userIdOf(req: Request): string {
    return (req as Request & { sessionUserId: string }).sessionUserId;
  }

  // The session the request's access token belongs to.
  private sessionIdOf(req: Request): string {
    return (req as Request & { sessionId: string }).sessionId;
  }

  // When the calling device was signed out, clears its cookies and tells the web client to log out.
  private endCallingSession(response: Response, callingEnded: boolean) {
    if (callingEnded) {
      clearSessionCookies(response);
      response.header('logout', 'true');
    }
  }
}
