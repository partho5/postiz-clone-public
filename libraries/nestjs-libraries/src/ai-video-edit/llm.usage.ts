// AI video editing (ai.video-editing), the LLM usage ledger: what one provider call used. A call reports it next to its
// result (an optional array the caller passes), so no result changes shape. The server keeps the model and the tokens and
// no price: the cost in USD is calculated later from the logged model id and tokens. Pure; nothing here reads a text.

// What one call used. `estimated` says the tokens are a guess from the sizes of what was sent and read (chars / 4), made
// when the provider reports no usage (and for a call that failed). A speech-to-text call has no tokens: it has
// `audio_seconds`, and its token fields are 0. `work` says what the call did, from ids and counts only, never a text.
export interface LlmUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  images?: number;
  audio_seconds?: number;
  estimated: boolean;
  latency_ms: number;
  ok: boolean;
  work?: string;
}

// The characters one token stands for, on average, in the estimate.
const CHARS_PER_TOKEN = 4;

// A guess of the tokens of a text of `chars` characters.
export const estimateTokens = (chars: number) =>
  Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;

// A count a provider reported: a finite number of at least 0, else undefined.
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

// The usage of one call. `reported` is the provider's own usage object (OpenAI's `usage` with `prompt_tokens` and
// `completion_tokens`, or a provider that says `input_tokens` and `output_tokens`); a count it does not give is estimated
// from the characters sent (`inputChars`) and read (`outputChars`), and then the call is `estimated`.
export const llmUsage = (call: {
  model: string;
  reported?: unknown;
  inputChars: number;
  outputChars?: number;
  startedAt: number;
  ok: boolean;
  images?: number;
}): LlmUsage => {
  const reported = (call.reported && typeof call.reported === 'object' ? call.reported : {}) as Record<string, any>;
  const input = count(reported.prompt_tokens) ?? count(reported.input_tokens);
  const output = count(reported.completion_tokens) ?? count(reported.output_tokens);
  const cached = count(reported.prompt_tokens_details?.cached_tokens) ?? count(reported.cached_tokens);
  return {
    model: call.model,
    input_tokens: input ?? estimateTokens(call.inputChars),
    output_tokens: output ?? estimateTokens(call.outputChars ?? 0),
    ...(cached === undefined ? {} : { cached_tokens: cached }),
    ...(call.images === undefined ? {} : { images: call.images }),
    estimated: input === undefined || output === undefined,
    latency_ms: Math.max(0, Date.now() - call.startedAt),
    ok: call.ok,
  };
};

// The characters of a value as JSON (what a call sent or read); 0 for what JSON cannot hold.
export const jsonChars = (value: unknown) => {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 0;
  }
};
