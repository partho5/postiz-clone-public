// AI video editing (ai.video-editing): the body of POST /public/v1/ai-edits, the request of the task plan's contract.
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CONTRACT_VERSION,
  EDIT_LEVELS,
  EditLevel,
} from '@gitroom/nestjs-libraries/ai-video-edit/contract/edit.contract';

// Most activity entries one request may carry.
export const AI_EDIT_MAX_ACTIVITY = 2000;

// Most facecam keys one request may carry (the phone keeps one per move).
export const AI_EDIT_MAX_FACECAM_KEYS = 2000;

// Most proxy pieces one request may name: the longest video (600 s) in pieces of at most 60 s.
export const AI_EDIT_MAX_PROXIES = 10;

// The ratios the phone renders, 9:16 first.
const OUTPUT_RATIOS = ['9:16', '4:5', '1:1'];

// Most names the optional capability lists `text_motions` and `text_features` may carry.
export const AI_EDIT_MAX_TEXT_CAPABILITIES = 50;

// A motion or feature name: lowercase letters, digits and `_`, 1 to 64 characters.
const CAPABILITY_NAME = /^[a-z0-9_]{1,64}$/;

// The kinds of an activity entry.
const ACTIVITY_TYPES = ['brush', 'board_show', 'board_hide', 'slide_change', 'motion'];

// The kinds of a chapter (the slide's main content).
const CHAPTER_KINDS = ['text', 'image', 'other'];

// Most chapters one request may carry.
export const AI_EDIT_MAX_CHAPTERS = 50;

// Exactly one of `aiCaptionId` and `audioUploadId` names where the words come from.
@ValidatorConstraint({ name: 'oneTranscriptSource' })
class OneTranscriptSource implements ValidatorConstraintInterface {
  // True when one of the two is given and the other is not.
  validate(_value: unknown, args: ValidationArguments) {
    const dto = args.object as AiVideoEditCreateDto;
    return !!dto.aiCaptionId !== !!dto.audioUploadId;
  }

  // The message of a body with both or neither.
  defaultMessage() {
    return 'exactly one of aiCaptionId and audioUploadId is required';
  }
}

// The recording: its length in milliseconds, its size, its frame rate and where it came from.
export class AiEditVideoDto {
  @IsInt()
  @Min(1)
  duration_ms: number;

  @IsInt()
  @Min(1)
  width: number;

  @IsInt()
  @Min(1)
  height: number;

  @IsNumber()
  @Min(1)
  @Max(240)
  fps: number;

  @IsIn(['in_app_recording', 'imported'])
  source: 'in_app_recording' | 'imported';
}

// A rectangle as fractions of the master width and height.
export class AiEditRectDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  x: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  y: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  w: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  h: number;
}

// The band the user's captions take, as fractions of that output's height.
export class AiEditCaptionBandDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  y0: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  y1: number;
}

// One output the user enabled: its ratio, its crop of the master and its caption band (none when it shows no captions).
export class AiEditOutputDto {
  @IsIn(OUTPUT_RATIOS)
  ratio: '9:16' | '4:5' | '1:1';

  @IsDefined()
  @Type(() => AiEditRectDto)
  @ValidateNested()
  crop: AiEditRectDto;

  @IsOptional()
  @Type(() => AiEditCaptionBandDto)
  @ValidateNested()
  caption_band?: AiEditCaptionBandDto;
}

// One place of the facecam: centre as fractions of the master, radius as a fraction of its width.
export class AiEditFacecamKeyDto {
  @IsInt()
  @Min(0)
  t_ms: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  cx: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  cy: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  r: number;
}

// One thing that changed on screen, from the phone's event log or its frame difference.
export class AiEditActivityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id: string;

  @IsIn(ACTIVITY_TYPES)
  type: 'brush' | 'board_show' | 'board_hide' | 'slide_change' | 'motion';

  @IsInt()
  @Min(0)
  start_ms: number;

  @IsInt()
  @Min(0)
  end_ms: number;

  @IsDefined()
  @Type(() => AiEditRectDto)
  @ValidateNested()
  region: AiEditRectDto;

  @IsNumber()
  @Min(0)
  @Max(1)
  strength: number;

  @IsIn(['event_log', 'frame_diff'])
  source: 'event_log' | 'frame_diff';
}

// The effect and text-look ids this build of the phone can render, and (both optional, absent means the legacy set only)
// the text motions and look features it passed its checks for.
export class AiEditCapabilitiesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  effects: string[];

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  text_styles: string[];

  // `params.entry`, `params.hold` and `params.exit` values the phone draws; absent: only the legacy motions
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AI_EDIT_MAX_TEXT_CAPABILITIES)
  @IsString({ each: true })
  @Matches(CAPABILITY_NAME, { each: true })
  text_motions?: string[];

  // look features the phone draws (S6); absent: only looks that need none
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AI_EDIT_MAX_TEXT_CAPABILITIES)
  @IsString({ each: true })
  @Matches(CAPABILITY_NAME, { each: true })
  text_features?: string[];
}

// One slide of the recording (a new slide, a topic change): when it starts, what it holds and (optional) its content box.
export class AiEditChapterDto {
  @IsInt()
  @Min(0)
  start_ms: number;

  @IsIn(CHAPTER_KINDS)
  kind: 'text' | 'image' | 'other';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  note?: string;

  // the slide's title or image box, as fractions of the master frame
  @IsOptional()
  @ValidateNested()
  @Type(() => AiEditRectDto)
  region?: AiEditRectDto;
}

// The user's switches.
export class AiEditOptionsDto {
  @IsBoolean()
  sound_effects: boolean;
}

// The engine request: everything the planner reads about the recording besides its words.
export class AiEditRequestDto {
  @IsIn([CONTRACT_VERSION])
  contract_version: number;

  @IsDefined()
  @Type(() => AiEditVideoDto)
  @ValidateNested()
  video: AiEditVideoDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(OUTPUT_RATIOS.length)
  @Type(() => AiEditOutputDto)
  @ValidateNested({ each: true })
  outputs: AiEditOutputDto[];

  @IsArray()
  @ArrayMaxSize(AI_EDIT_MAX_FACECAM_KEYS)
  @Type(() => AiEditFacecamKeyDto)
  @ValidateNested({ each: true })
  facecam_track: AiEditFacecamKeyDto[];

  @IsArray()
  @ArrayMaxSize(AI_EDIT_MAX_ACTIVITY)
  @Type(() => AiEditActivityDto)
  @ValidateNested({ each: true })
  activity_map: AiEditActivityDto[];

  @IsIn(['multi', 'brand'])
  text_colors: 'multi' | 'brand';

  // ISO 639-3, from the caption when the phone has one
  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @IsDefined()
  @Type(() => AiEditCapabilitiesDto)
  @ValidateNested()
  capabilities: AiEditCapabilitiesDto;

  @IsDefined()
  @Type(() => AiEditOptionsDto)
  @ValidateNested()
  options: AiEditOptionsDto;

  // the slides of the recording; absent from older phones
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AI_EDIT_MAX_CHAPTERS)
  @Type(() => AiEditChapterDto)
  @ValidateNested({ each: true })
  chapters?: AiEditChapterDto[];
}

// One AI edit of a recording at one level: where its words come from (a READY caption of the recording, else a
// completed speech audio upload), its proxy pieces (Standard and Heavy) and the engine request.
export class AiVideoEditCreateDto {
  // the recording's session uuid, from the phone's event log
  @IsUUID()
  sessionId: string;

  @IsIn(EDIT_LEVELS)
  level: EditLevel;

  @ValidateIf(
    (dto: AiVideoEditCreateDto) =>
      !dto.audioUploadId || dto.aiCaptionId !== undefined
  )
  @Validate(OneTranscriptSource)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  aiCaptionId?: string;

  @ValidateIf((dto: AiVideoEditCreateDto) => !dto.aiCaptionId)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  audioUploadId?: string;

  // completed `edit_proxy` uploads in time order; required for Standard and Heavy (Basic reads none)
  @ValidateIf(
    (dto: AiVideoEditCreateDto) =>
      dto.level !== 'basic' || !!dto.proxyUploadIds?.length
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AI_EDIT_MAX_PROXIES)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(100, { each: true })
  proxyUploadIds?: string[];

  @IsDefined()
  @Type(() => AiEditRequestDto)
  @ValidateNested()
  request: AiEditRequestDto;
}
