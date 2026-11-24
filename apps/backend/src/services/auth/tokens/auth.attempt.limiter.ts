// Token auth: failed sign-ins, refreshes and API-key attempts counted per client
// address and kind in Redis, so every backend instance shares the counts.
import { Injectable } from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { tokenConfig } from '@gitroom/backend/services/auth/tokens/token.config';
import { AuthRateLimitedException } from '@gitroom/backend/services/auth/tokens/token.exceptions';

export type AttemptKind = 'sign_in' | 'refresh' | 'api_key';

// The Redis key counting the failures of one kind from one address.
const keyOf = (clientIp: string, kind: AttemptKind) =>
  `auth:fail:${kind}:${clientIp}`;

// Where each address and kind's most recent queued attempt ends in this process.
const attemptTails = new Map<string, Promise<unknown>>();

// Runs one check-then-count attempt after every earlier one from the same address and kind in this
// process has finished, so a burst of parallel attempts cannot all pass `assertAllowed` before the
// first failure is counted.
export const underAttemptLock = async <T>(
  clientIp: string,
  kind: AttemptKind,
  attempt: () => Promise<T>
): Promise<T> => {
  const key = keyOf(clientIp, kind);
  const run = (attemptTails.get(key) ?? Promise.resolve()).then(attempt);
  // the next attempt waits for this one to end, however it ends; its failure goes to the caller below
  const tail = run.catch(() => undefined);
  attemptTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (attemptTails.get(key) === tail) {
      attemptTails.delete(key);
    }
  }
};

// Counts failed attempts per client address and kind, shared across backend instances through Redis.
@Injectable()
export class AuthAttemptLimiter {
  // Refuses to start without REDIS_URL, since the counts live in Redis.
  constructor() {
    if (!process.env.REDIS_URL) {
      throw new Error(
        'AuthAttemptLimiter needs REDIS_URL: failed attempts are counted in Redis so every backend instance shares them'
      );
    }
  }

  // Throws AUTH_RATE_LIMITED while the address is over the limit, before anything is checked.
  async assertAllowed(clientIp: string, kind: AttemptKind): Promise<void> {
    const key = keyOf(clientIp, kind);
    const count = Number(await ioRedis.get(key));
    if (count >= tokenConfig().failLimit) {
      const ttl = await ioRedis.ttl(key);
      throw new AuthRateLimitedException(
        ttl > 0 ? ttl : tokenConfig().failWindowSeconds
      );
    }
  }

  // Counts one failed attempt; the failure that reaches the limit locks the address for a full window.
  async recordFailure(clientIp: string, kind: AttemptKind): Promise<void> {
    const key = keyOf(clientIp, kind);
    const { failLimit, failWindowSeconds } = tokenConfig();
    const results = await ioRedis
      .multi()
      .incr(key)
      .expire(key, failWindowSeconds, 'NX')
      .exec();
    const count = Number(results?.[0]?.[1]);
    if (count === failLimit) {
      await ioRedis.expire(key, failWindowSeconds);
    }
  }
}
