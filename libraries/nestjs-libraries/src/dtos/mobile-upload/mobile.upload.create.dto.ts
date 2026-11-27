// Mobile direct upload (api.mobile-direct-upload): the body of POST /public/v1/upload/multipart.
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

// What an upload is for: a video or image for a post (`media`, the default), the speech audio of a caption
// job (`transcript_audio`, ai.video-captions): a WAV with no media row, deleted once it is transcribed, or a
// small video of an AI edit job (`edit_proxy`, ai.video-editing): an mp4 with no media row either.
export const MOBILE_UPLOAD_PURPOSE_AUDIO = 'transcript_audio';
export const MOBILE_UPLOAD_PURPOSE_EDIT_PROXY = 'edit_proxy';
export const MOBILE_UPLOAD_PURPOSES = [
  'media',
  MOBILE_UPLOAD_PURPOSE_AUDIO,
  MOBILE_UPLOAD_PURPOSE_EDIT_PROXY,
] as const;
export type MobileUploadPurpose = (typeof MOBILE_UPLOAD_PURPOSES)[number];

// The recording to upload: its name (the extension decides the type), its size in bytes, and the
// content type the app believes it has (informational, the stored one comes from the extension).
export class MobileUploadCreateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @IsInt()
  @Min(1)
  size: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contentType?: string;

  // ai.video-captions, ai.video-editing: what the upload is for; left out it is `media`, as before this field existed.
  @IsOptional()
  @IsIn(MOBILE_UPLOAD_PURPOSES)
  purpose?: MobileUploadPurpose;
}
