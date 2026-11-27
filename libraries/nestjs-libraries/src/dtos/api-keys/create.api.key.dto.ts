// Scoped API keys: the validated body of the route that creates a workspace key.
import { ArrayNotEmpty, IsArray, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import {
  API_SCOPES,
  ApiScope,
} from '@gitroom/nestjs-libraries/dtos/api-keys/api.scopes';

// The body of `POST /workspace-keys`: a name and the scopes the key is allowed.
export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_SCOPES, { each: true })
  scopes: ApiScope[];
}
