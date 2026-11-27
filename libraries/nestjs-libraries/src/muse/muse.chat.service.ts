// Meta Model API chat (content plan): sends one chat-completions request to Meta's Muse Spark and reads the answer
// back as a validated object, with the token numbers of the call. The endpoint is OpenAI-compatible, so the `openai`
// client runs against Meta's base URL with the deployment key META_MUSE_API_KEY (an app-level key, not a workspace
// credential). Endpoint, structured output, reasoning effort, error codes and prompt caching are from Meta's official
// docs (https://dev.meta.ai/docs/protocols/chat-completions, https://dev.meta.ai/docs/structured-output,
// https://dev.meta.ai/docs/muse-spark, https://dev.meta.ai/docs/error-handling and
// https://dev.meta.ai/docs/prompt-caching, checked 2026-11-22).
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

export const MUSE_CHAT_BASE_URL = 'https://api.meta.ai/v1';
// One request is abandoned after this long; the generator maps the timeout to a failed call.
export const MUSE_CHAT_TIMEOUT_MS = 180_000;
// Also covers the reasoning tokens of the model.
export const MUSE_CHAT_MAX_COMPLETION_TOKENS = 16_000;

// One message of a chat. `developer` is Meta's preferred role for instructions.
export type ChatTurn = {
  role: 'developer' | 'user' | 'assistant';
  content: string;
};
// The token numbers of one call; `cached` is the part of `prompt` that was served from Meta's prompt cache.
export type PlanUsage = { prompt: number; cached: number; completion: number };

// Whether the 24 hour cache retention is still sent. Meta documents it for Responses; if Chat Completions refuses it
// with a 400 that names it, it is left out for the rest of the process.
let sendRetention = true;

@Injectable()
export class MuseChatService {
  private _client: OpenAI | undefined;

  // Whether META_MUSE_API_KEY is set (an app-level key, not a workspace credential).
  configured() {
    return !!process.env.META_MUSE_API_KEY?.trim();
  }

  // Built on first use, so a missing key never breaks start-up. META_MUSE_BASE_URL (with META_MUSE_RELAY_TOKEN, sent as
  // x-relay-token) points the client at a relay when Meta does not serve the server's own region; both unset = Meta direct.
  private client() {
    const relayToken = process.env.META_MUSE_RELAY_TOKEN?.trim();
    this._client ??= new OpenAI({
      apiKey: process.env.META_MUSE_API_KEY?.trim(),
      baseURL: process.env.META_MUSE_BASE_URL?.trim() || MUSE_CHAT_BASE_URL,
      defaultHeaders: relayToken ? { 'x-relay-token': relayToken } : undefined,
    });
    return this._client;
  }

  // Sends `messages` and reads the answer as `schema` (Meta's strict structured-output subset: objects, arrays,
  // strings, booleans, numbers and enums, every field required). `data` is null when the model refused or answered
  // text that does not fit; `text` is the raw assistant content, which a chat stores to re-send byte for byte.
  // `cacheKey` routes requests of one kind to the same cache. An API error is let through for the generator to map.
  async writePlanPart<T extends z.ZodTypeAny>(
    model: string,
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high',
    messages: ChatTurn[],
    schema: T,
    name: string,
    cacheKey: string
  ): Promise<{ data: z.infer<T> | null; text: string; usage: PlanUsage }> {
    const send = () =>
      this.client().chat.completions.parse(
        {
          model,
          reasoning_effort: reasoningEffort,
          max_completion_tokens: MUSE_CHAT_MAX_COMPLETION_TOKENS,
          messages,
          response_format: zodResponseFormat(schema, name),
          prompt_cache_key: cacheKey,
          ...(sendRetention ? { prompt_cache_retention: '24h' as const } : {}),
        },
        // the SDK retries 429 and 5xx and honours Retry-After
        { timeout: MUSE_CHAT_TIMEOUT_MS, maxRetries: 2 }
      );

    let answer;
    try {
      answer = await send();
    } catch (error) {
      if (
        sendRetention &&
        error instanceof OpenAI.APIError &&
        error.status === 400 &&
        error.message.includes('prompt_cache_retention')
      ) {
        sendRetention = false;
        answer = await send();
      } else {
        throw error;
      }
    }

    const message = answer.choices[0]?.message;
    return {
      data: (message?.parsed ?? null) as z.infer<T> | null,
      text: message?.content ?? '',
      usage: {
        prompt: answer.usage?.prompt_tokens ?? 0,
        cached: answer.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        completion: answer.usage?.completion_tokens ?? 0,
      },
    };
  }
}
