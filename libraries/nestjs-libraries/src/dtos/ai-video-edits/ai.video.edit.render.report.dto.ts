// AI video editing (ai.video-editing): the body of POST /public/v1/ai-edits/:id/render-report, the phone's receipt of one
// render attempt. Codes, ids and numbers only: every string is limited in charset and length, so no text, path or message
// of the user can arrive, and every list is capped.
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// The ratios the phone renders, 9:16 first.
export const RENDER_RATIOS = ['9:16', '4:5', '1:1'];

// The warnings the phone's painters report (`property_not_drawn`: a look property the painter could not draw, so the overlay
// fell back to the plain look; `text_wrapped`: the text was broken into two lines; `layer_clipped`: a shadow, glow or tilt
// reached the safe-rectangle edge). Each carries the plan item id only.
export const RENDER_WARNING_CODES = [
  'overlay_skipped_no_room',
  'text_shrunk',
  'asset_missing',
  'caption_row_overflow',
  'property_not_drawn',
  'text_wrapped',
  'layer_clipped',
];

// Most warnings and outputs one receipt may carry.
export const RENDER_MAX_WARNINGS = 50;

// An id or a code: letters, digits and `. _ : -`.
const CODE = /^[A-Za-z0-9._:-]{1,64}$/;

// What a device model may look like: letters, digits, spaces and `. _ + -`.
const DEVICE = /^[A-Za-z0-9._+ -]{1,64}$/;

// An app version: letters, digits and `. _ + -`.
const VERSION = /^[A-Za-z0-9._+-]{1,32}$/;

// One output the phone rendered (or failed to): its ratio, whether it worked and, when it did not, a code.
export class AiEditRenderOutputDto {
  @IsIn(RENDER_RATIOS)
  ratio: '9:16' | '4:5' | '1:1';

  @IsBoolean()
  ok: boolean;

  @IsOptional()
  @IsString()
  @Matches(CODE)
  error_code?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400000)
  duration_ms?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  bytes?: number;
}

// One thing the painters did not draw as planned: the code and the plan item it concerns.
export class AiEditRenderWarningDto {
  @IsIn(RENDER_WARNING_CODES)
  code: string;

  @IsOptional()
  @IsString()
  @Matches(CODE)
  item_id?: string;
}

// The receipt of one render attempt of the plan the phone was served.
export class AiVideoEditRenderReportDto {
  // one value per attempt: a second receipt with the same one is ignored
  @IsString()
  @Matches(CODE)
  attemptId: string;

  // the sha256 (hex) of the body the phone was served
  @IsString()
  @Matches(/^[A-Fa-f0-9]{64}$/)
  served_sha256: string;

  @IsBoolean()
  parse_ok: boolean;

  @IsString()
  @Matches(VERSION)
  app_version: string;

  @IsString()
  @MaxLength(64)
  @Matches(DEVICE)
  device: string;

  @IsDefined()
  @IsArray()
  @ArrayMaxSize(RENDER_RATIOS.length)
  @Type(() => AiEditRenderOutputDto)
  @ValidateNested({ each: true })
  outputs: AiEditRenderOutputDto[];

  @IsDefined()
  @IsArray()
  @ArrayMaxSize(RENDER_MAX_WARNINGS)
  @Type(() => AiEditRenderWarningDto)
  @ValidateNested({ each: true })
  warnings: AiEditRenderWarningDto[];
}
