// AI charging: the body of POST /ai/quote.
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  AI_EDIT_LEVELS,
  AiEditLevel,
  AiKind,
} from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';

export class AiQuoteDto {
  @IsIn(['text', 'image', 'video', 'clip', 'captions', 'edit'])
  kind: AiKind;

  // edit: seconds of the recording
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsString()
  videoType?: string;

  @IsOptional()
  @IsObject()
  videoParams?: object;

  // ai.video-editing: required for an edit, which is priced by its level
  @ValidateIf((o: AiQuoteDto) => o.kind === 'edit' || o.editLevel !== undefined)
  @IsIn(AI_EDIT_LEVELS)
  editLevel?: AiEditLevel;
}
