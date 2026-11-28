// ai.video-editing: the Anthropic side of the decision calls (the writer and the icon picker). The SDK client is a
// stand-in: no network. Covers the answer of a finished call, the usage it reports, every answer that is not usable
// (a refusal, a cut-off answer, text that is not JSON, JSON of another shape) and a call that fails.
import { AnthropicService } from './anthropic.service';

const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class {
    messages = { create: (...args: unknown[]) => mockCreate(...args) };
  },
}));

const MESSAGES = [{ role: 'user' as const, content: 'x'.repeat(400) }];
const TEXTS = {
  slots: [{ id: 'h1', text: 'Hi', icon_query: null as string | null }],
};
const PICKS = { picks: [{ id: 's1', uuid: 'abc-1' }] };

// A finished response: a thinking block (empty text, as the default display gives) and the text of the answer.
const response = (text: string, overrides: Record<string, unknown> = {}) => ({
  model: 'claude-haiku-5-5',
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text },
  ],
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 64,
    cache_creation_input_tokens: 0,
  },
  ...overrides,
});

describe('ai.video-editing: AnthropicService decision calls', () => {
  beforeEach(() => mockCreate.mockReset());

  it('asks for the schema at the given effort, with adaptive thinking, and returns the checked answer', async () => {
    mockCreate.mockResolvedValue(response(JSON.stringify(TEXTS)));
    const usage: any[] = [];

    const answer = await new AnthropicService().writeEditTexts(
      'claude-haiku-5-5',
      'high',
      MESSAGES,
      usage
    );

    expect(answer).toEqual(TEXTS);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      messages: MESSAGES,
    });
    // the writer runs in writeEdit (10 minutes): two tries of 240 s
    expect(mockCreate.mock.calls[0][1]).toEqual({
      timeout: 240 * 1000,
      maxRetries: 1,
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      input_tokens: 1264,
      output_tokens: 300,
      cached_tokens: 64,
      estimated: false,
      ok: true,
    });
  });

  it('answers the icon picks of the same shape check, with the picker timeout (planEdit: two tries of 60 s)', async () => {
    mockCreate.mockResolvedValue(response(JSON.stringify(PICKS)));

    expect(
      await new AnthropicService().pickEditIcons(
        'claude-haiku-5-5',
        'high',
        MESSAGES
      )
    ).toEqual(PICKS);
  });

  it('answers null for a refusal and still records the call', async () => {
    mockCreate.mockResolvedValue(
      response('', { stop_reason: 'refusal', content: [] })
    );
    const usage: any[] = [];

    expect(
      await new AnthropicService().writeEditTexts(
        'claude-haiku-5-5',
        'high',
        MESSAGES,
        usage
      )
    ).toBeNull();
    expect(usage[0]).toMatchObject({
      ok: true,
      input_tokens: 1264,
      output_tokens: 300,
    });
  });

  it('answers null for an answer cut off at max_tokens, even when its text is valid so far', async () => {
    mockCreate.mockResolvedValue(
      response(JSON.stringify(TEXTS), { stop_reason: 'max_tokens' })
    );

    expect(
      await new AnthropicService().writeEditTexts(
        'claude-haiku-5-5',
        'high',
        MESSAGES
      )
    ).toBeNull();
  });

  it('answers null for text that is not JSON', async () => {
    mockCreate.mockResolvedValue(response('Here are the texts: {"slots": [}'));

    expect(
      await new AnthropicService().writeEditTexts(
        'claude-haiku-5-5',
        'high',
        MESSAGES
      )
    ).toBeNull();
  });

  it('answers null for JSON of another shape', async () => {
    mockCreate.mockResolvedValue(response(JSON.stringify(PICKS)));

    expect(
      await new AnthropicService().writeEditTexts(
        'claude-haiku-5-5',
        'high',
        MESSAGES
      )
    ).toBeNull();
  });

  it('adds a failed, estimated call and rethrows when the provider fails', async () => {
    mockCreate.mockRejectedValue(new Error('provider 529'));
    const usage: any[] = [];

    await expect(
      new AnthropicService().pickEditIcons(
        'claude-haiku-5-5',
        'high',
        MESSAGES,
        usage
      )
    ).rejects.toThrow('provider 529');

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      estimated: true,
      ok: false,
      output_tokens: 0,
    });
    expect(usage[0].input_tokens).toBeGreaterThanOrEqual(100);
  });

  it('sends a system message as the system field and keeps it out of the messages', async () => {
    mockCreate.mockResolvedValue(response(JSON.stringify(PICKS)));

    await new AnthropicService().pickEditIcons('claude-haiku-5-5', 'high', [
      { role: 'system', content: 'rule one' },
      { role: 'user', content: 'alpha' },
      { role: 'system', content: 'rule two' },
    ]);

    const body = mockCreate.mock.calls[0][0];
    expect(body.system).toBe('rule one\n\nrule two');
    expect(body.messages).toEqual([{ role: 'user', content: 'alpha' }]);
  });

  it('sends no system field when there is no system message', async () => {
    mockCreate.mockResolvedValue(response(JSON.stringify(PICKS)));

    await new AnthropicService().pickEditIcons(
      'claude-haiku-5-5',
      'high',
      MESSAGES
    );

    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('system');
  });

  it('answers the director labels with the writer timeout, the system prompt apart and the usage recorded', async () => {
    const direction = { style: 'calm', labels: [{ id: 's1', label: 'hook' }] };
    mockCreate.mockResolvedValue(response(JSON.stringify(direction)));
    const usage: any[] = [];

    expect(
      await new AnthropicService().directEdit('claude-haiku-5-5', 'high', [
        { role: 'system', content: 'rule one' },
        { role: 'user', content: 'alpha' },
      ], usage)
    ).toEqual(direction);

    const [body, options] = mockCreate.mock.calls[0];
    expect(body.system).toBe('rule one');
    expect(body.messages).toEqual([{ role: 'user', content: 'alpha' }]);
    expect(body.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
    // directEdit runs in a 10-minute activity: two tries of 240 s
    expect(options).toEqual({ timeout: 240 * 1000, maxRetries: 1 });
    expect(usage[0]).toMatchObject({ ok: true, estimated: false });
  });

  it('answers null for a director answer with a label outside the list or another shape', async () => {
    mockCreate.mockResolvedValueOnce(
      response(JSON.stringify({ style: 'calm', labels: [{ id: 's1', label: 'drawing' }] }))
    );
    mockCreate.mockResolvedValueOnce(response(JSON.stringify(PICKS)));

    expect(await new AnthropicService().directEdit('claude-haiku-5-5', 'high', MESSAGES)).toBeNull();
    expect(await new AnthropicService().directEdit('claude-haiku-5-5', 'high', MESSAGES)).toBeNull();
  });
});
