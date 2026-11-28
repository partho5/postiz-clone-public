// ai.video-editing (L7): the usage of the two AI edit model calls (the writer and the icon picker). The OpenAI client is a
// stand-in: no network. Covers the tokens the response reports (and the model id it names), the estimate when it reports
// none, a call that fails, and that the answer is the same with or without a `usage` array.
import { OpenaiService } from './openai.service';
import { iconPickMessages } from '../ai-video-edit/edit.icon.prompt';

const mockParse = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    chat = { completions: { parse: (...args: unknown[]) => mockParse(...args) } };
  },
}));
jest.mock('openai/helpers/zod', () => ({ zodResponseFormat: () => ({}) }));

const MESSAGES = [{ role: 'user' as const, content: 'x'.repeat(400) }];
const SLOTS = [{ id: 's1', query: 'rocket', candidates: [{ uuid: 'abc-1', name: 'Rocket launch' }] }];
const PICK = iconPickMessages(SLOTS);

describe('ai.video-editing: OpenaiService usage (L7)', () => {
  beforeEach(() => mockParse.mockReset());

  it('adds the tokens the writer response reports, under the model id the response names', async () => {
    mockParse.mockResolvedValue({
      model: 'gpt-5.1-2026-01-01',
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 64 } },
      choices: [{ message: { parsed: { slots: [{ id: 'h1', text: 'Hi', icon_query: null }] } } }],
    });
    const usage: any[] = [];

    const answer = await new OpenaiService().writeEditTexts('gpt-5.1', 'low', MESSAGES, usage);

    expect(answer).toEqual({ slots: [{ id: 'h1', text: 'Hi', icon_query: null }] });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: 'gpt-5.1-2026-01-01',
      input_tokens: 1200,
      output_tokens: 300,
      cached_tokens: 64,
      estimated: false,
      ok: true,
    });
  });

  it('estimates from the sizes when the response has no usage, and answers the same without a usage array', async () => {
    mockParse.mockResolvedValue({ choices: [{ message: { parsed: { picks: [{ id: 's1', uuid: 'abc-1' }] } } }] });
    const usage: any[] = [];

    const picked = await new OpenaiService().pickEditIcons('gpt-5.1', 'low', PICK, usage);
    const same = await new OpenaiService().pickEditIcons('gpt-5.1', 'low', PICK);

    expect(picked).toEqual(same);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'gpt-5.1', estimated: true, ok: true });
    expect(usage[0].input_tokens).toBeGreaterThan(0);
    expect(usage[0].output_tokens).toBeGreaterThan(0);
  });

  it('adds a failed, estimated call and rethrows when the provider fails', async () => {
    mockParse.mockRejectedValue(new Error('provider 500'));
    const usage: any[] = [];

    await expect(new OpenaiService().writeEditTexts('gpt-5.1', 'low', MESSAGES, usage)).rejects.toThrow('provider 500');

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'gpt-5.1', estimated: true, ok: false, output_tokens: 0 });
    expect(usage[0].input_tokens).toBeGreaterThanOrEqual(100);
  });

  it('answers null when the model refuses, and still records the call', async () => {
    mockParse.mockResolvedValue({ model: 'gpt-5.1', usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { parsed: null } }] });
    const usage: any[] = [];

    expect(await new OpenaiService().pickEditIcons('gpt-5.1', 'low', PICK, usage)).toBeNull();

    expect(usage[0]).toMatchObject({ input_tokens: 10, output_tokens: 2, estimated: false, ok: true });
  });

  it('asks the director for its schema and records the call, also when the model refuses or the call fails', async () => {
    const direction = { style: 'lively', labels: [{ id: 's1', label: 'claim' }] };
    mockParse.mockResolvedValueOnce({
      model: 'gpt-5.1',
      usage: { prompt_tokens: 50, completion_tokens: 7 },
      choices: [{ message: { parsed: direction } }],
    });
    const usage: any[] = [];

    expect(await new OpenaiService().directEdit('gpt-5.1', 'low', MESSAGES, usage)).toEqual(direction);
    expect(mockParse.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.1', reasoning_effort: 'low', messages: MESSAGES });

    mockParse.mockResolvedValueOnce({ model: 'gpt-5.1', choices: [{ message: { parsed: null } }] });
    expect(await new OpenaiService().directEdit('gpt-5.1', 'low', MESSAGES, usage)).toBeNull();

    mockParse.mockRejectedValueOnce(new Error('provider 500'));
    await expect(new OpenaiService().directEdit('gpt-5.1', 'low', MESSAGES, usage)).rejects.toThrow('provider 500');

    expect(usage.map((u) => u.ok)).toEqual([true, true, false]);
    expect(usage[0]).toMatchObject({ input_tokens: 50, output_tokens: 7, estimated: false });
  });
});
