// Scoped API keys: the decorator that names the scope a public API route needs.
import { SetMetadata } from '@nestjs/common';
import { ApiScope } from '@gitroom/nestjs-libraries/dtos/api-keys/api.scopes';

export const REQUIRE_SCOPE_KEY = 'require_scope';

// Names the scope a public API route needs.
export const RequireScope = (scope: ApiScope) =>
  SetMetadata(REQUIRE_SCOPE_KEY, scope);
