// Paid features (api.entitlements): where the app asks for its signed plan token.
import { Controller, Get, Header, Headers, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ThrottlerRealIpGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { EntitlementsService } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.service';
import { WorkspaceForbiddenException } from '@gitroom/backend/services/auth/auth.middleware';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import {
  InvalidAccessTokenException,
  InvalidBearerTokenException,
} from '@gitroom/backend/services/auth/tokens/token.exceptions';

// `GET /entitlements`. Not behind the authentication middleware: a phone that has not signed in asks too,
// so the device access token is read here. Only a missing `Authorization` is anonymous.
@ApiTags('Entitlements')
@Controller('/entitlements')
export class EntitlementsController {
  // Receives the token service that checks the optional Bearer token, the services that load its user and
  // workspaces, and the service that signs the plan.
  constructor(
    private _tokenService: TokenService,
    private _userService: UsersService,
    private _organizationService: OrganizationService,
    private _entitlementsService: EntitlementsService
  ) {}

  // The signed plan token and the plan catalogue. No `Authorization` gets FREE; a Bearer token that is bad,
  // expired or revoked is a 401, so the app refreshes its token rather than store FREE for a paying user.
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 120, ttl: 3600000 } })
  @Header('Cache-Control', 'no-store')
  @Get('/')
  async getEntitlements(
    @Headers('authorization') authorization?: string,
    @Headers('x-workspace-id') workspaceId?: string
  ) {
    const token = this.bearerOf(authorization);
    if (!token) {
      return this._entitlementsService.issue(null);
    }
    const { userId, sessionId } = await this.verify(token);
    return this._entitlementsService.issue({
      userId,
      sessionId,
      organizationId: await this.workspaceOf(userId, workspaceId),
    });
  }

  // The access token in the header; undefined when there is no `Authorization`. Any other value that is not
  // `Bearer <token>` is refused: an API key or a typo must not turn into a FREE token.
  private bearerOf(authorization?: string) {
    const value = authorization?.trim();
    if (!value) {
      return undefined;
    }
    const token = /^Bearer\s+(\S+)$/i.exec(value)?.[1];
    if (!token) {
      throw new InvalidBearerTokenException();
    }
    return token;
  }

  // The user and device session of a valid access token. An expired token or a revoked session keeps its own
  // 401; any other bad token, a user who is gone and a token with no session id are a 401 too.
  private async verify(token: string) {
    let verified: { userId: string; sessionId: string };
    try {
      verified = await this._tokenService.verifyAccess(token);
    } catch (err) {
      throw err instanceof InvalidAccessTokenException
        ? new InvalidBearerTokenException()
        : err;
    }
    const user = await this._userService.getUserById(verified.userId);
    if (!user || !user.activated || !verified.sessionId) {
      throw new InvalidBearerTokenException();
    }
    return verified;
  }

  // The workspace the token is for: the one `x-workspace-id` names, else the user's first one, as every
  // device-token route resolves it. A workspace the user is not an active member of is a 403; a user with no
  // workspace at all gets none.
  private async workspaceOf(userId: string, requested?: string) {
    const id = requested?.trim();
    const workspaces = (
      await this._organizationService.getOrgsByUserId(userId)
    ).filter((f) => !f.users[0].disabled);
    const workspace = id
      ? workspaces.find((org) => org.id === id)
      : workspaces[0];
    if (id && !workspace) {
      throw new WorkspaceForbiddenException();
    }
    return workspace?.id ?? null;
  }
}
