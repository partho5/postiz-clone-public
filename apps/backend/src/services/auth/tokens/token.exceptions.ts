// Token auth: the errors the token endpoints and the authentication middleware answer with.
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';

// Bad credentials, or an unknown, expired or reused refresh token, or a bad Google token.
export class InvalidGrantException extends HttpException {
  // Answers 401 INVALID_GRANT.
  constructor() {
    super({ statusCode: 401, code: 'INVALID_GRANT' }, 401);
  }
}

// The access token is not one of ours: a bad signature, no session id (upstream's one-year token), or a
// session that is not the user's. Kept apart from HttpForbiddenException, whose module imports the
// authentication middleware that imports the token service.
export class InvalidAccessTokenException extends HttpException {
  // Answers 403 Forbidden.
  constructor() {
    super('Forbidden', 403);
  }
}

// A route open to signed-out callers (api.entitlements) was given an `Authorization` that is no valid access
// token: not `Bearer <token>`, a bad signature, or a session or user that is gone. Unlike
// InvalidAccessTokenException it is a 401, so the app refreshes its token instead of treating itself as signed out.
export class InvalidBearerTokenException extends HttpException {
  // Answers 401 INVALID_BEARER_TOKEN.
  constructor() {
    super({ statusCode: 401, code: 'INVALID_BEARER_TOKEN' }, 401);
  }
}

// The access token is past its expiry; the client refreshes and retries.
export class TokenExpiredException extends HttpException {
  // Answers 401 TOKEN_EXPIRED.
  constructor() {
    super({ statusCode: 401, code: 'TOKEN_EXPIRED' }, 401);
  }
}

// The access token belongs to a session that was revoked.
export class SessionRevokedException extends HttpException {
  // Answers 401 SESSION_REVOKED.
  constructor() {
    super({ statusCode: 401, code: 'SESSION_REVOKED' }, 401);
  }
}

// The client address has failed too many attempts of one kind; carries the seconds until it may try again.
export class AuthRateLimitedException extends HttpException {
  // Keeps the seconds to wait and answers 429 AUTH_RATE_LIMITED.
  constructor(public readonly retryAfterSeconds: number) {
    super({ statusCode: 429, code: 'AUTH_RATE_LIMITED' }, 429);
  }
}

// Answers a rate-limited attempt with 429 and a Retry-After header.
@Catch(AuthRateLimitedException)
export class AuthRateLimitedFilter implements ExceptionFilter {
  // Sets Retry-After and answers 429 with the exception's body.
  catch(exception: AuthRateLimitedException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    return response.status(429).json(exception.getResponse());
  }
}
