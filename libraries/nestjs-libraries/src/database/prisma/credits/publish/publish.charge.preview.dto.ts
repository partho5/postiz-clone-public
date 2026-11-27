// Publish charging: the body of POST /posts/charge-preview.
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class PublishChargePreviewDto {
  @IsOptional()
  @IsString()
  group?: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  integrationIds: string[];

  // ai.video-captions: the seconds of speech audio the captions would be written from; the answer then
  // adds the credits they cost
  @IsOptional()
  @IsNumber()
  @Min(0)
  aiCaptionsSeconds?: number;
}
