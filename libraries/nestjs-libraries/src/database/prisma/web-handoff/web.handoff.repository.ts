// Web handoff (B2): the one-time sign-in links the app opens on the web, kept in Redis for their short life.
import { Injectable } from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

// Who a link signs in, in which workspace, the page it opens and the app device that asked for it.
export interface WebHandoffGrant {
  userId: string;
  organizationId: string;
  next: string;
  deviceName: string | null;
}

// The Redis key of a link, named by the SHA-256 of its code; the code itself is never stored.
const keyOf = (codeHash: string) => `webHandoff:${codeHash}`;

// Stores a link's grant until it expires and hands it out once.
@Injectable()
export class WebHandoffRepository {
  // Keeps the grant under the code's hash for `ttlSeconds`.
  async save(codeHash: string, grant: WebHandoffGrant, ttlSeconds: number) {
    await ioRedis.set(
      keyOf(codeHash),
      JSON.stringify(grant),
      'EX',
      ttlSeconds,
      'NX'
    );
  }

  // Reads and deletes the grant in one transaction, so two redemptions of one code never both get
  // it; null when it expired, was used or never existed.
  async take(codeHash: string): Promise<WebHandoffGrant | null> {
    const key = keyOf(codeHash);
    const results = await ioRedis.multi().get(key).del(key).exec();
    const raw = results?.[0]?.[1];
    if (typeof raw !== 'string') {
      return null;
    }
    try {
      return JSON.parse(raw) as WebHandoffGrant;
    } catch {
      return null;
    }
  }
}
