import { HttpException, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { User } from '@prisma/client';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';
import { MastraService } from '@gitroom/nestjs-libraries/chat/mastra.service';
import { setSentryUserContext } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { clearSessionCookies } from '@gitroom/backend/services/auth/tokens/token.cookies';
import {
  SessionRevokedException,
  TokenExpiredException,
} from '@gitroom/backend/services/auth/tokens/token.exceptions';

// The tab that sent the request believes it is signed in as another user
// (someone logged out and in again in another tab). The client reloads.
export class SessionChangedException extends HttpException {
  // Answers 409 SESSION_CHANGED.
  constructor() {
    super({ statusCode: 409, code: 'SESSION_CHANGED' }, 409);
  }
}

// The workspace in the tab's URL is not one of the user's workspaces. Never
// fall back to another workspace: the tab would show one brand and act on
// another.
export class WorkspaceForbiddenException extends HttpException {
  // Answers 403 WORKSPACE_FORBIDDEN.
  constructor() {
    super({ statusCode: 403, code: 'WORKSPACE_FORBIDDEN' }, 403);
  }
}

// The trimmed value of a request header, or undefined when it is missing or empty.
const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
};

// Clears the session cookies and tells the client to log out.
export const removeAuth = (res: Response) => {
  clearSessionCookies(res);
  res.header('logout', 'true');
};

// The access token the request carries: `Authorization: Bearer <token>`, else the `auth` header or cookie.
const accessTokenOf = (req: Request) => {
  const authorization = header(req, 'authorization');
  if (authorization && /^bearer\s+\S+$/i.test(authorization)) {
    return authorization.split(/\s+/)[1];
  }
  return (req.headers.auth as string | undefined) || req.cookies.auth;
};

// Authenticates every request of the controllers it is applied to.
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  // Receives the services that resolve the user and workspace, and the token service that checks access tokens.
  constructor(
    private _organizationService: OrganizationService,
    private _userService: UsersService,
    private _tokenService: TokenService
  ) {}
  // Authenticates a request from its access token and sets the user, workspace and session on it.
  async use(req: Request, res: Response, next: NextFunction) {
    const auth = accessTokenOf(req);
    if (!auth) {
      throw new HttpForbiddenException();
    }
    try {
      // Verify the token's signature, expiry and live session only. Never trust
      // authorization-relevant claims (isSuperAdmin, activated) — always
      // re-resolve the user from the database using the id. x-postiz-org is
      // not read: a token acts only in the workspace resolved below.
      const { userId, sessionId } = await this._tokenService.verifyAccess(auth);
      const workspaceHeader = header(req, 'x-workspace-id');
      const sessionUser = header(req, 'x-session-user');
      const orgHeader =
        workspaceHeader || req.cookies.showorg || req.headers.showorg;

      let user = (await this._userService.getUserById(userId)) as User | null;

      if (!user) {
        throw new HttpForbiddenException();
      }

      if (!user.activated) {
        throw new HttpForbiddenException();
      }

      // The session and the user that signed in, which differ from req.user
      // while a super admin impersonates.
      Object.assign(req, { sessionId, sessionUserId: userId });

      const impersonate = req.cookies.impersonate || req.headers.impersonate;
      if (user?.isSuperAdmin && impersonate) {
        const loadImpersonate = await this._organizationService.getUserOrg(
          impersonate
        );

        if (loadImpersonate) {
          user = loadImpersonate.user;
          user.isSuperAdmin = true;
          delete user.password;

          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          req.user = user;

          if (sessionUser && sessionUser !== user.id) {
            throw new SessionChangedException();
          }

          // @ts-ignore
          loadImpersonate.organization.users =
            loadImpersonate.organization.users.filter(
              (f) => f.userId === user.id
            );
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          req.org = loadImpersonate.organization;

          setSentryUserContext({
            userId: user.id,
            email: user.email,
            orgId: loadImpersonate.organization.id,
          });
          next();
          return;
        }
      }

      if (sessionUser && sessionUser !== user.id) {
        throw new SessionChangedException();
      }

      delete user.password;
      const organization = (
        await this._organizationService.getOrgsByUserId(user.id)
      ).filter((f) => !f.users[0].disabled);
      const workspace = organization.find((org) => org.id === orgHeader);
      if (workspaceHeader && !workspace) {
        throw new WorkspaceForbiddenException();
      }
      const setOrg = workspace || organization[0];

      if (!organization) {
        throw new HttpForbiddenException();
      }

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      req.user = user;

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      req.org = setOrg;

      setSentryUserContext({
        userId: user.id,
        email: user.email,
        orgId: setOrg.id,
      });
    } catch (err) {
      if (err instanceof SessionRevokedException) {
        removeAuth(res);
        throw err;
      }
      if (
        err instanceof SessionChangedException ||
        err instanceof WorkspaceForbiddenException ||
        err instanceof TokenExpiredException
      ) {
        throw err;
      }
      throw new HttpForbiddenException();
    }
    next();
  }
}
