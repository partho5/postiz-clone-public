// PayPal webhook intake: genuine notices only, each event id acted on at most once, handlers
// registered per event type, and a replay of PayPal's own event list.
//
// Runs against a real Postgres (migrated and given the API role by the jest global setup), on both
// database roles, and the real PayPal client against a local HTTP server that stands in for PayPal.
import { Logger } from '@nestjs/common';
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
import {
  PaypalApiError,
  PaypalClient,
  PaypalNotConfiguredError,
} from '@gitroom/nestjs-libraries/services/paypal/paypal.client';
import { PaypalEventsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.events.repository';
import {
  InvalidWebhookSignatureError,
  PaypalEvent,
  PaypalWebhookIntake,
} from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type Seen = { method: string; url: string; body: string };
type Answer = (seen: Seen, res: ServerResponse) => void;

let server: Server;
let seen: Seen[];
let answer: Answer;
let baseUrl: string;

// Answers with JSON.
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// PayPal's verdict on every signature check: SUCCESS unless a test says otherwise.
// DOWN: the verify endpoint itself answers 500.
let verification: 'SUCCESS' | 'FAILURE' | 'DOWN' = 'SUCCESS';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method!,
        url: req.url!,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      if (req.url === '/v1/oauth2/token') {
        return json(res, 200, { access_token: 'token', expires_in: 32400 });
      }
      seen.push(entry);
      if (req.url === '/v1/notifications/verify-webhook-signature') {
        return verification === 'DOWN'
          ? json(res, 500, { name: 'INTERNAL_SERVICE_ERROR' })
          : json(res, 200, { verification_status: verification });
      }
      answer(entry, res);
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
  'paypal-transmission-time': '2026-09-30T10:00:00Z',
};

// A PayPal event of the given type about a resource, with a fresh id unless one is given.
const eventOf = (
  type: string,
  resourceId = 'RES-' + randomUUID(),
  id = 'WH-' + randomUUID(),
  createTime = '2026-09-30T10:00:00Z'
): PaypalEvent => ({
  id,
  event_type: type,
  resource_type: 'sale',
  resource: { id: resourceId, amount: { total: '9.00' } },
  create_time: createTime,
});

// A resolved wait of a few milliseconds, to keep a handler busy while others arrive.
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('PaypalWebhookIntake (Postgres)', () => {
  let apiService: PrismaService;
  let workerService: PrismaService;
  let db: PrismaClient;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;
  const savedPaypal: Record<string, string | undefined> = {};
  const roles: Record<'api' | 'worker', PaypalWebhookIntake> = {} as any;

  // The intake on a given client, wired as the database module wires it.
  const intakeOn = (prisma: PrismaService) => {
    const repo = new PrismaRepository<any>(prisma);
    return new PaypalWebhookIntake(
      new PaypalClient(),
      new PaypalEventsRepository(new PrismaTransaction(prisma), repo)
    );
  };

  // The stored row of an event id.
  const row = (id: string) => db.paymentEvent.findUnique({ where: { id } });

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
  });

  afterAll(async () => {
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
  });

  beforeEach(() => {
    seen = [];
    answer = (_seen, res) => json(res, 200, {});
    verification = 'SUCCESS';
    process.env.PAYPAL_API_BASE = baseUrl;
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    process.env.PAYPAL_WEBHOOK_ID = 'WH-CONFIG';
    roles.api = intakeOn(apiService);
    roles.worker = intakeOn(workerService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    describe('verify', () => {
      it('returns the event of a request PayPal vouches for, with the raw body sent to PayPal unchanged', async () => {
        const event = eventOf('PAYMENT.SALE.COMPLETED');
        // spacing and key order a re-serialisation would change
        const rawBody = Buffer.from(
          `{ "resource_type":"sale",  "id":"${event.id}", "event_type":"${
            event.event_type
          }",\n "resource":${JSON.stringify(event.resource)}, "create_time":"${
            event.create_time
          }" }`
        );

        const verified = await roles[role].verify(rawBody, signed);

        expect(verified).toEqual(event);
        const call = seen.find((s) =>
          s.url.endsWith('verify-webhook-signature')
        )!;
        expect(call.body).toContain(rawBody.toString('utf8'));
        expect(JSON.parse(call.body).webhook_id).toBe('WH-CONFIG');
      });

      it('throws InvalidWebhookSignatureError and stores nothing when PayPal does not vouch for it', async () => {
        verification = 'FAILURE';
        const event = eventOf('PAYMENT.SALE.COMPLETED');

        await expect(
          roles[role].verify(Buffer.from(JSON.stringify(event)), signed)
        ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);

        expect(await row(event.id)).toBeNull();
      });

      it('throws InvalidWebhookSignatureError for a missing signature header without asking PayPal', async () => {
        const { 'paypal-transmission-sig': _sig, ...unsigned } = signed;

        await expect(
          roles[role].verify(
            Buffer.from(JSON.stringify(eventOf('PAYMENT.SALE.COMPLETED'))),
            unsigned
          )
        ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);

        expect(seen).toHaveLength(0);
      });

      it.each([
        ['not JSON', 'not json'],
        ['JSON with no event id', JSON.stringify({ event_type: 'X' })],
        ['JSON with no event type', JSON.stringify({ id: 'WH-1' })],
      ])(
        'throws InvalidWebhookSignatureError for a body that is %s',
        async (_n, body) => {
          await expect(
            roles[role].verify(Buffer.from(body), signed)
          ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
        }
      );

      it('does not report a PayPal outage as an invalid signature', async () => {
        verification = 'DOWN';

        const error = await roles[role]
          .verify(Buffer.from(JSON.stringify(eventOf('X.Y'))), signed)
          .catch((e) => e);

        expect(error).toBeInstanceOf(PaypalApiError);
        expect(error).not.toBeInstanceOf(InvalidWebhookSignatureError);
      });

      it('throws PaypalNotConfiguredError when PayPal is not configured', async () => {
        delete process.env.PAYPAL_WEBHOOK_ID;

        await expect(
          roles[role].verify(
            Buffer.from(JSON.stringify(eventOf('X.Y'))),
            signed
          )
        ).rejects.toBeInstanceOf(PaypalNotConfiguredError);
      });
    });

    describe('process', () => {
      it('runs the registered handler once, records the event and marks it processed', async () => {
        const intake = roles[role];
        const handler = jest.fn(async () => undefined);
        const event = eventOf('PAYMENT.SALE.COMPLETED', 'SALE-1');
        intake.on(['PAYMENT.SALE.COMPLETED'], handler);

        expect(await intake.process(event)).toBe('processed');

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(event);
        const stored = await row(event.id);
        expect(stored).toMatchObject({
          provider: 'paypal',
          eventType: 'PAYMENT.SALE.COMPLETED',
          resourceId: 'SALE-1',
          attempts: 1,
        });
        expect(stored!.processedAt).toBeInstanceOf(Date);
        expect(stored!.payload).toEqual(event);
      });

      it('answers duplicate for a processed id and runs no handler', async () => {
        const intake = roles[role];
        const handler = jest.fn(async () => undefined);
        const event = eventOf('PAYMENT.SALE.COMPLETED');
        intake.on(['PAYMENT.SALE.COMPLETED'], handler);
        await intake.process(event);

        expect(await intake.process(event)).toBe('duplicate');
        expect(await intake.process({ ...event })).toBe('duplicate');

        expect(handler).toHaveBeenCalledTimes(1);
        expect((await row(event.id))!.attempts).toBe(1);
      });

      it('answers ignored for a type with no handler, and still records it as processed', async () => {
        const intake = roles[role];
        intake.on(['SOMETHING.ELSE'], jest.fn());
        const event = eventOf('CATALOG.PRODUCT.CREATED');

        expect(await intake.process(event)).toBe('ignored');

        const stored = await row(event.id);
        expect(stored!.eventType).toBe('CATALOG.PRODUCT.CREATED');
        expect(stored!.processedAt).toBeInstanceOf(Date);
        expect(await intake.process(event)).toBe('duplicate');
      });

      it('runs every handler registered for the type in registration order, and no other', async () => {
        const intake = roles[role];
        const calls: string[] = [];
        intake.on(
          ['PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED'],
          async () => {
            calls.push('first');
          }
        );
        intake.on(['PAYMENT.SALE.COMPLETED'], async () => {
          calls.push('second');
        });
        intake.on(['PAYMENT.CAPTURE.COMPLETED'], async () => {
          calls.push('other');
        });

        await intake.process(eventOf('PAYMENT.SALE.COMPLETED'));
        await intake.process(eventOf('PAYMENT.SALE.REFUNDED'));

        expect(calls).toEqual(['first', 'second', 'first']);
      });

      it('lets a ".*" registration match every type under its prefix and nothing else', async () => {
        const intake = roles[role];
        const handler = jest.fn(async () => undefined);
        intake.on(['BILLING.SUBSCRIPTION.*'], handler);

        await intake.process(eventOf('BILLING.SUBSCRIPTION.ACTIVATED'));
        await intake.process(eventOf('BILLING.SUBSCRIPTION.PAYMENT.FAILED'));
        await intake.process(eventOf('BILLING.PLAN.CREATED'));
        await intake.process(eventOf('BILLING.SUBSCRIPTIONS'));

        expect(handler).toHaveBeenCalledTimes(2);
      });

      it('leaves the event unprocessed and rethrows when a handler throws; a redelivery runs the handlers again', async () => {
        const intake = roles[role];
        const first = jest.fn(async () => undefined);
        let failing = true;
        const second = jest.fn(async () => {
          if (failing) {
            throw new Error('PayPal is unreachable');
          }
        });
        intake.on(['PAYMENT.SALE.COMPLETED'], first);
        intake.on(['PAYMENT.SALE.COMPLETED'], second);
        const event = eventOf('PAYMENT.SALE.COMPLETED');

        await expect(intake.process(event)).rejects.toThrow(
          'PayPal is unreachable'
        );

        let stored = await row(event.id);
        expect(stored!.processedAt).toBeNull();
        expect(stored!.attempts).toBe(1);

        failing = false;
        expect(await intake.process(event)).toBe('processed');

        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledTimes(2);
        stored = await row(event.id);
        expect(stored!.processedAt).toBeInstanceOf(Date);
        expect(stored!.attempts).toBe(2);
        expect(await intake.process(event)).toBe('duplicate');
      });

      it('never runs the handlers of one event id in parallel, and runs them to completion once', async () => {
        const intake = roles[role];
        let running = 0;
        let overlapped = false;
        const handler = jest.fn(async () => {
          running++;
          overlapped ||= running > 1;
          await pause(150);
          running--;
        });
        intake.on(['PAYMENT.SALE.COMPLETED'], handler);
        const event = eventOf('PAYMENT.SALE.COMPLETED');

        const outcomes = await Promise.all(
          Array.from({ length: 6 }, () => intake.process(event))
        );

        expect(handler).toHaveBeenCalledTimes(1);
        expect(overlapped).toBe(false);
        expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
        expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(5);
      });

      it('lets concurrent deliveries of different ids run side by side', async () => {
        const intake = roles[role];
        let running = 0;
        let peak = 0;
        intake.on(['PAYMENT.SALE.COMPLETED'], async () => {
          running++;
          peak = Math.max(peak, running);
          await pause(150);
          running--;
        });

        await Promise.all(
          Array.from({ length: 3 }, () =>
            intake.process(eventOf('PAYMENT.SALE.COMPLETED'))
          )
        );

        expect(peak).toBeGreaterThan(1);
      });

      it('runs the handlers again after a failed delivery even when two deliveries race it', async () => {
        const intake = roles[role];
        let failing = true;
        const handler = jest.fn(async () => {
          await pause(100);
          if (failing) {
            throw new Error('boom');
          }
        });
        intake.on(['PAYMENT.SALE.COMPLETED'], handler);
        const event = eventOf('PAYMENT.SALE.COMPLETED');

        const first = await Promise.allSettled([
          intake.process(event),
          intake.process(event),
        ]);
        failing = false;
        const retry = await intake.process(event);

        // the second delivery waited for the first, found it unprocessed and ran the handlers too
        expect(first.every((r) => r.status === 'rejected')).toBe(true);
        expect(retry).toBe('processed');
        expect((await row(event.id))!.processedAt).toBeInstanceOf(Date);
        expect(handler).toHaveBeenCalledTimes(3);
      });

      it('throws for an event with no id or no type', async () => {
        await expect(
          roles[role].process({ event_type: 'X.Y' } as any)
        ).rejects.toThrow();
        await expect(
          roles[role].process({ id: 'WH-x' } as any)
        ).rejects.toThrow();
      });
    });

    describe('receive', () => {
      it('verifies, then processes', async () => {
        const intake = roles[role];
        const handler = jest.fn(async () => undefined);
        intake.on(['PAYMENT.SALE.COMPLETED'], handler);
        const event = eventOf('PAYMENT.SALE.COMPLETED');
        const body = Buffer.from(JSON.stringify(event));

        expect(await intake.receive(body, signed)).toBe('processed');
        expect(await intake.receive(body, signed)).toBe('duplicate');

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('runs no handler and stores nothing for a bad signature', async () => {
        const intake = roles[role];
        const handler = jest.fn(async () => undefined);
        intake.on(['PAYMENT.SALE.COMPLETED'], handler);
        verification = 'FAILURE';
        const event = eventOf('PAYMENT.SALE.COMPLETED');

        await expect(
          intake.receive(Buffer.from(JSON.stringify(event)), signed)
        ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);

        expect(handler).not.toHaveBeenCalled();
        expect(await row(event.id)).toBeNull();
      });
    });

    describe('findProcessedEvent', () => {
      it('finds the processed event of that type about that resource', async () => {
        const intake = roles[role];
        const event = eventOf('PAYMENT.SALE.COMPLETED', 'SALE-FIND-' + role);
        await intake.process(event);

        expect(
          await intake.findProcessedEvent(
            'PAYMENT.SALE.COMPLETED',
            'SALE-FIND-' + role
          )
        ).toEqual(event);
      });

      it('finds nothing for another type, another resource, or an event still unprocessed', async () => {
        const intake = roles[role];
        const resourceId = 'SALE-MISS-' + role;
        intake.on(['PAYMENT.SALE.REFUNDED'], async () => {
          throw new Error('boom');
        });
        await intake.process(eventOf('PAYMENT.SALE.COMPLETED', resourceId));
        await intake
          .process(eventOf('PAYMENT.SALE.REFUNDED', resourceId))
          .catch(() => undefined);

        expect(
          await intake.findProcessedEvent('PAYMENT.SALE.REFUNDED', resourceId)
        ).toBeNull();
        expect(
          await intake.findProcessedEvent(
            'PAYMENT.CAPTURE.COMPLETED',
            resourceId
          )
        ).toBeNull();
        expect(
          await intake.findProcessedEvent('PAYMENT.SALE.COMPLETED', 'SALE-NOPE')
        ).toBeNull();
      });
    });

    describe('replay', () => {
      // PayPal's event list: the given pages, the first at the events path, the rest behind `next`.
      const listPages = (pages: unknown[][]) => {
        answer = (call, res) => {
          const index = Number(
            new URL(call.url, baseUrl).searchParams.get('page') || 0
          );
          const links =
            index + 1 < pages.length
              ? [
                  {
                    rel: 'next',
                    href: `${baseUrl}/v1/notifications/webhooks-events?page=${
                      index + 1
                    }`,
                  },
                ]
              : [];
          json(res, 200, {
            events: pages[index],
            count: pages[index].length,
            links,
          });
        };
      };

      it('processes, oldest first, the listed events that are not yet processed, across pages', async () => {
        const intake = roles[role];
        const order: string[] = [];
        intake.on(['PAYMENT.SALE.COMPLETED'], async (e) => {
          order.push(e.id);
        });
        const oldest = eventOf(
          'PAYMENT.SALE.COMPLETED',
          undefined,
          'WH-a-' + randomUUID(),
          '2026-09-28T10:00:00Z'
        );
        const middle = eventOf(
          'PAYMENT.SALE.COMPLETED',
          undefined,
          'WH-b-' + randomUUID(),
          '2026-09-29T10:00:00Z'
        );
        const newest = eventOf(
          'PAYMENT.SALE.COMPLETED',
          undefined,
          'WH-c-' + randomUUID(),
          '2026-09-30T10:00:00Z'
        );
        const already = eventOf(
          'PAYMENT.SALE.COMPLETED',
          undefined,
          'WH-d-' + randomUUID(),
          '2026-09-29T12:00:00Z'
        );
        await intake.process(already);
        order.length = 0;
        // PayPal lists newest first
        listPages([
          [newest, already],
          [middle, oldest],
        ]);

        const result = await intake.replay(new Date('2026-09-27T00:00:00Z'));

        expect(result).toEqual({ seen: 4, processed: 3 });
        expect(order).toEqual([oldest.id, middle.id, newest.id]);
        const list = seen.find((s) =>
          s.url.startsWith('/v1/notifications/webhooks-events')
        )!;
        expect(list.method).toBe('GET');
        expect(new URL(list.url, baseUrl).searchParams.get('start_time')).toBe(
          '2026-09-27T00:00:00.000Z'
        );
      });

      it('runs nothing for events all processed, and a second replay changes nothing', async () => {
        const intake = roles[role];
        const handler = jest.fn(async () => undefined);
        intake.on(['PAYMENT.SALE.COMPLETED'], handler);
        const event = eventOf('PAYMENT.SALE.COMPLETED');
        listPages([[event]]);

        expect(await intake.replay(new Date(0))).toEqual({
          seen: 1,
          processed: 1,
        });
        expect(await intake.replay(new Date(0))).toEqual({
          seen: 1,
          processed: 0,
        });

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('grants under the same event id a webhook would have used: a delivered event and its replay are one run', async () => {
        const intake = roles[role];
        const handler = jest.fn(async () => undefined);
        intake.on(['PAYMENT.SALE.COMPLETED'], handler);
        const event = eventOf('PAYMENT.SALE.COMPLETED');
        listPages([[event]]);

        await intake.receive(Buffer.from(JSON.stringify(event)), signed);
        await intake.replay(new Date(0));

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('logs a failing event, leaves it unprocessed, and still processes the others', async () => {
        const intake = roles[role];
        const failing = eventOf(
          'PAYMENT.SALE.REFUNDED',
          undefined,
          undefined,
          '2026-09-29T10:00:00Z'
        );
        const fine = eventOf(
          'PAYMENT.SALE.COMPLETED',
          undefined,
          undefined,
          '2026-09-30T10:00:00Z'
        );
        intake.on(['PAYMENT.SALE.REFUNDED'], async () => {
          throw new Error('PayPal is unreachable');
        });
        intake.on(['PAYMENT.SALE.COMPLETED'], async () => undefined);
        listPages([[fine, failing]]);

        const result = await intake.replay(new Date(0));

        expect(result).toEqual({ seen: 2, processed: 1 });
        expect((await row(failing.id))!.processedAt).toBeNull();
        expect((await row(fine.id))!.processedAt).toBeInstanceOf(Date);
        expect(Logger.prototype.error).toHaveBeenCalled();
      });

      it('skips a listed entry that is not an event', async () => {
        const intake = roles[role];
        const event = eventOf('PAYMENT.SALE.COMPLETED');
        listPages([[{ nope: true }, event]]);
        intake.on(['PAYMENT.SALE.COMPLETED'], async () => undefined);

        expect(await intake.replay(new Date(0))).toEqual({
          seen: 1,
          processed: 1,
        });
      });

      it('throws when PayPal cannot list the events, having processed nothing', async () => {
        answer = (_call, res) =>
          json(res, 401, { name: 'AUTHENTICATION_FAILURE' });

        await expect(roles[role].replay(new Date(0))).rejects.toBeInstanceOf(
          PaypalApiError
        );
      });

      it('does not follow a next link that leaves the events endpoint', async () => {
        const event = eventOf('PAYMENT.SALE.COMPLETED');
        answer = (_call, res) =>
          json(res, 200, {
            events: [event],
            links: [{ rel: 'next', href: 'https://evil.example/v1/other' }],
          });

        expect(await roles[role].replay(new Date(0))).toEqual({
          seen: 1,
          processed: 1,
        });
        expect(seen.filter((s) => s.method === 'GET')).toHaveLength(1);
      });
    });
  });
});
