// Pricing config: the pricing file reaches the database at start-up, and a change
// reaches new charges, grants and purchases only.
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import {
  PricingConfigError,
  PricingService,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import {
  PRICING,
  PricingConfig,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { PricingController } from '@gitroom/backend/api/routes/pricing.controller';
import { HttpException, RequestMethod } from '@nestjs/common';
import { Organization, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// The file under test is a copy each test may edit; the checked-in values stay in FILE.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config',
  () => {
    const actual = jest.requireActual(
      '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config'
    );
    return { ...actual, PRICING: structuredClone(actual.PRICING) };
  }
);
const FILE: PricingConfig = jest.requireActual(
  '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config'
).PRICING;

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Services run as the API role (the backend); direct database edits use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// Only Date is faked: Prisma keeps its real timers.
const atTime = (iso: string) =>
  jest.useFakeTimers({
    now: new Date(iso),
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

describe('pricing file', () => {
  it('holds the starting values', () => {
    expect(FILE).toEqual({
      actions: [
        { key: 'post.publish', cost: 1, unit: 'ITEM', description: expect.any(String) },
        { key: 'ai.text', cost: 1, unit: 'CALL', description: expect.any(String) },
        { key: 'ai.image', cost: 5, unit: 'ITEM', description: expect.any(String) },
        { key: 'ai.video.per_second', cost: 2, unit: 'SECOND', description: expect.any(String) },
        { key: 'ai.clip.per_minute', cost: 5, unit: 'ITEM', description: expect.any(String) },
        { key: 'ai.captions.per_minute', cost: 1, unit: 'ITEM', description: expect.any(String) },
        { key: 'ai.edit.basic', cost: 1, unit: 'ITEM', description: expect.any(String) },
        { key: 'ai.edit.standard', cost: 2, unit: 'ITEM', description: expect.any(String) },
        { key: 'ai.edit.heavy', cost: 3, unit: 'ITEM', description: expect.any(String) },
        { key: 'brand.create', cost: 0, unit: 'CALL', description: expect.any(String) },
        { key: 'channel.connect', cost: 0, unit: 'CALL', description: expect.any(String) },
        { key: 'plan.setup_round', cost: 0, unit: 'CALL', description: expect.any(String) },
        { key: 'plan.proposal', cost: 0, unit: 'CALL', description: expect.any(String) },
        { key: 'plan.instant', cost: 0, unit: 'CALL', description: expect.any(String) },
        { key: 'plan.week', cost: 0, unit: 'CALL', description: expect.any(String) },
        { key: 'plan.day', cost: 0, unit: 'CALL', description: expect.any(String) },
        { key: 'plan.roadmap', cost: 0, unit: 'CALL', description: expect.any(String) },
      ],
      free: { monthlyGrant: 50, monthlyAiCap: 25 },
      tiers: [
        { key: 'STARTER', name: expect.any(String), monthlyPriceCents: 900, currency: 'USD', monthlyCredits: 300 },
        { key: 'PRO', name: expect.any(String), monthlyPriceCents: 2900, currency: 'USD', monthlyCredits: 1200 },
        { key: 'AGENCY', name: expect.any(String), monthlyPriceCents: 7900, currency: 'USD', monthlyCredits: 4000 },
      ],
      topupPacks: [
        { key: 'pack.100', credits: 100, priceCents: 500, currency: 'USD' },
        { key: 'pack.500', credits: 500, priceCents: 2000, currency: 'USD' },
        { key: 'pack.2000', credits: 2000, priceCents: 7000, currency: 'USD' },
      ],
      lowBalanceRatio: 0.2,
      features: {
        crop_9_16: 'FREE',
        floating_cam: 'FREE',
        drawing_board: 'FREE',
        slide_ink: 'FREE',
        auto_publish: 'FREE',
        crop_4_5: 'STARTER',
        crop_1_1: 'STARTER',
        ai_captions: 'STARTER',
        bg_replace: 'PRO',
        bg_custom: 'PRO',
      },
    });
  });
});

describeDb('PricingService (Postgres)', () => {
  let api: PrismaService;
  let worker: PrismaClient;
  let pricing: PricingService;
  let credits: CreditsService;
  let accounts: AccountsService;
  const clients: PrismaService[] = [];

  // A pricing service on its own client, wired as the database module wires it.
  const pricingOn = (prisma: PrismaService) => {
    const repo = new PrismaRepository<any>(prisma);
    const accountsService = new AccountsService(new AccountsRepository(repo, repo, repo));
    const scope = new MoneyScope(new PrismaTransaction(prisma), accountsService);
    const creditsService = new CreditsService(
      new CreditsRepository(scope, repo, repo, repo),
      accountsService,
      scope
    );
    return {
      pricing: new PricingService(
        new PricingRepository(new PrismaTransaction(prisma), repo, repo),
        creditsService,
        accountsService
      ),
      credits: creditsService,
      accounts: accountsService,
    };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    ({ pricing, credits, accounts } = pricingOn(api));
    await pricing.sync();
  });

  // Each test starts from the checked-in file, synced
  afterEach(async () => {
    jest.useRealTimers();
    Object.assign(PRICING, structuredClone(FILE));
    await pricing.sync();
  });

  afterAll(async () => {
    await api.$disconnect();
    await worker.$disconnect();
    await Promise.all(clients.map((client) => client.$disconnect()));
  });

  // An action key no other test uses
  const actionKey = () => 'test.p' + randomUUID().replace(/-/g, '').slice(0, 16);

  // Adds an action to the file under test
  const addAction = (action: PricingConfig['actions'][number]) => {
    PRICING.actions.push(action);
    return action;
  };

  const fileAction = (key: string) => PRICING.actions.find((a) => a.key === key)!;

  const registry = (key: string) =>
    worker.creditAction.findUnique({ where: { key }, include: { planOverrides: true } });

  // A user with a workspace, billed to the user's own account
  const workspace = async () => {
    const org = await api.organization.create({
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

  describe('sync of actions', () => {
    it('makes the registry hold exactly the actions of the file, at their prices', async () => {
      await worker.creditAction.create({
        data: { key: actionKey(), cost: 7, unit: 'CALL' },
      });
      await pricing.sync();

      const stored = await worker.creditAction.findMany({ include: { planOverrides: true } });
      expect(stored.map((a) => a.key).sort()).toEqual(FILE.actions.map((a) => a.key).sort());
      for (const action of FILE.actions) {
        const row = stored.find((a) => a.key === action.key)!;
        expect(row).toMatchObject({
          cost: action.cost,
          unit: action.unit,
          description: action.description,
        });
        expect(row.planOverrides).toEqual([]);
        const quote = await credits.quote(action.key, 1, 'FREE');
        expect(quote.unitCost).toBe(action.cost);
      }
    });

    it('creates an action that is new in the file at version 1, with its plan costs', async () => {
      const { key } = addAction({
        key: actionKey(),
        cost: 3,
        unit: 'CALL',
        description: 'new',
        planCosts: { PRO: 2 },
      });

      const report = await pricing.sync();

      expect(report.created).toEqual([key]);
      expect(report.repriced).toEqual([]);
      expect(await registry(key)).toMatchObject({ cost: 3, unit: 'CALL', version: 1 });
      expect((await credits.quote(key, 1, 'FREE')).unitCost).toBe(3);
      expect(await credits.quote(key, 1, 'PRO')).toMatchObject({ unitCost: 2, actionVersion: 1 });
    });

    it('bumps the version by exactly 1 on a cost change, and quotes use the new price', async () => {
      const { key } = addAction({ key: actionKey(), cost: 3, unit: 'CALL', description: 'd' });
      await pricing.sync();

      fileAction(key).cost = 4;
      const report = await pricing.sync();

      expect(report.repriced).toEqual([{ key, version: 2 }]);
      expect(await credits.quote(key, 2, 'FREE')).toMatchObject({
        actionVersion: 2,
        unitCost: 4,
        amount: 8,
      });
      const again = await pricing.sync();
      expect(again.repriced).toEqual([]);
      expect((await registry(key))!.version).toBe(2);
    });

    it('bumps the version by exactly 1 on a unit change', async () => {
      const { key } = addAction({ key: actionKey(), cost: 3, unit: 'CALL', description: 'd' });
      await pricing.sync();

      fileAction(key).unit = 'ITEM';
      const report = await pricing.sync();

      expect(report.repriced).toEqual([{ key, version: 2 }]);
      expect(await registry(key)).toMatchObject({ unit: 'ITEM', version: 2 });
    });

    it('bumps the version by exactly 1 when a plan cost is added, changed or removed', async () => {
      const { key } = addAction({ key: actionKey(), cost: 3, unit: 'CALL', description: 'd' });
      await pricing.sync();

      fileAction(key).planCosts = { PRO: 2 };
      expect((await pricing.sync()).repriced).toEqual([{ key, version: 2 }]);
      expect(await credits.quote(key, 1, 'PRO')).toMatchObject({ unitCost: 2, actionVersion: 2 });

      fileAction(key).planCosts = { PRO: 1 };
      expect((await pricing.sync()).repriced).toEqual([{ key, version: 3 }]);
      expect(await credits.quote(key, 1, 'PRO')).toMatchObject({ unitCost: 1, actionVersion: 3 });

      fileAction(key).planCosts = {};
      expect((await pricing.sync()).repriced).toEqual([{ key, version: 4 }]);
      expect(await credits.quote(key, 1, 'PRO')).toMatchObject({ unitCost: 3, actionVersion: 4 });
      expect((await registry(key))!.planOverrides).toEqual([]);
    });

    it('updates a description-only change without bumping the version', async () => {
      const { key } = addAction({ key: actionKey(), cost: 3, unit: 'CALL', description: 'old' });
      await pricing.sync();

      fileAction(key).description = 'new';
      const report = await pricing.sync();

      expect(report.repriced).toEqual([]);
      expect(await registry(key)).toMatchObject({ description: 'new', version: 1 });
    });

    it('removes an action missing from the file with its plan overrides, and quoting it fails closed', async () => {
      const { key } = addAction({
        key: actionKey(),
        cost: 3,
        unit: 'CALL',
        description: 'd',
        planCosts: { PRO: 1, AGENCY: 0 },
      });
      await pricing.sync();

      PRICING.actions = PRICING.actions.filter((a) => a.key !== key);
      const report = await pricing.sync();

      expect(report.removed).toEqual([key]);
      expect(await registry(key)).toBeNull();
      expect(await worker.creditPlanOverride.count({ where: { actionKey: key } })).toBe(0);
      const quote = credits.quote(key, 1, 'FREE');
      await expect(quote).rejects.toBeInstanceOf(HttpException);
      await expect(quote).rejects.toMatchObject({ status: 500 });
    });

    it('overwrites a hand edit in the database at the next start', async () => {
      const { key } = addAction({
        key: actionKey(),
        cost: 3,
        unit: 'CALL',
        description: 'd',
        planCosts: { PRO: 2 },
      });
      await pricing.sync();
      await worker.creditAction.update({ where: { key }, data: { cost: 99 } });
      await worker.creditPlanOverride.deleteMany({ where: { actionKey: key } });

      await pricing.sync();

      expect(await registry(key)).toMatchObject({ cost: 3, version: 2 });
      expect((await credits.quote(key, 1, 'PRO')).unitCost).toBe(2);
    });

    it('commits a reservation made before a price change at its snapshot price', async () => {
      const { key } = addAction({ key: actionKey(), cost: 4, unit: 'CALL', description: 'd' });
      await pricing.sync();
      const { accountId, organizationId } = await workspace();
      await credits.grant(accountId, { type: 'GRANT', amount: 100 });
      const idempotencyKey = 'test:' + randomUUID();
      const reserved = await credits.reserve({ organizationId, actionKey: key, idempotencyKey });
      expect(reserved).toMatchObject({ unitCost: 4, actionVersion: 1 });

      fileAction(key).cost = 10;
      await pricing.sync();

      const committed = await credits.commit(idempotencyKey, undefined, organizationId);
      expect(committed).toMatchObject({ committed: 4, unitCost: 4, actionVersion: 1 });
      expect((await credits.balance(organizationId)).available).toBe(96);
      expect((await credits.quote(key, 1, 'FREE')).unitCost).toBe(10);
    });

    it('converges when several processes sync at once, bumping each change once', async () => {
      for (let i = 0; i < 3; i++) {
        const client = new PrismaService();
        await client.$connect();
        clients.push(client);
      }
      const services = [api, ...clients].map((client) => pricingOn(client).pricing);
      const syncAll = () =>
        Promise.all([...services, ...services].map((service) => service.sync()));

      const created = addAction({ key: actionKey(), cost: 3, unit: 'CALL', description: 'd' });
      const first = await syncAll();
      expect(first.flatMap((report) => report.created)).toEqual([created.key]);
      expect((await registry(created.key))!.version).toBe(1);

      fileAction(created.key).cost = 5;
      fileAction(created.key).planCosts = { STARTER: 4 };
      const second = await syncAll();
      expect(second.flatMap((report) => report.repriced)).toEqual([
        { key: created.key, version: 2 },
      ]);
      expect(await registry(created.key)).toMatchObject({ cost: 5, version: 2 });
      expect((await registry(created.key))!.planOverrides).toHaveLength(1);
      expect(await credits.quote(created.key, 1, 'STARTER')).toMatchObject({
        unitCost: 4,
        actionVersion: 2,
      });
    });
  });

  describe('an invalid file', () => {
    const invalid: [string, (config: PricingConfig) => void][] = [
      ['a duplicate action key', (c) => c.actions.push({ ...c.actions[0] })],
      ['a malformed action key', (c) => (c.actions[0].key = 'Post Publish')],
      ['a non-integer cost', (c) => (c.actions[0].cost = 1.5)],
      ['a negative cost', (c) => (c.actions[0].cost = -1)],
      ['a negative plan cost', (c) => (c.actions[0].planCosts = { PRO: -1 })],
      ['an unknown plan in planCosts', (c) => (c.actions[0].planCosts = { ENTERPRISE: 1 } as any)],
      ['a non-integer free grant', (c) => (c.free.monthlyGrant = 10.5)],
      ['a negative free AI cap', (c) => (c.free.monthlyAiCap = -1)],
      ['a duplicate tier', (c) => c.tiers.push({ ...c.tiers[0] })],
      ['an unknown tier key', (c) => (c.tiers[0].key = 'FREE' as any)],
      ['negative tier credits', (c) => (c.tiers[0].monthlyCredits = -300)],
      ['a non-integer tier price', (c) => (c.tiers[0].monthlyPriceCents = 9.99)],
      ['a duplicate pack', (c) => c.topupPacks.push({ ...c.topupPacks[0] })],
      ['a malformed pack key', (c) => (c.topupPacks[0].key = '')],
      ['negative pack credits', (c) => (c.topupPacks[0].credits = -1)],
      ['a non-integer pack price', (c) => (c.topupPacks[0].priceCents = 4.5)],
      ['a ratio of 0', (c) => (c.lowBalanceRatio = 0)],
      ['a ratio of 1', (c) => (c.lowBalanceRatio = 1)],
    ];

    it.each(invalid)('with %s fails with PricingConfigError and writes nothing', async (_, breakIt) => {
      const { key } = addAction({ key: actionKey(), cost: 3, unit: 'CALL', description: 'd' });
      breakIt(PRICING);

      await expect(pricing.sync()).rejects.toBeInstanceOf(PricingConfigError);
      expect(await registry(key)).toBeNull();
    });

    it('stops the process at start-up: the service cannot be built', () => {
      PRICING.lowBalanceRatio = 2;
      expect(() => pricingOn(api)).toThrow(PricingConfigError);
    });
  });

  describe('free monthly grant and AI cap', () => {
    beforeEach(async () => {
      await worker.creditSetting.deleteMany();
    });

    afterAll(async () => {
      await worker.creditSetting.deleteMany();
    });

    it('are in effect now after the first sync', async () => {
      atTime('2030-05-10T12:00:00Z');
      const report = await pricing.sync();

      expect(report.scheduled).toEqual([]);
      expect(await pricing.freeMonthlyGrant()).toBe(50);
      expect(await pricing.freeMonthlyAiCap()).toBe(25);
      expect(await pricing.freeMonthlyGrant(new Date('2030-05-01T00:00:00Z'))).toBe(50);
    });

    it('take a changed value from the next UTC month', async () => {
      atTime('2030-05-31T23:30:00Z');
      await pricing.sync();
      PRICING.free = { monthlyGrant: 80, monthlyAiCap: 40 };

      const report = await pricing.sync();

      const june = new Date('2030-06-01T00:00:00Z');
      expect(report.scheduled).toEqual([
        { key: 'free.monthlyGrant', value: 80, effectiveFrom: june },
        { key: 'free.monthlyAiCap', value: 40, effectiveFrom: june },
      ]);
      expect(await pricing.freeMonthlyGrant()).toBe(50);
      expect(await pricing.freeMonthlyAiCap()).toBe(25);
      expect(await pricing.freeMonthlyGrant(june)).toBe(80);
      expect(await pricing.freeMonthlyAiCap(new Date('2030-06-30T23:59:59Z'))).toBe(40);

      atTime('2030-06-01T00:00:01Z');
      expect(await pricing.freeMonthlyGrant()).toBe(80);
      expect(await pricing.freeMonthlyAiCap()).toBe(40);
      expect((await pricing.sync()).scheduled).toEqual([]);
    });

    it('keep one pending change when the same change is synced again', async () => {
      atTime('2030-05-10T12:00:00Z');
      await pricing.sync();
      PRICING.free.monthlyGrant = 80;
      await pricing.sync();

      expect((await pricing.sync()).scheduled).toEqual([]);
      expect(await worker.creditSetting.count({ where: { key: 'free.monthlyGrant' } })).toBe(2);
    });

    it('cancel a pending change when the file is set back before the next month', async () => {
      atTime('2030-05-10T12:00:00Z');
      await pricing.sync();
      PRICING.free.monthlyGrant = 80;
      await pricing.sync();

      PRICING.free.monthlyGrant = 50;
      await pricing.sync();

      expect(await pricing.freeMonthlyGrant(new Date('2030-06-15T00:00:00Z'))).toBe(50);
      expect(await pricing.freeMonthlyGrant(new Date('2030-07-15T00:00:00Z'))).toBe(50);
    });

    it('replace a pending change with a newer one', async () => {
      atTime('2030-05-10T12:00:00Z');
      await pricing.sync();
      PRICING.free.monthlyGrant = 80;
      await pricing.sync();
      PRICING.free.monthlyGrant = 90;

      const report = await pricing.sync();

      expect(report.scheduled).toEqual([
        { key: 'free.monthlyGrant', value: 90, effectiveFrom: new Date('2030-06-01T00:00:00Z') },
      ]);
      expect(await pricing.freeMonthlyGrant(new Date('2030-06-15T00:00:00Z'))).toBe(90);
    });

    it('give a month before the first sync the first value', async () => {
      atTime('2030-05-10T12:00:00Z');
      await pricing.sync();

      expect(await pricing.freeMonthlyGrant(new Date('2029-01-15T00:00:00Z'))).toBe(50);
    });

    it('converge when several processes sync a change at once', async () => {
      atTime('2030-05-10T12:00:00Z');
      await pricing.sync();
      PRICING.free.monthlyAiCap = 30;

      await Promise.all(
        [api, ...clients, api].map((client) => pricingOn(client).pricing.sync())
      );

      expect(
        await worker.creditSetting.findMany({
          where: { key: 'free.monthlyAiCap' },
          orderBy: { effectiveFrom: 'asc' },
          select: { value: true, effectiveFrom: true },
        })
      ).toEqual([
        { value: 25, effectiveFrom: new Date('2030-05-01T00:00:00Z') },
        { value: 30, effectiveFrom: new Date('2030-06-01T00:00:00Z') },
      ]);
    });
  });

  describe('file values', () => {
    beforeAll(async () => {
      await pricing.sync();
    });

    it('serves tiers, packs and the low-balance ratio from the file', () => {
      expect(pricing.tiers()).toEqual(FILE.tiers);
      expect(pricing.tier('PRO')).toEqual(FILE.tiers[1]);
      expect(pricing.tier('FREE')).toBeUndefined();
      expect(pricing.topupPacks()).toEqual(FILE.topupPacks);
      expect(pricing.topupPack('pack.500')).toEqual(FILE.topupPacks[1]);
      expect(pricing.topupPack('pack.1')).toBeUndefined();
      expect(pricing.lowBalanceRatio()).toBe(0.2);
    });

    it('reads a tier or pack change from the file directly', () => {
      PRICING.tiers[0].monthlyCredits = 350;
      PRICING.topupPacks[0].priceCents = 600;

      expect(pricing.tier('STARTER')!.monthlyCredits).toBe(350);
      expect(pricing.topupPack('pack.100')!.priceCents).toBe(600);
    });

    it('gives each plan its monthly allotment', async () => {
      expect(await pricing.monthlyAllotment('FREE')).toBe(await pricing.freeMonthlyGrant());
      expect(await pricing.monthlyAllotment('STARTER')).toBe(300);
      expect(await pricing.monthlyAllotment('PRO')).toBe(1200);
      expect(await pricing.monthlyAllotment('AGENCY')).toBe(4000);
      await expect(pricing.monthlyAllotment('ENTERPRISE')).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('GET /credits/pricing', () => {
    it('is served by the credits controller', () => {
      expect(Reflect.getMetadata('path', PricingController)).toBe('/credits');
      const handler = PricingController.prototype.getPricing;
      expect(Reflect.getMetadata('path', handler)).toBe('/pricing');
      expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.GET);
    });

    it("returns the workspace account's plan, its prices, the tiers, the packs and the free values", async () => {
      const { key } = addAction({
        key: actionKey(),
        cost: 3,
        unit: 'SECOND',
        description: 'priced per plan',
        planCosts: { PRO: 1 },
      });
      await pricing.sync();
      const { accountId, organizationId } = await workspace();
      const controller = new PricingController(pricing);
      const org = { id: organizationId } as Organization;

      const free = await controller.getPricing(org);

      expect(free).toEqual({
        plan: 'FREE',
        actions: PRICING.actions.map((action) => ({
          key: action.key,
          unit: action.unit,
          unitCost: action.cost,
          description: action.description,
        })),
        tiers: FILE.tiers,
        topupPacks: FILE.topupPacks,
        free: { monthlyGrant: 50, monthlyAiCap: 25 },
      });

      await worker.account.update({ where: { id: accountId }, data: { planKey: 'PRO' } });
      const pro = await controller.getPricing(org);
      expect(pro.plan).toBe('PRO');
      expect(pro.actions.find((a) => a.key === key)).toEqual({
        key,
        unit: 'SECOND',
        unitCost: 1,
        description: 'priced per plan',
      });
    });
  });
});
