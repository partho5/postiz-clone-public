// Idempotency-Key, client half: customFetch sends a fresh key on every mutation unless the
// caller supplied one, and sends none on a read. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/libraries/helpers/src' custom.fetch.func
import {
  customFetch,
  newIdempotencyKey,
} from '@gitroom/helpers/utils/custom.fetch.func';

describe('customFetch Idempotency-Key', () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const realFetch = global.fetch;

  beforeEach(() => {
    sent.length = 0;
    global.fetch = jest.fn(async (url: any, init: any) => {
      sent.push({ url, init });
      return new Response('{}');
    }) as any;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  // Sends one request to `/x` through a fresh `customFetch` with the given options.
  const request = (options: RequestInit) =>
    customFetch({ baseUrl: 'http://backend' })('/x', options);
  // The `Idempotency-Key` header of the nth request that reached `fetch`.
  const keyOf = (index = 0) =>
    (sent[index].init.headers as Record<string, string>)['Idempotency-Key'];

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])(
    'sends a key on %s',
    async (method) => {
      await request({ method });
      expect(keyOf()).toMatch(/^[\x21-\x7e]{1,255}$/);
    }
  );

  it('sends a different key on every mutation', async () => {
    await request({ method: 'POST' });
    await request({ method: 'POST' });
    expect(keyOf(0)).not.toBe(keyOf(1));
  });

  it.each([undefined, 'GET', 'HEAD'])('sends no key on %s', async (method) => {
    await request({ method });
    expect(keyOf()).toBeUndefined();
  });

  it('keeps the key the caller supplied, whatever its case', async () => {
    await request({ method: 'POST', headers: { 'Idempotency-Key': 'mine' } });
    await request({ method: 'POST', headers: { 'idempotency-key': 'mine-2' } });
    expect(keyOf(0)).toBe('mine');
    const headers = sent[1].init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('mine-2');
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('never retries by itself', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('network');
    }) as any;
    await expect(request({ method: 'POST' })).rejects.toThrow('network');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('makes a valid key where randomUUID is not available', () => {
    const real = globalThis.crypto.randomUUID;
    // @ts-expect-error simulating a non-secure context
    globalThis.crypto.randomUUID = undefined;
    try {
      expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      globalThis.crypto.randomUUID = real;
    }
  });
});
