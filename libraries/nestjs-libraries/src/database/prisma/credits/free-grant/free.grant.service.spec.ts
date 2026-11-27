// Free monthly grant: once per UTC month, the first only after a channel exists, expiring
// at month end, on the API and the worker role; and the monthly run over every eligible account.
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
import { PRICING } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { CreditGrantsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.repository';
import { CreditGrantsService } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.service';
import { FreeGrantRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.repository';
import { FreeGrantService } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.service';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads and seeding use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

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

// A mid-month instant in a month far from the real one, so no other suite's rows interfere.
const MARCH = new Date(Date.UTC(2031, 2, 15, 10));
const APRIL = new Date(Date.UTC(2031, 3, 2, 9));
const APRIL_START = new Date(Date.UTC(2031, 3, 1));
const MAY_START = new Date(Date.UTC(2031, 4, 1));

interface Services {
  free: FreeGrantService;
  grants: CreditGrantsService;
  credits: CreditsService;
}

describeDb('FreeGrantService (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let pricing: PricingService;
  const roles: Record<'api' | 'worker', Services> = {} as any;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // The services on a given client, wired as the database module wires them; `price` can
  // replace the pricing service with a stub that answers by month.
  const servicesOn = (
    prisma: PrismaService,
    price?: Pick<PricingService, 'freeMonthlyGrant'>
  ): Services => {
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
    const grants = new CreditGrantsService(
      creditsRepository,
      new CreditGrantsRepository(moneyScope)
    );
    const credits = new CreditsService(
      creditsRepository,
      accountsService,
      moneyScope
    );
    const pricingService =
      price ??
      new PricingService(
        new PricingRepository(new PrismaTransaction(prisma), repo, repo),
        credits,
        accountsService
      );
    return {
      free: new FreeGrantService(
        new FreeGrantRepository(repo, repo),
        grants,
        pricingService as PricingService
      ),
      grants,
      credits,
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

    roles.api = servicesOn(api);
    roles.worker = servicesOn(workerService);
    pricing = new PricingService(
      new PricingRepository(
        new PrismaTransaction(api),
        new PrismaRepository<any>(api),
        new PrismaRepository<any>(api)
      ),
      roles.api.credits,
      new AccountsService(
        new AccountsRepository(
          new PrismaRepository<any>(api),
          new PrismaRepository<any>(api),
          new PrismaRepository<any>(api)
        )
      )
    );
    await pricing.sync();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
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

  // A user with a workspace, billed to the user's own account (no channel yet).
  const workspace = async (planKey = 'FREE') => {
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
    const accountId = await new AccountsService(
      new AccountsRepository(
        new PrismaRepository<any>(api),
        new PrismaRepository<any>(api),
        new PrismaRepository<any>(api)
      )
    ).getAccountIdForOrganization(org.id);
    if (planKey !== 'FREE') {
      await worker.account.update({ where: { id: accountId }, data: { planKey } });
    }
    return { organizationId: org.id, accountId };
  };

  // A channel in the workspace, optionally soft-deleted.
  const channel = (organizationId: string, deleted = false) =>
    worker.integration.create({
      data: {
        organizationId,
        internalId: randomUUID(),
        name: 'channel-' + randomUUID(),
        picture: '/no-picture.jpg',
        providerIdentifier: 'bluesky',
        type: 'social',
        token: 'token',
        ...(deleted ? { deletedAt: new Date() } : {}),
      },
    });

  // A second workspace of the same account.
  const secondWorkspace = async (accountId: string) => {
    const org = await worker.organization.create({
      data: { name: 'ws-' + randomUUID(), accountId },
    });
    return org.id;
  };

  const bucketsOf = (accountId: string) =>
    worker.creditBucket.findMany({ where: { accountId } });

  const keyFor = (accountId: string, month: string) =>
    `free:${accountId}:${month}`;

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const free = () => roles[role].free;
    const credits = () => roles[role].credits;

    it('grants nothing at sign-up: no channel, no grant, balance 0', async () => {
      const { organizationId, accountId } = await workspace();
      expect(await free().isEligible(accountId)).toBe(false);
      const result = await free().ensureMonthlyGrant(accountId, MARCH);
      expect(result).toEqual({
        granted: false,
        grantKey: keyFor(accountId, '2031-03'),
        amount: 0,
      });
      expect(await bucketsOf(accountId)).toEqual([]);
      expect(await credits().balance(organizationId)).toEqual({
        available: 0,
        reserved: 0,
      });
    });

    it('grants the free credits once the account has a channel: PROMO, keyed by month, expiring at the next month start', async () => {
      const { organizationId, accountId } = await workspace();
      await channel(organizationId);
      atTime(MARCH);
      expect(await free().isEligible(accountId)).toBe(true);
      const result = await free().ensureMonthlyGrant(accountId, MARCH);
      expect(result).toEqual({
        granted: true,
        grantKey: keyFor(accountId, '2031-03'),
        amount: PRICING.free.monthlyGrant,
      });
      const [bucket, ...rest] = await bucketsOf(accountId);
      expect(rest).toEqual([]);
      expect(bucket.type).toBe('PROMO');
      expect(bucket.grantKey).toBe(keyFor(accountId, '2031-03'));
      expect(bucket.initial).toBe(PRICING.free.monthlyGrant);
      expect(bucket.remaining).toBe(PRICING.free.monthlyGrant);
      expect(bucket.expiresAt).toEqual(APRIL_START);
      expect(await credits().balance(organizationId)).toEqual({
        available: PRICING.free.monthlyGrant,
        reserved: 0,
      });
    });

    it('grants once per month however many channels, workspaces and calls', async () => {
      const { organizationId, accountId } = await workspace();
      await channel(organizationId);
      atTime(MARCH);
      const first = await free().ensureMonthlyGrant(accountId, MARCH);
      await channel(organizationId);
      const otherWorkspace = await secondWorkspace(accountId);
      await channel(otherWorkspace);
      const second = await free().ensureMonthlyGrant(accountId, MARCH);
      const third = await free().ensureMonthlyGrant(
        accountId,
        new Date(Date.UTC(2031, 2, 31, 23, 59))
      );
      expect(first.granted).toBe(true);
      expect(second).toEqual({ ...first, granted: false });
      expect(third).toEqual({ ...first, granted: false });
      expect(await bucketsOf(accountId)).toHaveLength(1);
      expect(
        await worker.creditEntry.count({ where: { accountId } })
      ).toBe(1);
    });

    it('grants exactly once under concurrent calls', async () => {
      const { organizationId, accountId } = await workspace();
      await channel(organizationId);
      atTime(MARCH);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          free().ensureMonthlyGrant(accountId, MARCH)
        )
      );
      expect(results.filter((r) => r.granted)).toHaveLength(1);
      expect(await bucketsOf(accountId)).toHaveLength(1);
      expect(await credits().balance(organizationId)).toMatchObject({
        available: PRICING.free.monthlyGrant,
      });
    });

    it('gives one new grant next month and last month\'s remainder has expired', async () => {
      const { organizationId, accountId } = await workspace();
      await channel(organizationId);
      atTime(MARCH);
      await free().ensureMonthlyGrant(accountId, MARCH);
      await credits().spend(
        {
          organizationId,
          actionKey: 'post.publish',
          idempotencyKey: `test:${randomUUID()}`,
        },
        async () => true
      );
      atTime(APRIL);
      // Nothing of March is left to spend in April, and the April grant is not there yet
      expect((await credits().balance(organizationId)).available).toBe(0);
      const april = await free().ensureMonthlyGrant(accountId);
      expect(april).toEqual({
        granted: true,
        grantKey: keyFor(accountId, '2031-04'),
        amount: PRICING.free.monthlyGrant,
      });
      expect((await credits().balance(organizationId)).available).toBe(
        PRICING.free.monthlyGrant
      );
      const buckets = await bucketsOf(accountId);
      expect(buckets.map((b) => b.grantKey).sort()).toEqual([
        keyFor(accountId, '2031-03'),
        keyFor(accountId, '2031-04'),
      ]);
      expect(
        buckets.find((b) => b.grantKey === keyFor(accountId, '2031-04'))!
          .expiresAt
      ).toEqual(MAY_START);
    });

    it('counts a deleted channel, and a channel of another workspace of the account', async () => {
      const deleted = await workspace();
      await channel(deleted.organizationId, true);
      expect(await free().isEligible(deleted.accountId)).toBe(true);

      const multi = await workspace();
      const other = await secondWorkspace(multi.accountId);
      expect(await free().isEligible(multi.accountId)).toBe(false);
      await channel(other);
      expect(await free().isEligible(multi.accountId)).toBe(true);
    });

    it('gives a paid account nothing, and a lapse back to FREE the month on the next run', async () => {
      const { organizationId, accountId } = await workspace('PRO');
      await channel(organizationId);
      atTime(MARCH);
      expect(await free().isEligible(accountId)).toBe(false);
      expect(await free().ensureMonthlyGrant(accountId, MARCH)).toMatchObject({
        granted: false,
        amount: 0,
      });
      expect(await bucketsOf(accountId)).toEqual([]);

      await worker.account.update({
        where: { id: accountId },
        data: { planKey: 'FREE' },
      });
      await free().runMonthlyGrants(MARCH);
      const buckets = await bucketsOf(accountId);
      expect(buckets.map((b) => b.grantKey)).toEqual([
        keyFor(accountId, '2031-03'),
      ]);
    });

    it('treats an unknown account as not eligible and writes nothing', async () => {
      const accountId = randomUUID();
      expect(await free().isEligible(accountId)).toBe(false);
      expect(await free().ensureMonthlyGrant(accountId, MARCH)).toMatchObject({
        granted: false,
        amount: 0,
      });
    });

    it('does not grant a month that is already over', async () => {
      const { organizationId, accountId } = await workspace();
      await channel(organizationId);
      atTime(APRIL);
      const result = await free().ensureMonthlyGrant(accountId, MARCH);
      expect(result).toEqual({
        granted: false,
        grantKey: keyFor(accountId, '2031-03'),
        amount: 0,
      });
      expect(await bucketsOf(accountId)).toEqual([]);
    });

    it('answers hasConnected for a channel of the workspace, deleted or not, and not for another workspace', async () => {
      const { organizationId } = await workspace();
      const other = await workspace();
      const live = await channel(organizationId);
      const gone = await channel(organizationId, true);
      expect(await free().hasConnected(organizationId, live.internalId)).toBe(
        true
      );
      expect(await free().hasConnected(organizationId, gone.internalId)).toBe(
        true
      );
      expect(
        await free().hasConnected(other.organizationId, live.internalId)
      ).toBe(false);
      expect(await free().hasConnected(organizationId, randomUUID())).toBe(
        false
      );
    });
  });

  describe('value changes', () => {
    it('grants the value in effect for the month of the grant, and a change never alters a bucket already granted', async () => {
      const values = new Map([
        ['2031-03', 50],
        ['2031-04', 70],
      ]);
      const asked: Date[] = [];
      const stub = {
        freeMonthlyGrant: async (at: Date = new Date()) => {
          asked.push(at);
          return values.get(at.toISOString().slice(0, 7))!;
        },
      };
      const free = servicesOn(workerService, stub).free;
      const { organizationId, accountId } = await workspace();
      await channel(organizationId);

      atTime(MARCH);
      expect(await free.ensureMonthlyGrant(accountId, MARCH)).toMatchObject({
        granted: true,
        amount: 50,
      });
      atTime(APRIL);
      expect(await free.ensureMonthlyGrant(accountId)).toMatchObject({
        granted: true,
        amount: 70,
      });
      const buckets = await bucketsOf(accountId);
      const byKey = Object.fromEntries(
        buckets.map((b) => [b.grantKey, b.initial])
      );
      expect(byKey).toEqual({
        [keyFor(accountId, '2031-03')]: 50,
        [keyFor(accountId, '2031-04')]: 70,
      });
      expect(asked.map((d) => d.toISOString().slice(0, 7))).toEqual([
        '2031-03',
        '2031-04',
      ]);
    });

    it('writes nothing when the free grant is 0', async () => {
      const free = servicesOn(workerService, {
        freeMonthlyGrant: async () => 0,
      }).free;
      const { organizationId, accountId } = await workspace();
      await channel(organizationId);
      atTime(MARCH);
      expect(await free.ensureMonthlyGrant(accountId, MARCH)).toMatchObject({
        granted: false,
        amount: 0,
      });
      expect(await bucketsOf(accountId)).toEqual([]);
    });
  });

  describe.each(['api', 'worker'] as const)(
    'runMonthlyGrants on the %s role',
    (role) => {
      const free = () => roles[role].free;

      // Free accounts with a channel, as the database sees them.
      const eligibleCount = () =>
        worker.account.count({
          where: {
            planKey: 'FREE',
            organizations: { some: { Integration: { some: {} } } },
          },
        });

      it('grants every eligible account the month once, skips the rest, and a second run changes nothing', async () => {
        const eligible = [await workspace(), await workspace()];
        for (const w of eligible) {
          await channel(w.organizationId);
        }
        const signedUp = await workspace();
        const paid = await workspace('AGENCY');
        await channel(paid.organizationId);
        atTime(MARCH);

        const marchBuckets = () =>
          worker.creditBucket.count({
            where: { grantKey: { endsWith: ':2031-03', startsWith: 'free:' } },
          });
        const expectedChecked = await eligibleCount();
        const before = await marchBuckets();
        const first = await free().runMonthlyGrants(MARCH);
        const granted = await marchBuckets();
        expect(first.checked).toBe(expectedChecked);
        expect(first.granted).toBe(granted - before);
        for (const w of eligible) {
          expect(
            (await bucketsOf(w.accountId)).map((b) => b.grantKey)
          ).toEqual([keyFor(w.accountId, '2031-03')]);
        }
        expect(await bucketsOf(signedUp.accountId)).toEqual([]);
        expect(await bucketsOf(paid.accountId)).toEqual([]);

        const second = await free().runMonthlyGrants(MARCH);
        expect(second).toEqual({ checked: expectedChecked, granted: 0 });
        expect(await marchBuckets()).toBe(granted);
      });

      it('leaves an account whose grant fails for the next run and carries on with the others', async () => {
        const failing = await workspace();
        await channel(failing.organizationId);
        const healthy = await workspace();
        await channel(healthy.organizationId);
        atTime(MARCH);
        const services = roles[role];
        const real = services.grants.grantUntil.bind(services.grants);
        jest
          .spyOn(services.grants, 'grantUntil')
          .mockImplementation(async (accountId, params) => {
            if (accountId === failing.accountId) {
              throw new Error('database unavailable');
            }
            return real(accountId, params);
          });
        const logged = jest.spyOn(console, 'error').mockImplementation();

        const first = await free().runMonthlyGrants(MARCH);
        expect(first.checked).toBeGreaterThanOrEqual(2);
        expect(await bucketsOf(failing.accountId)).toEqual([]);
        expect(
          (await bucketsOf(healthy.accountId)).map((b) => b.grantKey)
        ).toEqual([keyFor(healthy.accountId, '2031-03')]);
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining('free grant failed'),
          failing.accountId,
          expect.any(Error)
        );

        jest.restoreAllMocks();
        const second = await free().runMonthlyGrants(MARCH);
        expect(second.granted).toBeGreaterThanOrEqual(1);
        expect(
          (await bucketsOf(failing.accountId)).map((b) => b.grantKey)
        ).toEqual([keyFor(failing.accountId, '2031-03')]);
      });
    }
  );

  it('walks past a page of accounts: 105 eligible accounts all get the month', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) {
      const w = await workspace();
      await channel(w.organizationId);
      ids.push(w.accountId);
    }
    atTime(MARCH);
    const before = await worker.account.count({
      where: {
        planKey: 'FREE',
        organizations: { some: { Integration: { some: {} } } },
      },
    });
    const result = await roles.worker.free.runMonthlyGrants(MARCH);
    expect(result.checked).toBe(before);
    const granted = await worker.creditBucket.count({
      where: { accountId: { in: ids }, grantKey: { endsWith: ':2031-03' } },
    });
    expect(granted).toBe(105);
  }, 180000);
});
