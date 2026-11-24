// PayPal reversals and lapse: refunds and reversals take back the credits they paid for,
// even into a negative balance; a lapsed plan falls back to free; a daily poll catches what
// webhooks missed.
import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { PaypalClient } from '@gitroom/nestjs-libraries/services/paypal/paypal.client';
import {
  PaypalEvent,
  PaypalWebhookIntake,
} from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';
import {
  AccountSubscriptionView,
  PaypalSubscriptionsService,
} from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.service';
import { TopupsService } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.service';
import { ReversalsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/reversals/reversals.repository';
import { CreditGrantsService } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.service';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';

// How far back the daily poll replays PayPal's events; also how long a sale refund waits for its renewal.
const REPLAY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
// Subscriptions read per page by the daily poll.
const SUBSCRIPTION_PAGE = 100;

// A PayPal money value in whole cents; v2 writes `{ value, currency_code }`, v1 `{ total, currency }`.
interface Money {
  cents: number;
  currency: string;
}

// The money value PayPal wrote, or null when there is none; an amount that is not a number is an error.
const moneyOf = (amount: any): Money | null => {
  if (!amount) {
    return null;
  }
  const text = amount.value ?? amount.total;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(text));
  const currency = amount.currency_code ?? amount.currency;
  if (!match || typeof currency !== 'string') {
    throw new Error('PayPal wrote a money value that cannot be read');
  }
  return {
    cents: Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')),
    currency,
  };
};

// The capture a refund or reversal event is about: a refund links up to its capture, a reversal is the capture.
const captureIdOf = (event: PaypalEvent): string | null => {
  const resource = event.resource;
  if (event.event_type === 'PAYMENT.CAPTURE.REVERSED') {
    return typeof resource?.id === 'string' ? resource.id : null;
  }
  const up = (resource?.links || []).find((link: any) => link?.rel === 'up');
  const id = String(up?.href || '')
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .pop();
  return id || null;
};

@Injectable()
export class ReversalsService implements OnModuleInit {
  private readonly _logger = new Logger(ReversalsService.name);

  constructor(
    private readonly _repository: ReversalsRepository,
    private readonly _client: PaypalClient,
    private readonly _intake: PaypalWebhookIntake,
    private readonly _subscriptions: PaypalSubscriptionsService,
    private readonly _topups: TopupsService,
    private readonly _grants: CreditGrantsService,
    private readonly _accounts: AccountsService
  ) {}

  // Registers the handlers for refunds, reversals, disputes and the end of a subscription.
  onModuleInit() {
    this._intake.on(
      ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'],
      (event) => this.onCaptureReturned(event)
    );
    this._intake.on(
      ['PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'],
      (event) => this.onSaleReturned(event)
    );
    this._intake.on(['CUSTOMER.DISPUTE.*'], (event) => this.onDispute(event));
    this._intake.on(
      [
        'BILLING.SUBSCRIPTION.CANCELLED',
        'BILLING.SUBSCRIPTION.SUSPENDED',
        'BILLING.SUBSCRIPTION.EXPIRED',
      ],
      (event) => this.onSubscriptionEnded(event)
    );
  }

  // Puts the account on FREE when its subscription is suspended, expired, or cancelled or not
  // renewed with its paid period over; otherwise leaves it. Credits and reservations are untouched.
  async enforceLapse(accountId: string, now = new Date()) {
    const account = await this._accounts.getAccountById(accountId);
    if (!account) {
      throw new HttpException('Account not found', 404);
    }
    const subscription = await this._subscriptions.getForAccount(accountId);
    if (
      !subscription ||
      account.planKey === 'FREE' ||
      !this.isLapsed(subscription, now)
    ) {
      return { planKey: account.planKey, changed: false };
    }
    await this._subscriptions.setPlanKey(accountId, 'FREE');
    return { planKey: 'FREE', changed: true };
  }

  // Replays the last 3 days of PayPal's events, then syncs every PayPal subscription and lapses
  // the ones no longer paid for. One subscription that fails is logged and the poll carries on.
  async dailyPoll(now = new Date()) {
    if (!this._client.isConfigured()) {
      this._logger.warn(
        'paypal: the daily poll skipped, PayPal is not configured'
      );
      return { replayed: 0, checked: 0, lapsed: 0 };
    }
    const { processed } = await this._intake.replay(
      new Date(now.getTime() - REPLAY_WINDOW_MS)
    );
    let checked = 0;
    let lapsed = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this._repository.paypalSubscriptions(
        cursor,
        SUBSCRIPTION_PAGE
      );
      for (const { externalId } of page) {
        try {
          const view = await this.syncOwn(externalId);
          if (!view) {
            continue;
          }
          checked++;
          if ((await this.enforceLapse(view.accountId, now)).changed) {
            lapsed++;
          }
        } catch (err) {
          this._logger.error(
            `paypal: the daily poll could not check subscription ${externalId}`
          );
          Sentry.captureException(err, {
            extra: { subscriptionId: externalId },
          });
        }
      }
      if (page.length < SUBSCRIPTION_PAGE) {
        break;
      }
      cursor = page[page.length - 1].id;
    }
    return { replayed: processed, checked, lapsed };
  }

  // A top-up capture refunded or reversed: takes back this refund's share of the order's credits,
  // so that in total, in any event order, the credits taken equal credits × refunded ÷ paid.
  private async onCaptureReturned(event: PaypalEvent) {
    const captureId = captureIdOf(event);
    const reversalId = event.resource?.id;
    if (!captureId || typeof reversalId !== 'string') {
      this._logger.warn(`paypal: event ${event.id} names no capture`);
      return;
    }
    const topup = await this._topups.findByCapture(captureId);
    if (!topup) {
      this._logger.log(`paypal: event ${event.id} is not about a top-up`);
      return;
    }
    const grantKey = `paypal:capture:${captureId}`;
    const grant = await this._grants.getGrant(topup.accountId, grantKey);
    if (!grant) {
      this._logger.log(`paypal: nothing to revoke under ${grantKey}`);
      return;
    }
    const total = await this.paid(
      `/v2/payments/captures/${encodeURIComponent(captureId)}`
    );
    const refunds = await this.orderRefunds(topup.orderId, captureId, total);
    const creditsOf = (cents: number) =>
      Math.ceil((topup.credits * cents) / total.cents);
    // What the grant left out when it was granted net of refunds already on the order.
    const leftOut = topup.credits - grant.initial;
    let owed: number;
    if (event.event_type === 'PAYMENT.CAPTURE.REVERSED') {
      owed = topup.credits - Math.max(leftOut, creditsOf(refunds.cents));
    } else {
      const step = refunds.steps.find((s) => s.id === reversalId);
      if (!step && !refunds.ignored.has(reversalId)) {
        throw new Error(`The order does not list refund ${reversalId} yet`);
      }
      owed = step
        ? creditsOf(step.after) - Math.max(creditsOf(step.before), leftOut)
        : 0;
    }
    const amount = Math.min(grant.initial, owed);
    if (amount < 1) {
      this._logger.log(`paypal: refund ${reversalId} takes back no credits`);
      return;
    }
    await this._grants.revokeGrant(
      topup.accountId,
      grantKey,
      `paypal:reversal:${reversalId}`,
      amount
    );
  }

  // The refunds PayPal lists on a top-up's order, oldest first, each with the money refunded before
  // and after it (capped at what was paid); refunds that were cancelled or failed are only named.
  private async orderRefunds(orderId: string, captureId: string, total: Money) {
    const order = await this._client.request<any>(
      'GET',
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`
    );
    const payments = order?.purchase_units?.[0]?.payments;
    const listed: any[] = payments?.refunds || [];
    const counted = listed
      .filter((refund) => !['CANCELLED', 'FAILED'].includes(refund.status))
      .sort(
        (a, b) =>
          (Date.parse(a.create_time) || 0) - (Date.parse(b.create_time) || 0) ||
          String(a.id).localeCompare(String(b.id))
      );
    let cents = 0;
    const steps = counted.map((refund) => {
      const money = moneyOf(refund.amount);
      if (!money || money.currency !== total.currency || total.cents <= 0) {
        throw new Error(`Refund ${refund.id} does not match its payment`);
      }
      const before = cents;
      cents = Math.min(total.cents, cents + money.cents);
      return { id: String(refund.id), before, after: cents };
    });
    const capture = (payments?.captures || []).find(
      (c: any) => c.id === captureId
    );
    if (capture?.status === 'REFUNDED') {
      cents = total.cents;
      if (steps.length) {
        steps[steps.length - 1].after = cents;
      }
    }
    return {
      steps,
      cents,
      ignored: new Set(
        listed.filter((r) => !counted.includes(r)).map((r) => String(r.id))
      ),
    };
  }

  // A plan payment refunded or reversed: takes back the credits its renewal granted, in proportion;
  // while the renewal is unprocessed it fails so PayPal's redelivery or the replay retries it.
  private async onSaleReturned(event: PaypalEvent) {
    const saleId = event.resource?.sale_id;
    const reversalId = event.resource?.id;
    if (typeof saleId !== 'string' || typeof reversalId !== 'string') {
      this._logger.warn(`paypal: event ${event.id} names no sale`);
      return;
    }
    const renewal = await this._intake.findProcessedEvent(
      'PAYMENT.SALE.COMPLETED',
      saleId
    );
    if (!renewal) {
      if (Date.now() - Date.parse(event.create_time) > REPLAY_WINDOW_MS) {
        this._logger.error(
          `paypal: event ${event.id} refunds sale ${saleId}, whose renewal was never processed`
        );
        Sentry.captureMessage(
          'PayPal sale refund without a processed renewal',
          {
            extra: { eventId: event.id, saleId },
          }
        );
        return;
      }
      throw new Error(`The renewal of sale ${saleId} is not processed yet`);
    }
    const subscription = await this.syncOwn(
      renewal.resource?.billing_agreement_id
    );
    if (!subscription) {
      this._logger.log(`paypal: event ${event.id} is not about our plans`);
      return;
    }
    await this.revokeShare(
      subscription.accountId,
      `paypal:event:${renewal.id}`,
      reversalId,
      moneyOf(event.resource.amount),
      () => this.paid(`/v1/payments/sale/${encodeURIComponent(saleId)}`)
    );
  }

  // A dispute notice: logged only, credits move on the refund and reversal events.
  private async onDispute(event: PaypalEvent) {
    this._logger.log(`paypal: dispute event ${event.id} (${event.event_type})`);
  }

  // A subscription that was cancelled, suspended or expired: synced from PayPal, then lapsed if no longer paid for.
  private async onSubscriptionEnded(event: PaypalEvent) {
    const subscription = await this.syncOwn(event.resource?.id);
    if (!subscription) {
      this._logger.log(`paypal: event ${event.id} is not about our plans`);
      return;
    }
    await this.enforceLapse(subscription.accountId);
  }

  // Takes `refunded` ÷ paid of the grant's credits back (the whole grant when `refunded` is null),
  // rounded up; nothing when the account holds no grant under the key.
  private async revokeShare(
    accountId: string,
    grantKey: string,
    reversalId: string,
    refunded: Money | null,
    paid: () => Promise<Money>
  ) {
    const grant = await this._grants.getGrant(accountId, grantKey);
    if (!grant) {
      this._logger.log(`paypal: nothing to revoke under ${grantKey}`);
      return;
    }
    const total = await paid();
    const returned = refunded ?? total;
    if (returned.currency !== total.currency || total.cents <= 0) {
      throw new Error(`Refund ${reversalId} does not match its payment`);
    }
    const amount = Math.min(
      grant.initial,
      Math.ceil((grant.initial * returned.cents) / total.cents)
    );
    if (amount < 1) {
      this._logger.log(`paypal: refund ${reversalId} takes back no credits`);
      return;
    }
    await this._grants.revokeGrant(
      accountId,
      grantKey,
      `paypal:reversal:${reversalId}`,
      amount
    );
  }

  // The amount PayPal says a payment was for, read from the payment itself.
  private async paid(path: string) {
    const payment = await this._client.request<any>('GET', path);
    const money = moneyOf(payment?.amount);
    if (!money) {
      throw new Error('PayPal answered a payment without an amount');
    }
    return money;
  }

  // The subscription fetched from PayPal and stored; null when it is not one of ours.
  private async syncOwn(
    subscriptionId: unknown
  ): Promise<AccountSubscriptionView | null> {
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      return null;
    }
    try {
      return await this._subscriptions.syncFromPaypal(subscriptionId);
    } catch (err) {
      if (
        err instanceof HttpException &&
        (err.getResponse() as any)?.code === 'NO_SUBSCRIPTION'
      ) {
        return null;
      }
      throw err;
    }
  }

  // Whether the subscription no longer pays for a tier: suspended or expired; cancelled with its period
  // over (or none); active with its period over (not renewed).
  private isLapsed(subscription: AccountSubscriptionView, now: Date) {
    const end = subscription.currentPeriodEnd
      ? Date.parse(subscription.currentPeriodEnd)
      : null;
    const over = end !== null && end <= now.getTime();
    switch (subscription.status) {
      case 'SUSPENDED':
      case 'EXPIRED':
        return true;
      case 'CANCELLED':
        return end === null || over;
      case 'ACTIVE':
        return over;
      default:
        return false;
    }
  }
}
