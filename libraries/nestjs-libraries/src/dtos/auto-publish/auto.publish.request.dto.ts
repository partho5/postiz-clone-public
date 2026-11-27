// Mobile auto-publish (api.mobile-auto-publish): the body of POST /public/v1/auto-publish.
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// The video the app uploaded through POST /public/v1/upload.
export class AutoPublishMediaDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  path: string;
}

// The recording to publish and the file name the phone sends (never used as a caption), and the AI caption job
// written for it (ai.video-captions) when there is one.
export class AutoPublishRequestDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => AutoPublishMediaDto)
  media: AutoPublishMediaDto;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title: string;

  // a caption that is not READY (or not the workspace's) changes nothing: the posts go out as without it
  @IsOptional()
  @IsString()
  @MaxLength(100)
  aiCaptionId?: string;
}
