// PayPal top-ups: a credit pack buys credits only once its payment is captured, exactly once
// per capture, with no expiry, from the pack's price and credits as they were when ordered.
//
// Runs against a real Postgres (migrated and given the API role by the jest global setup), on both
// database roles, with the real PayPal client, webhook intake, credit and pricing services; a local
// HTTP server stands in for PayPal's Orders API.
import { HttpException, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PaypalClient } from '@gitroom/nestjs-libraries/services/paypal/paypal.client';
import { PaypalEventsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.events.repository';
import {
  PaypalEvent,
  PaypalWebhookIntake,
} from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { PRICING } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { TopupsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.repository';
import { TopupsService } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// What the stand-in PayPal keeps about one order and what it does when the order is captured.
interface FakeOrder {
  id: string;
  customId: string;
  amount: { currency_code: string; value: string };
  captures: { id: string; status: string; amount: any }[];
  refunds: { status: string; amount: any }[];
}
type CaptureMode =
  | 'complete'
  | 'pending'
  | 'declined'
  | 'already'
  | 'not-approved'
  | 'status-declined';
type Seen = { method: string; url: string; body: any; requestId?: string };

let server: Server;
let baseUrl: string;
let seen: Seen[];
let orders: Map<string, FakeOrder>;
let captureMode: CaptureMode;

// Answers with JSON.
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Captures the order on PayPal's side as COMPLETED (or the given status).
const capturedBy = (order: FakeOrder, status = 'COMPLETED') => {
  const capture = {
    id: 'CAP-' + randomUUID(),
    status,
    amount: order.amount,
  };
  order.captures.push(capture);
  return capture;
};

// The stand-in's answer to one request from the server under test.
const standIn = (req: Seen, res: ServerResponse) => {
  const match = /^\/v2\/checkout\/orders(?:\/([^/]+?))?(\/capture)?$/.exec(
    req.url
  );
  if (!match) {
    return json(res, 404, { name: 'NOT_FOUND' });
  }
  const [, id, capture] = match;
  if (!id && req.method === 'POST') {
    const unit = req.body.purchase_units[0];
    const order: FakeOrder = {
      id: 'ORD-' + randomUUID(),
      customId: unit.custom_id,
      amount: unit.amount,
      captures: [],
      refunds: [],
    };
    orders.set(order.id, order);
    return json(res, 201, {
      id: order.id,
      status: 'PAYER_ACTION_REQUIRED',
      links: [
        { rel: 'self', href: `${baseUrl}/v2/checkout/orders/${order.id}` },
        {
          rel: 'payer-action',
          href: `https://paypal.test/approve/${order.id}`,
        },
      ],
    });
  }
  const order = id ? orders.get(id) : undefined;
  if (!order) {
    return json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
  }
  if (capture) {
    const refusals: Partial<Record<CaptureMode, string>> = {
      declined: 'INSTRUMENT_DECLINED',
      'not-approved': 'ORDER_NOT_APPROVED',
      already: 'ORDER_ALREADY_CAPTURED',
    };
    if (refusals[captureMode]) {
      // PayPal names a refused capture UNPROCESSABLE_ENTITY and gives the reason as the detail's issue.
      return json(res, 422, {
        name: 'UNPROCESSABLE_ENTITY',
        details: [{ issue: refusals[captureMode] }],
      });
    }
    if (!order.captures.length) {
      capturedBy(
        order,
        captureMode === 'pending'
          ? 'PENDING'
          : captureMode === 'status-declined'
          ? 'DECLINED'
          : 'COMPLETED'
      );
    }
    return json(res, 201, { id: order.id, status: 'COMPLETED' });
  }
  return json(res, 200, {
    id: order.id,
    status: 'COMPLETED',
    purchase_units: [
      {
        custom_id: order.customId,
        payments: { captures: order.captures, refunds: order.refunds },
      },
    ],
  });
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/oauth2/token') {
        return json(res, 200, { access_token: 'token', expires_in: 32400 });
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = {
        method: req.method!,
        url: req.url!,
        body: text ? JSON.parse(text) : undefined,
        requestId: req.headers['paypal-request-id'] as string | undefined,
      };
      seen.push(entry);
      standIn(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// The pack every test buys: 100 credits for $5.00, so shares of it are easy to check by hand.
const PACK = {
  key: 'test.pack',
  credits: 100,
  priceCents: 500,
  currency: 'USD' as const,
};

describeDb('TopupsService (Postgres)', () => {
  let apiService: PrismaService;
  let workerService: PrismaService;
  let db: PrismaClient;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;
  const savedPaypal: Record<string, string | undefined> = {};
  const savedPacks = PRICING.topupPacks;
  const savedFrontend = process.env.FRONTEND_URL;

  // The services on a given database client, wired as the database module wires them.
  const wire = (prisma: PrismaService) => {
    const repo = new PrismaRepository<any>(prisma);
    const accounts = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const scope = new MoneyScope(new PrismaTransaction(prisma), accounts);
    const credits = new CreditsService(
      new CreditsRepository(scope, repo, repo, repo),
      accounts,
      scope
    );
    const pricing = new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      credits,
      accounts
    );
    const client = new PaypalClient();
    const intake = new PaypalWebhookIntake(
      client,
      new PaypalEventsRepository(new PrismaTransaction(prisma), repo)
    );
    const topups = new TopupsService(
      new TopupsRepository(repo),
      client,
      intake,
      credits,
      pricing,
      accounts
    );
    topups.onModuleInit();
    return { topups, credits, intake, accounts };
  };

  beforeAll(async () => {
    for (const name of [
      'PAYPAL_API_BASE',
      'PAYPAL_CLIENT_ID',
      'PAYPAL_CLIENT_SECRET',
      'PAYPAL_WEBHOOK_ID',
    ]) {
      savedPaypal[name] = process.env[name];
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
    PRICING.topupPacks = [PACK];
    process.env.FRONTEND_URL = 'https://app.test';
  });

  afterAll(async () => {
    PRICING.topupPacks = savedPacks;
    await apiService.$disconnect();
    await workerService.$disconnect();
    await db.$disconnect();
    for (const [name, value] of Object.entries(savedPaypal)) {
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
    if (savedFrontend === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = savedFrontend;
    }
  });

  beforeEach(() => {
    seen = [];
    orders = new Map();
    captureMode = 'complete';
    process.env.PAYPAL_API_BASE = baseUrl;
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    process.env.PAYPAL_WEBHOOK_ID = 'WH-CONFIG';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // A workspace whose account belongs to its owner, plus a member who is not the owner.
  const workspace = async (accounts: AccountsService) => {
    const user = (email: string) =>
      ({
        user: {
          create: {
            email: `${email}-${randomUUID()}@test.local`,
            providerName: 'LOCAL',
            timezone: 0,
          },
        },
      } as const);
    const org = await db.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: {
          create: [
            { role: 'SUPERADMIN', ...user('owner') },
            { role: 'USER', ...user('member') },
          ],
        },
      },
      include: { users: true },
    });
    const accountId = await accounts.getAccountIdForOrganization(org.id);
    const account = await db.account.findUniqueOrThrow({
      where: { id: accountId },
    });
    return {
      organizationId: org.id,
      accountId,
      ownerId: account.ownerId,
      memberId: org.users.find((u) => u.userId !== account.ownerId)!.userId,
    };
  };

  // What the account holds: its available credits.
  const available = async (credits: CreditsService, organizationId: string) =>
    (await credits.balance(organizationId)).available;

  // The TOPUP buckets of an account.
  const topupBuckets = (accountId: string) =>
    db.creditBucket.findMany({ where: { accountId, type: 'TOPUP' } });

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

  // PayPal's webhook for a completed capture of the order, as the intake receives it.
  const captureEvent = (
    captureId: string,
    reference: { customId?: string; orderId?: string }
  ): PaypalEvent => ({
    id: 'WH-' + randomUUID(),
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource_type: 'capture',
    resource: {
      id: captureId,
      status: 'COMPLETED',
      custom_id: reference.customId,
      supplementary_data: reference.orderId
        ? { related_ids: { order_id: reference.orderId } }
        : undefined,
    },
    create_time: '2026-10-04T10:00:00Z',
  });

  describe.each(['api', 'worker'] as const)('as the %s role', (role) => {
    const svc = () => wire(role === 'api' ? apiService : workerService);

    describe('createOrder', () => {
      it('creates a PayPal CAPTURE order for the pack and answers the approval link, granting nothing', async () => {
        const { topups, credits, accounts } = svc();
        const ws = await workspace(accounts);

        const created = await topups.createOrder(
          ws.organizationId,
          ws.ownerId,
          PACK.key
        );

        const post = seen.find(
          (s) => s.method === 'POST' && s.url === '/v2/checkout/orders'
        )!;
        expect(post.body.intent).toBe('CAPTURE');
        expect(post.body.purchase_units[0].amount).toEqual({
          currency_code: 'USD',
          value: '5.00',
        });
        expect(
          post.body.payment_source.paypal.experience_context.return_url
        ).toBe(`https://app.test/w/${ws.organizationId}/billing/topup-return`);
        expect(post.requestId).toBeTruthy();
        const row = await db.topupOrder.findUniqueOrThrow({
          where: { paypalOrderId: created.orderId },
        });
        expect(post.body.purchase_units[0].custom_id).toBe(row.id);
        expect(created.orderId).toBe(orders.keys().next().value);
        expect(created.approveUrl).toBe(
          `https://paypal.test/approve/${created.orderId}`
        );
        expect(row).toMatchObject({
          accountId: ws.accountId,
          userId: ws.ownerId,
          packKey: PACK.key,
          credits: 100,
          priceCents: 500,
          currency: 'USD',
          status: 'CREATED',
          grantedAt: null,
          captureId: null,
        });
        expect(await available(credits, ws.organizationId)).toBe(0);
        expect(await topupBuckets(ws.accountId)).toEqual([]);
      });

      it('refuses a pack that is not in the pricing file with 400 UNKNOWN_PACK and does not call PayPal', async () => {
        const { topups, accounts } = svc();
        const ws = await workspace(accounts);

        const error = await failure(
          topups.createOrder(ws.organizationId, ws.ownerId, 'no.such.pack')
        );

        expect(error.status).toBe(400);
        expect(error.body.code).toBe('UNKNOWN_PACK');
        expect(seen).toEqual([]);
      });

      it('refuses a user who is not the account owner with 403 NOT_ACCOUNT_OWNER and does not call PayPal', async () => {
        const { topups, accounts } = svc();
        const ws = await workspace(accounts);

        const error = await failure(
          topups.createOrder(ws.organizationId, ws.memberId, PACK.key)
        );

        expect(error.status).toBe(403);
        expect(error.body.code).toBe('NOT_ACCOUNT_OWNER');
        expect(seen).toEqual([]);
      });

      it('answers 503 BILLING_NOT_CONFIGURED while a PayPal env var is missing', async () => {
        const { topups, accounts } = svc();
        const ws = await workspace(accounts);
        delete process.env.PAYPAL_CLIENT_SECRET;

        const error = await failure(
          topups.createOrder(ws.organizationId, ws.ownerId, PACK.key)
        );

        expect(error.status).toBe(503);
        expect(error.body.code).toBe('BILLING_NOT_CONFIGURED');
        expect(
          await db.topupOrder.count({ where: { accountId: ws.accountId } })
        ).toBe(0);
      });
    });

    describe('capture', () => {
      // An order the owner created, ready to be approved and captured.
      const ordered = async () => {
        const wired = svc();
        const ws = await workspace(wired.accounts);
        const { orderId } = await wired.topups.createOrder(
          ws.organizationId,
          ws.ownerId,
          PACK.key
        );
        return { ...wired, ...ws, orderId, fake: orders.get(orderId)! };
      };

      it('grants the pack once, as a TOPUP bucket that never expires under paypal:capture:{captureId}', async () => {
        const o = await ordered();

        const view = await o.topups.capture(
          o.organizationId,
          o.ownerId,
          o.orderId
        );

        const captureId = o.fake.captures[0].id;
        expect(view).toMatchObject({
          orderId: o.orderId,
          packKey: PACK.key,
          credits: 100,
          priceCents: 500,
          currency: 'USD',
          status: 'CAPTURED',
        });
        expect(view.grantedAt).toEqual(expect.any(String));
        const buckets = await topupBuckets(o.accountId);
        expect(buckets).toHaveLength(1);
        expect(buckets[0]).toMatchObject({
          grantKey: `paypal:capture:${captureId}`,
          initial: 100,
          remaining: 100,
          expiresAt: null,
        });
        expect(await available(o.credits, o.organizationId)).toBe(100);
        expect(await o.credits.reconcile(o.accountId)).toEqual({
          buckets: [],
          ledgers: [],
        });
      });

      it('grants nothing a second time when the capture is called again, and does not ask PayPal again', async () => {
        const o = await ordered();
        const first = await o.topups.capture(
          o.organizationId,
          o.ownerId,
          o.orderId
        );
        const calls = seen.length;

        const second = await o.topups.capture(
          o.organizationId,
          o.ownerId,
          o.orderId
        );

        expect(second).toEqual(first);
        expect(seen).toHaveLength(calls);
        expect(await topupBuckets(o.accountId)).toHaveLength(1);
        expect(await available(o.credits, o.organizationId)).toBe(100);
      });

      it('grants once when the capture call, the webhook and its redelivery all arrive, concurrently', async () => {
        const o = await ordered();

        const settled = await Promise.allSettled([
          o.topups.capture(o.organizationId, o.ownerId, o.orderId),
          o.topups.capture(o.organizationId, o.ownerId, o.orderId),
          o.topups.capture(o.organizationId, o.ownerId, o.orderId),
        ]);
        expect(settled.map((s) => s.status)).toEqual([
          'fulfilled',
          'fulfilled',
          'fulfilled',
        ]);
        const captureId = o.fake.captures[0].id;
        const hook = captureEvent(captureId, { customId: o.fake.customId });
        await Promise.all([
          o.intake.process(hook),
          o.intake.process({ ...hook, id: 'WH-' + randomUUID() }),
        ]);

        expect(await topupBuckets(o.accountId)).toHaveLength(1);
        expect(await available(o.credits, o.organizationId)).toBe(100);
      });

      it('grants nothing while the capture is PENDING (approved, not paid) and records it APPROVED', async () => {
        const o = await ordered();
        captureMode = 'pending';

        const view = await o.topups.capture(
          o.organizationId,
          o.ownerId,
          o.orderId
        );

        expect(view.status).toBe('APPROVED');
        expect(view.grantedAt).toBeNull();
        expect(await topupBuckets(o.accountId)).toEqual([]);
        expect(await available(o.credits, o.organizationId)).toBe(0);
      });

      it('grants when the PENDING capture later completes and PayPal sends PAYMENT.CAPTURE.COMPLETED', async () => {
        const o = await ordered();
        captureMode = 'pending';
        await o.topups.capture(o.organizationId, o.ownerId, o.orderId);
        o.fake.captures[0].status = 'COMPLETED';
        const captureId = o.fake.captures[0].id;

        const outcome = await o.intake.process(
          captureEvent(captureId, { customId: o.fake.customId })
        );

        expect(outcome).toBe('processed');
        const view = await o.topups.get(o.organizationId, o.orderId);
        expect(view.status).toBe('CAPTURED');
        expect(view.grantedAt).toEqual(expect.any(String));
        expect(await available(o.credits, o.organizationId)).toBe(100);
        const buckets = await topupBuckets(o.accountId);
        expect(buckets.map((b) => b.grantKey)).toEqual([
          `paypal:capture:${captureId}`,
        ]);
      });

      it('grants from the webhook alone when the buyer never returns, finding the order by custom_id', async () => {
        const o = await ordered();
        const capture = capturedBy(o.fake);

        await o.intake.process(
          captureEvent(capture.id, { customId: o.fake.customId })
        );

        expect(await available(o.credits, o.organizationId)).toBe(100);
        expect((await o.topups.get(o.organizationId, o.orderId)).status).toBe(
          'CAPTURED'
        );
      });

      it('finds the order by the PayPal order id when the event carries no custom_id', async () => {
        const o = await ordered();
        const capture = capturedBy(o.fake);

        await o.intake.process(
          captureEvent(capture.id, { orderId: o.orderId })
        );

        expect(await available(o.credits, o.organizationId)).toBe(100);
      });

      it('ignores a captured payment that is not a top-up, granting nothing', async () => {
        const { intake, accounts } = svc();
        const ws = await workspace(accounts);

        const outcome = await intake.process(
          captureEvent('CAP-foreign', { customId: randomUUID() })
        );

        expect(outcome).toBe('processed');
        expect(await topupBuckets(ws.accountId)).toEqual([]);
      });

      it('refuses a declined instrument with 402 PAYMENT_DECLINED, grants nothing and lets the buyer try again', async () => {
        const o = await ordered();
        captureMode = 'declined';

        const error = await failure(
          o.topups.capture(o.organizationId, o.ownerId, o.orderId)
        );

        expect(error.status).toBe(402);
        expect(error.body.code).toBe('PAYMENT_DECLINED');
        expect((await o.topups.get(o.organizationId, o.orderId)).status).toBe(
          'FAILED'
        );
        expect(await topupBuckets(o.accountId)).toEqual([]);

        captureMode = 'complete';
        const retried = await o.topups.capture(
          o.organizationId,
          o.ownerId,
          o.orderId
        );
        expect(retried.status).toBe('CAPTURED');
        expect(await available(o.credits, o.organizationId)).toBe(100);
      });

      it('answers 402 PAYMENT_DECLINED for a capture PayPal reports DECLINED, without granting', async () => {
        const o = await ordered();
        captureMode = 'status-declined';

        const error = await failure(
          o.topups.capture(o.organizationId, o.ownerId, o.orderId)
        );

        expect(error.status).toBe(402);
        expect(error.body.code).toBe('PAYMENT_DECLINED');
        expect(await topupBuckets(o.accountId)).toEqual([]);
      });

      it('answers 402 PAYMENT_DECLINED for an order the buyer has not approved, without granting or failing the order', async () => {
        const o = await ordered();
        captureMode = 'not-approved';

        const error = await failure(
          o.topups.capture(o.organizationId, o.ownerId, o.orderId)
        );

        expect(error.status).toBe(402);
        expect(error.body.code).toBe('PAYMENT_DECLINED');
        expect((await o.topups.get(o.organizationId, o.orderId)).status).toBe(
          'CREATED'
        );
        expect(await topupBuckets(o.accountId)).toEqual([]);
      });

      it('converges on one grant when PayPal says the order was already captured', async () => {
        const o = await ordered();
        const capture = capturedBy(o.fake);
        captureMode = 'already';

        const view = await o.topups.capture(
          o.organizationId,
          o.ownerId,
          o.orderId
        );

        expect(view.status).toBe('CAPTURED');
        expect(
          (await topupBuckets(o.accountId)).map((b) => b.grantKey)
        ).toEqual([`paypal:capture:${capture.id}`]);
      });

      it('grants the unrefunded share, rounded down, when part of the payment was already refunded', async () => {
        const o = await ordered();
        const capture = capturedBy(o.fake, 'PARTIALLY_REFUNDED');
        o.fake.refunds.push({
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '1.99' },
        });
        captureMode = 'already';

        const view = await o.topups.capture(
          o.organizationId,
          o.ownerId,
          o.orderId
        );

        // $3.01 of $5.00 stays paid: 100 × 301 / 500 = 60.2 → 60
        expect(view.status).toBe('CAPTURED');
        expect(await available(o.credits, o.organizationId)).toBe(60);
        expect((await topupBuckets(o.accountId))[0].grantKey).toBe(
          `paypal:capture:${capture.id}`
        );
      });

      it('does not count a cancelled or failed refund against the grant', async () => {
        const o = await ordered();
        capturedBy(o.fake, 'COMPLETED');
        o.fake.refunds.push(
          {
            status: 'CANCELLED',
            amount: { currency_code: 'USD', value: '2.00' },
          },
          { status: 'FAILED', amount: { currency_code: 'USD', value: '2.00' } }
        );
        captureMode = 'already';

        await o.topups.capture(o.organizationId, o.ownerId, o.orderId);

        expect(await available(o.credits, o.organizationId)).toBe(100);
      });

      it('grants nothing for a payment already fully refunded, and records the capture', async () => {
        const o = await ordered();
        const capture = capturedBy(o.fake, 'REFUNDED');
        captureMode = 'already';

        const view = await o.topups.capture(
          o.organizationId,
          o.ownerId,
          o.orderId
        );

        expect(view.status).toBe('CAPTURED');
        expect(view.grantedAt).toBeNull();
        expect(await topupBuckets(o.accountId)).toEqual([]);
        expect((await o.topups.findByCapture(capture.id))?.orderId).toBe(
          o.orderId
        );
      });

      it('throws and grants nothing when the captured amount is not the order amount', async () => {
        const o = await ordered();
        const capture = capturedBy(o.fake);
        capture.amount = { currency_code: 'USD', value: '4.00' };
        captureMode = 'already';

        await expect(
          o.topups.capture(o.organizationId, o.ownerId, o.orderId)
        ).rejects.toThrow(/does not match/);
        expect(await topupBuckets(o.accountId)).toEqual([]);
      });

      it('grants what the pack held when it was ordered, whatever the pricing file says by capture time', async () => {
        const o = await ordered();
        PRICING.topupPacks = [{ ...PACK, credits: 7, priceCents: 900 }];
        try {
          await o.topups.capture(o.organizationId, o.ownerId, o.orderId);
          expect(await available(o.credits, o.organizationId)).toBe(100);
          const later = await o.topups.createOrder(
            o.organizationId,
            o.ownerId,
            PACK.key
          );
          expect(orders.get(later.orderId)!.amount.value).toBe('9.00');
          expect(
            (
              await db.topupOrder.findUniqueOrThrow({
                where: { paypalOrderId: later.orderId },
              })
            ).credits
          ).toBe(7);
        } finally {
          PRICING.topupPacks = [PACK];
        }
      });

      it('refuses a user who is not the account owner with 403 and grants nothing', async () => {
        const o = await ordered();

        const error = await failure(
          o.topups.capture(o.organizationId, o.memberId, o.orderId)
        );

        expect(error.status).toBe(403);
        expect(error.body.code).toBe('NOT_ACCOUNT_OWNER');
        expect(seen.filter((s) => s.url.endsWith('/capture'))).toEqual([]);
      });

      it("answers 404 for another account's order, on capture and on get", async () => {
        const mine = await ordered();
        const other = await ordered();

        const capture = await failure(
          mine.topups.capture(mine.organizationId, mine.ownerId, other.orderId)
        );
        const get = await failure(
          mine.topups.get(mine.organizationId, other.orderId)
        );

        expect(capture.status).toBe(404);
        expect(get.status).toBe(404);
        expect(await topupBuckets(other.accountId)).toEqual([]);
      });

      it('answers 404 for an order that does not exist', async () => {
        const o = await ordered();

        const error = await failure(
          o.topups.capture(o.organizationId, o.ownerId, 'ORD-unknown')
        );

        expect(error.status).toBe(404);
      });
    });

    describe('get and findByCapture', () => {
      it('shows any member the order as stored, with the PayPal order id as its orderId, and no capture before one is paid', async () => {
        const { topups, accounts } = svc();
        const ws = await workspace(accounts);
        const { orderId } = await topups.createOrder(
          ws.organizationId,
          ws.ownerId,
          PACK.key
        );

        const view = await topups.get(ws.organizationId, orderId);

        expect(view).toEqual({
          orderId,
          packKey: PACK.key,
          credits: 100,
          priceCents: 500,
          currency: 'USD',
          status: 'CREATED',
          grantedAt: null,
        });
      });

      it('finds the order paid by a capture with its account, and null for an unknown capture', async () => {
        const { topups, accounts } = svc();
        const ws = await workspace(accounts);
        const { orderId } = await topups.createOrder(
          ws.organizationId,
          ws.ownerId,
          PACK.key
        );
        await topups.capture(ws.organizationId, ws.ownerId, orderId);
        const captureId = orders.get(orderId)!.captures[0].id;

        const found = await topups.findByCapture(captureId);

        expect(found).toMatchObject({
          orderId,
          accountId: ws.accountId,
          captureId,
          status: 'CAPTURED',
        });
        expect(await topups.findByCapture('CAP-unknown')).toBeNull();
      });
    });
  });
});
