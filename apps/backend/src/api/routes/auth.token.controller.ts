// Token auth: the token endpoint web, mobile and API clients all sign in and refresh through.
import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { RealIP } from 'nestjs-real-ip';
import { UserAgent } from '@gitroom/nestjs-libraries/user/user.agent';
import { TokenRequestDto } from '@gitroom/nestjs-libraries/dtos/auth/token.request.dto';
import {
  TokenPair,
  TokenService,
} from '@gitroom/backend/services/auth/tokens/token.service';
import { EmailOtpService } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.service';
import { TokenGrantsService } from '@gitroom/backend/services/auth/tokens/token.grants.service';
import {
  AttemptKind,
  AuthAttemptLimiter,
  underAttemptLock,
} from '@gitroom/backend/services/auth/tokens/auth.attempt.limiter';
import {
  AuthRateLimitedFilter,
  InvalidGrantException,
} from '@gitroom/backend/services/auth/tokens/token.exceptions';
import {
  clearSessionCookies,
  setSessionCookies,
} from '@gitroom/backend/services/auth/tokens/token.cookies';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';

// The `/auth/token` endpoints: sign in, refresh and revoke.
@ApiTags('Auth')
@UseFilters(AuthRateLimitedFilter)
@Controller('/auth/token')
export class AuthTokenController {
  // Receives the token, grants, one-time-code and failed-attempt services the endpoints use.
  constructor(
    private _tokenService: TokenService,
    private _grantsService: TokenGrantsService,
    private _attemptLimiter: AuthAttemptLimiter,
    private _emailOtpService: EmailOtpService,
    private _webHandoffService: WebHandoffService
  ) {}

  // Signs in with an email one-time code, a Google ID token or the code of a web handoff link, or
  // refreshes a session, and answers with the token pair (a handoff also names the page to open).
  @Post('/')
  @HttpCode(200)
  async token(
    @Body() body: TokenRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ): Promise<TokenPair & { next?: string }> {
    const device = { name: body.device_name, userAgent, ip };
    if (body.grant_type === 'web_handoff') {
      return this.webHandoff(body.code!, req, response, ip, userAgent);
    }
    if (body.grant_type === 'email_otp') {
      // the one-time-code service checks the failed-attempt limit and counts refusals itself
      const { userId, created } = await this._emailOtpService.verify(
        body.email!,
        body.code!,
        ip
      );
      const otpPair = await this._tokenService.issue(userId, device);
      setSessionCookies(response, otpPair);
      if (created) {
        response.header('onboarding', 'true');
      }
      return otpPair;
    }
    const pair = await this.attempt(
      ip,
      body.grant_type === 'refresh_token' ? 'refresh' : 'sign_in',
      async () => {
        if (body.grant_type === 'refresh_token') {
          const refreshToken = body.refresh_token || req.cookies?.refresh;
          if (!refreshToken) {
            throw new InvalidGrantException();
          }
          return this._tokenService.refresh(refreshToken, device);
        }
        const user = await this._grantsService.googleIdToken(body.id_token!);
        return this._tokenService.issue(user.id, device);
      },
      body.grant_type === 'refresh_token' ? response : undefined
    );
    setSessionCookies(response, pair);
    return pair;
  }

  // Redeems a web handoff link (B2) under the sign-in failed-attempt limit and starts a web session for
  // its user, as every web sign-in does; the browser's previous session, whoever it was for, ends,
  // since its cookies are replaced. The answer names the page the link opens.
  private async webHandoff(
    code: string,
    req: Request,
    response: Response,
    ip: string,
    userAgent: string
  ): Promise<TokenPair & { next: string }> {
    const handoff = await this.attempt(ip, 'sign_in', async () => {
      const redeemed = await this._webHandoffService.redeem(code);
      if (!redeemed) {
        throw new InvalidGrantException();
      }
      return redeemed;
    });
    const previousRefresh = req.cookies?.refresh;
    if (previousRefresh) {
      await this._tokenService.revokeRefreshToken(previousRefresh);
    }
    const pair = await this._tokenService.issue(handoff.userId, {
      name: handoff.sessionName,
      userAgent,
      ip,
    });
    setSessionCookies(response, pair);
    return { ...pair, next: handoff.next };
  }

  // Ends the session the presented refresh token (body or cookie) belongs to, and clears the cookies.
  @Post('/revoke')
  @HttpCode(204)
  async revoke(
    @Body('refresh_token') bodyToken: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const refreshToken = bodyToken || req.cookies?.refresh;
    if (refreshToken) {
      await this._tokenService.revokeRefreshToken(refreshToken);
    }
    clearSessionCookies(response);
    response.header('logout', 'true');
  }

  // Runs one credential check under the failed-attempt limit: refused outright while the address is
  // limited, counted when the check fails; a failed refresh also clears the cookies of the tab.
  // Parallel attempts from one address run one after another.
  private attempt<T>(
    ip: string,
    kind: AttemptKind,
    check: () => Promise<T>,
    clearOnFailure?: Response
  ): Promise<T> {
    return underAttemptLock(ip, kind, async () => {
      await this._attemptLimiter.assertAllowed(ip, kind);
      try {
        return await check();
      } catch (err) {
        if (err instanceof InvalidGrantException) {
          await this._attemptLimiter.recordFailure(ip, kind);
          if (clearOnFailure) {
            clearSessionCookies(clearOnFailure);
            clearOnFailure.header('logout', 'true');
          }
        }
        throw err;
      }
    });
  }
}
