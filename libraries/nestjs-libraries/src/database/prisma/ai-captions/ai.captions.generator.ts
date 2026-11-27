// AI captions (ai.video-captions): writes the caption, title and hashtags of one video for each platform
// it goes to. A prompt is built from the Prompt Book (the locked frame, the workspace's brand voice and the
// platform's own instructions, resolved for the workspace) and the facts only code knows: the transcript,
// the channel's character limit, its title rule and the creator's own text. The answer is fitted to the
// limit as the shared create-post validation counts it. Nothing here names a platform: the limit is the
// provider's `maxLength()` (given by the caller) and the title rule is read from its settings class.
import { Injectable, Logger } from '@nestjs/common';
import pLimit from 'p-limit';
import {
  CaptionMessage,
  OpenaiService,
} from '@gitroom/nestjs-libraries/openai/openai.service';
import {
  PromptBookService,
  ResolvedPrompt,
} from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.service';
import { PROMPT_FRAME_PLACEHOLDERS } from '@gitroom/nestjs-libraries/dtos/prompt-book/save.prompt.dto';
import {
  longestFit,
  postTextLength,
  titleRule,
} from '@gitroom/nestjs-libraries/integrations/post.text.limits';

// The most captions written at the same time.
const MAX_PARALLEL = 4;

// The limit used for a provider that reports none, so a caption stays bounded.
const DEFAULT_MAX_LENGTH = 2000;

// The room the creator's own text must leave for the AI text; with less, the channel keeps only that text.
const MIN_ROOM = 40;

// What a frame's `{{language}}` says: the speech-to-text service does not report the language spoken.
const SAME_LANGUAGE = 'the same language as the transcript';

type FramePlaceholder = (typeof PROMPT_FRAME_PLACEHOLDERS)[number];

// What a placeholder is called in the block appended when a frame lost it.
const PLACEHOLDER_LABELS: Record<FramePlaceholder, string> = {
  platform: 'Platform',
  language: 'Language to write in',
  transcript: 'Transcript',
  brand_voice: 'How the creator wants to sound',
  platform_instructions: 'What works on this platform',
  max_length: 'Characters the text and its hashtags together must fit in',
  title_rule: 'Title',
  user_text: "The creator's own text",
};

// A caption written for the channels that share a provider and a kind of post.
export type CaptionKind = 'video' | 'text';

// One text to write: all the channels of one provider that get the same kind of post.
export interface CaptionTarget {
  // The provider identifier of the channels.
  identifier: string;
  // The platform's name as the prompt says it.
  platform: string;
  kind: CaptionKind;
  // The provider's `maxLength()` for the channel (the smallest of the channels that share the text).
  maxLength?: number;
}

export interface CaptionInput {
  transcript: string;
  // The language spoken, when the transcriber reports it; else the caption follows the transcript's.
  language?: string;
  // The creator's own text (plain), published after the AI text word for word.
  userText?: string;
  targets: CaptionTarget[];
}

// A caption as saved in `AiCaptionOutput`.
export interface GeneratedCaption {
  identifier: string;
  kind: CaptionKind;
  // Only for a provider whose settings class has a `title`, within its limits.
  title?: string;
  // The text with its hashtags in a line of their own.
  text: string;
  // `text` as `<p>` lines, the content of the post's first value.
  html: string;
  // The hashtags that fitted, without the # sign.
  hashtags: string[];
  // The platform prompt the text was written from (its family default when the platform has none).
  promptKey: string;
  promptVersion: number;
  promptSource: 'default' | 'workspace';
  model: string;
}

// What the model wrote, tidied.
interface Draft {
  title: string;
  text: string;
  hashtags: string[];
}

// The text with escaped `& < >`, one `<p>` per line.
export const captionToHtml = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(
      (line) =>
        `<p>${line
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')}</p>`
    )
    .join('');

// The hashtags without # or blanks or punctuation, empty and repeated ones (any case) dropped.
const cleanHashtags = (hashtags: string[]) => {
  const seen = new Set<string>();
  return hashtags
    .map((tag) => tag.replace(/\s/g, '').replace(/[^\wÀ-￿]/g, ''))
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
};

// The text with its hashtags in a line of their own.
const withHashtags = (text: string, hashtags: string[]) =>
  hashtags.length
    ? `${text}\n\n${hashtags.map((tag) => `#${tag}`).join(' ')}`
    : text;

// The text with as many of its hashtags as fit, the last ones dropped first; null when the text alone
// is too long.
const dropHashtags = (
  text: string,
  hashtags: string[],
  fits: (value: string) => boolean
) => {
  for (let keep = hashtags.length; keep >= 0; keep -= 1) {
    const kept = hashtags.slice(0, keep);
    const composed = withHashtags(text, kept);
    if (fits(composed)) {
      return { text: composed, hashtags: kept };
    }
  }
  return null;
};

// The longest start of the text that fits, cut after a whole word when the text has one there.
export const cutAtWord = (text: string, fits: (value: string) => boolean) => {
  const cut = longestFit(text, fits);
  if (cut.length === text.length || /\s/.test(text.charAt(cut.length))) {
    return cut.trimEnd();
  }
  return cut.replace(/\s+\S*$/, '').trimEnd();
};

// The title cut to the settings class's limit; undefined when empty or under its minimum.
const fitTitle = (title: string, rule: { min?: number; max?: number }) => {
  const value = rule.max
    ? cutAtWord(title, (candidate) => candidate.length <= rule.max!)
    : title;
  return value && !(rule.min && value.length < rule.min) ? value : undefined;
};

// One sentence on the title for the frame's `{{title_rule}}`.
const titleSentence = (rule?: { min?: number; max?: number }) => {
  if (!rule) {
    return 'This platform has no title: return an empty string as the title.';
  }
  if (rule.min && rule.max) {
    return `Write a title of ${rule.min} to ${rule.max} characters.`;
  }
  if (rule.max) {
    return `Write a title of at most ${rule.max} characters.`;
  }
  return rule.min
    ? `Write a title of at least ${rule.min} characters.`
    : 'Write a title.';
};

// The frame with every `{{name}}` replaced in a single pass, so a value that contains `{{name}}` (a
// transcript, a workspace's text) is never expanded. A name the frame lost (the owner can save a frame
// without a placeholder) is appended in a marked block, so the transcript and the limits always reach
// the model; a name that is not a placeholder is left as written.
const fillFrame = (frame: string, values: Record<FramePlaceholder, string>) => {
  const filled = frame.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? values[name as FramePlaceholder]
      : match
  );
  const lost = PROMPT_FRAME_PLACEHOLDERS.filter(
    (name) => values[name] && !frame.includes(`{{${name}}}`)
  );
  return lost.length
    ? `${filled}\n\n--- Required details (the instructions above did not include them) ---\n${lost
        .map((name) => `${PLACEHOLDER_LABELS[name]}:\n${values[name]}`)
        .join('\n\n')}`
    : filled;
};

// Writes the captions of a video.
@Injectable()
export class AiCaptionsGenerator {
  private readonly _logger = new Logger(AiCaptionsGenerator.name);

  // Receives the Prompt Book the prompts are read from and the client that writes the text.
  constructor(
    private _promptBookService: PromptBookService,
    private _openaiService: OpenaiService
  ) {}

  // The captions for the targets, at most MAX_PARALLEL at a time, in the order of the targets. A target
  // whose room is too small once the creator's own text is counted is left out: its channels keep only
  // that text.
  async generate(
    orgId: string,
    input: CaptionInput
  ): Promise<GeneratedCaption[]> {
    const limit = pLimit(MAX_PARALLEL);
    const written = await Promise.all(
      input.targets.map((target) => limit(() => this.write(orgId, input, target)))
    );
    return written.filter((caption): caption is GeneratedCaption => !!caption);
  }

  // The caption for one target; null when the creator's own text leaves it too little room.
  private async write(
    orgId: string,
    input: CaptionInput,
    target: CaptionTarget
  ): Promise<GeneratedCaption | null> {
    const { identifier } = target;
    const max = target.maxLength || DEFAULT_MAX_LENGTH;
    // The creator's text follows the AI text as its own paragraphs; it takes its characters and the line
    // break before it from the limit.
    const userHtml = input.userText ? captionToHtml(input.userText) : '';
    const taken = userHtml
      ? postTextLength(identifier, `<p>x</p>${userHtml}`) -
        postTextLength(identifier, '<p>x</p>')
      : 0;
    const room = max - taken;
    if (userHtml && room < MIN_ROOM) {
      return null;
    }
    // Whether an AI text fits the channel together with the creator's text, measured as validation does.
    const fits = (text: string) =>
      postTextLength(identifier, captionToHtml(text) + userHtml) <= max;

    const [frame, brandVoice, platform] = await Promise.all([
      this._promptBookService.resolve(orgId, `captions.frame.${target.kind}`),
      this._promptBookService.resolve(orgId, 'captions.general'),
      this._promptBookService.resolve(
        orgId,
        `captions.${target.kind}.${identifier}`
      ),
    ]);
    const rule = titleRule(identifier);
    const messages: CaptionMessage[] = [
      {
        role: 'user',
        content: fillFrame(frame.body, {
          platform: target.platform,
          language: input.language || SAME_LANGUAGE,
          transcript: input.transcript.trim(),
          brand_voice: brandVoice.body,
          platform_instructions: platform.body,
          max_length: String(room),
          title_rule: titleSentence(rule),
          user_text: input.userText
            ? `- The creator typed this text, and it is published right after your caption exactly as written: ${JSON.stringify(
                input.userText
              )}. Do not repeat what it says, and write your caption so it reads well in front of it.`
            : '',
        }),
      },
    ];

    // Hashtags are dropped first, then one retry asks for a shorter text, then the text is cut at a word.
    let draft = await this.draft(frame, messages);
    let fitted = dropHashtags(draft.text, draft.hashtags, fits);
    if (!fitted) {
      const shorter = await this.shorten(frame, messages, draft, room);
      if (shorter) {
        // the retry may leave the title out: the first draft's is kept
        draft = { ...shorter, title: shorter.title || draft.title };
        fitted = dropHashtags(draft.text, draft.hashtags, fits);
      }
    }
    const final = fitted ?? { text: cutAtWord(draft.text, fits), hashtags: [] };
    if (!final.text) {
      return null;
    }
    const title = rule ? fitTitle(draft.title, rule) : undefined;
    return {
      identifier,
      kind: target.kind,
      ...(title ? { title } : {}),
      text: final.text,
      html: captionToHtml(final.text),
      hashtags: final.hashtags,
      promptKey: platform.key,
      promptVersion: platform.version,
      promptSource: platform.source,
      model: frame.model,
    };
  }

  // Asks the model for the draft the messages lead to; fails when it writes no text.
  private async draft(
    frame: ResolvedPrompt,
    messages: CaptionMessage[]
  ): Promise<Draft> {
    const written = await this._openaiService.writeCaption(
      frame.model,
      frame.settings.reasoningEffort,
      messages
    );
    const text = (written?.text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) {
      throw new Error('The model wrote no caption text');
    }
    return {
      title: (written?.title ?? '').replace(/\s+/g, ' ').trim(),
      text,
      hashtags: cleanHashtags(written?.hashtags ?? []),
    };
  }

  // Asks once for a shorter version of a draft that did not fit; null when that fails, so the draft is cut.
  private async shorten(
    frame: ResolvedPrompt,
    messages: CaptionMessage[],
    draft: Draft,
    room: number
  ) {
    try {
      return await this.draft(frame, [
        ...messages,
        { role: 'assistant', content: JSON.stringify(draft) },
        {
          role: 'user',
          content: `That text is too long. The text and its hashtags together must fit in ${room} characters. Write it again, shorter, in the same language, keeping the most important point. Return the same fields.`,
        },
      ]);
    } catch (err) {
      this._logger.warn(`Shorter caption failed: ${(err as Error).message}`);
      return null;
    }
  }
}
