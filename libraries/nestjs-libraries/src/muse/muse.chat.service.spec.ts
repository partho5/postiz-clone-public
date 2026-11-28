// Content plan: the Meta chat client. Runs on a stubbed client, so it needs no network, key or database.
import OpenAI from 'openai';
import { z } from 'zod';
import {
  MUSE_CHAT_MAX_COMPLETION_TOKENS,
  MUSE_CHAT_TIMEOUT_MS,
  MuseChatService,
} from '@gitroom/nestjs-libraries/muse/muse.chat.service';

const Answer = z.object({ direction: z.string() });
const MESSAGES = [
  { role: 'developer' as const, content: 'rules' },
  { role: 'user' as const, content: '{"sourceText":"x"}' },
];

// The answer Meta gives for a request: the parsed object, the raw text and the token numbers.
const answerOf = (cached = 0) => ({
  choices: [
    {
      message: {
        parsed: { direction: 'd' },
        content: '{"direction":"d"}',
      },
    },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: cached },
  },
});

describe('MuseChatService', () => {
  const realKey = process.env.META_MUSE_API_KEY;
  let parse: jest.Mock;
  let service: MuseChatService;

  beforeEach(() => {
    parse = jest.fn().mockResolvedValue(answerOf(80));
    service = new MuseChatService();
    jest
      .spyOn(service as any, 'client')
      .mockReturnValue({ chat: { completions: { parse } } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (realKey === undefined) {
      delete process.env.META_MUSE_API_KEY;
    } else {
      process.env.META_MUSE_API_KEY = realKey;
    }
  });

  describe('configured', () => {
    it('is true for a key and false for none, an empty one or a blank one', () => {
      process.env.META_MUSE_API_KEY = 'muse-key';
      expect(service.configured()).toBe(true);
      delete process.env.META_MUSE_API_KEY;
      expect(service.configured()).toBe(false);
      for (const empty of ['', '   ']) {
        process.env.META_MUSE_API_KEY = empty;
        expect(service.configured()).toBe(false);
      }
    });
  });

  // Calls of the AI edit decisions (ai.video-editing). Synthetic words only; no prompt or answer is real.
  describe('AI edit decision calls', () => {
    const EDIT_MESSAGES = [
      { role: 'system' as const, content: 'rule one' },
      { role: 'user' as const, content: 'alpha beta' },
    ];
    const edit = (parsed: unknown, extra: Record<string, unknown> = {}) => ({
      model: 'muse-spark-1.3-contributor-0001',
      choices: [{ message: { parsed, ...extra } }],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 512 },
      },
    });

    it('sends system as developer, the effort, the cache key, the cap and the edit timeout', async () => {
      parse.mockResolvedValue(edit({ slots: [] }));

      await service.writeEditTexts(
        'muse-spark-1.3-contributor',
        'high',
        EDIT_MESSAGES
      );

      const [body, options] = parse.mock.calls[0];
      expect(body).toMatchObject({
        model: 'muse-spark-1.3-contributor',
        reasoning_effort: 'high',
        max_completion_tokens: MUSE_CHAT_MAX_COMPLETION_TOKENS,
        messages: [
          { role: 'developer', content: 'rule one' },
          { role: 'user', content: 'alpha beta' },
        ],
        prompt_cache_key: 'ai-edit:editTextsPrompt',
      });
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.name).toBe('editTextsPrompt');
      expect(options).toEqual({ timeout: 120_000, maxRetries: 1 });
    });

    it('keys the icon picker to its own cache and schema name', async () => {
      parse.mockResolvedValue(edit({ picks: [] }));

      await service.pickEditIcons('m', 'medium', EDIT_MESSAGES);

      const [body] = parse.mock.calls[0];
      expect(body.prompt_cache_key).toBe('ai-edit:iconPicksPrompt');
      expect(body.response_format.json_schema.name).toBe('iconPicksPrompt');
      expect(body.reasoning_effort).toBe('medium');
    });

    it('reads an empty icon_query as null and keeps a filled one', async () => {
      parse.mockResolvedValue(
        edit({
          slots: [
            { id: 'h1', text: 'Alpha', icon_query: '' },
            { id: 'h2', text: 'Beta', icon_query: '  ' },
            { id: 'h3', text: 'Gamma', icon_query: 'small green door' },
          ],
        })
      );

      expect(
        await service.writeEditTexts('m', 'high', EDIT_MESSAGES)
      ).toEqual({
        slots: [
          { id: 'h1', text: 'Alpha', icon_query: null },
          { id: 'h2', text: 'Beta', icon_query: null },
          { id: 'h3', text: 'Gamma', icon_query: 'small green door' },
        ],
      });
    });

    it('reads an empty uuid as null and keeps a filled one', async () => {
      parse.mockResolvedValue(
        edit({
          picks: [
            { id: 's1', uuid: '' },
            { id: 's2', uuid: 'abc-1' },
          ],
        })
      );

      expect(await service.pickEditIcons('m', 'high', EDIT_MESSAGES)).toEqual({
        picks: [
          { id: 's1', uuid: null },
          { id: 's2', uuid: 'abc-1' },
        ],
      });
    });

    it('answers null for a refusal and for no parsed answer, and still records the call', async () => {
      const usage: any[] = [];
      parse.mockResolvedValueOnce(
        edit({ slots: [] }, { refusal: 'cannot help' })
      );
      expect(
        await service.writeEditTexts('m', 'high', EDIT_MESSAGES, usage)
      ).toBeNull();

      parse.mockResolvedValueOnce(edit(null));
      expect(
        await service.pickEditIcons('m', 'high', EDIT_MESSAGES, usage)
      ).toBeNull();

      expect(usage).toHaveLength(2);
      expect(usage.every((u) => u.ok)).toBe(true);
    });

    it('pushes the usage of a finished call with the model the answer reports', async () => {
      parse.mockResolvedValue(edit({ picks: [] }));
      const usage: any[] = [];

      await service.pickEditIcons('muse-spark-1.3-contributor', 'high', EDIT_MESSAGES, usage);

      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        model: 'muse-spark-1.3-contributor-0001',
        input_tokens: 900,
        output_tokens: 40,
        cached_tokens: 512,
        estimated: false,
        ok: true,
      });
    });

    it('pushes a failed, estimated call and rethrows when Meta fails', async () => {
      parse.mockRejectedValue(
        new OpenAI.APIError(500, { message: 'down' }, 'down', new Headers())
      );
      const usage: any[] = [];

      await expect(
        service.writeEditTexts('m', 'high', EDIT_MESSAGES, usage)
      ).rejects.toBeInstanceOf(OpenAI.APIError);

      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        model: 'm',
        estimated: true,
        ok: false,
        output_tokens: 0,
      });
    });

    it('works without a usage array', async () => {
      parse.mockResolvedValue(edit({ picks: [] }));

      await expect(
        service.pickEditIcons('m', 'high', EDIT_MESSAGES)
      ).resolves.toEqual({ picks: [] });
    });

    it('asks the director with its own cache key and schema name, and returns the answer as it is', async () => {
      const direction = { style: 'calm', labels: [{ id: 's1', label: 'hook' }] };
      parse.mockResolvedValue(edit(direction));
      const usage: any[] = [];

      expect(
        await service.directEdit('muse-spark-1.3-contributor', 'high', EDIT_MESSAGES, usage)
      ).toEqual(direction);

      const [body] = parse.mock.calls[0];
      expect(body.prompt_cache_key).toBe('ai-edit:editDirectionPrompt');
      expect(body.response_format.json_schema.name).toBe('editDirectionPrompt');
      expect(body.reasoning_effort).toBe('high');
      expect(body.messages[0]).toEqual({ role: 'developer', content: 'rule one' });
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ input_tokens: 900, output_tokens: 40, ok: true });
    });

    it('answers null for a director refusal and records a failed director call', async () => {
      const usage: any[] = [];
      parse.mockResolvedValueOnce(edit({ style: 'calm', labels: [] }, { refusal: 'no' }));
      expect(await service.directEdit('m', 'high', EDIT_MESSAGES, usage)).toBeNull();

      parse.mockRejectedValueOnce(new OpenAI.APIError(500, { message: 'down' }, 'down', new Headers()));
      await expect(service.directEdit('m', 'high', EDIT_MESSAGES, usage)).rejects.toBeInstanceOf(OpenAI.APIError);

      expect(usage.map((u) => u.ok)).toEqual([true, false]);
    });
  });

  describe('writePlanPart', () => {
    it('sends the model, the effort, the token cap, a json_schema format and the cache hints', async () => {
      await service.writePlanPart(
        'muse-spark-1.3-contributor',
        'low',
        MESSAGES,
        Answer,
        'setupAnswer',
        'content-plan:planner.frame.setup'
      );

      const [body, options] = parse.mock.calls[0];
      expect(body).toMatchObject({
        model: 'muse-spark-1.3-contributor',
        reasoning_effort: 'low',
        max_completion_tokens: MUSE_CHAT_MAX_COMPLETION_TOKENS,
        messages: MESSAGES,
        prompt_cache_key: 'content-plan:planner.frame.setup',
        prompt_cache_retention: '24h',
      });
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.name).toBe('setupAnswer');
      expect(options).toMatchObject({
        timeout: MUSE_CHAT_TIMEOUT_MS,
        maxRetries: 2,
      });
    });

    it('returns the parsed answer, the raw text and the usage with the cached tokens', async () => {
      const result = await service.writePlanPart(
        'm',
        'medium',
        MESSAGES,
        Answer,
        'a',
        'k'
      );

      expect(result).toEqual({
        data: { direction: 'd' },
        text: '{"direction":"d"}',
        usage: { prompt: 100, cached: 80, completion: 20 },
      });
    });

    it('returns null data, empty text and zero usage when the model gave nothing', async () => {
      parse.mockResolvedValue({ choices: [{ message: { parsed: null } }] });

      await expect(
        service.writePlanPart('m', 'medium', MESSAGES, Answer, 'a', 'k')
      ).resolves.toEqual({
        data: null,
        text: '',
        usage: { prompt: 0, cached: 0, completion: 0 },
      });
    });

    it('lets an API error through', async () => {
      parse.mockRejectedValue(
        new OpenAI.APIError(429, { message: 'slow down' }, 'slow down', new Headers())
      );

      await expect(
        service.writePlanPart('m', 'medium', MESSAGES, Answer, 'a', 'k')
      ).rejects.toBeInstanceOf(OpenAI.APIError);
      expect(parse).toHaveBeenCalledTimes(1);
    });

    // Last on purpose: the retention flag lives for the whole process.
    it('retries once without the retention when a 400 names it, and later calls omit it', async () => {
      parse
        .mockRejectedValueOnce(
          new OpenAI.APIError(
            400,
            { message: 'Unknown parameter: prompt_cache_retention' },
            'Unknown parameter: prompt_cache_retention',
            new Headers()
          )
        )
        .mockResolvedValue(answerOf());

      await service.writePlanPart('m', 'medium', MESSAGES, Answer, 'a', 'k');

      expect(parse).toHaveBeenCalledTimes(2);
      expect(parse.mock.calls[0][0].prompt_cache_retention).toBe('24h');
      expect(parse.mock.calls[1][0]).not.toHaveProperty(
        'prompt_cache_retention'
      );

      await service.writePlanPart('m', 'medium', MESSAGES, Answer, 'a', 'k');
      expect(parse.mock.calls[2][0]).not.toHaveProperty(
        'prompt_cache_retention'
      );
    });
  });
});
