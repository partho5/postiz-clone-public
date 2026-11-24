// AI video editing (ai.video-editing), perception: the call to Cloudflare Workers AI Clef-omni
// (@cf/cloudflare/clef-omni). One call takes one proxy piece (an MP4 of at most 60 s and 16 MiB, embedded in the
// request) and at most 64 questions of the types noul, choice and score, and answers one value per question. Nothing
// here knows the planner: it sends questions and returns answers by id. The media embedding and the answer shape are
// the model's schema-input.json / schema-output.json; they are kept in `requestBody` and `readAnswers` alone.
import { Injectable } from '@nestjs/common';
import { ClefAnswer, ClefAnswers, ClefQuestion, MAX_QUESTIONS } from './core/edit.perception';
import { LlmUsage, jsonChars, llmUsage } from './llm.usage';

// A call that failed or answered something unusable. Perception degrades on it, so it carries no customer text.
export class ClefError extends Error {
  // `retryable` is only a hint for logs: perception never retries a call itself.
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

// The most one piece may weigh (the model's limit; the `edit_proxy` upload is capped at the same size).
export const MAX_PIECE_BYTES = 16 * 1024 * 1024;

// How long one call may take before it is given up.
const CALL_TIMEOUT_MS = 90_000;

// The model every call names (the trace records it).
export const CLEF_MODEL = 'clef-omni';

// The model's id at the provider (Cloudflare Workers AI), as the usage ledger names it.
export const CLEF_MODEL_ID = `@cf/cloudflare/${CLEF_MODEL}`;

// The body of one call: the piece embedded as a data URI, and the questions.
const requestBody = (video: Buffer, questions: ClefQuestion[]) => ({
  model: CLEF_MODEL,
  state: {},
  videos: [`data:video/mp4;base64,${video.toString('base64')}`],
  questions: questions.map((q) => ({
    id: q.id,
    type: q.type,
    instruction: q.instruction,
    ...(q.criteria ? { criteria: q.criteria } : {}),
  })),
});

// The answers by question id out of the response: `result.answers` as an object by id, or a list of
// { id, answer }. Anything else is not an answer.
const readAnswers = (json: any): ClefAnswers => {
  const raw = json?.result?.answers ?? json?.answers;
  const out: ClefAnswers = {};
  const take = (id: unknown, value: unknown) => {
    if (typeof id === 'string' && (typeof value === 'number' || typeof value === 'string')) {
      out[id] = value as ClefAnswer;
    }
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) take(entry?.id, entry?.answer ?? entry?.value);
  } else if (raw && typeof raw === 'object') {
    for (const [id, value] of Object.entries(raw)) take(id, value);
  } else {
    throw new ClefError('The answer has no answers');
  }
  return out;
};

@Injectable()
export class ClefOmniClient {
  // The network call: the global fetch (a test sets another).
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  // Whether the account and token are set; without them perception is skipped.
  isConfigured() {
    return !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN);
  }

  // Asks the questions about one piece, in one call; the caller batches by MAX_QUESTIONS. Throws ClefError on a
  // refusal, a timeout or an answer that is not one. `usage`, when given, gets what the call used (the tokens the response
  // reports in `usage`, else an estimate from the text of the questions and the answers, which leaves the video out), also
  // when the call fails after it was made; the answers are the same with or without it.
  async ask(video: Buffer, questions: ClefQuestion[], usage?: LlmUsage[]): Promise<ClefAnswers> {
    if (!this.isConfigured()) {
      throw new ClefError('Clef-omni is not configured');
    }
    if (questions.length > MAX_QUESTIONS) {
      throw new ClefError('Too many questions for one call');
    }
    if (video.length > MAX_PIECE_BYTES) {
      throw new ClefError('The piece is larger than a call takes');
    }
    const startedAt = Date.now();
    const inputChars = jsonChars(questions);
    const note = (reported: unknown, ok: boolean, answers?: ClefAnswers) =>
      usage?.push(
        llmUsage({ model: CLEF_MODEL_ID, reported, inputChars, outputChars: answers ? jsonChars(answers) : 0, startedAt, ok })
      );
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${CLEF_MODEL}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.CLOUDFLARE_AI_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody(video, questions)),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        }
      );
    } catch (err) {
      // the message names no body: only that the call did not complete
      note(undefined, false);
      throw new ClefError(`The call did not complete (${(err as Error).name})`, true);
    }
    if (!response.ok) {
      note(undefined, false);
      throw new ClefError(`Clef-omni answered ${response.status}`, response.status >= 500 || response.status === 429);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      note(undefined, false);
      throw new ClefError('The answer is not JSON');
    }
    const reported = (json as any)?.result?.usage ?? (json as any)?.usage;
    let answers: ClefAnswers;
    try {
      answers = readAnswers(json);
    } catch (err) {
      note(reported, false);
      throw err;
    }
    note(reported, true, answers);
    return answers;
  }
}
