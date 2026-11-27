// Idempotency-Key: the rules that make a mutation sent twice with one key have the effect of one.
import { HttpException, Injectable } from '@nestjs/common';
import {
  IdempotencyRepository,
  IdempotencyScope,
  StoredAnswer,
} from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.repository';

// How long a finished answer is kept.
export const ANSWER_TTL_MS = 24 * 60 * 60 * 1000;
// How long a running handler holds its key; a handler that never finished (a crash) frees it after this.
export const RUNNING_LEASE_MS = 15 * 60 * 1000;
// The longest answer kept for replay; a longer one is treated like a streamed answer.
export const MAX_REPLAY_BYTES = 1024 * 1024;

const VISIBLE_ASCII = /^[\x21-\x7e]{1,255}$/;

export type IdempotencyBegin =
  | { kind: 'run' }
  | { kind: 'replay'; answer: StoredAnswer & { body: Buffer } };

// Client-actionable refusals: { statusCode, code, message }, clients branch on `code`.
export class IdempotencyKeyInvalidException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 400,
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 1 to 255 visible ASCII characters.',
      },
      400
    );
  }
}

export class IdempotencyInProgressException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 409,
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is still running.',
      },
      409
    );
  }
}

export class IdempotencyKeyUsedException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_USED',
        message:
          'The answer to this Idempotency-Key was streamed and cannot be replayed.',
      },
      409
    );
  }
}

export class IdempotencyKeyReusedException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 422,
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was used for a different request.',
      },
      422
    );
  }
}

@Injectable()
export class IdempotencyService {
  constructor(private _idempotencyRepository: IdempotencyRepository) {}

  // The key a request sent, or undefined when it sent none; throws 400 IDEMPOTENCY_KEY_INVALID for a bad one.
  parseKey(header: string | string[] | undefined): string | undefined {
    if (header === undefined) {
      return undefined;
    }
    const key = Array.isArray(header) ? header.join(', ') : header;
    if (!VISIBLE_ASCII.test(key)) {
      throw new IdempotencyKeyInvalidException();
    }
    return key;
  }

  // Claims the key for this request, or answers what an earlier request with it left: run the
  // handler, replay the stored answer, or refuse (409 in progress / used, 422 reused).
  async begin(
    scope: IdempotencyScope,
    fingerprint: string
  ): Promise<IdempotencyBegin> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = new Date();
      if (
        await this._idempotencyRepository.claim(
          scope,
          fingerprint,
          new Date(now.getTime() + RUNNING_LEASE_MS)
        )
      ) {
        return { kind: 'run' };
      }

      const record = await this._idempotencyRepository.find(scope);
      if (!record) {
        continue;
      }
      if (record.expiresAt <= now) {
        await this._idempotencyRepository.deleteIfExpired(scope, now);
        continue;
      }
      if (record.fingerprint !== fingerprint) {
        throw new IdempotencyKeyReusedException();
      }
      if (record.state === 'RUNNING') {
        throw new IdempotencyInProgressException();
      }
      if (!record.responseBody) {
        throw new IdempotencyKeyUsedException();
      }
      const headers = record.responseHeaders as Record<string, string> | null;
      return {
        kind: 'replay',
        answer: {
          statusCode: record.statusCode!,
          body: Buffer.from(record.responseBody),
          contentType: headers?.['content-type'] ?? null,
        },
      };
    }
    throw new IdempotencyInProgressException();
  }

  // Keeps the handler's final answer for 24 hours, or frees the key when it answered 5xx.
  async finish(
    scope: IdempotencyScope,
    fingerprint: string,
    answer: StoredAnswer
  ) {
    if (answer.statusCode >= 500) {
      await this._idempotencyRepository.release(scope, fingerprint);
      return;
    }
    await this._idempotencyRepository.complete(
      scope,
      fingerprint,
      answer,
      new Date(Date.now() + ANSWER_TTL_MS)
    );
  }

  // Deletes every record past its expiry; how many went.
  async deleteExpired(): Promise<{ deleted: number }> {
    return {
      deleted: await this._idempotencyRepository.deleteExpired(new Date()),
    };
  }
}
