// PayPal REST client: configuration, token handling, retries, error mapping and
// the webhook signature check, against a local HTTP server that stands in for PayPal.
import { Logger } from '@nestjs/common';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import {
  PaypalApiError,
  PaypalClient,
  PaypalNotConfiguredError,
} from '@gitroom/nestjs-libraries/services/paypal/paypal.client';

type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
};
type Handler = (seen: Seen, req: IncomingMessage, res: ServerResponse) => void;

const SECRET = 'client-secret-value';
const CLIENT_ID = 'client-id-value';
const WEBHOOK_ID = 'WH-123';

let server: Server;
let seen: Seen[];
let tokenCalls: number;
let handler: Handler;
let baseUrl: string;

// Answers with JSON.
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// PayPal's answer to every call that is not the token call, unless a test replaces it.
const ok: Handler = (_seen, _req, res) => json(res, 200, { ok: true });

// Calls seen that are not the token call.
const apiCalls = () => seen.filter((s) => s.url !== '/v1/oauth2/token');

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      if (req.url === '/v1/oauth2/token') {
        tokenCalls++;
        return json(res, 200, {
          access_token: `token-${tokenCalls}`,
          expires_in: 32400,
        });
      }
      handler(entry, req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen = [];
  tokenCalls = 0;
  handler = ok;
  process.env.PAYPAL_API_BASE = baseUrl;
  process.env.PAYPAL_CLIENT_ID = CLIENT_ID;
  process.env.PAYPAL_CLIENT_SECRET = SECRET;
  process.env.PAYPAL_WEBHOOK_ID = WEBHOOK_ID;
  delete process.env.PAYPAL_MODE;
  // Retry warnings stay out of the test output
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isConfigured', () => {
  it('is true when all four env vars are set', () => {
    expect(new PaypalClient().isConfigured()).toBe(true);
  });

  it.each([
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
  ])('is false when %s is missing', (name) => {
    delete process.env[name];
    expect(new PaypalClient().isConfigured()).toBe(false);
  });

  it('is true without PAYPAL_API_BASE: the mode (live when unset) picks the API', () => {
    delete process.env.PAYPAL_API_BASE;
    expect(new PaypalClient().isConfigured()).toBe(true);
    expect(new PaypalClient().apiHost()).toBe('api-m.paypal.com');
  });

  it('calls the sandbox API for PAYPAL_MODE=Sandbox, in any case', () => {
    delete process.env.PAYPAL_API_BASE;
    process.env.PAYPAL_MODE = 'Sandbox';
    expect(new PaypalClient().apiHost()).toBe('api-m.sandbox.paypal.com');
  });

  it('lets PAYPAL_API_BASE override the mode', () => {
    process.env.PAYPAL_MODE = 'sandbox';
    expect(new PaypalClient().apiHost()).toBe(new URL(baseUrl).host);
  });

  it('is false for a PAYPAL_MODE other than sandbox or live', () => {
    process.env.PAYPAL_MODE = 'test';
    expect(new PaypalClient().isConfigured()).toBe(false);
  });
});

describe('not configured', () => {
  beforeEach(() => {
    delete process.env.PAYPAL_WEBHOOK_ID;
  });

  it('request throws PaypalNotConfiguredError and calls nobody', async () => {
    await expect(new PaypalClient().request('GET', '/v1/x')).rejects.toThrow(
      PaypalNotConfiguredError
    );
    expect(seen).toHaveLength(0);
  });

  it('verifyWebhookSignature throws PaypalNotConfiguredError and calls nobody', async () => {
    await expect(
      new PaypalClient().verifyWebhookSignature(Buffer.from('{}'), {})
    ).rejects.toThrow(PaypalNotConfiguredError);
    expect(seen).toHaveLength(0);
  });
});

describe('request', () => {
  it('sends the JSON body to base + path with a bearer token and returns the parsed answer', async () => {
    handler = (_s, _r, res) => json(res, 201, { id: 'ORDER-1' });
    const result = await new PaypalClient().request<{ id: string }>(
      'POST',
      '/v2/checkout/orders',
      { intent: 'CAPTURE' }
    );

    expect(result).toEqual({ id: 'ORDER-1' });
    const [call] = apiCalls();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v2/checkout/orders');
    expect(call.headers.authorization).toBe('Bearer token-1');
    expect(call.headers['content-type']).toContain('application/json');
    expect(JSON.parse(call.body)).toEqual({ intent: 'CAPTURE' });
  });

  it('gets the access token with the client credentials', async () => {
    await new PaypalClient().request('GET', '/v1/x');
    const [token] = seen;
    expect(token.url).toBe('/v1/oauth2/token');
    expect(token.headers.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`
    );
    expect(token.body).toBe('grant_type=client_credentials');
  });

  it('supports PATCH and GET without a body', async () => {
    const client = new PaypalClient();
    await client.request('PATCH', '/v1/x', [{ op: 'replace' }]);
    await client.request('GET', '/v1/y');
    expect(apiCalls().map((c) => c.method)).toEqual(['PATCH', 'GET']);
    expect(JSON.parse(apiCalls()[0].body)).toEqual([{ op: 'replace' }]);
    expect(apiCalls()[1].body).toBe('');
  });

  it('answers undefined for an empty 204', async () => {
    handler = (_s, _r, res) => {
      res.writeHead(204);
      res.end();
    };
    await expect(
      new PaypalClient().request('PATCH', '/v1/x', {})
    ).resolves.toBeUndefined();
  });

  it('sends requestId as PayPal-Request-Id, and nothing when absent', async () => {
    const client = new PaypalClient();
    await client.request('POST', '/v1/a', {}, { requestId: 'req-42' });
    await client.request('POST', '/v1/b', {});
    const [withId, without] = apiCalls();
    expect(withId.headers['paypal-request-id']).toBe('req-42');
    expect(without.headers['paypal-request-id']).toBeUndefined();
  });

  it('rejects a path that does not start with "/"', async () => {
    await expect(
      new PaypalClient().request('GET', '@evil.example/x')
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('tolerates a trailing slash on PAYPAL_API_BASE', async () => {
    process.env.PAYPAL_API_BASE = `${baseUrl}/`;
    await new PaypalClient().request('GET', '/v1/x');
    expect(apiCalls()[0].url).toBe('/v1/x');
  });
});

describe('access token', () => {
  it('is cached across calls', async () => {
    const client = new PaypalClient();
    await client.request('GET', '/v1/a');
    await client.request('GET', '/v1/b');
    expect(tokenCalls).toBe(1);
    expect(apiCalls().map((c) => c.headers.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-1',
    ]);
  });

  it('is shared by concurrent first calls', async () => {
    const client = new PaypalClient();
    await Promise.all([
      client.request('GET', '/v1/a'),
      client.request('GET', '/v1/b'),
      client.request('GET', '/v1/c'),
    ]);
    expect(tokenCalls).toBe(1);
  });

  it('is fetched again shortly before it expires', async () => {
    const client = new PaypalClient();
    const now = Date.now();
    await client.request('GET', '/v1/a');

    // 32400 s lifetime: still valid an hour before expiry, gone 30 s before expiry
    jest.spyOn(Date, 'now').mockReturnValue(now + 32400 * 1000 - 3600 * 1000);
    await client.request('GET', '/v1/b');
    expect(tokenCalls).toBe(1);

    jest.spyOn(Date, 'now').mockReturnValue(now + 32400 * 1000 - 30 * 1000);
    await client.request('GET', '/v1/c');
    expect(tokenCalls).toBe(2);
    expect(apiCalls()[2].headers.authorization).toBe('Bearer token-2');
  });

  it('fails with PaypalApiError when PayPal refuses the credentials', async () => {
    const refuse = createServer((_req, res) =>
      json(res, 401, { error: 'invalid_client', error_description: 'bad' })
    );
    await new Promise<void>((r) => refuse.listen(0, '127.0.0.1', r));
    process.env.PAYPAL_API_BASE = `http://127.0.0.1:${
      (refuse.address() as AddressInfo).port
    }`;
    try {
      await expect(
        new PaypalClient().request('GET', '/v1/x')
      ).rejects.toMatchObject({ name: 'PaypalApiError', status: 401 });
    } finally {
      await new Promise((r) => refuse.close(r));
    }
  });
});

describe('errors', () => {
  it('a non-2xx answer throws PaypalApiError with PayPal status, name, debug id and details', async () => {
    handler = (_s, _r, res) =>
      json(res, 422, {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed',
        debug_id: 'dbg-1',
        details: [{ issue: 'ORDER_NOT_APPROVED' }],
      });

    const error = await new PaypalClient()
      .request<never>('POST', '/v2/checkout/orders/1/capture', {})
      .catch((e: PaypalApiError) => e);

    expect(error).toBeInstanceOf(PaypalApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(422);
    expect(error.paypalName).toBe('UNPROCESSABLE_ENTITY');
    expect(error.debugId).toBe('dbg-1');
    expect(error.details).toEqual([{ issue: 'ORDER_NOT_APPROVED' }]);
  });

  it('a non-JSON error answer still throws PaypalApiError with the status', async () => {
    handler = (_s, _r, res) => {
      res.writeHead(404);
      res.end('not json');
    };
    await expect(
      new PaypalClient().request('GET', '/v1/x')
    ).rejects.toMatchObject({ name: 'PaypalApiError', status: 404 });
  });

  it('a 4xx is not retried', async () => {
    handler = (_s, _r, res) => json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
    await expect(new PaypalClient().request('GET', '/v1/x')).rejects.toThrow(
      PaypalApiError
    );
    expect(apiCalls()).toHaveLength(1);
  });
});

describe('retries', () => {
  // Answers 503 for the first `n` calls, then 200.
  const failFirst = (n: number) => {
    let count = 0;
    handler = (_s, _r, res) =>
      ++count <= n
        ? json(res, 503, { name: 'SERVICE_UNAVAILABLE' })
        : json(res, 200, { ok: count });
  };

  it('GET retries a 5xx twice and then succeeds', async () => {
    failFirst(2);
    await expect(new PaypalClient().request('GET', '/v1/x')).resolves.toEqual({
      ok: 3,
    });
    expect(apiCalls()).toHaveLength(3);
  });

  it('GET gives up after two retries with PayPal error', async () => {
    failFirst(10);
    await expect(
      new PaypalClient().request('GET', '/v1/x')
    ).rejects.toMatchObject({ name: 'PaypalApiError', status: 503 });
    expect(apiCalls()).toHaveLength(3);
  });

  it('GET retries a network error', async () => {
    let count = 0;
    handler = (_s, req, res) =>
      ++count <= 2 ? req.socket.destroy() : json(res, 200, { ok: count });
    await expect(new PaypalClient().request('GET', '/v1/x')).resolves.toEqual({
      ok: 3,
    });
    expect(apiCalls()).toHaveLength(3);
  });

  it.each(['POST', 'PATCH'] as const)(
    '%s without a requestId is never retried',
    async (method) => {
      failFirst(1);
      await expect(
        new PaypalClient().request(method, '/v1/x', {})
      ).rejects.toMatchObject({ status: 503 });
      expect(apiCalls()).toHaveLength(1);
    }
  );

  it.each(['POST', 'PATCH'] as const)(
    '%s with a requestId is retried, with the same requestId',
    async (method) => {
      failFirst(2);
      await expect(
        new PaypalClient().request(method, '/v1/x', {}, { requestId: 'r-1' })
      ).resolves.toEqual({ ok: 3 });
      expect(apiCalls()).toHaveLength(3);
      expect(apiCalls().map((c) => c.headers['paypal-request-id'])).toEqual([
        'r-1',
        'r-1',
        'r-1',
      ]);
    }
  );

  it('POST with a requestId gives up after two retries', async () => {
    failFirst(10);
    await expect(
      new PaypalClient().request('POST', '/v1/x', {}, { requestId: 'r-1' })
    ).rejects.toMatchObject({ status: 503 });
    expect(apiCalls()).toHaveLength(3);
  });
});

describe('verifyWebhookSignature', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': 'sig-1',
    'paypal-transmission-time': '2026-09-30T10:00:00Z',
  };
  // Spacing, key order, an escape and a number with a trailing zero: all lost by a re-serialise.
  const rawText =
    '{ "id" : "WH-EVT-1",  "amount": 1.10, "note": "caf\\u00e9", "event_type":"PAYMENT.SALE.COMPLETED" }';
  const rawBody = Buffer.from(rawText);

  // Answers the verify call with the given status.
  const verifyAnswers = (verification_status: string) => {
    handler = (_s, _r, res) => json(res, 200, { verification_status });
  };

  it('is true only for verification_status SUCCESS', async () => {
    verifyAnswers('SUCCESS');
    await expect(
      new PaypalClient().verifyWebhookSignature(rawBody, headers)
    ).resolves.toBe(true);
  });

  it('is false for verification_status FAILURE', async () => {
    verifyAnswers('FAILURE');
    await expect(
      new PaypalClient().verifyWebhookSignature(rawBody, headers)
    ).resolves.toBe(false);
  });

  it('asks the verify endpoint with the transmission headers, the webhook id and the exact raw body', async () => {
    verifyAnswers('SUCCESS');
    await new PaypalClient().verifyWebhookSignature(rawBody, headers);

    const [call] = apiCalls();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v1/notifications/verify-webhook-signature');
    expect(call.headers.authorization).toBe('Bearer token-1');
    expect(call.body).toContain(`"webhook_event":${rawText}`);
    expect(JSON.parse(call.body)).toMatchObject({
      auth_algo: 'SHA256withRSA',
      cert_url: headers['paypal-cert-url'],
      transmission_id: 'tx-1',
      transmission_sig: 'sig-1',
      transmission_time: '2026-09-30T10:00:00Z',
      webhook_id: WEBHOOK_ID,
    });
  });

  it('reads headers without regard to case and takes the first of a list', async () => {
    verifyAnswers('SUCCESS');
    const mixed = {
      'PayPal-Auth-Algo': ['SHA256withRSA', 'ignored'],
      'PAYPAL-CERT-URL': headers['paypal-cert-url'],
      'Paypal-Transmission-Id': 'tx-1',
      'paypal-transmission-sig': 'sig-1',
      'paypal-transmission-time': '2026-09-30T10:00:00Z',
      'content-type': 'application/json',
    };
    await expect(
      new PaypalClient().verifyWebhookSignature(rawBody, mixed)
    ).resolves.toBe(true);
    expect(JSON.parse(apiCalls()[0].body).auth_algo).toBe('SHA256withRSA');
  });

  it.each(Object.keys(headers))(
    'is false, without calling PayPal, when %s is missing',
    async (missing) => {
      verifyAnswers('SUCCESS');
      const partial: Record<string, string | undefined> = { ...headers };
      delete partial[missing];
      await expect(
        new PaypalClient().verifyWebhookSignature(rawBody, partial)
      ).resolves.toBe(false);
      expect(seen).toHaveLength(0);
    }
  );

  it('is false, without calling PayPal, when a header is empty', async () => {
    await expect(
      new PaypalClient().verifyWebhookSignature(rawBody, {
        ...headers,
        'paypal-transmission-sig': '',
      })
    ).resolves.toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('is false, without calling PayPal, for a body that is not JSON', async () => {
    await expect(
      new PaypalClient().verifyWebhookSignature(
        Buffer.from('not json'),
        headers
      )
    ).resolves.toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('is false when PayPal rejects the input with 400', async () => {
    handler = (_s, _r, res) => json(res, 400, { name: 'INVALID_REQUEST' });
    await expect(
      new PaypalClient().verifyWebhookSignature(rawBody, headers)
    ).resolves.toBe(false);
  });

  it('throws when PayPal fails or refuses our credentials', async () => {
    handler = (_s, _r, res) =>
      json(res, 500, { name: 'INTERNAL_SERVER_ERROR' });
    await expect(
      new PaypalClient().verifyWebhookSignature(rawBody, headers)
    ).rejects.toMatchObject({ name: 'PaypalApiError', status: 500 });
    expect(apiCalls()).toHaveLength(1);

    handler = (_s, _r, res) =>
      json(res, 401, { name: 'AUTHENTICATION_FAILURE' });
    await expect(
      new PaypalClient().verifyWebhookSignature(rawBody, headers)
    ).rejects.toMatchObject({ name: 'PaypalApiError', status: 401 });
  });

  it('throws when PayPal cannot be reached', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    process.env.PAYPAL_API_BASE = `http://127.0.0.1:${port}`;

    await expect(
      new PaypalClient().verifyWebhookSignature(rawBody, headers)
    ).rejects.toThrow(/unreachable/);
  });
});

describe('logging', () => {
  it('never logs credentials, access tokens or webhook bodies', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
    }
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }

    const client = new PaypalClient();
    let count = 0;
    handler = (_s, _r, res) =>
      ++count <= 2
        ? json(res, 503, { name: 'SERVICE_UNAVAILABLE' })
        : json(res, 200, { verification_status: 'SUCCESS' });
    await client.request('GET', '/v1/x');
    handler = (_s, _r, res) =>
      json(res, 422, { name: 'UNPROCESSABLE_ENTITY', message: 'no' });
    await client
      .request('POST', '/v1/y', { secretish: 'body-marker' })
      .catch(() => {});
    handler = (_s, _r, res) =>
      json(res, 200, { verification_status: 'SUCCESS' });
    await client.verifyWebhookSignature(
      Buffer.from('{"marker":"webhook-body-marker"}'),
      {
        'paypal-auth-algo': 'a',
        'paypal-cert-url': 'c',
        'paypal-transmission-id': 'i',
        'paypal-transmission-sig': 'sig-marker',
        'paypal-transmission-time': 't',
      }
    );

    const output = logged.join('\n');
    for (const secret of [
      SECRET,
      'token-1',
      Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64'),
      'body-marker',
      'webhook-body-marker',
      'sig-marker',
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
