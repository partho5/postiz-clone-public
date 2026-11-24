// PayPal reversals and lapse: a refund or reversal takes back the credits it paid for, in
// proportion and even into a negative balance; a sale refund waits for its renewal; a plan that is no
// longer paid for falls back to FREE; the daily poll catches what webhooks missed.
//
// Runs against a real Postgres (migrated and given the API role by the jest global setup), on both
// database roles, with the real PayPal client, webhook intake, subscriptions, top-ups, pricing and
// credit services; a local HTTP server stands in for PayPal.
import { HttpException, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
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
import { TopupsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.repository';
import { TopupsService } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.service';
import { ReversalsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/reversals/reversals.repository';
import { ReversalsService } from '@gitroom/nestjs-libraries/database/prisma/billing/reversals/reversals.service';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type Seen = { method: string; url: string };
interface FakeSubscription {
  id: string;
  plan_id: string;
  custom_id: string;
  status: string;
  billing_info: { next_billing_time?: string };
}

// A top-up's order as PayPal lists it: its capture and the refunds made on it so far.
interface FakeOrder {
  purchase_units: {
    payments: {
      captures: { id: string; status: string }[];
      refunds: {
        id: string;
        status: string;
        create_time: string;
        amount: { currency_code: string; value: string };
      }[];
    };
  }[];
}

// What the stand-in PayPal holds, replaced before every test.
let fake: {
  seen: Seen[];
  subscriptions: Map<string, FakeSubscription>;
  captures: Map<
    string,
    { id: string; amount: { currency_code: string; value: string } }
  >;
  sales: Map<
    string,
    { id: string; amount: { currency: string; total: string } }
  >;
  orders: Map<string, FakeOrder>;
  events: PaypalEvent[];
  failing: Set<string>;
};
let server: Server;
let baseUrl: string;

// Answers with JSON.
const reply = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body ?? {}));
};

// One PayPal call: the answer a real PayPal gives for the reads the service makes.
const paypal = (
  method: string,
  path: string,
  query: string,
  res: ServerResponse
) => {
  fake.seen.push({ method, url: path + query });
  if ([...fake.failing].some((prefix) => path.startsWith(prefix))) {
    return reply(res, 500, { name: 'INTERNAL_SERVICE_ERROR' });
  }
  if (path === '/v1/notifications/webhooks-events') {
    return reply(res, 200, { events: fake.events });
  }
  let match = path.match(
    /^\/v1\/billing\/subscriptions\/([^/]+)(\/transactions)?$/
  );
  if (match) {
    const subscription = fake.subscriptions.get(match[1]);
    if (!subscription) {
      return reply(res, 404, { name: 'RESOURCE_NOT_FOUND' });
    }
    return reply(res, 200, match[2] ? { transactions: [] } : subscription);
  }
  match = path.match(/^\/v2\/payments\/captures\/([^/]+)$/);
  if (match) {
    const capture = fake.captures.get(match[1]);
    return capture
      ? reply(res, 200, capture)
      : reply(res, 404, { name: 'RESOURCE_NOT_FOUND' });
  }
  match = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
  if (match) {
    const order = fake.orders.get(match[1]);
    return order
      ? reply(res, 200, order)
      : reply(res, 404, { name: 'RESOURCE_NOT_FOUND' });
  }
  match = path.match(/^\/v1\/payments\/sale\/([^/]+)$/);
  if (match) {
    const sale = fake.sales.get(match[1]);
    return sale
      ? reply(res, 200, sale)
      : reply(res, 404, { name: 'RESOURCE_NOT_FOUND' });
  }
  return reply(res, 404, { name: 'RESOURCE_NOT_FOUND' });
};

// Empties the stand-in PayPal.
const resetFake = () => {
  fake = {
    seen: [],
    subscriptions: new Map(),
    captures: new Map(),
    sales: new Map(),
    orders: new Map(),
    events: [],
    failing: new Set(),
  };
};

beforeAll(async () => {
  resetFake();
  server = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on('end', () => {
      const parsed = new URL(req.url!, 'http://paypal.test');
      if (parsed.pathname === '/v1/oauth2/token') {
        return reply(res, 200, { access_token: 'token', expires_in: 32400 });
      }
      paypal(req.method!, parsed.pathname, parsed.search, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const DAY = 24 * 60 * 60 * 1000;
// PayPal's ids are unique across accounts; the tests make theirs unique across tests, since a
// refund id held by another account is an idempotency conflict.
let run = randomUUID();
const id = (name: string) => `${name}-${run}`;
// The moment this many days from now.
const inDays = (days: number) => new Date(Date.now() + days * DAY);

// PayPal's webhook for a refund of a top-up capture: the refund links up to its capture.
const captureRefund = (
  captureId: string,
  refundId: string,
  value: string,
  id = 'WH-' + randomUUID(),
  createTime = new Date().toISOString()
): PaypalEvent => ({
  id,
  event_type: 'PAYMENT.CAPTURE.REFUNDED',
  resource_type: 'refund',
  resource: {
    id: refundId,
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value },
    links: [
      {
        rel: 'self',
        href: `https://api.paypal.test/v2/payments/refunds/${refundId}`,
      },
      {
        rel: 'up',
        href: `https://api.paypal.test/v2/payments/captures/${captureId}`,
      },
    ],
  },
  create_time: createTime,
});

// PayPal's webhook for a reversed top-up capture: the resource is the capture itself.
const captureReversed = (captureId: string, value: string): PaypalEvent => ({
  id: 'WH-' + randomUUID(),
  event_type: 'PAYMENT.CAPTURE.REVERSED',
  resource_type: 'capture',
  resource: {
    id: captureId,
    status: 'REVERSED',
    amount: { currency_code: 'USD', value },
  },
  create_time: new Date().toISOString(),
});

// A PAYMENT.SALE.COMPLETED event for a subscription.
const saleCompleted = (
  subscriptionId: string,
  saleId: string
): PaypalEvent => ({
  id: 'WH-' + randomUUID(),
  event_type: 'PAYMENT.SALE.COMPLETED',
  resource_type: 'sale',
  resource: {
    id: saleId,
    state: 'completed',
    billing_agreement_id: subscriptionId,
    create_time: new Date().toISOString(),
  },
  create_time: new Date().toISOString(),
});

// PayPal's webhook for a refunded or reversed plan payment: the resource is the refund, naming its sale.
const saleReturned = (
  type: 'PAYMENT.SALE.REFUNDED' | 'PAYMENT.SALE.REVERSED',
  saleId: string,
  refundId: string,
  total: string,
  id = 'WH-' + randomUUID(),
  createTime = new Date().toISOString()
): PaypalEvent => ({
  id,
  event_type: type,
  resource_type: 'refund',
  resource: {
    id: refundId,
    sale_id: saleId,
    state: 'completed',
    amount: { currency: 'USD', total },
  },
  create_time: createTime,
});

// A webhook about a subscription (BILLING.SUBSCRIPTION.*) or a dispute.
const simpleEvent = (type: string, resourceId: string): PaypalEvent => ({
  id: 'WH-' + randomUUID(),
  event_type: type,
  resource_type: 'resource',
  resource: { id: resourceId },
  create_time: new Date().toISOString(),
});

describeDb('ReversalsService (Postgres)', () => {
  let apiService: PrismaService;
  let workerService: PrismaService;
  let db: PrismaClient;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;
  const savedEnv: Record<string, string | undefined> = {};
  const envNames = [
    'PAYPAL_API_BASE',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
    'FRONTEND_URL',
  ];

  // The services on a given database client, wired as the database module wires them; the
  // subscriptions service registers its handlers while PayPal is unconfigured, so it creates no plans.
  const wire = async (prisma: PrismaService) => {
    const repo = new PrismaRepository<any>(prisma);
    const accounts = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const scope = new MoneyScope(new PrismaTransaction(prisma), accounts);
    const creditsRepository = new CreditsRepository(scope, repo, repo, repo);
    const credits = new CreditsService(creditsRepository, accounts, scope);
    const pricing = new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      credits,
      accounts
    );
    const grants = new CreditGrantsService(
      creditsRepository,
      new CreditGrantsRepository(scope)
    );
    const client = new PaypalClient();
    const intake = new PaypalWebhookIntake(
      client,
      new PaypalEventsRepository(new PrismaTransaction(prisma), repo)
    );
    const subscriptionsRepository = new PaypalSubscriptionsRepository(
      repo,
      repo,
      repo
    );
    const subscriptions = new PaypalSubscriptionsService(
      client,
      intake,
      subscriptionsRepository,
      pricing,
      grants,
      accounts
    );
    const topups = new TopupsService(
      new TopupsRepository(repo),
      client,
      intake,
      credits,
      pricing,
      accounts
    );
    const reversals = new ReversalsService(
      new ReversalsRepository(repo),
      client,
      intake,
      subscriptions,
      topups,
      grants,
      accounts
    );
    const clientId = process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_ID;
    await subscriptions.onModuleInit();
    process.env.PAYPAL_CLIENT_ID = clientId;
    reversals.onModuleInit();
    return {
      reversals,
      subscriptions,
      subscriptionsRepository,
      intake,
      credits,
      grants,
      accounts,
    };
  };

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
    db = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(apiService);
    const accounts = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const scope = new MoneyScope(new PrismaTransaction(apiService), accounts);
    await new PricingService(
      new PricingRepository(new PrismaTransaction(apiService), repo, repo),
      new CreditsService(
        new CreditsRepository(scope, repo, repo, repo),
        accounts,
        scope
      ),
      accounts
    ).sync();
  });

  afterAll(async () => {
    await apiService.$disconnect();
    await workerService.$disconnect();
    await db.$disconnect();
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
    run = randomUUID();
    jest.clearAllMocks();
    process.env.PAYPAL_API_BASE = baseUrl;
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    process.env.PAYPAL_WEBHOOK_ID = 'WH-CONFIG';
    process.env.FRONTEND_URL = 'https://app.test';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await db.billingSubscription.deleteMany();
    await db.paypalPlan.deleteMany();
    await db.paypalPlan.create({
      data: {
        tierKey: 'STARTER',
        productId: 'PROD-1',
        planId: 'P-STARTER',
        priceCents: 900,
        currency: 'USD',
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // A workspace whose account belongs to its owner.
  const workspace = async (accounts: AccountsService) => {
    const org = await db.organization.create({
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
    const account = await db.account.findUniqueOrThrow({
      where: { id: accountId },
    });
    return { organizationId: org.id, accountId, ownerId: account.ownerId };
  };

  // The account's plan key.
  const planKey = async (accountId: string) =>
    (await db.account.findUniqueOrThrow({ where: { id: accountId } })).planKey;

  // The credits an account can spend now (negative while reversals are owed).
  const available = async (credits: CreditsService, organizationId: string) =>
    (await credits.balance(organizationId)).available;

  // The REVERSAL bucket a refund or reversal id wrote, or null.
  const reversal = (accountId: string, id: string) =>
    db.creditBucket.findFirst({
      where: { accountId, grantKey: `paypal:reversal:${id}` },
    });

  // The error status and body a call fails with.
  const failure = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const http = error as HttpException;
      return { status: http.getStatus(), body: http.getResponse() as any };
    }
    throw new Error('the call did not fail');
  };

  type Wired = Awaited<ReturnType<typeof wire>>;

  // An account with a paid top-up: `granted` of the order's `credits` granted under the capture's key
  // (less than `credits` when a refund was already on the order), and PayPal says `paid` was captured.
  const toppedUp = async (
    wired: Wired,
    credits = 100,
    paid = '5.00',
    granted = credits
  ) => {
    const ws = await workspace(wired.accounts);
    const captureId = 'CAP-' + randomUUID();
    const paypalOrderId = 'ORD-' + randomUUID();
    fake.orders.set(paypalOrderId, {
      purchase_units: [
        {
          payments: {
            captures: [{ id: captureId, status: 'COMPLETED' }],
            refunds: [],
          },
        },
      ],
    });
    await db.topupOrder.create({
      data: {
        accountId: ws.accountId,
        userId: ws.ownerId,
        paypalOrderId,
        captureId,
        packKey: 'pack.100',
        credits,
        priceCents: 500,
        currency: 'USD',
        status: 'CAPTURED',
        grantedAt: new Date(),
      },
    });
    await wired.grants.grantUntil(ws.accountId, {
      type: 'TOPUP',
      amount: granted,
      expiresAt: null,
      grantKey: `paypal:capture:${captureId}`,
    });
    fake.captures.set(captureId, {
      id: captureId,
      amount: { currency_code: 'USD', value: paid },
    });
    return { ...ws, captureId, paypalOrderId };
  };

  type TopUp = Awaited<ReturnType<typeof toppedUp>>;

  // PayPal lists a refund of the top-up's capture on its order, and answers the webhook announcing it.
  const refundOf = (
    t: TopUp,
    refundId: string,
    value: string,
    createTime = new Date().toISOString(),
    currency = 'USD'
  ) => {
    fake.orders.get(t.paypalOrderId)!.purchase_units[0].payments.refunds.push({
      id: refundId,
      status: 'COMPLETED',
      create_time: createTime,
      amount: { currency_code: currency, value },
    });
    const event = captureRefund(
      t.captureId,
      refundId,
      value,
      undefined,
      createTime
    );
    event.resource.amount.currency_code = currency;
    return event;
  };

  // An account on STARTER whose renewal of `sale` was processed: 300 credits granted, PayPal says $9.00 was paid.
  const subscribed = async (wired: Wired, nextBilling = inDays(30)) => {
    const ws = await workspace(wired.accounts);
    const subscriptionId = 'I-' + randomUUID();
    fake.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      plan_id: 'P-STARTER',
      custom_id: ws.accountId,
      status: 'ACTIVE',
      billing_info: { next_billing_time: nextBilling.toISOString() },
    });
    await wired.subscriptions.syncFromPaypal(subscriptionId);
    const saleId = 'SALE-' + randomUUID();
    fake.sales.set(saleId, {
      id: saleId,
      amount: { currency: 'USD', total: '9.00' },
    });
    const renewal = saleCompleted(subscriptionId, saleId);
    expect(await wired.intake.process(renewal)).toBe('processed');
    return { ...ws, subscriptionId, saleId, renewalId: renewal.id };
  };

  describe.each(['api', 'worker'] as const)('as the %s role', (role) => {
    const svc = () => wire(role === 'api' ? apiService : workerService);

    describe('top-up refunds and reversals', () => {
      it('takes back the share of the credits that the refunded money is of the money paid, rounded up', async () => {
        const w = await svc();
        const t = await toppedUp(w);

        const outcome = await w.intake.process(
          refundOf(t, id('REF-1'), '2.00')
        );

        expect(outcome).toBe('processed');
        expect(await available(w.credits, t.organizationId)).toBe(60);
        expect(await reversal(t.accountId, id('REF-1'))).toMatchObject({
          type: 'REVERSAL',
          initial: -40,
          expiresAt: null,
        });

        const small = await toppedUp(w);
        await w.intake.process(refundOf(small, id('REF-2'), '0.01'));
        expect(await available(w.credits, small.organizationId)).toBe(99);
      });

      it('reads the money paid from PayPal, not from the stored order', async () => {
        const w = await svc();
        const t = await toppedUp(w, 100, '4.00');

        await w.intake.process(refundOf(t, id('REF-1'), '2.00'));

        expect(await available(w.credits, t.organizationId)).toBe(50);
      });

      it('takes back the whole grant on a full refund and never more than the grant when more is returned', async () => {
        const w = await svc();
        const full = await toppedUp(w);
        const over = await toppedUp(w);

        await w.intake.process(refundOf(full, id('REF-F'), '5.00'));
        await w.intake.process(refundOf(over, id('REF-O'), '6.00'));

        expect(await available(w.credits, full.organizationId)).toBe(0);
        expect(await available(w.credits, over.organizationId)).toBe(0);
      });

      it('applies each refund once per refund id, whatever event delivers it', async () => {
        const w = await svc();
        const t = await toppedUp(w);
        const first = refundOf(t, id('REF-1'), '2.00');

        await w.intake.process(first);
        expect(await w.intake.process(first)).toBe('duplicate');
        await w.intake.process(refundOf(t, id('REF-1'), '2.00'));

        expect(await available(w.credits, t.organizationId)).toBe(60);
        expect(
          await db.creditBucket.count({
            where: { accountId: t.accountId, type: 'REVERSAL' },
          })
        ).toBe(1);
      });

      it('applies a second refund of the same capture on its own', async () => {
        const w = await svc();
        const t = await toppedUp(w);

        await w.intake.process(refundOf(t, id('REF-1'), '2.00'));
        await w.intake.process(refundOf(t, id('REF-2'), '3.00'));

        expect(await available(w.credits, t.organizationId)).toBe(0);
        expect(
          await db.creditBucket.count({
            where: { accountId: t.accountId, type: 'REVERSAL' },
          })
        ).toBe(2);
      });

      it('takes back the whole grant when a capture is reversed, once', async () => {
        const w = await svc();
        const t = await toppedUp(w);
        const event = captureReversed(t.captureId, '5.00');

        expect(await w.intake.process(event)).toBe('processed');
        await w.intake.process({ ...event, id: 'WH-' + randomUUID() });

        expect(await available(w.credits, t.organizationId)).toBe(0);
        expect(await reversal(t.accountId, t.captureId)).toMatchObject({
          type: 'REVERSAL',
          initial: -100,
        });
        expect(
          await db.creditBucket.count({
            where: { accountId: t.accountId, type: 'REVERSAL' },
          })
        ).toBe(1);
      });

      it('lets the balance go negative, blocks new spends with 402, and leaves published work alone', async () => {
        const w = await svc();
        const t = await toppedUp(w);
        await w.credits.spend(
          {
            organizationId: t.organizationId,
            actionKey: 'post.publish',
            quantity: 70,
            idempotencyKey: 'pub:' + randomUUID(),
          },
          async () => undefined
        );
        const committed = await db.creditLedger.findMany({
          where: { accountId: t.accountId },
        });

        await w.intake.process(refundOf(t, id('REF-1'), '5.00'));

        expect(await available(w.credits, t.organizationId)).toBe(-70);
        const refused = await failure(
          w.credits.reserve({
            organizationId: t.organizationId,
            actionKey: 'post.publish',
            idempotencyKey: 'new:' + randomUUID(),
          })
        );
        expect(refused.status).toBe(402);
        expect(refused.body.code).toBe('INSUFFICIENT_CREDITS');
        expect(
          await db.creditLedger.findMany({ where: { accountId: t.accountId } })
        ).toEqual(committed);
      });

      it('lets a post that was reserved before the refund publish and commit', async () => {
        const w = await svc();
        const t = await toppedUp(w);
        const key = 'post:' + randomUUID();
        await w.credits.reserve({
          organizationId: t.organizationId,
          actionKey: 'post.publish',
          idempotencyKey: key,
        });

        await w.intake.process(refundOf(t, id('REF-1'), '5.00'));
        await w.credits.commit(key, undefined, t.organizationId);

        expect(
          (
            await db.creditLedger.findUniqueOrThrow({
              where: { idempotencyKey: key },
            })
          ).status
        ).toBe('COMMITTED');
        expect(await w.credits.reconcile(t.accountId)).toEqual({
          buckets: [],
          ledgers: [],
        });
      });

      it('has nothing to take back for a capture that is no top-up, or a top-up that never granted', async () => {
        const w = await svc();
        const ws = await workspace(w.accounts);
        const never = await toppedUp(w);
        await db.creditEntry.deleteMany({
          where: { accountId: never.accountId },
        });
        await db.creditBucket.deleteMany({
          where: { accountId: never.accountId },
        });

        expect(
          await w.intake.process(
            captureRefund('CAP-unknown', id('REF-1'), '2.00')
          )
        ).toBe('processed');
        expect(
          await w.intake.process(refundOf(never, id('REF-2'), '2.00'))
        ).toBe('processed');

        expect(
          await db.creditBucket.count({
            where: { accountId: { in: [ws.accountId, never.accountId] } },
          })
        ).toBe(0);
      });

      it('leaves the event unprocessed while PayPal cannot be reached, and applies it once on redelivery', async () => {
        const w = await svc();
        const t = await toppedUp(w);
        const event = refundOf(t, id('REF-1'), '2.00');
        fake.failing.add('/v2/payments/captures');

        await expect(w.intake.process(event)).rejects.toThrow();

        expect(
          (await db.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }))
            .processedAt
        ).toBeNull();
        expect(await available(w.credits, t.organizationId)).toBe(100);
        fake.failing.clear();
        expect(await w.intake.process(event)).toBe('processed');
        expect(await available(w.credits, t.organizationId)).toBe(60);
      });

      it('fails, taking back nothing, when the refund is in another currency than the payment', async () => {
        const w = await svc();
        const t = await toppedUp(w);
        const event = refundOf(t, id('REF-1'), '2.00', undefined, 'EUR');

        await expect(w.intake.process(event)).rejects.toThrow();

        expect(await available(w.credits, t.organizationId)).toBe(100);
      });

      // The credits taken back in total are credits × refunded to date ÷ paid, in any event order.
      describe('whatever order the events are handled in', () => {
        it('takes nothing again for a refund already on the order when the capture was granted net', async () => {
          const w = await svc();
          const t = await toppedUp(w, 100, '5.00', 50);
          const event = refundOf(t, id('REF-1'), '2.50');

          expect(await w.intake.process(event)).toBe('processed');

          expect(await available(w.credits, t.organizationId)).toBe(50);
          expect(
            await db.creditBucket.count({
              where: { accountId: t.accountId, type: 'REVERSAL' },
            })
          ).toBe(0);
          expect(await w.intake.process(event)).toBe('duplicate');
          expect(await available(w.credits, t.organizationId)).toBe(50);
        });

        it('takes only the later refund when the grant already left out the earlier one', async () => {
          const w = await svc();
          const t = await toppedUp(w, 100, '5.00', 80);
          const early = refundOf(
            t,
            id('REF-1'),
            '1.00',
            '2026-10-01T10:00:00Z'
          );
          const late = refundOf(t, id('REF-2'), '2.00', '2026-10-02T10:00:00Z');

          await w.intake.process(early);
          await w.intake.process(late);

          expect(await available(w.credits, t.organizationId)).toBe(40);
        });

        it('ends with the same balance whichever of two refunds is handled first', async () => {
          const w = await svc();
          const forward = await toppedUp(w);
          const backward = await toppedUp(w);
          const events = (t: TopUp) => [
            refundOf(
              t,
              id(`REF-1-${t.captureId}`),
              '1.00',
              '2026-10-01T10:00:00Z'
            ),
            refundOf(
              t,
              id(`REF-2-${t.captureId}`),
              '2.00',
              '2026-10-02T10:00:00Z'
            ),
          ];

          const [f1, f2] = events(forward);
          await w.intake.process(f1);
          await w.intake.process(f2);
          const [b1, b2] = events(backward);
          await w.intake.process(b2);
          await w.intake.process(b1);

          expect(await available(w.credits, forward.organizationId)).toBe(40);
          expect(await available(w.credits, backward.organizationId)).toBe(40);
        });

        it('never takes more in total than credits × refunded ÷ paid rounded up, however many small refunds', async () => {
          const w = await svc();
          const t = await toppedUp(w);

          for (const n of [1, 2, 3]) {
            await w.intake.process(
              refundOf(t, id(`REF-${n}`), '0.01', `2026-10-0${n}T10:00:00Z`)
            );
          }

          expect(await available(w.credits, t.organizationId)).toBe(99);
        });

        it('takes only what the refunds left when the capture is then reversed, in either order', async () => {
          const w = await svc();
          const after = await toppedUp(w);
          const before = await toppedUp(w);
          const partial = refundOf(after, id('REF-A'), '2.00');
          const reversed = captureReversed(after.captureId, '5.00');

          await w.intake.process(partial);
          await w.intake.process(reversed);
          expect(await available(w.credits, after.organizationId)).toBe(0);

          const late = refundOf(before, id('REF-B'), '2.00');
          await w.intake.process(captureReversed(before.captureId, '5.00'));
          await w.intake.process(late);
          expect(await available(w.credits, before.organizationId)).toBe(0);
        });

        it('fails, taking nothing, for a refund the order does not list yet, and passes over a cancelled one', async () => {
          const w = await svc();
          const t = await toppedUp(w);
          const unlisted = captureRefund(t.captureId, id('REF-X'), '2.00');
          const cancelled = refundOf(t, id('REF-C'), '2.00');
          fake.orders.get(
            t.paypalOrderId
          )!.purchase_units[0].payments.refunds[0].status = 'CANCELLED';

          await expect(w.intake.process(unlisted)).rejects.toThrow();
          expect(await w.intake.process(cancelled)).toBe('processed');

          expect(await available(w.credits, t.organizationId)).toBe(100);
        });

        it('takes the whole grant once the capture shows as fully refunded', async () => {
          const w = await svc();
          const t = await toppedUp(w);
          const first = refundOf(t, id('REF-1'), '2.00');
          fake.orders.get(
            t.paypalOrderId
          )!.purchase_units[0].payments.captures[0].status = 'REFUNDED';

          await w.intake.process(first);

          expect(await available(w.credits, t.organizationId)).toBe(0);
        });
      });
    });

    describe('plan payment refunds and reversals', () => {
      it('takes back the share of the renewal credits that the refunded money is of the sale', async () => {
        const w = await svc();
        const s = await subscribed(w);

        const outcome = await w.intake.process(
          saleReturned('PAYMENT.SALE.REFUNDED', s.saleId, id('REF-1'), '3.00')
        );

        expect(outcome).toBe('processed');
        expect(await available(w.credits, s.organizationId)).toBe(200);
        expect(await reversal(s.accountId, id('REF-1'))).toMatchObject({
          type: 'REVERSAL',
          initial: -100,
        });
      });

      it('takes back the whole renewal on a full refund and on a reversal, once per refund id', async () => {
        const w = await svc();
        const refunded = await subscribed(w);
        const reversed = await subscribed(w);
        const again = saleReturned(
          'PAYMENT.SALE.REFUNDED',
          refunded.saleId,
          id('REF-1'),
          '9.00'
        );

        await w.intake.process(again);
        await w.intake.process({ ...again, id: 'WH-' + randomUUID() });
        await w.intake.process(
          saleReturned(
            'PAYMENT.SALE.REVERSED',
            reversed.saleId,
            id('REV-1'),
            '9.00'
          )
        );

        expect(await available(w.credits, refunded.organizationId)).toBe(0);
        expect(await available(w.credits, reversed.organizationId)).toBe(0);
        expect(
          await db.creditBucket.count({
            where: { accountId: refunded.accountId, type: 'REVERSAL' },
          })
        ).toBe(1);
      });

      it('fails while the renewal is unprocessed, and takes the credits back once the renewal is processed', async () => {
        const w = await svc();
        const ws = await workspace(w.accounts);
        const subscriptionId = 'I-' + randomUUID();
        fake.subscriptions.set(subscriptionId, {
          id: subscriptionId,
          plan_id: 'P-STARTER',
          custom_id: ws.accountId,
          status: 'ACTIVE',
          billing_info: { next_billing_time: inDays(30).toISOString() },
        });
        const saleId = 'SALE-' + randomUUID();
        fake.sales.set(saleId, {
          id: saleId,
          amount: { currency: 'USD', total: '9.00' },
        });
        const refund = saleReturned(
          'PAYMENT.SALE.REFUNDED',
          saleId,
          id('REF-1'),
          '3.00'
        );

        await expect(w.intake.process(refund)).rejects.toThrow();
        expect(
          (
            await db.paymentEvent.findUniqueOrThrow({
              where: { id: refund.id },
            })
          ).processedAt
        ).toBeNull();
        await w.intake.process(saleCompleted(subscriptionId, saleId));
        expect(await available(w.credits, ws.organizationId)).toBe(300);
        expect(await w.intake.process(refund)).toBe('processed');

        expect(await available(w.credits, ws.organizationId)).toBe(200);
      });

      it('alerts and counts a refund processed when its renewal never was and it is older than the replay window', async () => {
        const w = await svc();
        const old = saleReturned(
          'PAYMENT.SALE.REFUNDED',
          'SALE-' + randomUUID(),
          id('REF-1'),
          '3.00',
          undefined,
          new Date(Date.now() - 4 * DAY).toISOString()
        );

        expect(await w.intake.process(old)).toBe('processed');

        expect(
          (await db.paymentEvent.findUniqueOrThrow({ where: { id: old.id } }))
            .processedAt
        ).not.toBeNull();
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            extra: expect.objectContaining({ eventId: old.id }),
          })
        );
      });

      it('has nothing to take back when the renewal granted nothing, or the subscription is not ours', async () => {
        const w = await svc();
        const none = await subscribed(w);
        await db.creditEntry.deleteMany({
          where: { accountId: none.accountId },
        });
        await db.creditBucket.deleteMany({
          where: { accountId: none.accountId },
        });
        const foreignSale = 'SALE-' + randomUUID();
        await w.intake.process(saleCompleted('I-unknown', foreignSale));

        expect(
          await w.intake.process(
            saleReturned(
              'PAYMENT.SALE.REFUNDED',
              none.saleId,
              id('REF-1'),
              '3.00'
            )
          )
        ).toBe('processed');
        expect(
          await w.intake.process(
            saleReturned(
              'PAYMENT.SALE.REFUNDED',
              foreignSale,
              id('REF-2'),
              '3.00'
            )
          )
        ).toBe('processed');

        expect(
          await db.creditBucket.count({ where: { accountId: none.accountId } })
        ).toBe(0);
      });
    });

    describe('disputes', () => {
      it('only logs them, moving no credits and changing no plan', async () => {
        const w = await svc();
        const t = await toppedUp(w);

        expect(
          await w.intake.process(
            simpleEvent('CUSTOMER.DISPUTE.CREATED', 'PP-D-1')
          )
        ).toBe('processed');
        expect(
          await w.intake.process(
            simpleEvent('CUSTOMER.DISPUTE.RESOLVED', 'PP-D-1')
          )
        ).toBe('processed');

        expect(await available(w.credits, t.organizationId)).toBe(100);
        expect(
          await db.creditBucket.count({
            where: { accountId: t.accountId, type: 'REVERSAL' },
          })
        ).toBe(0);
      });
    });

    describe('the end of a subscription', () => {
      // Sets what PayPal now says about the subscription, then delivers the matching notice.
      const ends = async (
        w: Wired,
        s: { subscriptionId: string },
        status: string,
        nextBilling?: Date
      ) => {
        const state = fake.subscriptions.get(s.subscriptionId)!;
        state.status = status;
        if (nextBilling) {
          state.billing_info.next_billing_time = nextBilling.toISOString();
        }
        return w.intake.process(
          simpleEvent(`BILLING.SUBSCRIPTION.${status}`, s.subscriptionId)
        );
      };

      it.each(['SUSPENDED', 'EXPIRED'])(
        'puts the account on FREE at once when the subscription is %s',
        async (status) => {
          const w = await svc();
          const s = await subscribed(w);
          expect(await planKey(s.accountId)).toBe('STARTER');

          expect(await ends(w, s, status)).toBe('processed');

          expect(await planKey(s.accountId)).toBe('FREE');
        }
      );

      it('keeps the tier of a cancelled subscription until its paid period ends, then puts the account on FREE', async () => {
        const w = await svc();
        const s = await subscribed(w);

        await ends(w, s, 'CANCELLED');
        expect(await planKey(s.accountId)).toBe('STARTER');
        await ends(w, s, 'CANCELLED', inDays(-1));

        expect(await planKey(s.accountId)).toBe('FREE');
      });

      it('leaves credits and reserved posts as they are', async () => {
        const w = await svc();
        const s = await subscribed(w);
        const key = 'post:' + randomUUID();
        await w.credits.reserve({
          organizationId: s.organizationId,
          actionKey: 'post.publish',
          idempotencyKey: key,
        });

        await ends(w, s, 'SUSPENDED');

        expect(await planKey(s.accountId)).toBe('FREE');
        expect(await available(w.credits, s.organizationId)).toBe(299);
        expect(
          (
            await db.creditLedger.findUniqueOrThrow({
              where: { idempotencyKey: key },
            })
          ).status
        ).toBe('RESERVED');
      });

      it('ignores a subscription that is not ours', async () => {
        const w = await svc();
        const s = await subscribed(w);

        expect(
          await w.intake.process(
            simpleEvent('BILLING.SUBSCRIPTION.SUSPENDED', 'I-unknown')
          )
        ).toBe('processed');

        expect(await planKey(s.accountId)).toBe('STARTER');
      });
    });

    describe('enforceLapse', () => {
      // An account on STARTER holding a stored subscription with this status and period end.
      const holding = async (w: Wired, status: string, end: Date | null) => {
        const ws = await workspace(w.accounts);
        await db.account.update({
          where: { id: ws.accountId },
          data: { planKey: 'STARTER' },
        });
        await w.subscriptionsRepository.save({
          accountId: ws.accountId,
          externalId: 'I-' + randomUUID(),
          tierKey: 'STARTER',
          status,
          currentPeriodEnd: end,
          cancelAtPeriodEnd: status === 'CANCELLED',
        });
        return ws;
      };

      it.each([
        ['SUSPENDED', 30, true],
        ['EXPIRED', 30, true],
        ['CANCELLED', 5, false],
        ['CANCELLED', -1, true],
        ['CANCELLED', null, true],
        ['ACTIVE', 5, false],
        ['ACTIVE', -1, true],
        ['ACTIVE', null, false],
        ['APPROVAL_PENDING', null, false],
      ] as const)(
        '%s with a period end %s days away: lapsed is %s',
        async (status, days, lapsed) => {
          const w = await svc();
          const ws = await holding(
            w,
            status,
            days === null ? null : inDays(days)
          );

          const result = await w.reversals.enforceLapse(ws.accountId);

          expect(result).toEqual({
            planKey: lapsed ? 'FREE' : 'STARTER',
            changed: lapsed,
          });
          expect(await planKey(ws.accountId)).toBe(lapsed ? 'FREE' : 'STARTER');
        }
      );

      it('changes nothing the second time, for an account already on FREE, and for one with no subscription', async () => {
        const w = await svc();
        const ws = await holding(w, 'SUSPENDED', null);
        const bare = await workspace(w.accounts);
        await db.account.update({
          where: { id: bare.accountId },
          data: { planKey: 'STARTER' },
        });

        expect((await w.reversals.enforceLapse(ws.accountId)).changed).toBe(
          true
        );
        expect(await w.reversals.enforceLapse(ws.accountId)).toEqual({
          planKey: 'FREE',
          changed: false,
        });
        expect(await w.reversals.enforceLapse(bare.accountId)).toEqual({
          planKey: 'STARTER',
          changed: false,
        });
      });

      it('judges the period against the given moment', async () => {
        const w = await svc();
        const ws = await holding(w, 'CANCELLED', inDays(5));

        expect(
          (await w.reversals.enforceLapse(ws.accountId, inDays(4))).changed
        ).toBe(false);
        expect(await w.reversals.enforceLapse(ws.accountId, inDays(6))).toEqual(
          { planKey: 'FREE', changed: true }
        );
      });

      it('answers 404 for an account that does not exist', async () => {
        const w = await svc();

        const error = await failure(w.reversals.enforceLapse(randomUUID()));

        expect(error.status).toBe(404);
      });
    });

    describe('dailyPoll', () => {
      it('replays the last three days of PayPal events, applying a refund whose webhook was lost, once', async () => {
        const w = await svc();
        const t = await toppedUp(w);
        const now = new Date();
        fake.events = [refundOf(t, id('REF-1'), '2.00')];

        const first = await w.reversals.dailyPoll(now);
        const second = await w.reversals.dailyPoll(now);

        const listing = fake.seen.find((s) =>
          s.url.startsWith('/v1/notifications/webhooks-events')
        )!;
        expect(decodeURIComponent(listing.url)).toContain(
          `start_time=${new Date(now.getTime() - 3 * DAY).toISOString()}`
        );
        expect(first.replayed).toBe(1);
        expect(second.replayed).toBe(0);
        expect(await available(w.credits, t.organizationId)).toBe(60);
      });

      it('puts an account on FREE within one poll even though every webhook was lost', async () => {
        const w = await svc();
        const lost = await subscribed(w);
        const kept = await subscribed(w);
        fake.subscriptions.get(lost.subscriptionId)!.status = 'SUSPENDED';

        const result = await w.reversals.dailyPoll();

        expect(result).toEqual({ replayed: 0, checked: 2, lapsed: 1 });
        expect(await planKey(lost.accountId)).toBe('FREE');
        expect(await planKey(kept.accountId)).toBe('STARTER');
      });

      it('syncs every PayPal subscription, a page at a time', async () => {
        const w = await svc();
        const count = 101;
        const ids = Array.from({ length: count }, () => randomUUID());
        await db.user.createMany({
          data: ids.map((id) => ({
            id,
            email: id + '@test.local',
            providerName: 'LOCAL',
            timezone: 0,
          })),
        });
        await db.account.createMany({
          data: ids.map((ownerId) => ({ ownerId })),
        });
        const accounts = await db.account.findMany({
          where: { ownerId: { in: ids } },
        });
        for (const account of accounts) {
          const externalId = 'I-' + account.id;
          fake.subscriptions.set(externalId, {
            id: externalId,
            plan_id: 'P-STARTER',
            custom_id: account.id,
            status: 'ACTIVE',
            billing_info: { next_billing_time: inDays(30).toISOString() },
          });
        }
        await db.billingSubscription.createMany({
          data: accounts.map((account) => ({
            accountId: account.id,
            provider: 'paypal',
            externalId: 'I-' + account.id,
            tierKey: 'STARTER',
            status: 'APPROVAL_PENDING',
          })),
        });

        const result = await w.reversals.dailyPoll();

        expect(result).toEqual({ replayed: 0, checked: count, lapsed: 0 });
        expect(
          await db.account.count({
            where: { ownerId: { in: ids }, planKey: 'STARTER' },
          })
        ).toBe(count);
      });

      it('carries on past a subscription PayPal does not know and one it cannot read', async () => {
        const w = await svc();
        const lapsing = await subscribed(w);
        const unknown = await subscribed(w);
        const broken = await subscribed(w);
        fake.subscriptions.get(lapsing.subscriptionId)!.status = 'EXPIRED';
        fake.subscriptions.delete(unknown.subscriptionId);
        fake.failing.add(`/v1/billing/subscriptions/${broken.subscriptionId}`);

        const result = await w.reversals.dailyPoll();

        expect(result).toEqual({ replayed: 0, checked: 1, lapsed: 1 });
        expect(await planKey(lapsing.accountId)).toBe('FREE');
        expect(Sentry.captureException).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            extra: { subscriptionId: broken.subscriptionId },
          })
        );
      });

      it('does nothing, and asks PayPal nothing, while PayPal is not configured', async () => {
        const w = await svc();
        await subscribed(w);
        fake.seen = [];
        delete process.env.PAYPAL_CLIENT_SECRET;

        const result = await w.reversals.dailyPoll();

        expect(result).toEqual({ replayed: 0, checked: 0, lapsed: 0 });
        expect(fake.seen).toEqual([]);
      });
    });
  });
});
