// PayPal subscriptions: monthly plans bought through PayPal, owned by the account, each paid
// period granting the tier's credits exactly once. The plan catalogue follows the pricing file.
import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import dayjs from 'dayjs';
import { randomUUID } from 'crypto';
import {
  PaypalApiError,
  PaypalClient,
} from '@gitroom/nestjs-libraries/services/paypal/paypal.client';
import {
  PaypalEvent,
  PaypalWebhookIntake,
} from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';
import {
  PaypalSubscriptionsRepository,
  StoredPlan,
  StoredSubscription,
} from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.repository';
import { PAYPAL_PROVIDER } from '@gitroom/nestjs-libraries/services/payment/payment.providers';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { Tier } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { CreditGrantsService } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.service';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';

// The name PayPal shows on the plans and the approval page.
const BRAND_NAME = PRODUCT_NAME;

export interface AccountSubscriptionView {
  accountId: string;
  provider: 'paypal';
  tierKey: string;
  status: 'APPROVAL_PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

type SubscriptionStatus = AccountSubscriptionView['status'];

// A subscription as PayPal reports it now, mapped to our account and tier.
interface SubscriptionState {
  id: string;
  accountId: string;
  tierKey: string;
  status: SubscriptionStatus;
  nextBillingTime: Date | null;
}

// PayPal's subscription statuses and the one each is stored as (APPROVED is approved but not yet billing).
const STATUSES: Record<string, SubscriptionStatus> = {
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVED: 'APPROVAL_PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

// How far either side of a sale's time its transaction is looked for.
const SALE_WINDOW_DAYS = 1;

// A client-actionable billing error: `{ statusCode, code, message }`, branched on by `code`.
const billingError = (status: number, code: string, message: string) =>
  new HttpException({ statusCode: status, code, message }, status);

// An amount in cents as PayPal writes money.
const money = (cents: number) => (cents / 100).toFixed(2);

// The `href` of a PayPal link with this relation, or null.
const linkOf = (answer: any, rel: string): string | null =>
  (answer?.links || []).find((link: any) => link?.rel === rel)?.href || null;

@Injectable()
export class PaypalSubscriptionsService implements OnModuleInit {
  private readonly _logger = new Logger(PaypalSubscriptionsService.name);

  constructor(
    private readonly _client: PaypalClient,
    private readonly _intake: PaypalWebhookIntake,
    private readonly _repository: PaypalSubscriptionsRepository,
    private readonly _pricing: PricingService,
    private readonly _grants: CreditGrantsService,
    private readonly _accounts: AccountsService
  ) {}

  // Registers the webhook handlers and, when PayPal is configured, creates the plans the pricing file lists.
  async onModuleInit() {
    this._intake.on(['BILLING.SUBSCRIPTION.*'], (event) =>
      this.onSubscriptionEvent(event)
    );
    this._intake.on(['PAYMENT.SALE.COMPLETED'], (event) =>
      this.onSaleCompleted(event)
    );
    if (!this._client.isConfigured()) {
      return;
    }
    try {
      await this.syncPlans();
    } catch (err) {
      this._logger.error(
        `paypal: the plans could not be synced at start-up, each is created when first needed: ${
          err instanceof Error ? err.message : err
        }`
      );
      Sentry.captureException(err);
    }
  }

  // Creates the PayPal product and monthly plan of each tier, and updates the price of a plan whose tier price changed.
  async syncPlans() {
    this.requireConfigured();
    for (const tier of this._pricing.tiers()) {
      await this.planFor(tier);
    }
  }

  // Starts a subscription to a tier for the account and returns where its owner approves it at PayPal.
  async subscribe(organizationId: string, userId: string, tierKey: string) {
    this.requireConfigured();
    const accountId = await this.requireOwner(organizationId, userId);
    const tier = this.requireTier(tierKey);
    const existing = await this._repository.getByAccount(accountId);
    if (existing?.status === 'ACTIVE') {
      throw billingError(
        409,
        'ALREADY_SUBSCRIBED',
        'This account already has an active subscription'
      );
    }
    const plan = await this.planFor(tier);
    const page = `${process.env.FRONTEND_URL}/w/${encodeURIComponent(
      organizationId
    )}/billing`;
    const created = await this._client.request<any>(
      'POST',
      '/v1/billing/subscriptions',
      {
        plan_id: plan.planId,
        custom_id: accountId,
        application_context: {
          brand_name: BRAND_NAME,
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          return_url: page,
          cancel_url: page,
        },
      },
      { requestId: randomUUID() }
    );
    const approveUrl = linkOf(created, 'approve');
    if (!created?.id || !approveUrl) {
      throw new Error('PayPal answered a subscription without an approve link');
    }
    await this._repository.save({
      accountId,
      externalId: created.id,
      tierKey: tier.key,
      status: 'APPROVAL_PENDING',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
    return { approveUrl, subscriptionId: created.id as string };
  }

  // Reads the account's subscription back from PayPal after the owner returns from approving it.
  async confirm(
    organizationId: string,
    userId: string,
    subscriptionId: string
  ) {
    this.requireConfigured();
    const accountId = await this.requireOwner(organizationId, userId);
    const own = await this._repository.getByAccount(accountId);
    if (!own || own.externalId !== subscriptionId) {
      throw this.noSubscription();
    }
    return this.syncFromPaypal(subscriptionId);
  }

  // Moves the account's active subscription to another tier from its next billing period; the
  // approve link when PayPal needs the owner to approve the change.
  async changeTier(organizationId: string, userId: string, tierKey: string) {
    this.requireConfigured();
    const accountId = await this.requireOwner(organizationId, userId);
    const tier = this.requireTier(tierKey);
    const own = await this._repository.getByAccount(accountId);
    if (!own || own.status !== 'ACTIVE') {
      throw this.noSubscription();
    }
    if (own.tierKey === tier.key) {
      return { approveUrl: null };
    }
    const plan = await this.planFor(tier);
    const revised = await this._client.request<any>(
      'POST',
      `/v1/billing/subscriptions/${encodeURIComponent(own.externalId)}/revise`,
      { plan_id: plan.planId },
      { requestId: randomUUID() }
    );
    return { approveUrl: linkOf(revised, 'approve') };
  }

  // Cancels the account's subscription at PayPal; its tier stays until the paid period ends.
  async cancel(organizationId: string, userId: string) {
    this.requireConfigured();
    const accountId = await this.requireOwner(organizationId, userId);
    const own = await this._repository.getByAccount(accountId);
    if (!own) {
      throw this.noSubscription();
    }
    if (own.status === 'CANCELLED') {
      return this.view(own);
    }
    if (own.status === 'ACTIVE') {
      await this.syncFromPaypal(own.externalId);
      await this.cancelAtPaypal(own.externalId);
    }
    return this.syncFromPaypal(own.externalId);
  }

  // Cancels the subscription of the workspace's account when deleting an account must stop its billing.
  async cancelForOrganization(organizationId: string) {
    const accountId = await this._accounts.getAccountIdForOrganization(
      organizationId
    );
    const own = await this._repository.getByAccount(accountId);
    if (own?.status === 'ACTIVE') {
      await this.cancelAtPaypal(own.externalId);
      await this.syncFromPaypal(own.externalId);
    }
  }

  // Fetches the subscription's current state from PayPal, stores it, and puts the account on its tier while it is paid for.
  async syncFromPaypal(subscriptionId: string) {
    const state = await this.loadState(subscriptionId);
    if (!state) {
      throw this.noSubscription();
    }
    return this.view(await this.storeState(state));
  }

  // The account's subscription, or null.
  async getForAccount(accountId: string) {
    const stored = await this._repository.getByAccount(accountId);
    return stored ? this.view(stored) : null;
  }

  // Puts an account on a plan key (FREE or a tier); the only writer of `Account.planKey`.
  async setPlanKey(accountId: string, planKey: string) {
    if (planKey !== 'FREE' && !this._pricing.tier(planKey)) {
      throw new Error(`Unknown plan ${planKey}`);
    }
    await this._repository.setPlanKey(accountId, planKey);
  }

  // The tiers, each with the app features it grants, and the workspace account's subscription, as the
  // plans screen shows them.
  async plans(organizationId: string) {
    return {
      tiers: this._pricing.tiers().map((tier) => ({
        ...tier,
        features: this._pricing.featuresFor(tier.key),
      })),
      current: await this.getForAccount(
        await this._accounts.getAccountIdForOrganization(organizationId)
      ),
    };
  }

  // The account a workspace's plan belongs to, for a user who must be its owner.
  private async requireOwner(organizationId: string, userId: string) {
    const accountId = await this._accounts.getAccountIdForOrganization(
      organizationId
    );
    const account = await this._accounts.getAccountById(accountId);
    if (!account || account.ownerId !== userId) {
      throw billingError(
        403,
        'NOT_ACCOUNT_OWNER',
        'Only the account owner can manage the plan'
      );
    }
    return accountId;
  }

  // The tier with this key, or an UNKNOWN_TIER 400.
  private requireTier(tierKey: string) {
    const tier = this._pricing.tier(tierKey);
    if (!tier) {
      throw billingError(400, 'UNKNOWN_TIER', 'This plan does not exist');
    }
    return tier;
  }

  // Throws the BILLING_NOT_CONFIGURED 503 while PayPal is not configured.
  private requireConfigured() {
    if (!this._client.isConfigured()) {
      throw billingError(
        503,
        'BILLING_NOT_CONFIGURED',
        'Billing is not available right now'
      );
    }
  }

  // The NO_SUBSCRIPTION 404.
  private noSubscription() {
    return billingError(
      404,
      'NO_SUBSCRIPTION',
      'This account has no such subscription'
    );
  }

  // The stored PayPal plan of a tier in the PayPal environment in use (a plan id of the other
  // environment is never reused): created when missing, repriced when the tier's price changed.
  private async planFor(tier: Tier): Promise<StoredPlan> {
    const environment = this._client.apiHost();
    const stored =
      (await this._repository.getPlanByTier(tier.key, environment)) ??
      (await this.adoptUnrecordedPlan(tier.key, environment));
    if (!stored) {
      return this.createPlan(tier, environment);
    }
    if (
      stored.priceCents === tier.monthlyPriceCents &&
      stored.currency === tier.currency
    ) {
      return stored;
    }
    return this.reprice(stored, tier, environment);
  }

  // The tier's plan stored before environments were recorded, now recorded as this environment's
  // when PayPal knows its id here; null when there is none or PayPal does not know it.
  private async adoptUnrecordedPlan(tierKey: string, environment: string) {
    const unrecorded = await this._repository.getUnrecordedPlan(tierKey);
    if (!unrecorded) {
      // A concurrent call may have just adopted it: read again, so its plan id is not overwritten.
      return this._repository.getPlanByTier(tierKey, environment);
    }
    try {
      await this._client.request(
        'GET',
        `/v1/billing/plans/${encodeURIComponent(unrecorded.planId)}`
      );
    } catch (err) {
      if (err instanceof PaypalApiError && [400, 404].includes(err.status)) {
        return null;
      }
      throw err;
    }
    return this._repository.recordEnvironment(
      unrecorded.id,
      tierKey,
      environment
    );
  }

  // Creates the PayPal product and monthly plan of a tier; a repeated call returns PayPal's first answer.
  private async createPlan(tier: Tier, environment: string) {
    const product = await this._client.request<any>(
      'POST',
      '/v1/catalogs/products',
      {
        name: `${BRAND_NAME} ${tier.name}`,
        description: `${tier.name} plan: ${tier.monthlyCredits} credits a month`,
        type: 'SERVICE',
        category: 'SOFTWARE',
      },
      { requestId: `product:${tier.key}` }
    );
    const plan = await this._client.request<any>(
      'POST',
      '/v1/billing/plans',
      {
        product_id: product.id,
        name: `${BRAND_NAME} ${tier.name}`,
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: { interval_unit: 'MONTH', interval_count: 1 },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: this.pricingScheme(tier),
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          payment_failure_threshold: 3,
        },
      },
      { requestId: `plan:${tier.key}:${tier.monthlyPriceCents}:${tier.currency}` }
    );
    return this._repository.savePlan({
      tierKey: tier.key,
      environment,
      productId: product.id,
      planId: plan.id,
      priceCents: tier.monthlyPriceCents,
      currency: tier.currency,
    });
  }

  // Updates the price of a tier's PayPal plan; PayPal applies it from each subscriber's next billing cycle.
  private async reprice(stored: StoredPlan, tier: Tier, environment: string) {
    await this._client.request(
      'POST',
      `/v1/billing/plans/${encodeURIComponent(
        stored.planId
      )}/update-pricing-schemes`,
      {
        pricing_schemes: [
          {
            billing_cycle_sequence: 1,
            pricing_scheme: this.pricingScheme(tier),
          },
        ],
      },
      {
        requestId: `reprice:${stored.planId}:${tier.monthlyPriceCents}:${tier.currency}`,
      }
    );
    return this._repository.savePlan({
      ...stored,
      environment,
      priceCents: tier.monthlyPriceCents,
      currency: tier.currency,
    });
  }

  // A tier's monthly price as PayPal's fixed pricing scheme.
  private pricingScheme(tier: Tier) {
    return {
      fixed_price: {
        value: money(tier.monthlyPriceCents),
        currency_code: tier.currency,
      },
    };
  }

  // Asks PayPal to cancel a subscription.
  private async cancelAtPaypal(subscriptionId: string) {
    await this._client.request(
      'POST',
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      { reason: 'Cancelled by the account owner' },
      { requestId: `cancel:${subscriptionId}` }
    );
  }

  // The subscription as PayPal reports it now, or null when it is not one of ours (unknown to PayPal, no account, no tier).
  private async loadState(
    subscriptionId: string
  ): Promise<SubscriptionState | null> {
    let raw: any;
    try {
      raw = await this._client.request<any>(
        'GET',
        `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`
      );
    } catch (err) {
      if (err instanceof PaypalApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
    const account =
      typeof raw?.custom_id === 'string' && raw.custom_id
        ? await this._accounts.getAccountById(raw.custom_id)
        : null;
    const plan = raw?.plan_id
      ? await this._repository.getPlanByPlanId(raw.plan_id)
      : null;
    if (!account || !plan) {
      return null;
    }
    const status = STATUSES[raw.status];
    if (!status) {
      throw new Error(`PayPal reported the subscription status ${raw.status}`);
    }
    const next = raw.billing_info?.next_billing_time;
    return {
      id: subscriptionId,
      accountId: account.id,
      tierKey: plan.tierKey,
      status,
      nextBillingTime: next ? new Date(next) : null,
    };
  }

  // Stores a fetched state as the account's subscription and applies its plan; a notice about another,
  // not active subscription never replaces the account's active one.
  private async storeState(state: SubscriptionState) {
    const existing = await this._repository.getByAccount(state.accountId);
    if (
      existing &&
      existing.externalId !== state.id &&
      existing.status === 'ACTIVE' &&
      state.status !== 'ACTIVE'
    ) {
      return existing;
    }
    const sameSubscription = existing?.externalId === state.id;
    const stored = await this._repository.save({
      accountId: state.accountId,
      externalId: state.id,
      tierKey: state.tierKey,
      status: state.status,
      currentPeriodEnd:
        state.nextBillingTime ??
        (sameSubscription ? existing!.currentPeriodEnd : null),
      cancelAtPeriodEnd: state.status === 'CANCELLED',
    });
    await this.applyPlan(stored);
    return stored;
  }

  // Puts the account on the subscription's tier while it is paid for: active, or cancelled before its period ends.
  private async applyPlan(stored: StoredSubscription) {
    const paidFor =
      stored.status === 'ACTIVE' ||
      (stored.status === 'CANCELLED' &&
        !!stored.currentPeriodEnd &&
        stored.currentPeriodEnd.getTime() > Date.now());
    if (paidFor) {
      await this.setPlanKey(stored.accountId, stored.tierKey);
    }
  }

  // A stored subscription as the API shows it.
  private view(stored: StoredSubscription): AccountSubscriptionView {
    return {
      accountId: stored.accountId,
      provider: PAYPAL_PROVIDER,
      tierKey: stored.tierKey,
      status: stored.status as SubscriptionStatus,
      currentPeriodEnd: stored.currentPeriodEnd
        ? stored.currentPeriodEnd.toISOString()
        : null,
      cancelAtPeriodEnd: stored.cancelAtPeriodEnd,
    };
  }

  // A BILLING.SUBSCRIPTION.* notice: the subscription's state is read from PayPal, never from the notice.
  private async onSubscriptionEvent(event: PaypalEvent) {
    const id = event.resource?.id;
    if (typeof id !== 'string' || !id) {
      return;
    }
    const state = await this.loadState(id);
    if (!state) {
      this._logger.warn(
        `paypal: event ${event.id} is about a subscription that is not one of ours`
      );
      return;
    }
    await this.storeState(state);
  }

  // A PAYMENT.SALE.COMPLETED notice for a subscription: grants the tier's credits once per event id,
  // until the end of the period the payment bought, and nothing when PayPal says the sale was refunded.
  private async onSaleCompleted(event: PaypalEvent) {
    const subscriptionId = event.resource?.billing_agreement_id;
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      return;
    }
    const state = await this.loadState(subscriptionId);
    if (!state) {
      this._logger.warn(
        `paypal: sale event ${event.id} is for a subscription that is not one of ours`
      );
      return;
    }
    await this.storeState(state);
    const saleTime = dayjs(event.resource.create_time || event.create_time);
    if (
      (await this.saleStatus(subscriptionId, event.resource.id, saleTime)) ===
      'REFUNDED'
    ) {
      return;
    }
    const tier = this._pricing.tier(state.tierKey);
    if (!tier) {
      throw new Error(`The plan ${state.tierKey} is no longer in the pricing file`);
    }
    const expiresAt = (
      state.nextBillingTime
        ? dayjs(state.nextBillingTime)
        : saleTime.add(1, 'month')
    ).toDate();
    if (expiresAt.getTime() <= Date.now()) {
      this._logger.error(
        `paypal: sale event ${event.id} paid a period that has already ended, nothing to grant`
      );
      Sentry.captureMessage('PayPal sale paid a period that has ended', {
        extra: { eventId: event.id },
      });
      return;
    }
    await this._grants.grantUntil(state.accountId, {
      type: 'GRANT',
      amount: tier.monthlyCredits,
      expiresAt,
      grantKey: `paypal:event:${event.id}`,
    });
  }

  // The status PayPal lists for a subscription's payment, or null when the payment is not listed.
  private async saleStatus(
    subscriptionId: string,
    saleId: string,
    saleTime: dayjs.Dayjs
  ) {
    const from = saleTime.subtract(SALE_WINDOW_DAYS, 'day').toISOString();
    const to = saleTime.add(SALE_WINDOW_DAYS, 'day').toISOString();
    const listed = await this._client.request<any>(
      'GET',
      `/v1/billing/subscriptions/${encodeURIComponent(
        subscriptionId
      )}/transactions?start_time=${encodeURIComponent(
        from
      )}&end_time=${encodeURIComponent(to)}`
    );
    const sale = (listed?.transactions || []).find(
      (transaction: any) => transaction?.id === saleId
    );
    return sale?.status ? String(sale.status) : null;
  }
}
