// Grant lifecycle: grants until a fixed instant, and revoking a
// grant into debt when its payment is reversed, on the API and the worker role.
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { CreditGrantsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.repository';
import { CreditGrantsService } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.service';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;

// Only Date is faked: Prisma keeps its real timers.
const atTime = (at: Date) =>
  jest.useFakeTimers({
    now: at,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });

interface Services {
  grants: CreditGrantsService;
  credits: CreditsService;
}

describeDb('CreditGrantsService (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  const roles: Record<'api' | 'worker', Services> = {} as any;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // The grants and credits services on a given client, wired as the database module wires them.
  const servicesOn = (prisma: PrismaService): Services => {
    const repo = new PrismaRepository<any>(prisma);
    const accountsService = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const moneyScope = new MoneyScope(
      new PrismaTransaction(prisma),
      accountsService
    );
    const creditsRepository = new CreditsRepository(
      moneyScope,
      repo,
      repo,
      repo
    );
    return {
      grants: new CreditGrantsService(
        creditsRepository,
        new CreditGrantsRepository(moneyScope)
      ),
      credits: new CreditsService(creditsRepository, accountsService, moneyScope),
    };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerService = new PrismaService();
    expect(api.role).toBe('api');
    expect(workerService.role).toBe('worker');
    await workerService.$connect();
    worker = new PrismaClient({ datasourceUrl: url });

    const repo = new PrismaRepository<any>(api);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    roles.api = servicesOn(api);
    roles.worker = servicesOn(workerService);
    await new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      roles.api.credits,
      accounts
    ).sync();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    await api.$disconnect();
    await workerService.$disconnect();
    await worker.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  // A user with a workspace, billed to the user's own account.
  const workspace = async () => {
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: {
          create: {
            role: 'SUPERADMIN',
            user: {
              create: {
                email: randomUUID() + '@test.local',
                providerName: 'LOCAL',
                timezone: 0,
              },
            },
          },
        },
      },
    });
    const accountId = await accounts.getAccountIdForOrganization(org.id);
    return { organizationId: org.id, accountId };
  };

  const key = (kind = 'test') => `${kind}:${randomUUID()}`;
  const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

  // The account's buckets, ledger rows and entries, read by the worker role.
  const rowsOf = async (accountId: string) => ({
    buckets: await worker.creditBucket.findMany({
      where: { accountId },
      orderBy: { id: 'asc' },
    }),
    ledgers: await worker.creditLedger.findMany({
      where: { accountId },
      orderBy: { id: 'asc' },
    }),
    entries: await worker.creditEntry.findMany({
      where: { accountId },
      orderBy: { id: 'asc' },
    }),
  });

  const bucketOf = (grantKey: string) =>
    worker.creditBucket.findUnique({ where: { grantKey } });

  const statusOf = (err: unknown) => {
    expect(err).toBeInstanceOf(HttpException);
    return (err as HttpException).getStatus();
  };

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const grants = () => roles[role].grants;
    const credits = () => roles[role].credits;

    // Spends quantity credits of post.publish (1 credit each) through the engine.
    const spend = (organizationId: string, quantity: number) =>
      credits().spend(
        {
          organizationId,
          actionKey: 'post.publish',
          quantity,
          idempotencyKey: key('spend'),
        },
        async () => true
      );

    // Reserves quantity credits of post.publish; returns the reservation key.
    const reserve = async (organizationId: string, quantity: number) => {
      const idempotencyKey = key('reserve');
      await credits().reserve({
        organizationId,
        actionKey: 'post.publish',
        quantity,
        idempotencyKey,
      });
      return idempotencyKey;
    };

    // An account with one never-expiring grant of amount under its own key.
    const granted = async (amount: number, expiresAt: Date | null = null) => {
      const ws = await workspace();
      const grantKey = key('grant');
      await grants().grantUntil(ws.accountId, {
        type: 'GRANT',
        amount,
        expiresAt,
        grantKey,
      });
      return { ...ws, grantKey };
    };

    const expectReconciled = async (accountId: string) =>
      expect(await credits().reconcile(accountId)).toEqual({
        buckets: [],
        ledgers: [],
      });

    describe('grantUntil', () => {
      it('creates a bucket expiring at the given instant with a GRANT entry', async () => {
        const ws = await workspace();
        const grantKey = key('paypal:event');
        const expiresAt = inHours(24 * 30);

        const result = await grants().grantUntil(ws.accountId, {
          type: 'GRANT',
          amount: 300,
          expiresAt,
          grantKey,
        });

        expect(result.created).toBe(true);
        expect(result.bucket).toMatchObject({
          accountId: ws.accountId,
          type: 'GRANT',
          initial: 300,
          remaining: 300,
          grantKey,
        });
        expect(result.bucket.expiresAt!.getTime()).toBe(expiresAt.getTime());
        const rows = await rowsOf(ws.accountId);
        expect(rows.entries).toEqual([
          expect.objectContaining({
            bucketId: result.bucket.id,
            kind: 'GRANT',
            delta: 300,
            ledgerId: null,
          }),
        ]);
        expect(await credits().balance(ws.organizationId)).toEqual({
          available: 300,
          reserved: 0,
        });
      });

      it('creates a never-expiring bucket when expiresAt is null', async () => {
        const ws = await workspace();
        const { bucket, created } = await grants().grantUntil(ws.accountId, {
          type: 'TOPUP',
          amount: 100,
          expiresAt: null,
          grantKey: key('paypal:capture'),
        });
        expect(created).toBe(true);
        expect(bucket.type).toBe('TOPUP');
        expect(bucket.expiresAt).toBeNull();

        atTime(new Date(Date.now() + 10 * 365 * 24 * HOUR));
        expect((await credits().balance(ws.organizationId)).available).toBe(100);
      });

      it('stops counting the credits at expiresAt', async () => {
        const ws = await workspace();
        const expiresAt = inHours(1);
        await grants().grantUntil(ws.accountId, {
          type: 'PROMO',
          amount: 50,
          expiresAt,
          grantKey: key('free'),
        });

        atTime(new Date(expiresAt.getTime() - 1000));
        expect((await credits().balance(ws.organizationId)).available).toBe(50);
        atTime(new Date(expiresAt.getTime() + 1000));
        expect((await credits().balance(ws.organizationId)).available).toBe(0);
      });

      it('returns the first bucket for a grantKey the account already used, whatever the other params', async () => {
        const ws = await workspace();
        const grantKey = key('free');
        const expiresAt = inHours(2);
        const first = await grants().grantUntil(ws.accountId, {
          type: 'PROMO',
          amount: 50,
          expiresAt,
          grantKey,
        });

        const again = await grants().grantUntil(ws.accountId, {
          type: 'TOPUP',
          amount: 999,
          expiresAt: null,
          grantKey,
        });
        expect(again.created).toBe(false);
        expect(again.bucket).toEqual(first.bucket);

        // Replayed after the grant's own expiry, with that (now past) expiry
        atTime(new Date(expiresAt.getTime() + HOUR));
        const late = await grants().grantUntil(ws.accountId, {
          type: 'PROMO',
          amount: 50,
          expiresAt,
          grantKey,
        });
        expect(late.created).toBe(false);
        expect(late.bucket.id).toBe(first.bucket.id);

        const rows = await rowsOf(ws.accountId);
        expect(rows.buckets).toHaveLength(1);
        expect(rows.entries).toHaveLength(1);
      });

      it('grants once under concurrent calls with one key', async () => {
        const ws = await workspace();
        const grantKey = key('paypal:event');
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            grants().grantUntil(ws.accountId, {
              type: 'GRANT',
              amount: 300,
              expiresAt: inHours(24),
              grantKey,
            })
          )
        );
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(new Set(results.map((r) => r.bucket.id)).size).toBe(1);
        expect((await credits().balance(ws.organizationId)).available).toBe(300);
        await expectReconciled(ws.accountId);
      });

      it.each([0, -5, 1.5, Number.NaN])(
        'rejects amount %p with 400 and writes nothing',
        async (amount) => {
          const ws = await workspace();
          const err = await grants()
            .grantUntil(ws.accountId, {
              type: 'GRANT',
              amount,
              expiresAt: inHours(1),
              grantKey: key(),
            })
            .catch((e) => e);
          expect(statusOf(err)).toBe(400);
          expect((await rowsOf(ws.accountId)).buckets).toEqual([]);
        }
      );

      it.each([
        ['in the past', () => new Date(Date.now() - 1000)],
        ['now', () => new Date()],
        ['not a date', () => new Date('nope')],
      ])('rejects an expiresAt %s with 400 and writes nothing', async (_, at) => {
        const ws = await workspace();
        const expiresAt = at();
        atTime(new Date(Math.max(Date.now(), expiresAt.getTime() || 0)));
        const err = await grants()
          .grantUntil(ws.accountId, {
            type: 'GRANT',
            amount: 10,
            expiresAt,
            grantKey: key(),
          })
          .catch((e) => e);
        expect(statusOf(err)).toBe(400);
        expect((await rowsOf(ws.accountId)).buckets).toEqual([]);
      });

      it('rejects an empty grantKey and a REVERSAL type with 400', async () => {
        const ws = await workspace();
        const empty = await grants()
          .grantUntil(ws.accountId, {
            type: 'GRANT',
            amount: 10,
            expiresAt: null,
            grantKey: '',
          })
          .catch((e) => e);
        expect(statusOf(empty)).toBe(400);
        const reversal = await grants()
          .grantUntil(ws.accountId, {
            type: 'REVERSAL',
            amount: 10,
            expiresAt: null,
            grantKey: key(),
          })
          .catch((e) => e);
        expect(statusOf(reversal)).toBe(400);
        expect((await rowsOf(ws.accountId)).buckets).toEqual([]);
      });

      it("answers 409 for a grantKey another account holds and leaves both accounts' rows untouched", async () => {
        const other = await granted(40);
        const mine = await workspace();
        const before = await rowsOf(other.accountId);

        const err = await grants()
          .grantUntil(mine.accountId, {
            type: 'GRANT',
            amount: 10,
            expiresAt: null,
            grantKey: other.grantKey,
          })
          .catch((e) => e);

        expect(statusOf(err)).toBe(409);
        expect(JSON.stringify(err.getResponse())).not.toContain(other.accountId);
        expect(await rowsOf(other.accountId)).toEqual(before);
        expect((await rowsOf(mine.accountId)).buckets).toEqual([]);
      });
    });

    describe('getGrant', () => {
      it("returns the account's bucket under the key", async () => {
        const ws = await granted(25);
        const bucket = await grants().getGrant(ws.accountId, ws.grantKey);
        expect(bucket).toMatchObject({
          accountId: ws.accountId,
          grantKey: ws.grantKey,
          initial: 25,
        });
      });

      it('returns null for an unknown key and for a key of another account', async () => {
        const other = await granted(25);
        const mine = await workspace();
        expect(await grants().getGrant(mine.accountId, key())).toBeNull();
        expect(await grants().getGrant(mine.accountId, other.grantKey)).toBeNull();
      });
    });

    describe('revokeGrant', () => {
      it('removes an unspent grant whole, with no debt, and records the reversal', async () => {
        const ws = await granted(100);
        const reversalKey = key('paypal:reversal');

        const result = await grants().revokeGrant(
          ws.accountId,
          ws.grantKey,
          reversalKey
        );

        expect(result).toEqual({ removed: 100, debt: 0, created: true });
        expect((await bucketOf(ws.grantKey))!.remaining).toBe(0);
        expect(await bucketOf(reversalKey)).toMatchObject({
          accountId: ws.accountId,
          type: 'REVERSAL',
          initial: -100,
          remaining: 0,
          expiresAt: null,
        });
        const reversal = (await bucketOf(reversalKey))!;
        const entries = (await rowsOf(ws.accountId)).entries;
        expect(entries.filter((e) => e.bucketId === reversal.id)).toEqual([]);
        expect(entries.filter((e) => e.kind === 'ADJUST')).toEqual([
          expect.objectContaining({
            bucketId: (await bucketOf(ws.grantKey))!.id,
            delta: -100,
          }),
        ]);
        expect((await credits().balance(ws.organizationId)).available).toBe(0);
        await expectReconciled(ws.accountId);
      });

      it('turns what was already spent into debt and blocks new spends with 402', async () => {
        const ws = await granted(10);
        const spent = await spend(ws.organizationId, 7);
        const ledgersBefore = (await rowsOf(ws.accountId)).ledgers;
        const reversalKey = key('paypal:reversal');

        const result = await grants().revokeGrant(
          ws.accountId,
          ws.grantKey,
          reversalKey
        );

        expect(spent).toBe(true);
        expect(result).toEqual({ removed: 3, debt: 7, created: true });
        expect(result.removed + result.debt).toBe(10);
        expect(await bucketOf(reversalKey)).toMatchObject({
          type: 'REVERSAL',
          initial: -10,
          remaining: -7,
          expiresAt: null,
        });
        const reversal = (await bucketOf(reversalKey))!;
        expect(
          (await rowsOf(ws.accountId)).entries.filter(
            (e) => e.bucketId === reversal.id
          )
        ).toEqual([expect.objectContaining({ kind: 'ADJUST', delta: -7 })]);
        // Nothing committed is clawed back
        expect((await rowsOf(ws.accountId)).ledgers).toEqual(ledgersBefore);
        expect((await credits().balance(ws.organizationId)).available).toBe(-7);

        const err = await spend(ws.organizationId, 1).catch((e) => e);
        expect(statusOf(err)).toBe(402);
        expect(err.getResponse()).toMatchObject({
          code: 'INSUFFICIENT_CREDITS',
          available: -7,
        });
        await expectReconciled(ws.accountId);
      });

      it('revokes a given part of the grant', async () => {
        const ws = await granted(10);
        expect(
          await grants().revokeGrant(ws.accountId, ws.grantKey, key(), 4)
        ).toEqual({ removed: 4, debt: 0, created: true });
        expect((await credits().balance(ws.organizationId)).available).toBe(6);

        await spend(ws.organizationId, 5);
        expect(
          await grants().revokeGrant(ws.accountId, ws.grantKey, key(), 3)
        ).toEqual({ removed: 1, debt: 2, created: true });
        expect((await credits().balance(ws.organizationId)).available).toBe(-2);
        await expectReconciled(ws.accountId);
      });

      it('takes from what is left in an expired grant first; only what was used becomes debt', async () => {
        const expiresAt = inHours(1);
        const ws = await granted(10, expiresAt);
        await spend(ws.organizationId, 3);

        atTime(new Date(expiresAt.getTime() + HOUR));
        expect((await credits().balance(ws.organizationId)).available).toBe(0);
        const result = await grants().revokeGrant(
          ws.accountId,
          ws.grantKey,
          key('paypal:reversal')
        );

        expect(result).toEqual({ removed: 7, debt: 3, created: true });
        expect((await credits().balance(ws.organizationId)).available).toBe(-3);
        await expectReconciled(ws.accountId);
      });

      it('lets reserved work commit after a revoke', async () => {
        const ws = await granted(10);
        const reservation = await reserve(ws.organizationId, 6);

        expect(
          await grants().revokeGrant(ws.accountId, ws.grantKey, key())
        ).toEqual({ removed: 4, debt: 6, created: true });
        expect(await credits().balance(ws.organizationId)).toEqual({
          available: -6,
          reserved: 6,
        });

        const ledger = await credits().commit(
          reservation,
          undefined,
          ws.organizationId
        );
        expect(ledger).toMatchObject({ status: 'COMMITTED', committed: 6 });
        expect(await credits().balance(ws.organizationId)).toEqual({
          available: -6,
          reserved: 0,
        });
        await expectReconciled(ws.accountId);
      });

      it("returns released credits to the grant's bucket, offsetting the debt", async () => {
        const ws = await granted(10);
        const reservation = await reserve(ws.organizationId, 6);
        await grants().revokeGrant(ws.accountId, ws.grantKey, key());
        expect((await credits().balance(ws.organizationId)).available).toBe(-6);

        await credits().release(reservation, ws.organizationId);

        expect((await bucketOf(ws.grantKey))!.remaining).toBe(6);
        expect(await credits().balance(ws.organizationId)).toEqual({
          available: 0,
          reserved: 0,
        });
        await expectReconciled(ws.accountId);
      });

      it('replays a reversalKey with the first result and changes nothing', async () => {
        const ws = await granted(10);
        await spend(ws.organizationId, 4);
        const reversalKey = key('paypal:reversal');
        const first = await grants().revokeGrant(
          ws.accountId,
          ws.grantKey,
          reversalKey,
          8
        );
        expect(first).toEqual({ removed: 6, debt: 2, created: true });
        const after = await rowsOf(ws.accountId);

        expect(
          await grants().revokeGrant(ws.accountId, ws.grantKey, reversalKey, 8)
        ).toEqual({ removed: 6, debt: 2, created: false });
        expect(
          await grants().revokeGrant(ws.accountId, ws.grantKey, reversalKey)
        ).toEqual({ removed: 6, debt: 2, created: false });
        expect(await rowsOf(ws.accountId)).toEqual(after);
      });

      it('replays a revoke that left no debt', async () => {
        const ws = await granted(10);
        const reversalKey = key('paypal:reversal');
        await grants().revokeGrant(ws.accountId, ws.grantKey, reversalKey);
        const after = await rowsOf(ws.accountId);

        expect(
          await grants().revokeGrant(ws.accountId, ws.grantKey, reversalKey)
        ).toEqual({ removed: 10, debt: 0, created: false });
        expect(await rowsOf(ws.accountId)).toEqual(after);
      });

      it('revokes once under concurrent calls with one reversalKey', async () => {
        const ws = await granted(10);
        await spend(ws.organizationId, 2);
        const reversalKey = key('paypal:reversal');
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            grants().revokeGrant(ws.accountId, ws.grantKey, reversalKey)
          )
        );
        expect(results.filter((r) => r.created)).toHaveLength(1);
        for (const r of results) {
          expect({ removed: r.removed, debt: r.debt }).toEqual({
            removed: 8,
            debt: 2,
          });
        }
        expect((await credits().balance(ws.organizationId)).available).toBe(-2);
        await expectReconciled(ws.accountId);
      });

      it('keeps ledger and buckets consistent through interleaved grants, spends, revokes and releases', async () => {
        const ws = await granted(20);
        const second = key('paypal:capture');
        await grants().grantUntil(ws.accountId, {
          type: 'TOPUP',
          amount: 15,
          expiresAt: null,
          grantKey: second,
        });
        await spend(ws.organizationId, 2);
        const reservations = await Promise.all(
          Array.from({ length: 5 }, () => reserve(ws.organizationId, 3))
        );
        await Promise.all([
          grants().revokeGrant(ws.accountId, ws.grantKey, key(), 12),
          grants().revokeGrant(ws.accountId, second, key()),
          credits().release(reservations[0], ws.organizationId),
          credits().commit(reservations[1], 1, ws.organizationId),
        ]);
        await credits().release(reservations[2], ws.organizationId);

        // 35 granted, 27 revoked, 2 spent, 1 committed, 2 reservations of 3 still held
        expect(await credits().balance(ws.organizationId)).toEqual({
          available: 35 - 27 - 2 - 1 - 6,
          reserved: 6,
        });
        await expectReconciled(ws.accountId);
      });

      it('answers 404 for an unknown grantKey and writes nothing', async () => {
        const ws = await granted(10);
        const before = await rowsOf(ws.accountId);
        const reversalKey = key();
        const err = await grants()
          .revokeGrant(ws.accountId, key(), reversalKey)
          .catch((e) => e);
        expect(statusOf(err)).toBe(404);
        expect(await rowsOf(ws.accountId)).toEqual(before);
        expect(await bucketOf(reversalKey)).toBeNull();
      });

      it("treats another account's grantKey as unknown (404) and never changes it", async () => {
        const other = await granted(10);
        const mine = await granted(10);
        const otherBefore = await rowsOf(other.accountId);
        const mineBefore = await rowsOf(mine.accountId);

        const err = await grants()
          .revokeGrant(mine.accountId, other.grantKey, key())
          .catch((e) => e);

        expect(statusOf(err)).toBe(404);
        expect(JSON.stringify(err.getResponse())).not.toContain(other.accountId);
        expect(await rowsOf(other.accountId)).toEqual(otherBefore);
        expect(await rowsOf(mine.accountId)).toEqual(mineBefore);
      });

      it.each([
        ["the account's own grant", (grantKey: string) => ({ grantKey })],
        ['an unknown grantKey', () => ({ grantKey: key() })],
        [
          "an amount above the grant's initial",
          (grantKey: string) => ({ grantKey, amount: 11 }),
        ],
      ] as [string, (grantKey: string) => { grantKey: string; amount?: number }][])(
        'answers 409 for a reversalKey another account holds, with %s, and writes nothing',
        async (_, args) => {
          const other = await granted(10);
          const otherReversal = key('paypal:reversal');
          await roles.api.grants.revokeGrant(
            other.accountId,
            other.grantKey,
            otherReversal
          );
          const mine = await granted(10);
          const otherBefore = await rowsOf(other.accountId);
          const mineBefore = await rowsOf(mine.accountId);
          const { grantKey, amount } = args(mine.grantKey);

          const err = await grants()
            .revokeGrant(mine.accountId, grantKey, otherReversal, amount)
            .catch((e) => e);

          expect(statusOf(err)).toBe(409);
          expect(JSON.stringify(err.getResponse())).not.toContain(
            other.accountId
          );
          expect(await rowsOf(other.accountId)).toEqual(otherBefore);
          expect(await rowsOf(mine.accountId)).toEqual(mineBefore);
        }
      );

      it('answers 409 for a reversalKey that names a grant, not a reversal', async () => {
        const ws = await granted(10);
        const otherGrant = key('grant');
        await grants().grantUntil(ws.accountId, {
          type: 'GRANT',
          amount: 5,
          expiresAt: null,
          grantKey: otherGrant,
        });
        const before = await rowsOf(ws.accountId);

        const err = await grants()
          .revokeGrant(ws.accountId, ws.grantKey, otherGrant)
          .catch((e) => e);

        expect(statusOf(err)).toBe(409);
        expect(await rowsOf(ws.accountId)).toEqual(before);
      });

      it("answers 400 for an amount above the grant's initial and writes nothing", async () => {
        const ws = await granted(10);
        await spend(ws.organizationId, 10);
        const before = await rowsOf(ws.accountId);
        const reversalKey = key();

        const err = await grants()
          .revokeGrant(ws.accountId, ws.grantKey, reversalKey, 11)
          .catch((e) => e);

        expect(statusOf(err)).toBe(400);
        expect(await rowsOf(ws.accountId)).toEqual(before);
        expect(await bucketOf(reversalKey)).toBeNull();
        // The whole grant is still allowed
        expect(
          await grants().revokeGrant(ws.accountId, ws.grantKey, reversalKey, 10)
        ).toEqual({ removed: 0, debt: 10, created: true });
      });

      it.each([0, -1, 2.5, Number.NaN])(
        'answers 400 for amount %p and writes nothing',
        async (amount) => {
          const ws = await granted(10);
          const before = await rowsOf(ws.accountId);
          const err = await grants()
            .revokeGrant(ws.accountId, ws.grantKey, key(), amount)
            .catch((e) => e);
          expect(statusOf(err)).toBe(400);
          expect(await rowsOf(ws.accountId)).toEqual(before);
        }
      );

      it('answers 400 for an empty grantKey or reversalKey', async () => {
        const ws = await granted(10);
        const before = await rowsOf(ws.accountId);
        for (const [grantKey, reversalKey] of [
          ['', key()],
          [ws.grantKey, ''],
        ]) {
          const err = await grants()
            .revokeGrant(ws.accountId, grantKey, reversalKey)
            .catch((e) => e);
          expect(statusOf(err)).toBe(400);
        }
        expect(await rowsOf(ws.accountId)).toEqual(before);
      });
    });
  });
});
