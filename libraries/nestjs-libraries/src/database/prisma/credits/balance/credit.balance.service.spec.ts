// Balance header: the server's available and reserved credits, the low-balance mark, who may
// top up, and the list of reserved posts of one workspace, read from a real Postgres on both database roles.
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
import { CreditBalanceRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.balance.repository';
import { CreditBalanceService } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.balance.service';
import { CreditsController } from '@gitroom/backend/api/routes/credits.controller';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads and writes of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

interface Services {
  credits: CreditsService;
  balance: CreditBalanceService;
  pricing: PricingService;
}

describeDb('CreditBalanceService (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let unit: number;
  const roles: Record<'api' | 'worker', Services> = {} as any;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // The balance, credits and pricing services on a given client, wired as the database module wires them.
  const servicesOn = (prisma: PrismaService): Services => {
    const repo = new PrismaRepository<any>(prisma);
    const accountsService = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const moneyScope = new MoneyScope(
      new PrismaTransaction(prisma),
      accountsService
    );
    const credits = new CreditsService(
      new CreditsRepository(moneyScope, repo, repo, repo),
      accountsService,
      moneyScope
    );
    const pricing = new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      credits,
      accountsService
    );
    const balance = new CreditBalanceService(
      credits,
      accountsService,
      pricing,
      new CreditBalanceRepository(moneyScope, repo)
    );
    return { credits, balance, pricing };
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
    await roles.api.pricing.sync();
    unit = (await roles.api.credits.quote('post.publish', 1, 'FREE')).unitCost;
    expect(unit).toBeGreaterThan(0);
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

  // A workspace billed to its owner's account, holding credits; ownerId is the account owner.
  const workspace = async (credits: number) => {
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
    const account = await worker.account.findUniqueOrThrow({
      where: { id: accountId },
    });
    if (credits > 0) {
      await roles.worker.credits.grant(accountId, {
        type: 'GRANT',
        amount: credits,
      });
    }
    return { organizationId: org.id, accountId, ownerId: account.ownerId };
  };

  // A second workspace of the same account.
  const secondWorkspace = async (ws: Awaited<ReturnType<typeof workspace>>) => {
    const org = await worker.organization.create({
      data: { name: 'ws2-' + randomUUID() },
    });
    await accounts.attachOrganizationToOwner(org.id, ws.ownerId);
    return org.id;
  };

  // A channel and a post of the workspace, for a publish reservation to name.
  const postOf = async (
    organizationId: string,
    data: Record<string, unknown> = {}
  ) => {
    const integration = await worker.integration.create({
      data: {
        organizationId,
        internalId: randomUUID(),
        name: 'channel-' + randomUUID(),
        picture: '/no-picture.jpg',
        providerIdentifier: 'bluesky',
        type: 'social',
        token: 'token',
      },
    });
    const post = await worker.post.create({
      data: {
        organizationId,
        integrationId: integration.id,
        group: randomUUID(),
        content: '<p>hello</p>',
        publishDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        state: 'QUEUE',
        ...data,
      },
    });
    return { post, integrationId: integration.id };
  };

  // Reserves `amount` credits for the workspace under a fresh key, created at `at`.
  const reserve = async (
    s: Services,
    organizationId: string,
    at: Date,
    metadata?: Record<string, unknown>,
    actionKey = 'post.publish',
    quantity = 1
  ) => {
    const idempotencyKey = 'test:' + randomUUID();
    const ledger = await s.credits.reserve({
      organizationId,
      actionKey,
      quantity,
      idempotencyKey,
      metadata: metadata as any,
    });
    await worker.creditLedger.update({
      where: { id: ledger.id },
      data: { createdAt: at },
    });
    return { ...ledger, idempotencyKey };
  };

  // The instant n minutes before now.
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    // The services of the role under test.
    const s = () => roles[role];

    describe('view', () => {
      it('answers the account balance, plan, allotment and ownership', async () => {
        const ws = await workspace(5 * unit);
        await reserve(s(), ws.organizationId, minutesAgo(1));

        const view = await s().balance.view(ws.organizationId, ws.ownerId);

        expect(view).toEqual({
          available: 4 * unit,
          reserved: unit,
          plan: 'FREE',
          allotment: await s().pricing.monthlyAllotment('FREE'),
          low: expect.any(Boolean),
          canTopUp: true,
        });
      });

      it('canTopUp is false for a user who does not own the account', async () => {
        const ws = await workspace(unit);

        const view = await s().balance.view(ws.organizationId, randomUUID());

        expect(view.canTopUp).toBe(false);
      });

      it('low is true below allotment x ratio and false at or above it', async () => {
        const allotment = await s().pricing.monthlyAllotment('FREE');
        const mark = Math.ceil(allotment * s().pricing.lowBalanceRatio());
        expect(mark).toBeGreaterThan(1);
        const below = await workspace(mark - 1);
        const at = await workspace(mark);
        const above = await workspace(mark + 1);

        expect(
          (await s().balance.view(below.organizationId, below.ownerId)).low
        ).toBe(true);
        expect(
          (await s().balance.view(at.organizationId, at.ownerId)).low
        ).toBe(false);
        expect(
          (await s().balance.view(above.organizationId, above.ownerId)).low
        ).toBe(false);
      });

      it('an empty balance is low', async () => {
        const ws = await workspace(0);

        const view = await s().balance.view(ws.organizationId, ws.ownerId);

        expect(view).toMatchObject({ available: 0, reserved: 0, low: true });
      });

      it('a negative balance is shown as the server holds it, and is low', async () => {
        const ws = await workspace(0);
        await worker.creditBucket.create({
          data: {
            accountId: ws.accountId,
            type: 'REVERSAL',
            initial: 0,
            remaining: -7,
          },
        });

        const view = await s().balance.view(ws.organizationId, ws.ownerId);

        expect(view).toMatchObject({ available: -7, low: true });
      });

      it('a paid plan reports its tier plan key and monthly credits as the allotment', async () => {
        const ws = await workspace(0);
        const tier = PRICING.tiers[0];
        await worker.account.update({
          where: { id: ws.accountId },
          data: { planKey: tier.key },
        });

        const view = await s().balance.view(ws.organizationId, ws.ownerId);

        expect(view).toMatchObject({
          plan: tier.key,
          allotment: tier.monthlyCredits,
        });
      });

      it('the reserved figure counts every workspace of the account', async () => {
        const ws = await workspace(10 * unit);
        const other = await secondWorkspace(ws);
        await reserve(s(), ws.organizationId, minutesAgo(2));
        await reserve(s(), other, minutesAgo(1));

        const view = await s().balance.view(ws.organizationId, ws.ownerId);

        expect(view.reserved).toBe(2 * unit);
        expect(view.available).toBe(8 * unit);
      });
    });

    describe('reservations', () => {
      it('lists the RESERVED rows of the workspace newest first with their publish fields', async () => {
        const ws = await workspace(10 * unit);
        const a = await postOf(ws.organizationId);
        const b = await postOf(ws.organizationId);
        // The metadata a publish reservation carries for this post and occurrence.
        const meta = (p: typeof a, occurrence: number) => ({
          postId: p.post.id,
          integrationId: p.integrationId,
          group: p.post.group,
          occurrence,
          publishDate: p.post.publishDate.toISOString(),
        });
        const firstAt = minutesAgo(5);
        const secondAt = minutesAgo(1);
        const first = await reserve(s(), ws.organizationId, firstAt, meta(a, 1));
        const second = await reserve(s(), ws.organizationId, secondAt, meta(b, 2));

        const page = await s().balance.reservations(ws.organizationId, {});

        expect(page.nextCursor).toBeNull();
        expect(page.otherWorkspacesReserved).toBe(0);
        expect(page.items).toEqual([
          {
            ledgerId: second.id,
            actionKey: 'post.publish',
            amount: unit,
            createdAt: secondAt.toISOString(),
            postId: b.post.id,
            integrationId: b.integrationId,
            group: b.post.group,
            occurrence: 2,
            publishDate: b.post.publishDate.toISOString(),
          },
          {
            ledgerId: first.id,
            actionKey: 'post.publish',
            amount: unit,
            createdAt: firstAt.toISOString(),
            postId: a.post.id,
            integrationId: a.integrationId,
            group: a.post.group,
            occurrence: 1,
            publishDate: a.post.publishDate.toISOString(),
          },
        ]);
      });

      it('omits committed and released reservations', async () => {
        const ws = await workspace(10 * unit);
        const kept = await reserve(s(), ws.organizationId, minutesAgo(3));
        const committed = await reserve(s(), ws.organizationId, minutesAgo(2));
        const released = await reserve(s(), ws.organizationId, minutesAgo(1));
        await s().credits.commit(committed.idempotencyKey, undefined, ws.organizationId);
        await s().credits.release(released.idempotencyKey, ws.organizationId);

        const page = await s().balance.reservations(ws.organizationId, {});

        expect(page.items.map((i) => i.ledgerId)).toEqual([kept.id]);
      });

      it('a reservation without publish metadata has only the common fields', async () => {
        const ws = await workspace(10 * unit);
        const at = minutesAgo(1);
        const held = await reserve(s(), ws.organizationId, at, undefined, 'ai.image', 2);
        const price = await s().credits.quote('ai.image', 2, 'FREE');

        const page = await s().balance.reservations(ws.organizationId, {});

        expect(page.items).toEqual([
          {
            ledgerId: held.id,
            actionKey: 'ai.image',
            amount: price.amount,
            createdAt: at.toISOString(),
          },
        ]);
      });

      it('another workspace of the account is only totalled in credits, never listed', async () => {
        const ws = await workspace(10 * unit);
        const otherOrg = await secondWorkspace(ws);
        const theirs = await postOf(otherOrg);
        const mine = await reserve(s(), ws.organizationId, minutesAgo(2));
        await reserve(s(), otherOrg, minutesAgo(1), {
          postId: theirs.post.id,
          integrationId: theirs.integrationId,
          group: theirs.post.group,
          occurrence: 1,
          publishDate: theirs.post.publishDate.toISOString(),
        });

        const page = await s().balance.reservations(ws.organizationId, {});

        expect(page.items.map((i) => i.ledgerId)).toEqual([mine.id]);
        expect(page.otherWorkspacesReserved).toBe(unit);
        expect(JSON.stringify(page)).not.toContain(theirs.post.id);
        expect(JSON.stringify(page)).not.toContain(theirs.post.group);
      });

      it('pages through the list once, in order, with a cursor until the last page', async () => {
        const ws = await workspace(20 * unit);
        const made = [];
        for (let i = 5; i >= 1; i--) {
          made.push(await reserve(s(), ws.organizationId, minutesAgo(i)));
        }
        const expected = made.map((m) => m.id).reverse();

        const first = await s().balance.reservations(ws.organizationId, { limit: 2 });
        const second = await s().balance.reservations(ws.organizationId, {
          limit: 2,
          cursor: first.nextCursor!,
        });
        const third = await s().balance.reservations(ws.organizationId, {
          limit: 2,
          cursor: second.nextCursor!,
        });

        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();
        expect(second.items).toHaveLength(2);
        expect(second.nextCursor).not.toBeNull();
        expect(third.items).toHaveLength(1);
        expect(third.nextCursor).toBeNull();
        expect(
          [...first.items, ...second.items, ...third.items].map((i) => i.ledgerId)
        ).toEqual(expected);
      });

      it('a page that ends exactly at the last row has no next cursor', async () => {
        const ws = await workspace(10 * unit);
        await reserve(s(), ws.organizationId, minutesAgo(2));
        await reserve(s(), ws.organizationId, minutesAgo(1));

        const page = await s().balance.reservations(ws.organizationId, { limit: 2 });

        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
      });

      it('defaults to 20 rows and accepts up to 50', async () => {
        const ws = await workspace(60 * unit);
        for (let i = 0; i < 21; i++) {
          await reserve(s(), ws.organizationId, minutesAgo(30 - i));
        }

        const byDefault = await s().balance.reservations(ws.organizationId, {});
        const wide = await s().balance.reservations(ws.organizationId, { limit: 50 });

        expect(byDefault.items).toHaveLength(20);
        expect(byDefault.nextCursor).not.toBeNull();
        expect(wide.items).toHaveLength(21);
        expect(wide.nextCursor).toBeNull();
      });

      it.each([0, 51, -1, 1.5])('rejects limit %s with 400', async (limit) => {
        const ws = await workspace(unit);

        await expect(
          s().balance.reservations(ws.organizationId, { limit })
        ).rejects.toMatchObject({ status: 400 });
      });

      it('reads group and publish date from the live post, not the reservation snapshot', async () => {
        const ws = await workspace(10 * unit);
        const p = await postOf(ws.organizationId);
        await reserve(s(), ws.organizationId, minutesAgo(1), {
          postId: p.post.id,
          integrationId: p.integrationId,
          group: p.post.group,
          occurrence: 1,
          publishDate: p.post.publishDate.toISOString(),
        });
        const movedGroup = randomUUID();
        const movedDate = new Date(p.post.publishDate.getTime() + 3 * 60 * 60 * 1000);
        await worker.post.update({
          where: { id: p.post.id },
          data: { group: movedGroup, publishDate: movedDate },
        });

        const page = await s().balance.reservations(ws.organizationId, {});

        expect(page.items[0]).toMatchObject({
          postId: p.post.id,
          group: movedGroup,
          publishDate: movedDate.toISOString(),
        });
      });

      it('falls back to the snapshot when the post was deleted', async () => {
        const ws = await workspace(10 * unit);
        const p = await postOf(ws.organizationId);
        await reserve(s(), ws.organizationId, minutesAgo(1), {
          postId: p.post.id,
          integrationId: p.integrationId,
          group: p.post.group,
          occurrence: 1,
          publishDate: p.post.publishDate.toISOString(),
        });
        await worker.post.update({
          where: { id: p.post.id },
          data: { group: randomUUID(), deletedAt: new Date() },
        });

        const page = await s().balance.reservations(ws.organizationId, {});

        expect(page.items[0]).toMatchObject({
          postId: p.post.id,
          group: p.post.group,
          publishDate: p.post.publishDate.toISOString(),
        });
      });

      it('never takes a group from a post of another workspace', async () => {
        const ws = await workspace(10 * unit);
        const stranger = await workspace(0);
        const foreign = await postOf(stranger.organizationId);
        await reserve(s(), ws.organizationId, minutesAgo(1), {
          postId: foreign.post.id,
          integrationId: foreign.integrationId,
          group: 'snapshot-group',
          occurrence: 1,
          publishDate: '2026-01-01T00:00:00.000Z',
        });

        const page = await s().balance.reservations(ws.organizationId, {});

        expect(page.items[0]).toMatchObject({
          group: 'snapshot-group',
          publishDate: '2026-01-01T00:00:00.000Z',
        });
      });
    });
  });

  describe('CreditsController', () => {
    // The route path and HTTP method Nest registers for a controller method.
    const routeOf = (name: 'balance' | 'reservations') => ({
      path: Reflect.getMetadata(
        PATH_METADATA,
        CreditsController.prototype[name]
      ),
      method: Reflect.getMetadata(
        METHOD_METADATA,
        CreditsController.prototype[name]
      ),
    });

    it('serves GET /credits/balance and GET /credits/reservations', () => {
      expect(Reflect.getMetadata(PATH_METADATA, CreditsController)).toBe('/credits');
      expect(routeOf('balance')).toEqual({ path: '/balance', method: RequestMethod.GET });
      expect(routeOf('reservations')).toEqual({
        path: '/reservations',
        method: RequestMethod.GET,
      });
    });

    it('answers the balance for the request workspace and user, and the page for the workspace', async () => {
      const ws = await workspace(3 * unit);
      const held = await reserve(roles.api, ws.organizationId, minutesAgo(1));
      const controller = new CreditsController(roles.api.balance);

      const view = await controller.balance(
        { id: ws.organizationId } as any,
        { id: ws.ownerId } as any
      );
      const page = await controller.reservations(
        { id: ws.organizationId } as any,
        { limit: 5 }
      );

      expect(view).toMatchObject({
        available: 2 * unit,
        reserved: unit,
        canTopUp: true,
      });
      expect(page.items.map((i) => i.ledgerId)).toEqual([held.id]);
    });
  });
});
