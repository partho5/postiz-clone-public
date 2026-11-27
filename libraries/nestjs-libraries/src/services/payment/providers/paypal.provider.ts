// PayPal subscriptions: the payment provider that answers PayPal's webhooks and keeps account deletion from being blocked by a PayPal subscription.
import { HttpException } from '@nestjs/common';
import {
  PaymentProvider,
  PaymentProviderAbstract,
} from '@gitroom/nestjs-libraries/services/payment/payment.provider.interface';
import { PAYPAL_PROVIDER } from '@gitroom/nestjs-libraries/services/payment/payment.providers';
import {
  InvalidWebhookSignatureError,
  PaypalEvent,
  PaypalWebhookIntake,
} from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';
import { PaypalSubscriptionsService } from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.service';

@PaymentProvider({ provider: PAYPAL_PROVIDER })
export class PaypalProvider extends PaymentProviderAbstract {
  platform = 'web' as const;

  constructor(
    private readonly _intake: PaypalWebhookIntake,
    private readonly _subscriptions: PaypalSubscriptionsService
  ) {
    super();
  }

  // The event in a webhook request PayPal signed; a 400 for anything else.
  override async validateWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ) {
    try {
      return await this._intake.verify(rawBody, headers);
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        throw new HttpException(err.message, 400);
      }
      throw err;
    }
  }

  // Runs the handlers registered for a verified event, once per event id.
  override async processWebhook(event: PaypalEvent) {
    return this._intake.process(event);
  }

  // Account deletion: cancels the account's PayPal subscription, and does nothing when it has none.
  override async cancelAllSubscriptions(organizationId: string) {
    await this._subscriptions.cancelForOrganization(organizationId);
  }
}
