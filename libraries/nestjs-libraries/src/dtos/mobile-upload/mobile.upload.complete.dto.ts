// Mobile direct upload (api.mobile-direct-upload): the body of POST /public/v1/upload/multipart/:id/complete.
import { IsArray, IsOptional, IsString } from 'class-validator';

// The finished parts, `{ n, etag }` each, as the phone read them from the part PUT responses. Only the
// array is checked here; that the list is exactly 1..partCount, each with an etag, is checked by the
// service, which knows the upload's part count and answers it with the code INVALID_PARTS.
export class MobileUploadCompleteDto {
  @IsArray()
  parts: Array<{ n: number; etag: string }>;

  // api.media-retention (RET-B4): the poster image, base64 of a jpeg, png or webp of at most 512 KiB. Only
  // its being a string is checked here; size and content (magic bytes) are checked by the service, which
  // answers INVALID_POSTER.
  @IsOptional()
  @IsString()
  poster?: string;
}
