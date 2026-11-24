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
