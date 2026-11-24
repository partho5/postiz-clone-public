// AI video editing (ai.video-editing), the models that make its decisions: the on-screen texts (the writer) and the icon
// picks. Pure: the options, the answer schemas and the rules that pick an option. The calls are in the providers
// (OpenaiService, AnthropicService) behind `EditLlmClient`; `EditLlmService` routes a call to the provider of its option.

import { z } from 'zod/v4';
import { LlmUsage } from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';

// One message of the conversation that a decision call sends (the edit prompts are one user message).
export type EditLlmMessage = { role: 'user' | 'assistant'; content: string };

export type EditLlmProvider = 'openai' | 'anthropic';

// The reasoning effort of a call: `low` for the cheap model, `high` for Claude Haiku 5.5.
export type EditLlmEffort = 'low' | 'medium' | 'high';

export interface EditLlmOption {
  model: string;
  provider: EditLlmProvider;
  effort: EditLlmEffort;
}

// The models a decision can run on. The writer and the icon picker take any of them by name in AI_EDIT_WRITER_MODEL and
// AI_EDIT_ICON_MODEL; the default is Claude Haiku 5.5 at high effort.
export const EDIT_LLM_OPTIONS: EditLlmOption[] = [
  { model: 'gpt-5-nano', provider: 'openai', effort: 'low' },
  { model: 'claude-haiku-5-5', provider: 'anthropic', effort: 'high' },
];

export const EDIT_DECISION_MODEL = 'claude-haiku-5-5';

// The environment variable that holds the key of each provider; an option whose key is unset cannot run.
export const EDIT_LLM_KEY_ENV: Record<EditLlmProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

// The option of a model name. A name that is not listed runs on the provider its name belongs to, at that provider's
// default effort: `claude-` names Anthropic, every other name OpenAI (as before the options existed).
export const resolveEditLlm = (model: string): EditLlmOption => {
  const listed = EDIT_LLM_OPTIONS.find((option) => option.model === model);
  if (listed) return listed;
  return model.startsWith('claude-')
    ? { model, provider: 'anthropic', effort: 'high' }
    : { model, provider: 'openai', effort: 'low' };
};

// The writer's option: AI_EDIT_WRITER_MODEL, else the default.
export const writerEditLlm = () =>
  resolveEditLlm(process.env.AI_EDIT_WRITER_MODEL || EDIT_DECISION_MODEL);

// The icon picker's option: AI_EDIT_ICON_MODEL, else AI_EDIT_WRITER_MODEL, else the default.
export const iconEditLlm = () =>
  resolveEditLlm(
    process.env.AI_EDIT_ICON_MODEL ||
      process.env.AI_EDIT_WRITER_MODEL ||
      EDIT_DECISION_MODEL
  );

// Whether the provider of an option has its key in the environment.
export const editLlmConfigured = (option: EditLlmOption) =>
  !!process.env[EDIT_LLM_KEY_ENV[option.provider]];

// The answer of the writer: a text and an optional icon search query per slot id.
export const EditTextsSchema = z.object({
  slots: z.array(
    z.object({
      id: z.string().describe('The id of the slot the text is for'),
      text: z.string().describe('The on-screen text, 1 to 4 words'),
      icon_query: z
        .string()
        .nullable()
        .describe('2 to 6 English words describing a small scene, or null'),
    })
  ),
});

// The answer of the icon picker: a candidate uuid or null per slot id.
export const IconPicksSchema = z.object({
  picks: z.array(
    z.object({
      id: z.string().describe('The id of the slot the pick is for'),
      uuid: z
        .string()
        .nullable()
        .describe(
          'The uuid of the best candidate of that slot, or null when none fits'
        ),
    })
  ),
});

// What the model wrote for the slots of an AI edit.
export type EditTextsDraft = z.infer<typeof EditTextsSchema>;

// What the model picked for the slots of an AI edit.
export type EditIconPicks = z.infer<typeof IconPicksSchema>;

// The contract of a provider for the decision calls. Each answer is the schema's shape, or null when the model refused,
// stopped early or answered nothing usable. `usage`, when given, gets what the call used, also when it fails.
export interface EditLlmClient {
  writeEditTexts(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditTextsDraft | null>;
  pickEditIcons(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditIconPicks | null>;
}
