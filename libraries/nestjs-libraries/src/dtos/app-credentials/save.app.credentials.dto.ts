// Workspace app credentials (T4): the validated body of the route that saves one provider's keys.
import { IsDefined, IsObject } from 'class-validator';

// The body of `PUT /app-credentials/:identifier`: key name to value. A non-empty value sets or
// replaces the key, an empty value removes it, a key left out is unchanged. The service refuses a
// key the provider does not declare, a value that is not text, or one longer than 4096 characters.
export class SaveAppCredentialsDto {
  @IsDefined()
  @IsObject()
  values: Record<string, string>;
}
