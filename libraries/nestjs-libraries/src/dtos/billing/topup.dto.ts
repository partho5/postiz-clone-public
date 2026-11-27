// PayPal top-ups: the request body of the top-up order route.
import { IsString, MinLength } from 'class-validator';

// The credit pack an owner buys.
export class TopupPackDto {
  @IsString()
  @MinLength(1)
  packKey: string;
}
