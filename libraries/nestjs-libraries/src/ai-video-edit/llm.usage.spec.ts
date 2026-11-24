// AI video editing (ai.video-editing), the LLM usage ledger: what one call reports. The tokens the provider reports are
// kept as they are; without them (or for a call that failed) they are estimated from the sizes, and the call says so.
import { estimateTokens, jsonChars, llmUsage } from './llm.usage';

describe('ai.video-editing: llm usage', () => {
  it('takes the tokens the provider reports, with the cached share, and is not estimated', () => {
    const usage = llmUsage({
      model: 'gpt-5.1',
      reported: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 100 } },
      inputChars: 99999,
      outputChars: 99999,
      startedAt: Date.now() - 50,
      ok: true,
    });

    expect(usage).toMatchObject({ model: 'gpt-5.1', input_tokens: 1200, output_tokens: 300, cached_tokens: 100, estimated: false, ok: true });
    expect(usage.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('reads input_tokens and output_tokens as well', () => {
    const usage = llmUsage({ model: 'm', reported: { input_tokens: 7, output_tokens: 3 }, inputChars: 0, startedAt: Date.now(), ok: true });

    expect(usage).toMatchObject({ input_tokens: 7, output_tokens: 3, estimated: false });
    expect(usage.cached_tokens).toBeUndefined();
  });

  it('estimates from the sizes (4 characters a token) and flags it when the provider reports nothing', () => {
    const usage = llmUsage({ model: 'm', inputChars: 401, outputChars: 40, startedAt: Date.now(), ok: true });

    expect(usage).toMatchObject({ input_tokens: 101, output_tokens: 10, estimated: true });
  });

  it('estimates the count the provider left out and flags the call', () => {
    const usage = llmUsage({ model: 'm', reported: { prompt_tokens: 50 }, inputChars: 4000, outputChars: 80, startedAt: Date.now(), ok: true });

    expect(usage).toMatchObject({ input_tokens: 50, output_tokens: 20, estimated: true });
  });

  it('ignores a count that is not a plain number and keeps a failed call as estimated with no output', () => {
    const usage = llmUsage({
      model: 'm',
      reported: { prompt_tokens: 'many', completion_tokens: -1 },
      inputChars: 80,
      startedAt: Date.now(),
      ok: false,
    });

    expect(usage).toMatchObject({ input_tokens: 20, output_tokens: 0, estimated: true, ok: false });
  });

  it('counts characters and tokens safely', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(NaN)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(jsonChars({ a: 1 })).toBe('{"a":1}'.length);
    expect(jsonChars(undefined)).toBe('null'.length);
    const cycle: any = {};
    cycle.self = cycle;
    expect(jsonChars(cycle)).toBe(0);
  });
});
