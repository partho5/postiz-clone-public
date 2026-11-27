// Token auth: the validated request body for issuing and refreshing device tokens.
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

// The grant types `POST /auth/token` accepts.
const GRANT_TYPES = [
  'email_otp',
  'google_id_token',
  'refresh_token',
  'web_handoff',
] as const;

// The request body of `POST /auth/token`: a grant type and the fields that grant needs.
export class TokenRequestDto {
  @IsIn(GRANT_TYPES)
  grant_type: (typeof GRANT_TYPES)[number];

  @ValidateIf((o) => o.grant_type === 'google_id_token')
  @IsString()
  @MinLength(1)
  @MaxLength(8192)
  id_token?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o) => o.grant_type === 'email_otp')
  @IsString()
  @MaxLength(254)
  @IsEmail()
  email?: string;

  // six digits for `email_otp`; the 43-character code of a web handoff link (B2) for `web_handoff`
  @ValidateIf(
    (o) => o.grant_type === 'email_otp' || o.grant_type === 'web_handoff'
  )
  @IsString()
  @Matches(/^(?:\d{6}|[A-Za-z0-9_-]{43})$/)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  refresh_token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  device_name?: string;
}
