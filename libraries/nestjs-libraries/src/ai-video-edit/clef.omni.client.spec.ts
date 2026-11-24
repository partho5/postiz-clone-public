// AI video editing (ai.video-editing): the Clef-omni client with the network stubbed. Covers the request it sends,
// the answers it reads, a refusal, a timeout and the question limit.
import { ClefError, ClefOmniClient } from './clef.omni.client';
import { ClefQuestion, MAX_QUESTIONS } from './core/edit.perception';

const question = (id: string): ClefQuestion => ({ id, type: 'noul', instruction: 'x' });

const respond = (body: unknown, status = 200) =>
  jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  });

describe('ai.video-editing: ClefOmniClient', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
    process.env.CLOUDFLARE_AI_TOKEN = 'token';
  });

  afterAll(() => {
    process.env = saved;
  });

  it('posts the piece and the questions to the model with the bearer token and reads the answers', async () => {
    const client = new ClefOmniClient();
    const fetchMock = respond({
      result: { answers: { mood: 'calm', emph_1: 0.7 } },
      success: true,
    });
    client.fetchImpl = fetchMock as any;

    const answers = await client.ask(Buffer.from('video'), [
      question('mood'),
      question('emph_1'),
    ]);

    expect(answers).toEqual({ mood: 'calm', emph_1: 0.7 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-omni'
    );
    expect(init.headers.Authorization).toBe('Bearer token');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('clef-omni');
    expect(body.videos).toHaveLength(1);
    expect(body.questions.map((q: { id: string }) => q.id)).toEqual(['mood', 'emph_1']);
  });

  it('reads answers given as a list', async () => {
    const client = new ClefOmniClient();
    client.fetchImpl = respond({
      result: { answers: [{ id: 'a', answer: 1 }, { id: 'b', value: 'x' }] },
    }) as any;

    expect(await client.ask(Buffer.from('v'), [question('a')])).toEqual({ a: 1, b: 'x' });
  });

  it('fails with a ClefError on a refusal, a timeout and an answer without answers', async () => {
    const client = new ClefOmniClient();
    client.fetchImpl = respond({}, 503) as any;
    await expect(client.ask(Buffer.from('v'), [question('a')])).rejects.toBeInstanceOf(
      ClefError
    );

    client.fetchImpl = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' })) as any;
    await expect(client.ask(Buffer.from('v'), [question('a')])).rejects.toMatchObject({
      retryable: true,
    });

    client.fetchImpl = respond({ result: {} }) as any;
    await expect(client.ask(Buffer.from('v'), [question('a')])).rejects.toBeInstanceOf(
      ClefError
    );
  });

  it('refuses without a call when over 64 questions or unconfigured', async () => {
    const client = new ClefOmniClient();
    const fetchMock = respond({ result: { answers: {} } });
    client.fetchImpl = fetchMock as any;

    const many = Array.from({ length: MAX_QUESTIONS + 1 }, (_, k) => question(`q${k}`));
    await expect(client.ask(Buffer.from('v'), many)).rejects.toBeInstanceOf(ClefError);

    delete process.env.CLOUDFLARE_AI_TOKEN;
    expect(client.isConfigured()).toBe(false);
    await expect(client.ask(Buffer.from('v'), [question('a')])).rejects.toBeInstanceOf(
      ClefError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  describe('usage', () => {
    it('adds the tokens the response reports, under the provider model id, and answers the same', async () => {
      const client = new ClefOmniClient();
      client.fetchImpl = respond({
        result: { answers: { mood: 'calm' }, usage: { prompt_tokens: 5400, completion_tokens: 12, total_tokens: 5412 } },
      }) as any;
      const usage: any[] = [];

      expect(await client.ask(Buffer.from('video'), [question('mood')], usage)).toEqual({ mood: 'calm' });

      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ model: '@cf/cloudflare/clef-omni', input_tokens: 5400, output_tokens: 12, estimated: false, ok: true });
    });

    it('estimates from the questions and the answers when the response reports no usage', async () => {
      const client = new ClefOmniClient();
      client.fetchImpl = respond({ result: { answers: { mood: 'calm' } } }) as any;
      const usage: any[] = [];

      await client.ask(Buffer.from('video'), [question('mood')], usage);

      expect(usage[0]).toMatchObject({ estimated: true, ok: true });
      expect(usage[0].input_tokens).toBeGreaterThan(0);
      expect(usage[0].output_tokens).toBeGreaterThan(0);
    });

    it.each([
      ['a refusal', () => respond({}, 503)],
      ['a call that does not complete', () => jest.fn().mockRejectedValue(new Error('timed out'))],
      ['an answer without answers', () => respond({ result: {} })],
    ])('adds a failed, estimated call for %s and still throws', async (_name, make) => {
      const client = new ClefOmniClient();
      client.fetchImpl = make() as any;
      const usage: any[] = [];

      await expect(client.ask(Buffer.from('v'), [question('a')], usage)).rejects.toBeInstanceOf(ClefError);

      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ ok: false, estimated: true, output_tokens: 0 });
    });

    it('adds nothing for a call it refuses before making it', async () => {
      const client = new ClefOmniClient();
      client.fetchImpl = respond({ result: { answers: {} } }) as any;
      const usage: any[] = [];

      const many = Array.from({ length: MAX_QUESTIONS + 1 }, (_, k) => question(`q${k}`));
      await expect(client.ask(Buffer.from('v'), many, usage)).rejects.toBeInstanceOf(ClefError);

      expect(usage).toEqual([]);
    });
  });
});
