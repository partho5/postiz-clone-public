// Email one-time-code sign-in: the validated body of `POST /auth/otp/request`.
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

// The request body of `POST /auth/otp/request`: the address the code is sent to.
export class OtpRequestDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(254)
  @IsEmail()
  email: string;
}
