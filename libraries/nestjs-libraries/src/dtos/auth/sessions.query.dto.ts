// Device sessions: the validated query of the route that signs devices out.
import { IsIn, IsOptional } from 'class-validator';

// The query of `DELETE /auth/sessions`: `except=current` keeps the calling device signed in.
export class SessionsQueryDto {
  @IsOptional()
  @IsIn(['current'])
  except?: 'current';
}
