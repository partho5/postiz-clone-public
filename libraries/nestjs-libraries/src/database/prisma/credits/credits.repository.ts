import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  MoneyScope,
  MoneyScopeRequiredError,
} from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import {
  CreditBucket,
  CreditBucketType,
  CreditLedger,
  Prisma,
} from '@prisma/client';
import dayjs from 'dayjs';

// Credits returned to a bucket that expired in the meantime go to a new
// refund bucket that lives this long.
export const REFUND_BUCKET_DAYS = 30;

export class InsufficientCreditsError extends Error {
  constructor(public required: number, public available: number) {
    super(`Not enough credits: ${required} required, ${available} available`);
  }
}

export class CreditLedgerStateError extends Error {}

// A capped reservation would take the account past its cap for the period.
export class CapReachedError extends Error {
  constructor(public limit: number, public used: number) {
    super(`Cap of ${limit} credits reached: ${used} already used`);
  }
}

export class IdempotencyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was used for a different action`);
  }
}

// Limit on the credits reserved or committed on actions under a key prefix since a date.
export interface ReserveCap {
  limit: number;
  actionKeyPrefix: string;
  since: Date;
}

export interface ReserveCredits {
  accountId: string;
  organizationId?: string;
  userId?: string;
  actionKey: string;
  actionVersion: number;
  quantity: number;
  unitCost: number;
  idempotencyKey: string;
  metadata?: Prisma.InputJsonValue;
  // A key whose ledger is RELEASED is reserved again instead of returned as is
  reopenReleased?: boolean;
  // Refuses the reservation, under the account lock, when it would pass the cap
  cap?: ReserveCap;
}

export interface GrantCredits {
  accountId: string;
  type: CreditBucketType;
  amount: number;
  expiresAt?: Date | null;
  grantKey?: string;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class CreditsRepository {
  constructor(
    private readonly _scope: MoneyScope,
    private readonly _creditLedger: PrismaRepository<'creditLedger' | 'role'>,
    private readonly _creditAction: PrismaRepository<'creditAction'>,
    private readonly _account: PrismaRepository<'account'>
  ) {}

  // Every balance change of an account runs here, under the account row lock:
  // a second change of the same account waits until this one commits and then
  // reads the buckets as they are after it.
  private locked<T>(accountId: string, fn: (tx: Tx) => Promise<T>) {
    return this._scope.run(accountId, fn, { lock: true });
  }

  // Account of a reservation known only by its key. Only the worker role,
  // which bypasses row-level security, can find it; null when there is none.
  private async ledgerAccountId(idempotencyKey: string) {
    if (this._creditLedger.model.role !== 'worker') {
      throw new MoneyScopeRequiredError(idempotencyKey);
    }
    const ledger = await this._creditLedger.model.creditLedger.findUnique({
      where: { idempotencyKey },
      select: { accountId: true },
    });
    return ledger?.accountId ?? null;
  }

  private activeBuckets(accountId: string, now: Date) {
    return {
      accountId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
  }

  getAction(key: string, planKey: string) {
    return this._creditAction.model.creditAction.findUnique({
      where: { key },
      include: { planOverrides: { where: { planKey } } },
    });
  }

  reserve(params: ReserveCredits) {
    return this.locked(params.accountId, async (tx) => {
      const existing = await tx.creditLedger.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });
      if (existing) {
        if (
          existing.accountId !== params.accountId ||
          existing.actionKey !== params.actionKey
        ) {
          throw new IdempotencyConflictError(params.idempotencyKey);
        }
        if (existing.status === 'RELEASED' && params.reopenReleased) {
          await this.checkCap(
            tx,
            params,
            params.unitCost * params.quantity,
            existing.id
          );
          return { ledger: await this.reopen(tx, existing, params), created: false };
        }
        return { ledger: existing, created: false };
      }

      // The key is claimed before the balance is read, so a key another account
      // holds is a conflict whatever this account can afford. Not enough credits
      // throws below and rolls the claim back with the transaction.
      const amount = params.unitCost * params.quantity;
      let ledger: CreditLedger;
      try {
        ledger = await tx.creditLedger.create({
          data: {
            accountId: params.accountId,
            organizationId: params.organizationId,
            userId: params.userId,
            actionKey: params.actionKey,
            actionVersion: params.actionVersion,
            quantity: params.quantity,
            unitCost: params.unitCost,
            reserved: amount,
            status: 'RESERVED',
            idempotencyKey: params.idempotencyKey,
            metadata: params.metadata,
          },
        });
      } catch (err) {
        // A key held by another account is invisible here and fails as a duplicate
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new IdempotencyConflictError(params.idempotencyKey);
        }
        throw err;
      }

      await this.checkCap(tx, params, amount, ledger.id);
      await this.takeCredits(tx, params.accountId, ledger.id, amount);

      return { ledger, created: true };
    });
  }

  // Throws when reserving this amount would pass the request's cap (no cap: nothing to check).
  private async checkCap(
    tx: Tx,
    params: ReserveCredits,
    amount: number,
    ledgerId: string
  ) {
    if (!params.cap) {
      return;
    }
    const used = await this.spentIn(tx, params.accountId, params.cap, ledgerId);
    if (used + amount > params.cap.limit) {
      throw new CapReachedError(params.cap.limit, used);
    }
  }

  // Credits reserved or committed on actions under the prefix since the date, apart from one ledger.
  private async spentIn(
    tx: Tx,
    accountId: string,
    cap: Pick<ReserveCap, 'actionKeyPrefix' | 'since'>,
    exceptLedgerId?: string
  ) {
    const where = {
      accountId,
      actionKey: { startsWith: cap.actionKeyPrefix },
      createdAt: { gte: cap.since },
      ...(exceptLedgerId ? { id: { not: exceptLedgerId } } : {}),
    };
    const [reserved, committed] = await Promise.all([
      tx.creditLedger.aggregate({
        where: { ...where, status: 'RESERVED' },
        _sum: { reserved: true },
      }),
      tx.creditLedger.aggregate({
        where: { ...where, status: 'COMMITTED' },
        _sum: { committed: true },
      }),
    ]);
    return (reserved._sum.reserved || 0) + (committed._sum.committed || 0);
  }

  // What a cap counts so far: credits reserved or committed under the prefix since the date.
  spentSince(
    accountId: string,
    cap: Pick<ReserveCap, 'actionKeyPrefix' | 'since'>
  ) {
    return this._scope.run(accountId, (tx) => this.spentIn(tx, accountId, cap));
  }

  // One reservation by key. With accountId only that account's is found, on every role;
  // without it the key is looked up on the worker role only (as commit and release).
  async ledgerByKey(idempotencyKey: string, accountId?: string) {
    const owner = accountId ?? (await this.ledgerAccountId(idempotencyKey));
    if (!owner) {
      return null;
    }
    return this._scope.run(owner, (tx) =>
      tx.creditLedger.findUnique({
        where: { idempotencyKey, accountId: owner },
      })
    );
  }

  // Reserves a released ledger again at the given (today's) price and metadata.
  // Its new RESERVE entries are stamped after every earlier entry of the ledger,
  // so returnCredits gives back only what this reservation took.
  private async reopen(tx: Tx, ledger: CreditLedger, params: ReserveCredits) {
    const amount = params.unitCost * params.quantity;
    const last = await tx.creditEntry.findFirst({
      where: { ledgerId: ledger.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const at = new Date(
      Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1)
    );
    await this.takeCredits(tx, params.accountId, ledger.id, amount, at);

    return tx.creditLedger.update({
      where: { id: ledger.id },
      data: {
        organizationId: params.organizationId,
        userId: params.userId,
        actionVersion: params.actionVersion,
        quantity: params.quantity,
        unitCost: params.unitCost,
        reserved: amount,
        committed: null,
        status: 'RESERVED',
        metadata: params.metadata,
      },
    });
  }

  // Takes amount from the active buckets, earliest expiry first, one RESERVE
  // entry per bucket; not enough credits throws and rolls the transaction back.
  private async takeCredits(
    tx: Tx,
    accountId: string,
    ledgerId: string,
    amount: number,
    createdAt?: Date
  ) {
    const now = new Date();
    const buckets =
      amount > 0
        ? await tx.creditBucket.findMany({
            where: this.activeBuckets(accountId, now),
            orderBy: [
              { expiresAt: { sort: 'asc', nulls: 'last' } },
              { createdAt: 'asc' },
            ],
          })
        : [];

    // Negative buckets (reversed payments) count against the balance
    const available = buckets.reduce((sum, b) => sum + b.remaining, 0);
    if (available < amount) {
      throw new InsufficientCreditsError(amount, available);
    }

    let left = amount;
    for (const bucket of buckets) {
      if (left === 0) {
        break;
      }
      if (bucket.remaining <= 0) {
        continue;
      }
      const take = Math.min(left, bucket.remaining);
      await tx.creditBucket.update({
        where: { id: bucket.id },
        data: { remaining: { decrement: take } },
      });
      await tx.creditEntry.create({
        data: {
          accountId,
          bucketId: bucket.id,
          ledgerId,
          kind: 'RESERVE',
          delta: -take,
          createdAt,
        },
      });
      left -= take;
    }
  }

  // With accountId, only that account's reservation is found, on every role;
  // without it, the reservation is looked up by key (worker role only).
  async commit(idempotencyKey: string, actual?: number, accountId?: string) {
    const noReservation = () =>
      new CreditLedgerStateError(`No reservation for ${idempotencyKey}`);
    const owner = accountId ?? (await this.ledgerAccountId(idempotencyKey));
    if (!owner) {
      throw noReservation();
    }

    return this.locked(owner, async (tx) => {
      const ledger = await tx.creditLedger.findUnique({
        where: { idempotencyKey, accountId: owner },
      });
      if (!ledger) {
        throw noReservation();
      }
      if (ledger.status === 'COMMITTED') {
        return ledger;
      }
      if (ledger.status === 'RELEASED') {
        throw new CreditLedgerStateError(
          `Reservation ${idempotencyKey} was already released`
        );
      }

      const final = actual ?? ledger.reserved;
      if (final < 0 || final > ledger.reserved) {
        throw new CreditLedgerStateError(
          `Cannot commit ${final} of a ${ledger.reserved} reservation`
        );
      }
      if (final < ledger.reserved) {
        await this.returnCredits(tx, ledger, ledger.reserved - final);
      }

      return tx.creditLedger.update({
        where: { id: ledger.id },
        data: { status: 'COMMITTED', committed: final },
      });
    });
  }

  // Releasing something that was never reserved is a no-op (returns null),
  // so callers can release unconditionally on failure paths. accountId as in commit.
  async release(idempotencyKey: string, accountId?: string) {
    const owner = accountId ?? (await this.ledgerAccountId(idempotencyKey));
    if (!owner) {
      return null;
    }

    return this.locked(owner, async (tx) => {
      const ledger = await tx.creditLedger.findUnique({
        where: { idempotencyKey, accountId: owner },
      });
      if (!ledger) {
        return null;
      }
      if (ledger.status === 'RELEASED') {
        return ledger;
      }
      if (ledger.status === 'COMMITTED') {
        throw new CreditLedgerStateError(
          `Reservation ${idempotencyKey} was already committed`
        );
      }

      await this.returnCredits(tx, ledger, ledger.reserved);

      return tx.creditLedger.update({
        where: { id: ledger.id },
        data: { status: 'RELEASED' },
      });
    });
  }

  // Gives credits back to the buckets they came from, latest expiring first.
  // A bucket that expired since the reservation gets nothing back; that part
  // goes to one new refund bucket instead.
  private async returnCredits(tx: Tx, ledger: CreditLedger, amount: number) {
    const reserves = await tx.creditEntry.findMany({
      where: { ledgerId: ledger.id, kind: 'RESERVE' },
      include: { bucket: { select: { expiresAt: true } } },
    });
    // A ledger with RELEASE entries was released and reserved again (reopen):
    // only the newest reservation's entries are still held.
    const released = await tx.creditEntry.count({
      where: { ledgerId: ledger.id, kind: 'RELEASE' },
    });
    const newest = Math.max(0, ...reserves.map((e) => e.createdAt.getTime()));
    const entries = released
      ? reserves.filter((e) => e.createdAt.getTime() === newest)
      : reserves;
    const expiry = (e: (typeof entries)[number]) =>
      e.bucket.expiresAt ? e.bucket.expiresAt.getTime() : Infinity;
    entries.sort((a, b) => expiry(b) - expiry(a));

    const now = Date.now();
    let left = amount;
    let expired = 0;
    for (const entry of entries) {
      if (left === 0) {
        break;
      }
      const give = Math.min(left, -entry.delta);
      left -= give;
      if (expiry(entry) <= now) {
        expired += give;
        continue;
      }
      await tx.creditBucket.update({
        where: { id: entry.bucketId },
        data: { remaining: { increment: give } },
      });
      await tx.creditEntry.create({
        data: {
          accountId: ledger.accountId,
          bucketId: entry.bucketId,
          ledgerId: ledger.id,
          kind: 'RELEASE',
          delta: give,
        },
      });
    }

    if (expired > 0) {
      const bucket = await tx.creditBucket.create({
        data: {
          accountId: ledger.accountId,
          type: 'REFUND',
          initial: expired,
          remaining: expired,
          expiresAt: dayjs().add(REFUND_BUCKET_DAYS, 'day').toDate(),
        },
      });
      await tx.creditEntry.create({
        data: {
          accountId: ledger.accountId,
          bucketId: bucket.id,
          ledgerId: ledger.id,
          kind: 'RELEASE',
          delta: expired,
        },
      });
    }
  }

  // A grant key already used by the same account returns that bucket; one held
  // by another account is a conflict on every role.
  grant(params: GrantCredits) {
    return this.locked(params.accountId, async (tx) => {
      if (params.grantKey) {
        const existing = await tx.creditBucket.findUnique({
          where: { grantKey: params.grantKey },
        });
        if (existing) {
          if (existing.accountId !== params.accountId) {
            throw new IdempotencyConflictError(params.grantKey);
          }
          return { bucket: existing, created: false };
        }
      }

      let bucket: CreditBucket;
      try {
        bucket = await tx.creditBucket.create({
          data: {
            accountId: params.accountId,
            type: params.type,
            initial: params.amount,
            remaining: params.amount,
            expiresAt: params.expiresAt || null,
            grantKey: params.grantKey,
          },
        });
      } catch (err) {
        // A grant key held by another account is invisible here and fails as a duplicate
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new IdempotencyConflictError(params.grantKey!);
        }
        throw err;
      }
      await tx.creditEntry.create({
        data: {
          accountId: params.accountId,
          bucketId: bucket.id,
          kind: 'GRANT',
          delta: params.amount,
        },
      });

      return { bucket, created: true };
    });
  }

  async balance(accountId: string) {
    const [available, reserved] = await this._scope.run(accountId, (tx) =>
      Promise.all([
        tx.creditBucket.aggregate({
          where: this.activeBuckets(accountId, new Date()),
          _sum: { remaining: true },
        }),
        tx.creditLedger.aggregate({
          where: { accountId, status: 'RESERVED' },
          _sum: { reserved: true },
        }),
      ])
    );

    return {
      available: available._sum.remaining || 0,
      reserved: reserved._sum.reserved || 0,
    };
  }

  listAccountIds(cursor: string | undefined, take: number) {
    return this._account.model.account.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
  }

  // The entries are the source of truth. Returns every bucket whose cached
  // remaining and every ledger row whose held amount disagree with them.
  async reconcile(accountId: string) {
    const [buckets, bucketSums, ledgers, ledgerSums] = await this._scope.run(
      accountId,
      (tx) =>
        Promise.all([
          tx.creditBucket.findMany({
            where: { accountId },
            select: { id: true, remaining: true },
          }),
          tx.creditEntry.groupBy({
            by: ['bucketId'],
            where: { accountId },
            _sum: { delta: true },
          }),
          tx.creditLedger.findMany({
            where: { accountId },
            select: { id: true, status: true, reserved: true, committed: true },
          }),
          tx.creditEntry.groupBy({
            by: ['ledgerId'],
            where: { accountId, ledgerId: { not: null } },
            _sum: { delta: true },
          }),
        ])
    );

    const bucketTotal = new Map(
      bucketSums.map((s) => [s.bucketId, s._sum.delta || 0])
    );
    const ledgerTotal = new Map(
      ledgerSums.map((s) => [s.ledgerId!, s._sum.delta || 0])
    );

    const bucketDrift = buckets
      .filter((b) => b.remaining !== (bucketTotal.get(b.id) || 0))
      .map((b) => ({
        bucketId: b.id,
        remaining: b.remaining,
        entries: bucketTotal.get(b.id) || 0,
      }));

    const ledgerDrift = ledgers
      .map((l) => ({
        ledgerId: l.id,
        status: l.status,
        expectedHeld:
          l.status === 'RESERVED'
            ? l.reserved
            : l.status === 'COMMITTED'
            ? l.committed || 0
            : 0,
        held: -(ledgerTotal.get(l.id) || 0),
      }))
      .filter((l) => l.expectedHeld !== l.held);

    return { buckets: bucketDrift, ledgers: ledgerDrift };
  }
}
