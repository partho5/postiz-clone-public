// PayPal subscriptions: the plan catalogue follows the pricing file, an account's subscription
// is owned by its owner, and each PAYMENT.SALE.COMPLETED event id grants the tier's credits once.
//
// Runs against a real Postgres (migrated and given the API role by the jest global setup), on both
// database roles, with the real PayPal client, webhook intake, credit services and plans controller.
// Only PayPal is a stand-in: a local HTTP server that keeps products, plans and subscriptions.
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { validate } from 'class-validator';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
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
import { PaypalClient } from '@gitroom/nestjs-libraries/services/paypal/paypal.client';
import { PaypalEventsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.events.repository';
import {
  PaypalEvent,
  PaypalWebhookIntake,
} from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';
import { PaypalSubscriptionsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.repository';
import { PaypalSubscriptionsService } from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.service';
import { PaypalProvider } from '@gitroom/nestjs-libraries/services/payment/providers/paypal.provider';
import { PlansController } from '@gitroom/backend/api/routes/plans.controller';
import {
  PlanConfirmDto,
  PlanTierDto,
} from '@gitroom/nestjs-libraries/dtos/billing/paypal.plan.dto';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type Seen = { method: string; url: string; body: any; requestId?: string };
interface FakeSubscription {
  id: string;
  plan_id: string;
  custom_id: string;
  status: string;
  billing_info: { next_billing_time?: string };
}

// What the stand-in PayPal holds, replaced before every test.
let fake: {
  seen: Seen[];
  products: number;
  plans: Map<string, { product_id: string; price: string; body: any }>;
  subscriptions: Map<string, FakeSubscription>;
  transactions: Map<string, { id: string; status: string; time: string }[]>;
  cached: Map<string, { status: number; body: unknown }>;
  failing: Set<string>;
  verification: 'SUCCESS' | 'FAILURE';
  approveOnRevise: boolean;
  counter: number;
};
let server: Server;
let baseUrl: string;

// Answers with JSON, or an empty body for 204.
const reply = (res: ServerResponse, status: number, body?: unknown) => {
  if (status === 204) {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body ?? {}));
};

// The next PayPal-style id with this prefix.
const nextId = (prefix: string) => `${prefix}-${++fake.counter}-${randomUUID()}`;

// One PayPal call: the answer a real PayPal would give for the endpoints the service uses.
const paypal = (
  method: string,
  path: string,
  query: URLSearchParams,
  body: any,
  requestId: string | undefined,
  res: ServerResponse
) => {
  const seen = { method, url: path + (query.size ? `?${query}` : ''), body, requestId };
  fake.seen.push(seen);
  if (fake.failing.has(path) || [...fake.failing].some((f) => path.startsWith(f))) {
    return reply(res, 500, { name: 'INTERNAL_SERVICE_ERROR' });
  }
  const cacheKey = method === 'POST' && requestId ? `${path}|${requestId}` : null;
  if (cacheKey && fake.cached.has(cacheKey)) {
    const first = fake.cached.get(cacheKey)!;
    return reply(res, first.status, first.body);
  }
  const answer = (status: number, answerBody?: unknown) => {
    if (cacheKey) {
      fake.cached.set(cacheKey, { status, body: answerBody });
    }
    return reply(res, status, answerBody);
  };
  if (path === '/v1/notifications/verify-webhook-signature') {
    return reply(res, 200, { verification_status: fake.verification });
  }
  if (method === 'POST' && path === '/v1/catalogs/products') {
    fake.products++;
    return answer(201, { id: nextId('PROD') });
  }
  if (method === 'POST' && path === '/v1/billing/plans') {
    const id = nextId('P');
    fake.plans.set(id, {
      product_id: body.product_id,
      price: body.billing_cycles[0].pricing_scheme.fixed_price.value,
      body,
    });
    return answer(201, { id, status: 'ACTIVE' });
  }
  let match = path.match(/^\/v1\/billing\/plans\/([^/]+)\/update-pricing-schemes$/);
  if (method === 'POST' && match) {
    fake.plans.get(match[1])!.price =
      body.pricing_schemes[0].pricing_scheme.fixed_price.value;
    return answer(204);
  }
  if (method === 'POST' && path === '/v1/billing/subscriptions') {
    const id = nextId('I');
    fake.subscriptions.set(id, {
      id,
      plan_id: body.plan_id,
      custom_id: body.custom_id,
      status: 'APPROVAL_PENDING',
      billing_info: {},
    });
    return answer(201, {
      id,
      status: 'APPROVAL_PENDING',
      links: [{ rel: 'approve', href: `https://paypal.test/approve/${id}` }],
    });
  }
  match = path.match(/^\/v1\/billing\/subscriptions\/([^/]+)(\/[a-z]+)?$/);
  if (match) {
    const subscription = fake.subscriptions.get(match[1]);
    if (!subscription) {
      return reply(res, 404, { name: 'RESOURCE_NOT_FOUND' });
    }
    if (method === 'GET' && !match[2]) {
      return reply(res, 200, subscription);
    }
    if (method === 'GET' && match[2] === '/transactions') {
      return reply(res, 200, {
        transactions: fake.transactions.get(subscription.id) || [],
      });
    }
    if (method === 'POST' && match[2] === '/cancel') {
      subscription.status = 'CANCELLED';
      delete subscription.billing_info.next_billing_time;
      return answer(204);
    }
    if (method === 'POST' && match[2] === '/revise') {
      return answer(200, {
        plan_id: body.plan_id,
        links: fake.approveOnRevise
          ? [{ rel: 'approve', href: `https://paypal.test/revise/${subscription.id}` }]
          : [],
      });
    }
  }
  return reply(res, 404, { name: 'RESOURCE_NOT_FOUND' });
};

// Empties the stand-in PayPal's products, plans, subscriptions and recorded calls.
const resetFake = () => {
  fake = {
    seen: [],
    products: 0,
    plans: new Map(),
    subscriptions: new Map(),
    transactions: new Map(),
    cached: new Map(),
    failing: new Set(),
    verification: 'SUCCESS',
    approveOnRevise: true,
    counter: 0,
  };
};

beforeAll(async () => {
  resetFake();
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const parsed = new URL(req.url!, 'http://paypal.test');
      if (parsed.pathname === '/v1/oauth2/token') {
        return reply(res, 200, { access_token: 'token', expires_in: 32400 });
      }
      const text = Buffer.concat(chunks).toString('utf8');
      paypal(
        req.method!,
        parsed.pathname,
        parsed.searchParams,
        text ? JSON.parse(text) : undefined,
        req.headers['paypal-request-id'] as string | undefined,
        res
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// The signature headers PayPal sends with a webhook.
const signed = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.paypal.com/cert.pem',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig',
  'paypal-transmission-time': '2026-10-01T10:00:00Z',
};

const DAY = 24 * 60 * 60 * 1000;
// The moment this many days from now.
const inDays = (days: number) => new Date(Date.now() + days * DAY);

// A PAYMENT.SALE.COMPLETED event for a subscription, with fresh ids unless given.
const saleEvent = (
  subscriptionId: string | undefined,
  saleId = 'SALE-' + randomUUID(),
  id = 'WH-' + randomUUID(),
  createTime = new Date().toISOString()
): PaypalEvent => ({
  id,
  event_type: 'PAYMENT.SALE.COMPLETED',
  resource_type: 'sale',
  resource: {
    id: saleId,
    state: 'completed',
    create_time: createTime,
    ...(subscriptionId ? { billing_agreement_id: subscriptionId } : {}),
  },
  create_time: createTime,
});

// A BILLING.SUBSCRIPTION.* event about a subscription.
const subscriptionEvent = (type: string, subscriptionId: string): PaypalEvent => ({
  id: 'WH-' + randomUUID(),
  event_type: type,
  resource_type: 'subscription',
  resource: { id: subscriptionId },
  create_time: new Date().toISOString(),
});

describeDb('PaypalSubscriptionsService (Postgres)', () => {
  let apiService: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;
  const savedEnv: Record<string, string | undefined> = {};
  const envNames = [
    'PAYPAL_API_BASE',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
    'FRONTEND_URL',
  ];
  // The pricing file's tiers as they are before any test edits them: the objects, and a copy of their values.
  const originalTiers = [...PRICING.tiers];
  const savedTiers = JSON.stringify(PRICING.tiers);

  interface Wired {
    service: PaypalSubscriptionsService;
    intake: PaypalWebhookIntake;
    controller: PlansController;
    provider: PaypalProvider;
    accounts: AccountsService;
  }

  // The services on a given client, wired as the database module wires them.
  const wire = (prisma: PrismaService): Wired => {
    const repo = new PrismaRepository<any>(prisma);
    const accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const moneyScope = new MoneyScope(new PrismaTransaction(prisma), accounts);
    const creditsRepository = new CreditsRepository(moneyScope, repo, repo, repo);
    const credits = new CreditsService(creditsRepository, accounts, moneyScope);
    const client = new PaypalClient();
    const intake = new PaypalWebhookIntake(
      client,
      new PaypalEventsRepository(new PrismaTransaction(prisma), repo)
    );
    const service = new PaypalSubscriptionsService(
      client,
      intake,
      new PaypalSubscriptionsRepository(repo, repo, repo),
      new PricingService(
        new PricingRepository(new PrismaTransaction(prisma), repo, repo),
        credits,
        accounts
      ),
      new CreditGrantsService(
        creditsRepository,
        new CreditGrantsRepository(moneyScope)
      ),
      accounts
    );
    return {
      service,
      intake,
      accounts,
      controller: new PlansController(service),
      provider: new PaypalProvider(intake, service),
    };
  };
  const roles: Record<'api' | 'worker', Wired> = {} as any;

  beforeAll(async () => {
    for (const name of envNames) {
      savedEnv[name] = process.env[name];
    }
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    apiService = new PrismaService();
    await apiService.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerService = new PrismaService();
    expect(apiService.role).toBe('api');
    expect(workerService.role).toBe('worker');
    await workerService.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(apiService);
    const accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const moneyScope = new MoneyScope(new PrismaTransaction(apiService), accounts);
    await new PricingService(
      new PricingRepository(new PrismaTransaction(apiService), repo, repo),
      new CreditsService(
        new CreditsRepository(moneyScope, repo, repo, repo),
        accounts,
        moneyScope
      ),
      accounts
    ).sync();
  });

  afterAll(async () => {
    await apiService.$disconnect();
    await workerService.$disconnect();
    await worker.$disconnect();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  beforeEach(async () => {
    resetFake();
    PRICING.tiers.splice(0, PRICING.tiers.length, ...originalTiers);
    originalTiers.forEach((t, i) => Object.assign(t, JSON.parse(savedTiers)[i]));
    process.env.PAYPAL_API_BASE = baseUrl;
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    process.env.PAYPAL_WEBHOOK_ID = 'WH-CONFIG';
    process.env.FRONTEND_URL = 'https://app.test';
    await worker.paypalPlan.deleteMany();
    roles.api = wire(apiService);
    roles.worker = wire(workerService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // A workspace whose creator owns the account billed for it.
  const workspace = async () => {
    const owner = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        timezone: 0,
      },
    });
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: { create: { role: 'SUPERADMIN', userId: owner.id } },
      },
    });
    const accountId = await roles.worker.accounts.getAccountIdForOrganization(org.id);
    return { organizationId: org.id, accountId, ownerId: owner.id };
  };

  // Another user in the workspace, who is not the account's owner.
  const member = async (organizationId: string) => {
    const user = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        timezone: 0,
      },
    });
    await worker.userOrganization.create({
      data: { organizationId, userId: user.id, role: 'ADMIN' },
    });
    return user.id;
  };

  const tier = PRICING.tiers[0];
  const otherTier = PRICING.tiers[1];
  const buckets = (accountId: string) =>
    worker.creditBucket.findMany({ where: { accountId } });
  const planKeyOf = async (accountId: string) =>
    (await worker.account.findUnique({ where: { id: accountId } }))!.planKey;
  const calls = (method: string, startsWith: string) =>
    fake.seen.filter((s) => s.method === method && s.url.startsWith(startsWith));

  // Subscribes the owner and has PayPal activate the subscription, billing again at `next`.
  const subscribed = async (
    w: Wired,
    ws: Awaited<ReturnType<typeof workspace>>,
    tierKey = tier.key,
    next = inDays(30)
  ) => {
    const { subscriptionId } = await w.service.subscribe(
      ws.organizationId,
      ws.ownerId,
      tierKey
    );
    const stored = fake.subscriptions.get(subscriptionId)!;
    stored.status = 'ACTIVE';
    stored.billing_info.next_billing_time = next.toISOString();
    await w.service.confirm(ws.organizationId, ws.ownerId, subscriptionId);
    return subscriptionId;
  };

  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      return err as HttpException;
    }
    throw new Error('expected the call to fail');
  };
  const bodyOf = (err: HttpException) => err.getResponse() as any;

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const w = () => roles[role];

    describe('syncPlans', () => {
      it('creates one PayPal product and one monthly plan per tier of the pricing file, with its price, and stores their ids', async () => {
        await w().service.syncPlans();

        expect(fake.products).toBe(PRICING.tiers.length);
        expect(fake.plans.size).toBe(PRICING.tiers.length);
        const rows = await worker.paypalPlan.findMany();
        expect(rows.map((r) => r.tierKey).sort()).toEqual(
          PRICING.tiers.map((t) => t.key).sort()
        );
        for (const t of PRICING.tiers) {
          const row = rows.find((r) => r.tierKey === t.key)!;
          expect(row.priceCents).toBe(t.monthlyPriceCents);
          expect(row.currency).toBe(t.currency);
          const created = fake.plans.get(row.planId)!;
          expect(created.price).toBe((t.monthlyPriceCents / 100).toFixed(2));
          const cycle = created.body.billing_cycles[0];
          expect(cycle.frequency).toEqual({ interval_unit: 'MONTH', interval_count: 1 });
          expect(cycle.pricing_scheme.fixed_price.currency_code).toBe(t.currency);
        }
      });

      it('creates nothing again when the plans already match the pricing file', async () => {
        await w().service.syncPlans();
        const before = fake.seen.length;

        await w().service.syncPlans();

        expect(fake.seen.length).toBe(before);
        expect(await worker.paypalPlan.count()).toBe(PRICING.tiers.length);
      });

      it('updates the price of a tier whose price changed, keeping its plan and every other plan', async () => {
        await w().service.syncPlans();
        const before = await worker.paypalPlan.findFirst({ where: { tierKey: tier.key } });
        PRICING.tiers[0].monthlyPriceCents += 100;

        await w().service.syncPlans();

        const after = await worker.paypalPlan.findFirst({ where: { tierKey: tier.key } });
        expect(after!.planId).toBe(before!.planId);
        expect(after!.priceCents).toBe(tier.monthlyPriceCents);
        expect(fake.plans.get(after!.planId)!.price).toBe(
          (tier.monthlyPriceCents / 100).toFixed(2)
        );
        expect(calls('POST', '/v1/billing/plans/')).toHaveLength(1);
        expect(fake.plans.size).toBe(PRICING.tiers.length);
      });

      it('leaves one plan per tier when two processes sync at once', async () => {
        const other = wire(role === 'api' ? workerService : apiService);

        await Promise.all([w().service.syncPlans(), other.service.syncPlans()]);

        expect(await worker.paypalPlan.count()).toBe(PRICING.tiers.length);
        expect(fake.plans.size).toBe(PRICING.tiers.length);
      });

      it('is refused with BILLING_NOT_CONFIGURED (503) while PayPal is not configured', async () => {
        delete process.env.PAYPAL_CLIENT_SECRET;

        const err = await failure(w().service.syncPlans());

        expect(err.getStatus()).toBe(503);
        expect(bodyOf(err).code).toBe('BILLING_NOT_CONFIGURED');
        expect(fake.seen).toEqual([]);
      });
    });

    describe('onModuleInit', () => {
      it('creates the plans at start-up when PayPal is configured', async () => {
        await w().service.onModuleInit();

        expect(await worker.paypalPlan.count()).toBe(PRICING.tiers.length);
      });

      it('does not call PayPal at start-up when it is not configured', async () => {
        delete process.env.PAYPAL_WEBHOOK_ID;

        await w().service.onModuleInit();

        expect(fake.seen).toEqual([]);
      });

      it('lets the process start when PayPal is down, and a plan is created when first needed', async () => {
        fake.failing.add('/v1/catalogs/products');
        await w().service.onModuleInit();
        expect(await worker.paypalPlan.count()).toBe(0);

        fake.failing.clear();
        const ws = await workspace();
        const result = await w().service.subscribe(ws.organizationId, ws.ownerId, tier.key);

        expect(result.subscriptionId).toBeTruthy();
        expect(await worker.paypalPlan.count()).toBe(1);
      });
    });

    describe('subscribe', () => {
      it("creates the tier's subscription for the account and returns PayPal's approve link, leaving the plan key alone", async () => {
        const ws = await workspace();

        const result = await w().service.subscribe(ws.organizationId, ws.ownerId, tier.key);

        const plan = await worker.paypalPlan.findFirst({ where: { tierKey: tier.key } });
        const [call] = calls('POST', '/v1/billing/subscriptions');
        expect(call.body.plan_id).toBe(plan!.planId);
        expect(call.body.custom_id).toBe(ws.accountId);
        expect(call.body.application_context.return_url).toBe(
          `https://app.test/w/${ws.organizationId}/billing`
        );
        expect(result.approveUrl).toBe(`https://paypal.test/approve/${result.subscriptionId}`);
        const row = await worker.billingSubscription.findUnique({
          where: { accountId: ws.accountId },
        });
        expect(row).toMatchObject({
          externalId: result.subscriptionId,
          provider: 'paypal',
          tierKey: tier.key,
          status: 'APPROVAL_PENDING',
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        });
        expect(await planKeyOf(ws.accountId)).toBe('FREE');
      });

      it('refuses a user who is not the owner of the workspace account with NOT_ACCOUNT_OWNER (403), before PayPal is called', async () => {
        const ws = await workspace();
        const other = await member(ws.organizationId);

        const err = await failure(w().service.subscribe(ws.organizationId, other, tier.key));

        expect(err.getStatus()).toBe(403);
        expect(bodyOf(err).code).toBe('NOT_ACCOUNT_OWNER');
        expect(calls('POST', '/v1/billing/subscriptions')).toEqual([]);
        expect(await worker.billingSubscription.count({ where: { accountId: ws.accountId } })).toBe(0);
      });

      it.each(['GOLD', 'FREE', ''])('refuses the tier "%s" with UNKNOWN_TIER (400)', async (key) => {
        const ws = await workspace();

        const err = await failure(w().service.subscribe(ws.organizationId, ws.ownerId, key));

        expect(err.getStatus()).toBe(400);
        expect(bodyOf(err).code).toBe('UNKNOWN_TIER');
        expect(calls('POST', '/v1/billing/subscriptions')).toEqual([]);
      });

      it('refuses a second subscription while one is ACTIVE with ALREADY_SUBSCRIBED (409)', async () => {
        const ws = await workspace();
        await subscribed(w(), ws);
        const created = calls('POST', '/v1/billing/subscriptions').length;

        const err = await failure(w().service.subscribe(ws.organizationId, ws.ownerId, otherTier.key));

        expect(err.getStatus()).toBe(409);
        expect(bodyOf(err).code).toBe('ALREADY_SUBSCRIBED');
        expect(calls('POST', '/v1/billing/subscriptions')).toHaveLength(created);
      });

      it('lets an account whose subscription was never approved start a new one, which replaces it', async () => {
        const ws = await workspace();
        const first = await w().service.subscribe(ws.organizationId, ws.ownerId, tier.key);

        const second = await w().service.subscribe(ws.organizationId, ws.ownerId, otherTier.key);

        expect(second.subscriptionId).not.toBe(first.subscriptionId);
        const row = await worker.billingSubscription.findMany({ where: { accountId: ws.accountId } });
        expect(row).toHaveLength(1);
        expect(row[0]).toMatchObject({ externalId: second.subscriptionId, tierKey: otherTier.key });
      });

      it('is refused with BILLING_NOT_CONFIGURED (503) while PayPal is not configured', async () => {
        const ws = await workspace();
        delete process.env.PAYPAL_CLIENT_ID;

        const err = await failure(w().service.subscribe(ws.organizationId, ws.ownerId, tier.key));

        expect(err.getStatus()).toBe(503);
        expect(bodyOf(err).code).toBe('BILLING_NOT_CONFIGURED');
      });

      it('is seen by every workspace of the account', async () => {
        const ws = await workspace();
        const second = await worker.organization.create({
          data: { name: 'ws-' + randomUUID(), accountId: ws.accountId },
        });
        await subscribed(w(), ws);

        const view = await w().controller.plans(second as any);

        expect(view.current).toMatchObject({ accountId: ws.accountId, tierKey: tier.key, status: 'ACTIVE' });
        // each tier of the file, plus the app features it grants (api.entitlements, E4)
        expect(view.tiers).toEqual(
          PRICING.tiers.map((t) => ({ ...t, features: expect.any(Array) }))
        );
      });
    });

    describe('confirm', () => {
      it("stores the subscription state PayPal reports and puts the account on the tier while it is ACTIVE", async () => {
        const ws = await workspace();
        const next = inDays(30);

        const id = await subscribed(w(), ws, tier.key, next);

        const view = await w().service.getForAccount(ws.accountId);
        expect(view).toEqual({
          accountId: ws.accountId,
          provider: 'paypal',
          tierKey: tier.key,
          status: 'ACTIVE',
          currentPeriodEnd: next.toISOString(),
          cancelAtPeriodEnd: false,
        });
        expect((await worker.billingSubscription.findUnique({ where: { externalId: id } }))!.status).toBe('ACTIVE');
        expect(await planKeyOf(ws.accountId)).toBe(tier.key);
      });

      it('shows APPROVAL_PENDING and keeps the plan key while PayPal has not activated it', async () => {
        const ws = await workspace();
        const { subscriptionId } = await w().service.subscribe(ws.organizationId, ws.ownerId, tier.key);

        const view = await w().service.confirm(ws.organizationId, ws.ownerId, subscriptionId);

        expect(view.status).toBe('APPROVAL_PENDING');
        expect(await planKeyOf(ws.accountId)).toBe('FREE');
      });

      it('answers NO_SUBSCRIPTION (404) for an account with none, an unknown id and another account\'s subscription', async () => {
        const ws = await workspace();
        const foreign = await workspace();
        const foreignId = await subscribed(w(), foreign);

        const none = await failure(w().service.confirm(ws.organizationId, ws.ownerId, foreignId));
        expect(none.getStatus()).toBe(404);
        expect(bodyOf(none).code).toBe('NO_SUBSCRIPTION');

        await w().service.subscribe(ws.organizationId, ws.ownerId, tier.key);
        for (const id of [foreignId, 'I-UNKNOWN']) {
          const err = await failure(w().service.confirm(ws.organizationId, ws.ownerId, id));
          expect(err.getStatus()).toBe(404);
          expect(bodyOf(err).code).toBe('NO_SUBSCRIPTION');
        }
        expect(await planKeyOf(ws.accountId)).toBe('FREE');
        expect((await w().service.getForAccount(foreign.accountId))!.status).toBe('ACTIVE');
      });

      it('is for the owner only (NOT_ACCOUNT_OWNER, 403)', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const other = await member(ws.organizationId);

        const err = await failure(w().service.confirm(ws.organizationId, other, id));

        expect(err.getStatus()).toBe(403);
        expect(bodyOf(err).code).toBe('NOT_ACCOUNT_OWNER');
      });
    });

    describe('changeTier', () => {
      it('asks PayPal to revise the subscription to the new tier\'s plan and returns the approve link, leaving the tier until PayPal reports the change', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);

        const result = await w().service.changeTier(ws.organizationId, ws.ownerId, otherTier.key);

        const plan = await worker.paypalPlan.findFirst({ where: { tierKey: otherTier.key } });
        const [call] = calls('POST', `/v1/billing/subscriptions/${id}/revise`);
        expect(call.body.plan_id).toBe(plan!.planId);
        expect(result).toEqual({ approveUrl: `https://paypal.test/revise/${id}` });
        expect((await w().service.getForAccount(ws.accountId))!.tierKey).toBe(tier.key);
        expect(await planKeyOf(ws.accountId)).toBe(tier.key);
      });

      it('returns no approve link when PayPal asks for none', async () => {
        const ws = await workspace();
        await subscribed(w(), ws);
        fake.approveOnRevise = false;

        expect(await w().service.changeTier(ws.organizationId, ws.ownerId, otherTier.key)).toEqual({
          approveUrl: null,
        });
      });

      it('does nothing for the tier the account is already on', async () => {
        const ws = await workspace();
        await subscribed(w(), ws);

        expect(await w().service.changeTier(ws.organizationId, ws.ownerId, tier.key)).toEqual({
          approveUrl: null,
        });
        expect(calls('POST', '/v1/billing/subscriptions/').filter((c) => c.url.endsWith('/revise'))).toEqual([]);
      });

      it('follows the plan PayPal reports afterwards: the next sync stores the new tier', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        await w().service.changeTier(ws.organizationId, ws.ownerId, otherTier.key);
        const plan = await worker.paypalPlan.findFirst({ where: { tierKey: otherTier.key } });
        fake.subscriptions.get(id)!.plan_id = plan!.planId;

        const view = await w().service.syncFromPaypal(id);

        expect(view.tierKey).toBe(otherTier.key);
        expect(await planKeyOf(ws.accountId)).toBe(otherTier.key);
      });

      it('answers NO_SUBSCRIPTION (404), UNKNOWN_TIER (400) and NOT_ACCOUNT_OWNER (403) as declared', async () => {
        const ws = await workspace();
        const none = await failure(w().service.changeTier(ws.organizationId, ws.ownerId, otherTier.key));
        expect([none.getStatus(), bodyOf(none).code]).toEqual([404, 'NO_SUBSCRIPTION']);

        await subscribed(w(), ws);
        const unknown = await failure(w().service.changeTier(ws.organizationId, ws.ownerId, 'GOLD'));
        expect([unknown.getStatus(), bodyOf(unknown).code]).toEqual([400, 'UNKNOWN_TIER']);

        const other = await member(ws.organizationId);
        const notOwner = await failure(w().service.changeTier(ws.organizationId, other, otherTier.key));
        expect([notOwner.getStatus(), bodyOf(notOwner).code]).toEqual([403, 'NOT_ACCOUNT_OWNER']);
      });
    });

    describe('cancel', () => {
      it('cancels at PayPal and keeps the tier until the paid period ends', async () => {
        const ws = await workspace();
        const next = inDays(20);
        const id = await subscribed(w(), ws, tier.key, next);

        const view = await w().service.cancel(ws.organizationId, ws.ownerId);

        expect(calls('POST', `/v1/billing/subscriptions/${id}/cancel`)).toHaveLength(1);
        expect(view).toMatchObject({
          status: 'CANCELLED',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: next.toISOString(),
          tierKey: tier.key,
        });
        expect(await planKeyOf(ws.accountId)).toBe(tier.key);
      });

      it('answers a repeated cancel with the cancelled subscription and no second call to PayPal', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        await w().service.cancel(ws.organizationId, ws.ownerId);

        const again = await w().service.cancel(ws.organizationId, ws.ownerId);

        expect(again.status).toBe('CANCELLED');
        expect(calls('POST', `/v1/billing/subscriptions/${id}/cancel`)).toHaveLength(1);
      });

      it('answers NO_SUBSCRIPTION (404) without one and NOT_ACCOUNT_OWNER (403) for a member', async () => {
        const ws = await workspace();
        const none = await failure(w().service.cancel(ws.organizationId, ws.ownerId));
        expect([none.getStatus(), bodyOf(none).code]).toEqual([404, 'NO_SUBSCRIPTION']);

        await subscribed(w(), ws);
        const other = await member(ws.organizationId);
        const notOwner = await failure(w().service.cancel(ws.organizationId, other));
        expect([notOwner.getStatus(), bodyOf(notOwner).code]).toEqual([403, 'NOT_ACCOUNT_OWNER']);
        expect((await w().service.getForAccount(ws.accountId))!.status).toBe('ACTIVE');
      });
    });

    describe('setPlanKey', () => {
      it('puts an account on FREE or a tier of the pricing file, and refuses any other key', async () => {
        const ws = await workspace();

        await w().service.setPlanKey(ws.accountId, otherTier.key);
        expect(await planKeyOf(ws.accountId)).toBe(otherTier.key);
        await w().service.setPlanKey(ws.accountId, 'FREE');
        expect(await planKeyOf(ws.accountId)).toBe('FREE');

        await expect(w().service.setPlanKey(ws.accountId, 'GOLD')).rejects.toThrow();
        expect(await planKeyOf(ws.accountId)).toBe('FREE');
      });
    });

    describe('PAYMENT.SALE.COMPLETED', () => {
      beforeEach(async () => {
        await w().service.onModuleInit();
      });

      it('grants the tier\'s monthly credits once, as a GRANT that expires when the next period starts, under paypal:event:{id}', async () => {
        const ws = await workspace();
        const next = inDays(30);
        const id = await subscribed(w(), ws, tier.key, next);
        const event = saleEvent(id);

        expect(await w().intake.process(event)).toBe('processed');

        const [bucket, ...rest] = await buckets(ws.accountId);
        expect(rest).toEqual([]);
        expect(bucket).toMatchObject({
          type: 'GRANT',
          initial: tier.monthlyCredits,
          remaining: tier.monthlyCredits,
          grantKey: `paypal:event:${event.id}`,
        });
        expect(bucket.expiresAt!.toISOString()).toBe(next.toISOString());
      });

      it('grants nothing more for a duplicate delivery of the event id', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const event = saleEvent(id);
        await w().intake.process(event);

        expect(await w().intake.process(event)).toBe('duplicate');

        expect(await buckets(ws.accountId)).toHaveLength(1);
      });

      it('grants once when the same event id is delivered concurrently', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const event = saleEvent(id);

        await Promise.all([1, 2, 3, 4].map(() => w().intake.process(event)));

        expect(await buckets(ws.accountId)).toHaveLength(1);
      });

      it('grants again for the next renewal, which is another event id', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        await w().intake.process(saleEvent(id));
        await w().intake.process(saleEvent(id));

        const all = await buckets(ws.accountId);
        expect(all).toHaveLength(2);
        expect(new Set(all.map((b) => b.grantKey)).size).toBe(2);
      });

      it('grants nothing when PayPal lists the sale as REFUNDED, and the event counts as processed', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const event = saleEvent(id, 'SALE-REFUNDED');
        fake.transactions.set(id, [
          { id: 'SALE-REFUNDED', status: 'REFUNDED', time: event.create_time },
        ]);

        expect(await w().intake.process(event)).toBe('processed');

        expect(await buckets(ws.accountId)).toEqual([]);
        expect((await worker.paymentEvent.findUnique({ where: { id: event.id } }))!.processedAt).not.toBeNull();
      });

      it.each(['COMPLETED', 'PARTIALLY_REFUNDED'])('grants in full when PayPal lists the sale as %s', async (status) => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const event = saleEvent(id, 'SALE-1');
        fake.transactions.set(id, [{ id: 'SALE-1', status, time: event.create_time }]);

        await w().intake.process(event);

        const [bucket] = await buckets(ws.accountId);
        expect(bucket.initial).toBe(tier.monthlyCredits);
      });

      it('looks for the sale in the subscription\'s transactions around its time', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const event = saleEvent(id, 'SALE-1', undefined, '2026-10-01T10:00:00.000Z');
        await w().intake.process(event).catch(() => undefined);

        const [call] = calls('GET', `/v1/billing/subscriptions/${id}/transactions`);
        const query = new URLSearchParams(call.url.split('?')[1]);
        expect(Date.parse(query.get('start_time')!)).toBeLessThanOrEqual(Date.parse('2026-10-01T10:00:00.000Z'));
        expect(Date.parse(query.get('end_time')!)).toBeGreaterThanOrEqual(Date.parse('2026-10-01T10:00:00.000Z'));
      });

      it('grants in full when the sale is not in the transactions PayPal lists', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        fake.transactions.set(id, [{ id: 'SOMETHING-ELSE', status: 'REFUNDED', time: new Date().toISOString() }]);

        await w().intake.process(saleEvent(id));

        expect(await buckets(ws.accountId)).toHaveLength(1);
      });

      it('uses the credits of the pricing file at the time of the sale, and never alters a grant already made', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const first = saleEvent(id);
        await w().intake.process(first);
        PRICING.tiers[0].monthlyCredits += 50;

        await w().intake.process(saleEvent(id));

        const all = await buckets(ws.accountId);
        expect(all.find((b) => b.grantKey === `paypal:event:${first.id}`)!.initial).toBe(
          savedTierCredits()
        );
        expect(all.filter((b) => b.initial === savedTierCredits() + 50)).toHaveLength(1);
      });

      it('grants the credits of the tier PayPal reports for the subscription now', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const plan = await worker.paypalPlan.findFirst({ where: { tierKey: otherTier.key } });
        fake.subscriptions.get(id)!.plan_id = plan!.planId;

        await w().intake.process(saleEvent(id));

        const [bucket] = await buckets(ws.accountId);
        expect(bucket.initial).toBe(otherTier.monthlyCredits);
        expect(await planKeyOf(ws.accountId)).toBe(otherTier.key);
      });

      it('still grants when the cancellation was processed first, expiring one month after the sale', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        await w().service.cancel(ws.organizationId, ws.ownerId);
        const saleTime = new Date();
        const event = saleEvent(id, undefined, undefined, saleTime.toISOString());

        await w().intake.process(event);

        const [bucket] = await buckets(ws.accountId);
        expect(bucket.initial).toBe(tier.monthlyCredits);
        const expected = new Date(saleTime);
        expected.setUTCMonth(expected.getUTCMonth() + 1);
        expect(Math.abs(bucket.expiresAt!.getTime() - expected.getTime())).toBeLessThan(2 * DAY);
      });

      it('ignores a sale that is not for a subscription, without error', async () => {
        const ws = await workspace();
        await subscribed(w(), ws);

        expect(await w().intake.process(saleEvent(undefined))).toBe('processed');

        expect(await buckets(ws.accountId)).toEqual([]);
      });

      it('ignores a sale for a subscription that is not ours (unknown to PayPal, no account, or another plan)', async () => {
        const ws = await workspace();
        await subscribed(w(), ws);
        const strangerNoAccount = nextId('I');
        fake.subscriptions.set(strangerNoAccount, {
          id: strangerNoAccount,
          plan_id: (await worker.paypalPlan.findFirst())!.planId,
          custom_id: 'no-such-account',
          status: 'ACTIVE',
          billing_info: { next_billing_time: inDays(30).toISOString() },
        });
        const strangerPlan = nextId('I');
        fake.subscriptions.set(strangerPlan, {
          id: strangerPlan,
          plan_id: 'P-NOT-OURS',
          custom_id: ws.accountId,
          status: 'ACTIVE',
          billing_info: { next_billing_time: inDays(30).toISOString() },
        });

        for (const id of ['I-UNKNOWN', strangerNoAccount, strangerPlan]) {
          expect(await w().intake.process(saleEvent(id))).toBe('processed');
        }

        expect(await buckets(ws.accountId)).toEqual([]);
        expect((await w().service.getForAccount(ws.accountId))!.status).toBe('ACTIVE');
      });

      it('leaves the event unprocessed while PayPal is down, and a redelivery grants exactly once', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const event = saleEvent(id);
        fake.failing.add(`/v1/billing/subscriptions/${id}`);

        await expect(w().intake.process(event)).rejects.toThrow();
        expect(await buckets(ws.accountId)).toEqual([]);
        expect((await worker.paymentEvent.findUnique({ where: { id: event.id } }))!.processedAt).toBeNull();

        fake.failing.clear();
        expect(await w().intake.process(event)).toBe('processed');
        expect(await w().intake.process(event)).toBe('duplicate');
        expect(await buckets(ws.accountId)).toHaveLength(1);
      }, 30000);

      it('fails the event, keeping it for a redelivery, when the tier left the pricing file', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const event = saleEvent(id);
        PRICING.tiers.splice(0, 1);

        await expect(w().intake.process(event)).rejects.toThrow();

        expect(await buckets(ws.accountId)).toEqual([]);
        expect((await worker.paymentEvent.findUnique({ where: { id: event.id } }))!.processedAt).toBeNull();
      });
    });

    describe('BILLING.SUBSCRIPTION.* events', () => {
      beforeEach(async () => {
        await w().service.onModuleInit();
      });

      it('stores the state PayPal reports now, not what the event says, and puts the account on the tier', async () => {
        const ws = await workspace();
        const { subscriptionId } = await w().service.subscribe(ws.organizationId, ws.ownerId, tier.key);
        const stored = fake.subscriptions.get(subscriptionId)!;
        stored.status = 'ACTIVE';
        const next = inDays(30);
        stored.billing_info.next_billing_time = next.toISOString();

        await w().intake.process({
          ...subscriptionEvent('BILLING.SUBSCRIPTION.CREATED', subscriptionId),
          resource: { id: subscriptionId, status: 'APPROVAL_PENDING' },
        });

        expect(await w().service.getForAccount(ws.accountId)).toMatchObject({
          status: 'ACTIVE',
          currentPeriodEnd: next.toISOString(),
        });
        expect(await planKeyOf(ws.accountId)).toBe(tier.key);
      });

      it('a late ACTIVATED event does not undo a cancellation PayPal already reports', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        await w().service.cancel(ws.organizationId, ws.ownerId);

        await w().intake.process(subscriptionEvent('BILLING.SUBSCRIPTION.ACTIVATED', id));

        expect((await w().service.getForAccount(ws.accountId))!.status).toBe('CANCELLED');
      });

      it('stores SUSPENDED and EXPIRED without changing the plan key (the lapse belongs to billing.reversals-lapse)', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);

        for (const [type, status] of [
          ['BILLING.SUBSCRIPTION.SUSPENDED', 'SUSPENDED'],
          ['BILLING.SUBSCRIPTION.EXPIRED', 'EXPIRED'],
        ]) {
          fake.subscriptions.get(id)!.status = status;
          await w().intake.process(subscriptionEvent(type, id));
          expect((await w().service.getForAccount(ws.accountId))!.status).toBe(status);
        }
        expect(await planKeyOf(ws.accountId)).toBe(tier.key);
      });

      // A subscription PayPal reports CANCELLED that this account never saw ACTIVE, so only the
      // CANCELLED rule can put the account on the tier.
      const cancelledNeverActive = async (next: Date | null) => {
        const ws = await workspace();
        const { subscriptionId } = await w().service.subscribe(
          ws.organizationId,
          ws.ownerId,
          tier.key
        );
        const stored = fake.subscriptions.get(subscriptionId)!;
        stored.status = 'CANCELLED';
        if (next) {
          stored.billing_info.next_billing_time = next.toISOString();
        }
        expect(await planKeyOf(ws.accountId)).toBe('FREE');
        return { ws, subscriptionId };
      };

      it('puts an account on the tier for a CANCELLED subscription whose period has not ended', async () => {
        const next = inDays(10);
        const { ws, subscriptionId } = await cancelledNeverActive(next);

        await w().intake.process(
          subscriptionEvent('BILLING.SUBSCRIPTION.CANCELLED', subscriptionId)
        );

        expect(await w().service.getForAccount(ws.accountId)).toMatchObject({
          status: 'CANCELLED',
          currentPeriodEnd: next.toISOString(),
        });
        expect(await planKeyOf(ws.accountId)).toBe(tier.key);
      });

      it('puts an account on the tier when confirm stores a CANCELLED subscription whose period has not ended', async () => {
        const { ws, subscriptionId } = await cancelledNeverActive(inDays(10));

        await w().service.confirm(ws.organizationId, ws.ownerId, subscriptionId);

        expect(await planKeyOf(ws.accountId)).toBe(tier.key);
      });

      it('leaves an account on FREE for a CANCELLED subscription whose period has ended', async () => {
        const { ws, subscriptionId } = await cancelledNeverActive(inDays(-1));

        await w().intake.process(
          subscriptionEvent('BILLING.SUBSCRIPTION.CANCELLED', subscriptionId)
        );

        expect((await w().service.getForAccount(ws.accountId))!.status).toBe('CANCELLED');
        expect(await planKeyOf(ws.accountId)).toBe('FREE');
      });

      it('leaves an account on FREE for a CANCELLED subscription with no period end at all', async () => {
        const { ws, subscriptionId } = await cancelledNeverActive(null);

        await w().intake.process(
          subscriptionEvent('BILLING.SUBSCRIPTION.CANCELLED', subscriptionId)
        );

        expect(await w().service.getForAccount(ws.accountId)).toMatchObject({
          status: 'CANCELLED',
          currentPeriodEnd: null,
        });
        expect(await planKeyOf(ws.accountId)).toBe('FREE');
      });

      it('does not let a CANCELLED subscription whose period has ended confirm to a paid tier', async () => {
        const { ws, subscriptionId } = await cancelledNeverActive(inDays(-1));

        await w().service.confirm(ws.organizationId, ws.ownerId, subscriptionId);

        expect(await planKeyOf(ws.accountId)).toBe('FREE');
      });

      it('does not let a notice about another, not active subscription replace the active one', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const plan = await worker.paypalPlan.findFirst();
        const old = nextId('I');
        fake.subscriptions.set(old, {
          id: old,
          plan_id: plan!.planId,
          custom_id: ws.accountId,
          status: 'CANCELLED',
          billing_info: {},
        });

        await w().intake.process(subscriptionEvent('BILLING.SUBSCRIPTION.CANCELLED', old));

        expect(await worker.billingSubscription.findUnique({ where: { accountId: ws.accountId } })).toMatchObject({
          externalId: id,
          status: 'ACTIVE',
        });
      });

      it('ignores a subscription that is not ours', async () => {
        expect(
          await w().intake.process(subscriptionEvent('BILLING.SUBSCRIPTION.CANCELLED', 'I-UNKNOWN'))
        ).toBe('processed');
        expect(await worker.billingSubscription.count({ where: { externalId: 'I-UNKNOWN' } })).toBe(0);
      });
    });

    describe('PaypalProvider', () => {
      it('hands PayPal-signed requests to the intake: the verified event, then the handlers once', async () => {
        await w().service.onModuleInit();
        const ws = await workspace();
        const id = await subscribed(w(), ws);
        const event = saleEvent(id);
        const rawBody = Buffer.from(JSON.stringify(event));

        const verified = await w().provider.validateWebhook(rawBody, signed);
        expect(verified).toEqual(event);
        expect(await w().provider.processWebhook(verified)).toBe('processed');
        expect(await w().provider.processWebhook(verified)).toBe('duplicate');
        expect(await buckets(ws.accountId)).toHaveLength(1);
      });

      it('answers a request PayPal does not vouch for with a 400 and stores nothing', async () => {
        fake.verification = 'FAILURE';
        const event = saleEvent('I-1');

        const err = await failure(
          Promise.resolve(w().provider.validateWebhook(Buffer.from(JSON.stringify(event)), signed))
        );

        expect(err.getStatus()).toBe(400);
        expect(await worker.paymentEvent.findUnique({ where: { id: event.id } })).toBeNull();
      });

      it('is a web provider', () => {
        expect(w().provider.platform).toBe('web');
      });

      it('lets account deletion go on when the account has no subscription, without calling PayPal', async () => {
        const ws = await workspace();

        await w().provider.cancelAllSubscriptions(ws.organizationId);

        expect(fake.seen).toEqual([]);
      });

      it('cancels the account\'s active subscription when its account is deleted, and a second call changes nothing', async () => {
        const ws = await workspace();
        const id = await subscribed(w(), ws);

        await w().provider.cancelAllSubscriptions(ws.organizationId);
        await w().provider.cancelAllSubscriptions(ws.organizationId);

        expect(calls('POST', `/v1/billing/subscriptions/${id}/cancel`)).toHaveLength(1);
        expect((await w().service.getForAccount(ws.accountId))!.status).toBe('CANCELLED');
      });
    });

    describe('plans controller', () => {
      it('answers GET /billing/plans with the pricing file\'s tiers and the account\'s subscription, null before one exists', async () => {
        const ws = await workspace();

        const before = await w().controller.plans({ id: ws.organizationId } as any);
        // each tier of the file, plus the app features it grants (api.entitlements, E4)
        expect(before).toEqual({
          tiers: PRICING.tiers.map((t) => ({ ...t, features: expect.any(Array) })),
          current: null,
        });

        await subscribed(w(), ws);
        const after = await w().controller.plans({ id: ws.organizationId } as any);
        expect(after.current).toMatchObject({ tierKey: tier.key, status: 'ACTIVE' });
      });

      it('runs subscribe, confirm, change and cancel for the signed-in owner', async () => {
        const ws = await workspace();
        const org = { id: ws.organizationId } as any;
        const user = { id: ws.ownerId } as any;

        const { subscriptionId, approveUrl } = await w().controller.subscribe(org, user, { tierKey: tier.key });
        expect(approveUrl).toContain(subscriptionId);
        fake.subscriptions.get(subscriptionId)!.status = 'ACTIVE';
        fake.subscriptions.get(subscriptionId)!.billing_info.next_billing_time = inDays(30).toISOString();

        expect((await w().controller.confirm(org, user, { subscriptionId })).status).toBe('ACTIVE');
        expect(await w().controller.change(org, user, { tierKey: otherTier.key })).toEqual({
          approveUrl: `https://paypal.test/revise/${subscriptionId}`,
        });
        expect((await w().controller.cancel(org, user)).status).toBe('CANCELLED');
      });

      it('refuses a member who is not the owner on every mutation with NOT_ACCOUNT_OWNER (403)', async () => {
        const ws = await workspace();
        const org = { id: ws.organizationId } as any;
        const user = { id: await member(ws.organizationId) } as any;

        for (const call of [
          () => w().controller.subscribe(org, user, { tierKey: tier.key }),
          () => w().controller.confirm(org, user, { subscriptionId: 'I-1' }),
          () => w().controller.change(org, user, { tierKey: tier.key }),
          () => w().controller.cancel(org, user),
        ]) {
          const err = await failure(call());
          expect([err.getStatus(), bodyOf(err).code]).toEqual([403, 'NOT_ACCOUNT_OWNER']);
        }
      });
    });
  });

  describe('request bodies', () => {
    const invalid = async (dto: object) => (await validate(dto)).length > 0;

    it('needs a non-empty tierKey on subscribe and change', async () => {
      expect(await invalid(Object.assign(new PlanTierDto(), { tierKey: 'STARTER' }))).toBe(false);
      expect(await invalid(Object.assign(new PlanTierDto(), { tierKey: '' }))).toBe(true);
      expect(await invalid(Object.assign(new PlanTierDto(), { tierKey: 7 }))).toBe(true);
      expect(await invalid(new PlanTierDto())).toBe(true);
    });

    it('needs a non-empty subscriptionId on confirm', async () => {
      expect(await invalid(Object.assign(new PlanConfirmDto(), { subscriptionId: 'I-1' }))).toBe(false);
      expect(await invalid(Object.assign(new PlanConfirmDto(), { subscriptionId: '' }))).toBe(true);
      expect(await invalid(new PlanConfirmDto())).toBe(true);
    });
  });

  // The first tier's monthly credits as the pricing file has them, before any test edits them.
  function savedTierCredits() {
    return JSON.parse(savedTiers)[0].monthlyCredits as number;
  }
});
