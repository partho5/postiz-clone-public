// PayPal subscriptions: the request bodies of the plan routes.
import { IsString, MinLength } from 'class-validator';

// The tier an owner subscribes to or moves to.
export class PlanTierDto {
  @IsString()
  @MinLength(1)
  tierKey: string;
}

// The PayPal subscription an owner returns from approving.
export class PlanConfirmDto {
  @IsString()
  @MinLength(1)
  subscriptionId: string;
}
