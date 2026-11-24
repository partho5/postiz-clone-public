// Prompt Book (ai.video-captions): the validated bodies of the routes that save a prompt.
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

// The longest text a workspace saves for one of its prompts.
export const PROMPT_BODY_MAX_LENGTH = 4000;
// The longest text the owner saves as a default or a locked frame (frames carry the output rules).
export const PROMPT_DEFAULT_MAX_LENGTH = 20000;
// The values `reasoningEffort` takes (OpenAI reasoning models).
export const PROMPT_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
] as const;

// The names a locked frame may carry as `{{name}}`; the generator replaces each with its value. They are
// listed here, not in the defaults file, so the admin screen can name them without the frames' text
// reaching the client bundle:
//   platform               the channel's platform name
//   language               the language spoken in the video
//   transcript             what the creator says in the video
//   brand_voice            the workspace's `captions.general` text
//   platform_instructions  the platform's own prompt (`captions.video.*` or `captions.text.*`)
//   max_length             the characters the text and its hashtags may take together
//   title_rule             one sentence on the title: its limit, or that the platform has none
//   user_text              a sentence carrying the creator's own typed text, or nothing
export const PROMPT_FRAME_PLACEHOLDERS = [
  'platform',
  'language',
  'transcript',
  'brand_voice',
  'platform_instructions',
  'max_length',
  'title_rule',
  'user_text',
] as const;

// The body of `PUT /prompt-book/:key`: the workspace's own instructions for that prompt.
export class SavePromptDto {
  @IsString()
  @IsDefined()
  @MaxLength(PROMPT_BODY_MAX_LENGTH)
  body: string;
}

// The body of `PUT /admin/prompts`: a new version of a default. A model or reasoning effort left out
// keeps the one of the current version.
export class SaveDefaultPromptDto {
  @IsString()
  @IsDefined()
  key: string;

  @IsString()
  @IsDefined()
  @MaxLength(PROMPT_DEFAULT_MAX_LENGTH)
  body: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsIn(PROMPT_REASONING_EFFORTS)
  reasoningEffort?: (typeof PROMPT_REASONING_EFFORTS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// The body of `POST /admin/prompts/:key/restore`: the version to bring back as a new version.
export class RestorePromptDto {
  @IsInt()
  @Min(1)
  version: number;
}
