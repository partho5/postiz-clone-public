// Idempotency-Key: on every authenticated mutation, a retry with the same key gets the first answer.
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { createHash } from 'crypto';
import {
  IdempotencyService,
  MAX_REPLAY_BYTES,
} from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.service';
import { IdempotencyScope } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.repository';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// What the authentication middlewares and Nest's body parser attach to the request.
type AuthedRequest = Request & {
  user?: { id?: string };
  org?: { id?: string };
  rawBody?: Buffer;
};

// The SHA-256 of a string or buffer, as lowercase hex.
const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

// Who sent the request: the session's user, or for a public API call a hash of the credential
// (never the credential itself); undefined when nobody was authenticated.
const principalOf = (req: AuthedRequest): string | undefined => {
  const user = req.user;
  if (user?.id) {
    return `user:${user.id}`;
  }
  const credential = req.headers.authorization;
  return credential ? `key:${sha256(credential)}` : undefined;
};

// The principal and the workspace the request acts on; undefined when there is no authenticated
// principal and workspace, so the route is not covered.
const ownerOf = (req: AuthedRequest) => {
  const workspaceId = req.org?.id;
  const principal = principalOf(req);
  return workspaceId && principal ? { principal, workspaceId } : undefined;
};

// What the request body hashes to: the raw bytes where Nest kept them, the parsed body
// re-serialised where an earlier parser took it, and the content headers where the body is a
// stream no one has read yet (a file upload), so the middleware never buffers an upload.
const bodyHash = (req: AuthedRequest) => {
  const hasBody =
    req.headers['transfer-encoding'] !== undefined ||
    Number(req.headers['content-length'] ?? 0) > 0;
  if (!hasBody) {
    return sha256('');
  }
  if (req.is(['json', 'urlencoded', 'text/*'])) {
    const raw = req.rawBody;
    return sha256(raw ?? JSON.stringify(req.body ?? null));
  }
  return sha256(
    `${req.headers['content-type'] ?? ''}|${
      req.headers['content-length'] ?? ''
    }`
  );
};

// method + path (with its query) + body hash: two requests are the same request when this matches.
const fingerprintOf = (req: AuthedRequest) =>
  sha256(`${req.method} ${req.originalUrl} ${bodyHash(req)}`);

// The bytes a handler passed to `end`/`write`, whatever form it gave them.
const toBuffer = (chunk: unknown, encoding?: unknown) =>
  Buffer.isBuffer(chunk)
    ? chunk
    : typeof chunk === 'string'
    ? Buffer.from(
        chunk,
        typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
      )
    : chunk instanceof Uint8Array
    ? Buffer.from(chunk)
    : Buffer.alloc(0);

@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  private readonly _logger = new Logger(IdempotencyMiddleware.name);

  constructor(private _idempotencyService: IdempotencyService) {}

  // Replays the stored answer for a finished key, refuses a key that is running or reused, and
  // otherwise lets the handler run while its answer is captured and stored.
  async use(req: AuthedRequest, res: Response, next: NextFunction) {
    if (!MUTATIONS.has(req.method)) {
      return next();
    }
    const owner = ownerOf(req);
    if (!owner) {
      return next();
    }
    const key = this._idempotencyService.parseKey(
      req.headers['idempotency-key']
    );
    if (key === undefined) {
      return next();
    }
    const scope = { ...owner, key };
    const fingerprint = fingerprintOf(req);
    const begin = await this._idempotencyService.begin(scope, fingerprint);
    if (begin.kind === 'replay') {
      this.replay(res, begin.answer);
      return;
    }
    this.capture(res, scope, fingerprint);
    next();
  }

  // Sends a stored answer again, marked as a replay, without running the handler.
  private replay(
    res: Response,
    answer: { statusCode: number; body: Buffer; contentType: string | null }
  ) {
    res.status(answer.statusCode);
    res.setHeader('Idempotent-Replayed', 'true');
    if (answer.contentType) {
      res.setHeader('Content-Type', answer.contentType);
    }
    res.end(answer.body);
  }

  // Wraps the response so its final status and body are stored before the client receives the end
  // of it; a response written in pieces, or too long to keep, is stored as not replayable.
  private capture(res: Response, scope: IdempotencyScope, fingerprint: string) {
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let streamed = false;

    res.write = ((chunk: any, ...args: any[]) => {
      streamed = true;
      return originalWrite(chunk, ...args);
    }) as typeof res.write;

    res.end = ((chunk?: any, ...args: any[]) => {
      res.write = originalWrite as typeof res.write;
      res.end = originalEnd as typeof res.end;
      const body = streamed ? null : toBuffer(chunk, args[0]);
      const keep = body && body.length <= MAX_REPLAY_BYTES ? body : null;
      const contentType = res.getHeader('content-type');
      this._idempotencyService
        .finish(scope, fingerprint, {
          statusCode: res.statusCode,
          body: keep,
          contentType: contentType ? String(contentType) : null,
        })
        .catch((err) =>
          this._logger.error(`idempotency: answer not stored: ${err}`)
        )
        .finally(() => originalEnd(chunk, ...args));
      return res;
    }) as typeof res.end;
  }
}
