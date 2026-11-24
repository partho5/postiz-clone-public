// Mobile direct upload (api.mobile-direct-upload): the body of POST /public/v1/upload/multipart/:id/parts.
import { IsArray } from 'class-validator';

// The part numbers to sign. Only the array is checked here; the elements, their count, range and
// duplicates are checked by the service, which knows the upload's part count and answers them with
// the code INVALID_PARTS.
export class MobileUploadPartsDto {
  @IsArray()
  partNumbers: number[];
}
