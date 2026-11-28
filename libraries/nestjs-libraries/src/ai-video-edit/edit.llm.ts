// AI video editing (ai.video-editing), the models that make its decisions: the on-screen texts (the writer), the icon
// picks and the director's labels. Pure: the options, the answer schemas and the rules that pick an option. The calls are in the providers
// (OpenaiService, AnthropicService, MuseChatService) behind `EditLlmClient`; `EditLlmService` routes a call to the provider of its option.

import { z } from 'zod/v4';
import { LlmUsage } from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';

// One message of the conversation that a decision call sends. `system` holds the fixed instructions (also the cacheable
// prefix of the call); each provider sends it in its own way (see `splitSystem`).
export type EditLlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

// The system messages of a conversation apart from the rest: for a provider that takes the system prompt as a field of
// its own. The system messages are joined with a blank line, in order; `system` is undefined when there are none.
export const splitSystem = (
  messages: EditLlmMessage[]
): { system?: string; rest: (EditLlmMessage & { role: 'user' | 'assistant' })[] } => {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content);
  return {
    ...(system.length ? { system: system.join('\n\n') } : {}),
    rest: messages.filter(
      (message): message is EditLlmMessage & { role: 'user' | 'assistant' } =>
        message.role !== 'system'
    ),
  };
};

export type EditLlmProvider = 'openai' | 'anthropic' | 'meta';

// The reasoning effort of a call: `low` for the cheap model, `high` for Muse Spark and Claude Haiku 5.5.
export type EditLlmEffort = 'low' | 'medium' | 'high';

export interface EditLlmOption {
  model: string;
  provider: EditLlmProvider;
  effort: EditLlmEffort;
}

// The models a decision can run on. AI_EDIT_DECISION_MODEL (and the writer and icon picker variables) take any of them
// by name; a name that is not listed still runs, see `resolveEditLlm`.
export const EDIT_LLM_OPTIONS: EditLlmOption[] = [
  { model: 'muse-spark-1.3-contributor', provider: 'meta', effort: 'high' },
  { model: 'claude-haiku-5-5', provider: 'anthropic', effort: 'high' },
  { model: 'claude-sonnet-5-5', provider: 'anthropic', effort: 'medium' },
  { model: 'gpt-5-nano', provider: 'openai', effort: 'low' },
];

// THE SWITCH: the model of every AI edit decision (writer, icon picker, director). One of the models above, e.g.
// 'claude-haiku-5-5' or 'claude-sonnet-5-5'. AI_EDIT_DECISION_MODEL overrides it without a code change.
export const EDIT_DECISION_MODEL = 'muse-spark-1.3-contributor';
// Used only when the switch came from EDIT_DECISION_MODEL (no env var) and its provider has no key.
export const EDIT_FALLBACK_MODEL = 'claude-haiku-5-5';

// The environment variable that holds the key of each provider; an option whose key is unset cannot run.
export const EDIT_LLM_KEY_ENV: Record<EditLlmProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  meta: 'META_MUSE_API_KEY',
};

// The option of a model name. A name that is not listed runs on the provider its name belongs to, at that provider's
// default effort: `muse-` names Meta, `claude-` names Anthropic, every other name OpenAI (as before the options existed).
export const resolveEditLlm = (model: string): EditLlmOption => {
  const listed = EDIT_LLM_OPTIONS.find((option) => option.model === model);
  if (listed) return listed;
  if (model.startsWith('muse-')) return { model, provider: 'meta', effort: 'high' };
  return model.startsWith('claude-')
    ? { model, provider: 'anthropic', effort: 'high' }
    : { model, provider: 'openai', effort: 'low' };
};

// Whether the provider of an option has its key in the environment.
export const editLlmConfigured = (option: EditLlmOption) =>
  !!process.env[EDIT_LLM_KEY_ENV[option.provider]]?.trim();

// The option of every decision that has no variable of its own: AI_EDIT_DECISION_MODEL when set (an explicit choice
// without its key stays unconfigured, no fallback), else EDIT_DECISION_MODEL. When that default has no key and the
// fallback has one, the fallback, so a server without META_MUSE_API_KEY keeps working on Claude Haiku 5.5.
export const decisionEditLlm = () => {
  if (process.env.AI_EDIT_DECISION_MODEL) {
    return resolveEditLlm(process.env.AI_EDIT_DECISION_MODEL);
  }
  const option = resolveEditLlm(EDIT_DECISION_MODEL);
  const fallback = resolveEditLlm(EDIT_FALLBACK_MODEL);
  return !editLlmConfigured(option) && editLlmConfigured(fallback)
    ? fallback
    : option;
};

// The writer's option: AI_EDIT_WRITER_MODEL, else the decision option.
export const writerEditLlm = () =>
  process.env.AI_EDIT_WRITER_MODEL
    ? resolveEditLlm(process.env.AI_EDIT_WRITER_MODEL)
    : decisionEditLlm();

// The icon picker's option: AI_EDIT_ICON_MODEL, else AI_EDIT_WRITER_MODEL, else the decision option.
export const iconEditLlm = () => {
  const named =
    process.env.AI_EDIT_ICON_MODEL || process.env.AI_EDIT_WRITER_MODEL;
  return named ? resolveEditLlm(named) : decisionEditLlm();
};

// The director's option: AI_EDIT_DIRECTOR_MODEL, else the decision option.
export const directorEditLlm = () =>
  process.env.AI_EDIT_DIRECTOR_MODEL
    ? resolveEditLlm(process.env.AI_EDIT_DIRECTOR_MODEL)
    : decisionEditLlm();

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

// The same two answers in Meta's strict structured-output subset (every field required, so no nullable fields): an
// empty string stands for "none", and the Muse client maps it back to null (see MuseChatService).
export const MuseEditTextsSchema = z.object({
  slots: z.array(
    z.object({
      id: z.string().describe('The id of the slot the text is for'),
      text: z.string().describe('The on-screen text, 1 to 4 words'),
      icon_query: z
        .string()
        .describe('2 to 6 English words, or an empty string when none fits'),
    })
  ),
});

export const MuseIconPicksSchema = z.object({
  picks: z.array(
    z.object({
      id: z.string().describe('The id of the slot the pick is for'),
      uuid: z
        .string()
        .describe('The uuid, or an empty string when none fits'),
    })
  ),
});

// The labels the director gives a sentence (the same list as SENTENCE_LABELS in core/edit.moments.ts; a spec keeps them equal).
export const DIRECTOR_LABELS = ['hook', 'claim', 'reason', 'example', 'recap', 'cta', 'plain'] as const;

// The answer of the director: the style of the video and a label per sentence id. No nullable field, so Meta's strict
// structured output takes it as it is.
export const EditDirectionSchema = z.object({
  style: z.enum(['calm', 'lively']).describe('The style of the whole video'),
  labels: z.array(
    z.object({
      id: z.string().describe('The id of the sentence the label is for'),
      label: z.enum(DIRECTOR_LABELS).describe('The label of that sentence'),
    })
  ),
});

// What the model wrote for the slots of an AI edit.
export type EditTextsDraft = z.infer<typeof EditTextsSchema>;

// What the model picked for the slots of an AI edit.
export type EditIconPicks = z.infer<typeof IconPicksSchema>;

// What the director decided for an AI edit.
export type EditDirection = z.infer<typeof EditDirectionSchema>;

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
  directEdit(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditDirection | null>;
}
