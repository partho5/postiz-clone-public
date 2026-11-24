// AI captions (ai.video-captions): the body of POST /public/v1/ai-captions.
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

// Which channels the captions are written for: those auto-publish posts to (`auto`), or the ones the
// phone names (`manual`).
export const AI_CAPTION_MODES = ['auto', 'manual'] as const;
export type AiCaptionMode = (typeof AI_CAPTION_MODES)[number];

// The speech audio the phone uploaded (the id `POST /upload/multipart/:id/complete` answered), how the
// recording will be published, and the creator's own words.
export class AiCaptionCreateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  audioUploadId: string;

  @IsIn(AI_CAPTION_MODES)
  mode: AiCaptionMode;

  // `manual` only: the channels to write for (live channels of the workspace)
  @ValidateIf((dto: AiCaptionCreateDto) => dto.mode === 'manual')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  integrationIds?: string[];

  // the recording's name
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  // the caption the creator typed (manual publish), plain text; it is published after the AI text
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  userText?: string;
}
