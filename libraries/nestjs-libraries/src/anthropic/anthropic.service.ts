import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod/v4';
import {
  EditDirection,
  EditDirectionSchema,
  EditIconPicks,
  EditLlmClient,
  EditLlmEffort,
  EditLlmMessage,
  EditTextsDraft,
  EditTextsSchema,
  IconPicksSchema,
  splitSystem,
} from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm';
import {
  LlmUsage,
  jsonChars,
  llmUsage,
} from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';

// The most a decision call may write, thinking included: Claude Haiku 5.5 thinks by default and the thinking counts here,
// so a short answer still needs room.
const MAX_TOKENS = 16000;

// Each call is two tries (maxRetries 1), so the per-try timeout times two must fit the activity that makes the call:
// the writer runs in writeEdit (10 minutes): 240 s per try, 8 minutes at most. The icon picker runs in planEdit
// (2 minutes): 60 s per try, as the OpenAI picker.
const WRITER_TIMEOUT_MS = 240 * 1000;
const PICKER_TIMEOUT_MS = 60 * 1000;
// The director runs in directEdit, in an activity with the writer's 10 minutes: the writer's timeout.
const DIRECTOR_TIMEOUT_MS = WRITER_TIMEOUT_MS;

// The answer of a call as the schema's shape: only a finished answer that is valid JSON of that shape is an answer. A
// refusal, a cut-off answer, an empty one or text that is not the shape is null (the text is never logged).
const readAnswer = <T>(
  stopReason: string | null,
  text: string,
  schema: z.ZodType<T>
): T | null => {
  if (stopReason !== 'end_turn') return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const checked = schema.safeParse(json);
  return checked.success ? checked.data : null;
};

// The Anthropic side of the AI video editing decision calls (the writer and the icon picker), in structured outputs:
// the API constrains the answer to the schema, and the answer is checked again before it is returned.
@Injectable()
export class AnthropicService implements EditLlmClient {
  private _logger = new Logger(AnthropicService.name);

  writeEditTexts(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditTextsDraft | null> {
    return this.complete(
      model,
      effort,
      messages,
      EditTextsSchema,
      WRITER_TIMEOUT_MS,
      usage
    );
  }

  pickEditIcons(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditIconPicks | null> {
    return this.complete(
      model,
      effort,
      messages,
      IconPicksSchema,
      PICKER_TIMEOUT_MS,
      usage
    );
  }

  directEdit(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditDirection | null> {
    return this.complete(
      model,
      effort,
      messages,
      EditDirectionSchema,
      DIRECTOR_TIMEOUT_MS,
      usage
    );
  }

  private async complete<T>(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    schema: z.ZodType<T>,
    timeout: number,
    usage?: LlmUsage[]
  ): Promise<T | null> {
    const startedAt = Date.now();
    const inputChars = jsonChars(messages);
    const { system, rest } = splitSystem(messages);
    try {
      const response = await new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      }).messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          thinking: { type: 'adaptive' },
          output_config: { effort, format: zodOutputFormat(schema) },
          ...(system ? { system } : {}),
          messages: rest,
        },
        { timeout, maxRetries: 1 }
      );
      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      const cached = response.usage.cache_read_input_tokens ?? 0;
      const written = response.usage.cache_creation_input_tokens ?? 0;
      // The provider's input count leaves the cached tokens out: they are added back, so the ledger counts the input the
      // same way for every provider.
      usage?.push(
        llmUsage({
          model: response.model || model,
          reported: {
            input_tokens: response.usage.input_tokens + cached + written,
            output_tokens: response.usage.output_tokens,
            cached_tokens: cached,
          },
          inputChars,
          outputChars: text.length,
          startedAt,
          ok: true,
        })
      );
      const answer = readAnswer(response.stop_reason, text, schema);
      if (!answer)
        this._logger.warn(
          `A decision answered without a usable result (${
            response.stop_reason ?? 'no stop reason'
          })`
        );
      return answer;
    } catch (err) {
      usage?.push(llmUsage({ model, inputChars, startedAt, ok: false }));
      throw err;
    }
  }
}
