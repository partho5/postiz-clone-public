// Scoped API keys: the guard that refuses a key that does not hold the scope a route needs.
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ApiScope } from '@gitroom/nestjs-libraries/dtos/api-keys/api.scopes';
import { REQUIRE_SCOPE_KEY } from '@gitroom/backend/services/auth/scopes/require.scope';
import { ScopeForbiddenException } from '@gitroom/backend/services/auth/scopes/api.key.exceptions';

// Refuses a request authenticated by a scoped key when the route's scope is not among the key's.
// Other principals (a device token, an OAuth-app token) carry no key scopes and pass.
@Injectable()
export class ScopeGuard implements CanActivate {
  // Receives the reflector that reads the route's scope.
  constructor(private _reflector: Reflector) {}

  // Lets the request through, or throws SCOPE_FORBIDDEN for a key without the route's scope; a route
  // that names no scope is refused to a key, so a new route is never open by default.
  canActivate(context: ExecutionContext): boolean {
    const { apiKeyScopes } = context.switchToHttp().getRequest<
      Request & { apiKeyScopes?: ApiScope[] }
    >();
    if (!apiKeyScopes) {
      return true;
    }
    const required = this._reflector.get<ApiScope | undefined>(
      REQUIRE_SCOPE_KEY,
      context.getHandler()
    );
    if (!required || !apiKeyScopes.includes(required)) {
      throw new ScopeForbiddenException(required);
    }
    return true;
  }
}
