/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// api.token-auth, client half: on 401 TOKEN_EXPIRED customFetch refreshes the session once and
// retries the request once with the same headers (same Idempotency-Key); a refresh that fails sends the
// tab to login. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/libraries/helpers/src' custom.fetch.refresh
import { customFetch } from '@gitroom/helpers/utils/custom.fetch.func';

type Call = { url: string; init: RequestInit };

// jsdom has no fetch `Response`; this one has the parts customFetch and its callers read.
class Response {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Map<string, string> & { get(name: string): string | null };
  // Keeps the body text and sets the status, headers and ok flag from the init.
  constructor(
    private readonly text: string,
    init: { status?: number; headers?: Record<string, string> } = {}
  ) {
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Map(Object.entries(init.headers ?? {})) as any;
  }
  // A copy with the same body and status.
  clone() {
    return new Response(this.text, { status: this.status });
  }
  // The body parsed as JSON.
  async json() {
    return JSON.parse(this.text);
  }
}

describe('customFetch token refresh', () => {
  const calls: Call[] = [];
  const realFetch = global.fetch;
  // What the stand-in backend answers, in order, for the next `/x` requests and the next refreshes.
  let answers: Array<() => Response> = [];
  let refreshAnswers: Array<() => Response> = [];

  // A 401 answer carrying the `TOKEN_EXPIRED` code.
  const expired = () =>
    new Response(JSON.stringify({ statusCode: 401, code: 'TOKEN_EXPIRED' }), {
      status: 401,
    });
  // An answer factory for a 200 response with a JSON body.
  const ok = (body: object = { ok: true }) => () =>
    new Response(JSON.stringify(body), { status: 200 });

  beforeEach(() => {
    calls.length = 0;
    answers = [];
    refreshAnswers = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url, init });
      const queue = String(url).endsWith('/auth/token') ? refreshAnswers : answers;
      return (queue.shift() ?? ok())();
    }) as any;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  // The calls the client made to the token endpoint.
  const refreshCalls = () => calls.filter((c) => c.url.endsWith('/auth/token'));

  // The calls the client made to the `/x` route under test.
  const requestCalls = () => calls.filter((c) => c.url.endsWith('/x'));

  // One request through customFetch to `/x`, with its request options and customFetch params.
  const send = (
    options: RequestInit = { method: 'POST', body: '{}' },
    params: Partial<Parameters<typeof customFetch>[0]> = {}
  ) => customFetch({ baseUrl: 'http://backend', ...params })('/x', options);

  it('refreshes once with the refresh cookie and retries the request once, with the same headers and Idempotency-Key', async () => {
    answers = [expired, ok({ done: true })];
    const response = await send();

    expect(await response.json()).toEqual({ done: true });
    expect(refreshCalls()).toHaveLength(1);
    expect(refreshCalls()[0].init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ grant_type: 'refresh_token' }),
    });
    expect(requestCalls()).toHaveLength(2);
    const [first, retry] = requestCalls();
    const key = (first.init.headers as Record<string, string>)['Idempotency-Key'];
    expect(key).toBeTruthy();
    expect(retry.init.headers).toEqual(first.init.headers);
    expect(retry.init.body).toBe(first.init.body);
  });

  it('a request that is not expired makes no refresh', async () => {
    await send();
    expect(refreshCalls()).toHaveLength(0);
    expect(requestCalls()).toHaveLength(1);
  });

  it.each([
    ['SESSION_REVOKED', 401],
    ['INVALID_GRANT', 401],
    ['SESSION_CHANGED', 409],
    ['WORKSPACE_FORBIDDEN', 403],
  ])('%s (%i) makes no refresh', async (code, status) => {
    answers = [() => new Response(JSON.stringify({ code }), { status })];
    const response = await send();
    expect(response.status).toBe(status);
    expect(refreshCalls()).toHaveLength(0);
    expect(requestCalls()).toHaveLength(1);
  });

  it('a 401 with no JSON body makes no refresh', async () => {
    answers = [() => new Response('', { status: 401 })];
    expect((await send()).status).toBe(401);
    expect(refreshCalls()).toHaveLength(0);
  });

  it('retries only once: a second TOKEN_EXPIRED is returned, not refreshed again', async () => {
    answers = [expired, expired];
    const response = await send();
    expect(response.status).toBe(401);
    expect(refreshCalls()).toHaveLength(1);
    expect(requestCalls()).toHaveLength(2);
  });

  it('requests that find the token expired together share one refresh', async () => {
    answers = [expired, expired, expired, ok(), ok(), ok()];
    const responses = await Promise.all([send(), send(), send()]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refreshCalls()).toHaveLength(1);
    expect(requestCalls()).toHaveLength(6);
  });

  it('a later expiry refreshes again', async () => {
    answers = [expired, ok(), expired, ok()];
    await send();
    await send();
    expect(refreshCalls()).toHaveLength(2);
  });

  it('a failed refresh signs the tab out through onSessionLost and the request never resolves', async () => {
    answers = [expired];
    refreshAnswers = [
      () => new Response(JSON.stringify({ code: 'INVALID_GRANT' }), { status: 401 }),
    ];
    const onSessionLost = jest.fn(async () => undefined);
    const settled = jest.fn();
    send({ method: 'POST' }, { onSessionLost }).then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onSessionLost).toHaveBeenCalledTimes(1);
    expect(requestCalls()).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled();
  });

  it('a failed refresh with no onSessionLost returns the original answer', async () => {
    answers = [expired];
    refreshAnswers = [() => new Response('{}', { status: 401 })];
    const response = await send();
    expect(response.status).toBe(401);
    expect(requestCalls()).toHaveLength(1);
  });

  it('lets the app see a token the refresh returned, through afterRequest', async () => {
    answers = [expired, ok()];
    refreshAnswers = [() => new Response('{}', { status: 200, headers: { auth: 'new' } })];
    const afterRequest = jest.fn(async () => true);
    await send(undefined, { afterRequest });
    const refreshSeen = afterRequest.mock.calls.find(
      (args: any[]) => args[0] === '/auth/token'
    ) as any[];
    expect(refreshSeen[2].headers.get('auth')).toBe('new');
  });

  it('an explicit token (a server render) has no refresh cookie to use, so it never refreshes', async () => {
    answers = [expired];
    const response = await customFetch({ baseUrl: 'http://backend' }, 'explicit-token')(
      '/x',
      { method: 'POST' }
    );
    expect(response.status).toBe(401);
    expect(refreshCalls()).toHaveLength(0);
  });
});
