// Cost preview: the body of POST /credits/quote.
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class CreditQuoteDto {
  @IsString()
  @IsNotEmpty()
  actionKey: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;
}
