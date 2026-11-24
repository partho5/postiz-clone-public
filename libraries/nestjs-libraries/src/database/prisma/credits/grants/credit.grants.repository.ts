// Grant lifecycle: finding an account's grant by its key, and
// taking a grant back into a never-expiring REVERSAL bucket when its payment is reversed.
import { Injectable } from '@nestjs/common';
import { CreditBucket, Prisma } from '@prisma/client';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { IdempotencyConflictError } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';

// No grant under this key in the account.
export class UnknownGrantError extends Error {
  constructor(grantKey: string) {
    super(`No grant ${grantKey}`);
  }
}

// The grant has nothing that could be revoked.
export class InvalidGrantError extends Error {}

// More revoked than the grant ever held.
export class OverRevokeError extends Error {}

export interface RevokeGrant {
  accountId: string;
  grantKey: string;
  reversalKey: string;
  amount?: number;
}

export interface RevokeResult {
  removed: number;
  debt: number;
  created: boolean;
}

@Injectable()
export class CreditGrantsRepository {
  constructor(private readonly _scope: MoneyScope) {}

  // The bucket under grantKey in accountId, or null. Another account's key is
  // never found, on every role.
  getGrant(accountId: string, grantKey: string) {
    return this._scope.run(accountId, (tx) =>
      tx.creditBucket.findUnique({ where: { grantKey, accountId } })
    );
  }

  // Takes amount (default: the whole grant) back from the grant under grantKey,
  // under the account row lock: what is left in the grant first, the rest as
  // debt in one REVERSAL bucket keyed reversalKey. A replay of reversalKey
  // returns the first result.
  revoke(params: RevokeGrant) {
    return this._scope.run(
      params.accountId,
      async (tx): Promise<RevokeResult> => {
        const reversal = await tx.creditBucket.findUnique({
          where: { grantKey: params.reversalKey },
        });
        if (reversal) {
          if (
            reversal.accountId !== params.accountId ||
            reversal.type !== 'REVERSAL'
          ) {
            throw new IdempotencyConflictError(params.reversalKey);
          }
          // 0 - x, not -x: a revoke without debt answers 0, never -0
          const debt = 0 - reversal.remaining;
          return { removed: -reversal.initial - debt, debt, created: false };
        }

        const grant = await tx.creditBucket.findUnique({
          where: { grantKey: params.grantKey, accountId: params.accountId },
        });
        const amount = params.amount ?? grant?.initial ?? 0;
        // Whatever the grant still holds goes first, expired or not: an
        // expired remainder was never spent, so only what was used becomes debt.
        const removed = grant
          ? Math.min(amount, Math.max(grant.remaining, 0))
          : 0;
        const debt = amount - removed;

        // The key is claimed before the grant is checked, so a key another
        // account holds is a conflict whatever the grant or amount. An unknown
        // grant or a bad amount throws below and rolls the claim back with the
        // transaction.
        let bucket: CreditBucket;
        try {
          bucket = await tx.creditBucket.create({
            data: {
              accountId: params.accountId,
              type: 'REVERSAL',
              initial: -amount,
              remaining: -debt,
              expiresAt: null,
              grantKey: params.reversalKey,
            },
          });
        } catch (err) {
          // A reversal key held by another account is invisible here and fails as a duplicate
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            throw new IdempotencyConflictError(params.reversalKey);
          }
          throw err;
        }

        if (!grant) {
          throw new UnknownGrantError(params.grantKey);
        }
        if (amount <= 0) {
          throw new InvalidGrantError(
            `Grant ${params.grantKey} has nothing to revoke`
          );
        }
        if (amount > grant.initial) {
          throw new OverRevokeError(
            `Cannot revoke ${amount} of a ${grant.initial} grant`
          );
        }

        if (removed > 0) {
          await tx.creditBucket.update({
            where: { id: grant.id },
            data: { remaining: { decrement: removed } },
          });
          await tx.creditEntry.create({
            data: {
              accountId: params.accountId,
              bucketId: grant.id,
              kind: 'ADJUST',
              delta: -removed,
            },
          });
        }
        if (debt > 0) {
          await tx.creditEntry.create({
            data: {
              accountId: params.accountId,
              bucketId: bucket.id,
              kind: 'ADJUST',
              delta: -debt,
            },
          });
        }

        return { removed, debt, created: true };
      },
      { lock: true }
    );
  }
}
