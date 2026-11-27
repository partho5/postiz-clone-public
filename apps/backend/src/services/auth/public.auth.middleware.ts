// Public API authentication: scoped API keys, OAuth-app tokens and device access tokens.
import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { Organization } from '@prisma/client';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';
import { ApiKeysService } from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.service';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';
import { setSentryUserContext } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
import { WorkspaceForbiddenException } from '@gitroom/backend/services/auth/auth.middleware';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import {
  AuthAttemptLimiter,
  underAttemptLock,
} from '@gitroom/backend/services/auth/tokens/auth.attempt.limiter';
import { InvalidApiKeyException } from '@gitroom/backend/services/auth/scopes/api.key.exceptions';
import {
  AuthRateLimitedException,
  InvalidAccessTokenException,
  SessionRevokedException,
  TokenExpiredException,
} from '@gitroom/backend/services/auth/tokens/token.exceptions';

// The value of an `Authorization: Bearer <value>` header; undefined for any other shape of the
// header, so a bare API key, an `nsk_` key and a `pos_` token are never taken for a device token.
const bearerOf = (authorization: string) =>
  /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1];

// The address a request came from, read the way the public API's throttler reads it: the first
// `x-forwarded-for` entry the proxy sets, else the socket address.
const clientIpOf = (req: Request) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.ip || 'unknown';
};

// The trimmed value of a request header, or undefined when it is missing or empty.
const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
};

// Authenticates every `/public/v1` request: a scoped API key, an OAuth-app token, or a device's Bearer access token.
@Injectable()
export class PublicAuthMiddleware implements NestMiddleware {
  // Receives the services that resolve the key, token, user and workspace, and the failed-attempt limiter.
  constructor(
    private _organizationService: OrganizationService,
    private _oauthService: OAuthService,
    private _userService: UsersService,
    private _tokenService: TokenService,
    private _attemptLimiter: AuthAttemptLimiter,
    private _apiKeysService: ApiKeysService
  ) {}

  // Makes the key's workspace the request's, acting as a super admin.
  private setOrg(req: Request, org: Organization) {
    // @ts-ignore
    req.org = { ...org, users: [{ users: { role: 'SUPERADMIN' } }] };
  }

  // Checks a device access token and loads its user, counting a failed attempt for the address when
  // the token is not one of ours; an address over the limit is refused before the token is checked.
  private async deviceUser(token: string, ip: string) {
    return underAttemptLock(ip, 'api_key', async () => {
      await this._attemptLimiter.assertAllowed(ip, 'api_key');
      try {
        const { userId, sessionId } = await this._tokenService.verifyAccess(
          token
        );
        const user = await this._userService.getUserById(userId);
        if (!user || !user.activated) {
          throw new InvalidAccessTokenException();
        }
        return { user, sessionId };
      } catch (err) {
        if (err instanceof InvalidAccessTokenException) {
          await this._attemptLimiter.recordFailure(ip, 'api_key');
        }
        throw err;
      }
    });
  }

  // Answers a device token's or key's failure with the status and body the contract names for it;
  // rethrows anything that is not an authentication outcome.
  private refuse(res: Response, err: unknown) {
    if (err instanceof AuthRateLimitedException) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
      res.status(HttpStatus.TOO_MANY_REQUESTS).json(err.getResponse());
      return;
    }
    if (
      err instanceof TokenExpiredException ||
      err instanceof SessionRevokedException
    ) {
      res.status(HttpStatus.UNAUTHORIZED).json(err.getResponse());
      return;
    }
    if (
      err instanceof InvalidAccessTokenException ||
      err instanceof InvalidApiKeyException
    ) {
      res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'Invalid API key' });
      return;
    }
    throw err;
  }

  // Authenticates a request that carries a device's access token: the request acts as the token's
  // user, with that user's own role, in the workspace `x-workspace-id` names (else the user's
  // default), and only when the user is a member of it.
  private async useDeviceToken(
    token: string,
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const authenticated = await this.deviceUser(token, clientIpOf(req)).catch(
      (err) => this.refuse(res, err)
    );
    if (!authenticated) {
      return;
    }
    const { user, sessionId } = authenticated;

    if (header(req, 'x-postiz-org')) {
      res.status(HttpStatus.FORBIDDEN).json({ msg: 'Unauthorized' });
      return;
    }

    const workspaceHeader = header(req, 'x-workspace-id');
    const workspaces = (
      await this._organizationService.getOrgsByUserId(user.id)
    ).filter((f) => !f.users[0].disabled);
    const workspace = workspaceHeader
      ? workspaces.find((org) => org.id === workspaceHeader)
      : workspaces[0];
    if (!workspace) {
      res
        .status(HttpStatus.FORBIDDEN)
        .json(new WorkspaceForbiddenException().getResponse());
      return;
    }

    delete user.password;
    Object.assign(req, {
      user,
      org: workspace,
      sessionId,
      isOAuthApp: false,
      authOrgId: workspace.id,
      includeDeleted: header(req, 'x-postiz-include-deleted') === 'true',
    });
    setSentryUserContext({
      userId: user.id,
      email: user.email,
      orgId: workspace.id,
    });
    next();
  }

  // Looks a scoped API key up, counting a failed attempt for the address when the key is unknown, malformed
  // or revoked; an address over the limit is refused before the key is looked up.
  private async keyOf(key: string, ip: string) {
    return underAttemptLock(ip, 'api_key', async () => {
      await this._attemptLimiter.assertAllowed(ip, 'api_key');
      const authenticated = await this._apiKeysService.authenticate(key);
      if (!authenticated) {
        await this._attemptLimiter.recordFailure(ip, 'api_key');
        throw new InvalidApiKeyException();
      }
      return authenticated;
    });
  }

  // Authenticates a request that carries a scoped API key: the request acts in the key's workspace
  // and only for the key's scopes; no header names another workspace.
  private async useApiKey(
    auth: string,
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const authenticated = await this.keyOf(auth, clientIpOf(req)).catch((err) =>
      this.refuse(res, err)
    );
    if (!authenticated) {
      return;
    }

    const workspaceHeader = header(req, 'x-workspace-id');
    if (
      header(req, 'x-postiz-org') ||
      (workspaceHeader && workspaceHeader !== authenticated.organizationId)
    ) {
      res
        .status(HttpStatus.FORBIDDEN)
        .json(new WorkspaceForbiddenException().getResponse());
      return;
    }

    const org = await this._organizationService.getOrgByIdWithSubscription(
      authenticated.organizationId
    );
    if (!org || org.deletedAt) {
      res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'Invalid API key' });
      return;
    }

    this.setOrg(req, org);
    Object.assign(req, {
      isOAuthApp: false,
      authOrgId: org.id,
      apiKeyId: authenticated.keyId,
      apiKeyScopes: authenticated.scopes,
      includeDeleted: header(req, 'x-postiz-include-deleted') === 'true',
    });
    setSentryUserContext({ orgId: org.id });
    next();
  }

  // Authenticates a request that carries an OAuth-app token (`pos_…`), which acts in its app's
  // workspace and never names another.
  private async useOAuthToken(
    auth: string,
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    try {
      const authorization = await this._oauthService.getOrgByOAuthToken(auth);
      if (!authorization) {
        res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'Invalid OAuth token' });
        return;
      }

      const org = authorization.organization;
      this.setOrg(req, org);
      Object.assign(req, {
        isOAuthApp: true,
        authOrgId: org.id,
        includeDeleted: header(req, 'x-postiz-include-deleted') === 'true',
      });

      if (header(req, 'x-postiz-org')) {
        res.status(HttpStatus.FORBIDDEN).json({ msg: 'Unauthorized' });
        return;
      }
    } catch (err) {
      throw new HttpForbiddenException();
    }

    setSentryUserContext({
      // @ts-ignore
      orgId: req.org.id,
    });
    next();
  }

  // Authenticates a public API request from its `Authorization` header and sets the workspace it acts in.
  async use(req: Request, res: Response, next: NextFunction) {
    const auth = (req.headers.authorization ||
      req.headers.Authorization) as string;
    if (!auth) {
      res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'No API Key found' });
      return;
    }
    const deviceToken = bearerOf(auth);
    if (deviceToken) {
      await this.useDeviceToken(deviceToken, req, res, next);
      return;
    }
    if (auth.startsWith('pos_')) {
      await this.useOAuthToken(auth, req, res, next);
      return;
    }
    await this.useApiKey(auth, req, res, next);
  }
}
