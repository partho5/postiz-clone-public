// Meta Model API chat (content plan, AI video edit decisions): sends one chat-completions request to Meta's Muse Spark and reads the answer
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
import type { ZodType } from 'zod/v4';
import {
  EditDirection,
  EditDirectionSchema,
  EditIconPicks,
  EditLlmClient,
  EditLlmEffort,
  EditLlmMessage,
  EditTextsDraft,
  MuseEditTextsSchema,
  MuseIconPicksSchema,
} from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm';
import {
  LlmUsage,
  jsonChars,
  llmUsage,
} from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';

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

// What `chat.completions.parse` takes and gives, so the shared `send` needs no more types.
type ParseBody = Parameters<OpenAI['chat']['completions']['parse']>[0];
type ParseAnswer = Awaited<
  ReturnType<OpenAI['chat']['completions']['parse']>
>;

// An AI edit decision call is abandoned after this long (the write activity has 10 minutes and 3 attempts); with one
// retry of the SDK a call is two tries at most.
const EDIT_TIMEOUT_MS = 120_000;

// Whether the 24 hour cache retention is still sent. Meta documents it for Responses; if Chat Completions refuses it
// with a 400 that names it, it is left out for the rest of the process.
let sendRetention = true;

@Injectable()
export class MuseChatService implements EditLlmClient {
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
    const answer = await this.send(
      {
        model,
        reasoning_effort: reasoningEffort,
        max_completion_tokens: MUSE_CHAT_MAX_COMPLETION_TOKENS,
        messages,
        response_format: zodResponseFormat(schema, name),
        prompt_cache_key: cacheKey,
      },
      // the SDK retries 429 and 5xx and honours Retry-After
      { timeout: MUSE_CHAT_TIMEOUT_MS, maxRetries: 2 }
    );

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

  // The writer's texts of an AI edit (ai.video-editing). Meta's schema has no nullable field, so an empty `icon_query`
  // is read back as null: the answer has the shape of the other providers'.
  async writeEditTexts(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditTextsDraft | null> {
    const answer = await this.completeEdit(
      model,
      effort,
      messages,
      MuseEditTextsSchema,
      'editTextsPrompt',
      usage
    );
    return answer
      ? {
          slots: answer.slots.map((slot) => ({
            ...slot,
            icon_query: slot.icon_query.trim() || null,
          })),
        }
      : null;
  }

  // The icon picker's picks of an AI edit (ai.video-editing). An empty `uuid` is read back as null.
  async pickEditIcons(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditIconPicks | null> {
    const answer = await this.completeEdit(
      model,
      effort,
      messages,
      MuseIconPicksSchema,
      'iconPicksPrompt',
      usage
    );
    return answer
      ? {
          picks: answer.picks.map((pick) => ({
            ...pick,
            uuid: pick.uuid.trim() || null,
          })),
        }
      : null;
  }

  // The director's labels of an AI edit (ai.video-editing). Its schema has no nullable field, so Meta takes it as it is.
  directEdit(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditDirection | null> {
    return this.completeEdit(
      model,
      effort,
      messages,
      EditDirectionSchema,
      'editDirectionPrompt',
      usage
    );
  }

  // The decision call of an AI edit: the schema's answer, or null when the model refused or answered nothing usable.
  // `usage`, when given, gets what the call used, also when it fails. A message, a prompt or an answer is never logged.
  private async completeEdit<T>(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    schema: ZodType<T>,
    name: string,
    usage?: LlmUsage[]
  ): Promise<T | null> {
    const startedAt = Date.now();
    const inputChars = jsonChars(messages);
    try {
      const answer = await this.send(
        {
          model,
          reasoning_effort: effort,
          max_completion_tokens: MUSE_CHAT_MAX_COMPLETION_TOKENS,
          // Meta's preferred role for instructions is `developer`
          messages: messages.map((message) => ({
            role: (message.role === 'system' ? 'developer' : message.role) as
              | 'developer'
              | 'user'
              | 'assistant',
            content: message.content,
          })),
          response_format: zodResponseFormat(schema, name),
          prompt_cache_key: `ai-edit:${name}`,
        },
        { timeout: EDIT_TIMEOUT_MS, maxRetries: 1 }
      );
      const message = answer.choices[0]?.message;
      const parsed = message?.refusal
        ? null
        : ((message?.parsed ?? null) as T | null);
      usage?.push(
        llmUsage({
          model: answer.model || model,
          reported: answer.usage,
          inputChars,
          outputChars: jsonChars(parsed),
          startedAt,
          ok: true,
        })
      );
      return parsed;
    } catch (err) {
      usage?.push(llmUsage({ model, inputChars, startedAt, ok: false }));
      throw err;
    }
  }

  // One request with the 24 hour cache retention; if Chat Completions refuses the retention with a 400 that names it,
  // it is left out for the rest of the process and the request is sent again. Any other error is let through.
  private async send(
    body: ParseBody,
    options: { timeout: number; maxRetries: number }
  ): Promise<ParseAnswer> {
    const request = () =>
      this.client().chat.completions.parse(
        {
          ...body,
          ...(sendRetention ? { prompt_cache_retention: '24h' as const } : {}),
        },
        options
      );

    try {
      return await request();
    } catch (error) {
      if (
        sendRetention &&
        error instanceof OpenAI.APIError &&
        error.status === 400 &&
        error.message.includes('prompt_cache_retention')
      ) {
        sendRetention = false;
        return await request();
      }
      throw error;
    }
  }
}
