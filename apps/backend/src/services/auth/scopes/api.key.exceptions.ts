// Scoped API keys: the errors a public API request authenticated by a key can be refused with.
import { HttpException } from '@nestjs/common';
import { ApiScope } from '@gitroom/nestjs-libraries/dtos/api-keys/api.scopes';

// The key lacks the scope the route needs (a route's one scope, or the scopes MCP needs that it lacks).
export class ScopeForbiddenException extends HttpException {
  // Answers 403 SCOPE_FORBIDDEN naming what was required; a route that names no scope names none.
  constructor(required?: ApiScope | ApiScope[]) {
    super({ statusCode: 403, code: 'SCOPE_FORBIDDEN', required }, 403);
  }
}

// The key is unknown, malformed or revoked, or its workspace is gone; all four answer alike.
export class InvalidApiKeyException extends HttpException {
  // Answers 401 `{ msg: 'Invalid API key' }`, the body of a wrong key since before scoped keys.
  constructor() {
    super({ msg: 'Invalid API key' }, 401);
  }
}
