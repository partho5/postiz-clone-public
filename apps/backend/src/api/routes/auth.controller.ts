import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ThrottlerRealIpGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { Response, Request } from 'express';

import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { OtpRequestDto } from '@gitroom/nestjs-libraries/dtos/auth/otp.request.dto';
import { ApiTags } from '@nestjs/swagger';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';
import { RealIP } from 'nestjs-real-ip';
import { UserAgent } from '@gitroom/nestjs-libraries/user/user.agent';
import { Provider } from '@prisma/client';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { FarcasterProvider } from '@gitroom/backend/services/auth/providers/farcaster.provider';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { AuthRateLimitedFilter } from '@gitroom/backend/services/auth/tokens/token.exceptions';
import { setSessionCookies } from '@gitroom/backend/services/auth/tokens/token.cookies';
import { EmailOtpService } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.service';

// The `/auth` routes: the one-time sign-in code request and OAuth sign-in, each sign-in starting a device session.
@ApiTags('Auth')
@UseFilters(AuthRateLimitedFilter)
@Controller('/auth')
export class AuthController {
  // Receives the auth service, the token service that starts sessions, and the one-time-code service.
  constructor(
    private _authService: AuthService,
    private _tokenService: TokenService,
    private _emailOtpService: EmailOtpService
  ) {}

  // Starts a device session for the user the sign-in token names and sets its cookies on the response.
  private async startSession(
    response: Response,
    jwt: string,
    ip: string,
    userAgent: string
  ) {
    const { id } = AuthChecker.verifyJWT(jwt) as { id: string };
    setSessionCookies(
      response,
      await this._tokenService.issue(id, { userAgent, ip })
    );
  }

  @Get('/can-register')
  async canRegister() {
    return {
      register: await this._authService.canRegister(Provider.LOCAL as string),
    };
  }

  // Sends a one-time sign-in code to the address; answers 204 for every address.
  @Post('/otp/request')
  @HttpCode(204)
  async requestOtp(@Body() body: OtpRequestDto, @RealIP() ip: string) {
    await this._emailOtpService.request(body.email, ip);
  }

  @Get('/oauth-mobile-callback')
  mobileCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res({ passthrough: false }) response: Response
  ) {
    const scheme = process.env.MOBILE_APP_SCHEME || 'postiz://auth/callback';
    const params = new URLSearchParams();
    if (code) params.set('code', code);
    if (state) params.set('state', state);
    return response.redirect(302, `${scheme}?${params.toString()}`);
  }

  @Get('/oauth/:provider')
  async oauthLink(
    @Param('provider') provider: string,
    @Query() query: any,
    @Res({ passthrough: true }) response: Response
  ) {
    const state = `login-${makeSecureId(16)}`;
    response.cookie('oauth_state', state, {
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'none',
          }
        : {}),
      expires: new Date(Date.now() + 1000 * 60 * 10),
    });

    return this._authService.oauthLink(provider, { ...query, state });
  }

  // Farcaster SIGN-IN only (the product's own Neynar app from .env, no workspace yet); channel
  // connect uses /integrations/farcaster/signer with the workspace's keys.
  // public and creates a signer at Neynar per call, so cap it per client
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 30, ttl: 3600000 } })
  @Post('/farcaster/signer')
  async farcasterSigner() {
    try {
      return await new FarcasterProvider().createSigner();
    } catch (err: any) {
      return { error: err.message || 'Failed to create signer' };
    }
  }

  // the modal polls every 2s for up to 10 minutes, so leave room for that
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 1000, ttl: 3600000 } })
  @Get('/farcaster/signer')
  async farcasterSignerStatus(@Query('signerUuid') signerUuid: string) {
    try {
      return await new FarcasterProvider().signerStatus(signerUuid);
    } catch (err: any) {
      return { error: err.message || 'Failed to check signer' };
    }
  }

  @Post('/oauth/:provider/redirect')
  oauthRedirect(
    @Param('provider') provider: string,
    @Body('code') code: string,
    @Body('state') state: string,
    @Res({ passthrough: false }) response: Response
  ) {
    if (!code) {
      return response.redirect(303, `${process.env.FRONTEND_URL}/auth/login`);
    }

    const params = new URLSearchParams();
    params.set('code', code);
    if (state) params.set('state', state);
    params.set('provider', provider.toUpperCase());
    return response.redirect(
      303,
      `${process.env.FRONTEND_URL}/auth?${params.toString()}`
    );
  }

  // Signs in a user whose OAuth account already exists, or the user of the address the provider vouched for (created
  // as the email sign-in creates one), and starts their session; returns the OAuth token when the provider vouches for none.
  @Post('/oauth/:provider/exists')
  async oauthExists(
    @Req() req: Request,
    @Body('code') code: string,
    @Body('redirect_uri') redirect_uri: string,
    @Body('state') state: string,
    @Param('provider') provider: string,
    @Res({ passthrough: false }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ) {
    // a cross-site form post can spoof any body field, a json body cannot
    if (!req.headers['content-type']?.includes('application/json')) {
      return response.status(400).send('Invalid request');
    }

    const { jwt, token, verified } = await this._authService.checkExists(
      provider,
      code,
      redirect_uri,
      state,
      req?.cookies?.oauth_state
    );

    // no account linked to the provider: the address it vouched for signs in as an email code would,
    // under the same failed-attempt limit (a 429 carries Retry-After); a new user goes to onboarding
    if (verified) {
      const { userId, created } = await this._emailOtpService.signInVerified(
        verified.email,
        ip,
        { name: verified.name, lastName: verified.lastName }
      );
      setSessionCookies(
        response,
        await this._tokenService.issue(userId, { userAgent, ip })
      );
      response.header(created ? 'onboarding' : 'reload', 'true');
      return response.status(200).json({ login: true });
    }

    if (token) {
      return response.json({ token });
    }

    await this.startSession(response, jwt, ip, userAgent);

    response.header('reload', 'true');

    response.status(200).json({
      login: true,
    });
  }
}
