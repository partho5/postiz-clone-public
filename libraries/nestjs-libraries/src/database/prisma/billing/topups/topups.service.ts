// PayPal top-ups: buying a credit pack once. The credits are granted only when PayPal
// reports the payment captured, once per capture, and never expire.
import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TopupOrder } from '@prisma/client';
import {
  PaypalApiError,
  PaypalClient,
} from '@gitroom/nestjs-libraries/services/paypal/paypal.client';
import {
  PaypalEvent,
  PaypalWebhookIntake,
} from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';
import { TopupsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';

export interface TopupView {
  orderId: string;
  packKey: string;
  credits: number;
  priceCents: number;
  currency: string;
  status: 'CREATED' | 'APPROVED' | 'CAPTURED' | 'FAILED';
  grantedAt: string | null;
}

interface PaypalMoney {
  currency_code: string;
  value: string;
}

interface PaypalOrder {
  id: string;
  links?: { rel: string; href: string }[];
  purchase_units?: {
    payments?: {
      captures?: { id: string; status: string; amount?: PaypalMoney }[];
      refunds?: { status: string; amount?: PaypalMoney }[];
    };
  }[];
}

type Settled = 'captured' | 'pending' | 'declined';

// The link rels PayPal uses for the page where the buyer approves the payment.
const APPROVAL_RELS = ['payer-action', 'approve'];
// Capture statuses that mean the buyer paid (a refund may follow).
const PAID_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
// PayPal's reasons for a refused capture that the order's state depends on: the same order
// captured twice, and a funding source the buyer's bank turned down.
const ALREADY_CAPTURED = 'ORDER_ALREADY_CAPTURED';
const INSTRUMENT_DECLINED = 'INSTRUMENT_DECLINED';

// A money value PayPal wrote ("12.50") as whole cents, or null when it is not a two-decimal amount.
const toCents = (money?: PaypalMoney) => {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(money?.value || '');
  return match
    ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))
    : null;
};

// Whole cents as the decimal string PayPal expects ("1250" → "12.50").
const fromCents = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

// PayPal's reason for refusing a call: the `issue` of its first error detail, else the error's name.
const issueOf = (error: PaypalApiError) => {
  const detail: any = Array.isArray(error.details) ? error.details[0] : null;
  return typeof detail?.issue === 'string' ? detail.issue : error.paypalName;
};

// An error the client acts on by its `code`.
const billingError = (
  status: number,
  code: string,
  message: string,
  details: object = {}
) =>
  new HttpException({ statusCode: status, code, message, ...details }, status);

@Injectable()
export class TopupsService implements OnModuleInit {
  private readonly _logger = new Logger(TopupsService.name);

  constructor(
    private readonly _repository: TopupsRepository,
    private readonly _client: PaypalClient,
    private readonly _intake: PaypalWebhookIntake,
    private readonly _credits: CreditsService,
    private readonly _pricing: PricingService,
    private readonly _accounts: AccountsService
  ) {}

  // Registers the handler that grants a top-up when PayPal reports its capture completed.
  onModuleInit() {
    this._intake.on(['PAYMENT.CAPTURE.COMPLETED'], (event) =>
      this.onCaptureCompleted(event)
    );
  }

  // Creates a PayPal order for a pack, snapshotting its credits and price, and answers the approval link.
  async createOrder(organizationId: string, userId: string, packKey: string) {
    this.requireConfigured();
    const accountId = await this.requireOwner(organizationId, userId);
    const pack = this._pricing.topupPack(packKey);
    if (!pack) {
      throw billingError(
        400,
        'UNKNOWN_PACK',
        'This credit pack does not exist'
      );
    }

    const rowId = randomUUID();
    const base = `${process.env.FRONTEND_URL}/w/${encodeURIComponent(
      organizationId
    )}/billing`;
    const order = await this._client.request<PaypalOrder>(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: rowId,
            description: `${pack.credits} credits`,
            amount: {
              currency_code: pack.currency,
              value: fromCents(pack.priceCents),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: 'PAY_NOW',
              return_url: `${base}/topup-return`,
              cancel_url: base,
            },
          },
        },
      },
      { requestId: `topup:create:${rowId}` }
    );
    const approveUrl = order.links?.find((l) =>
      APPROVAL_RELS.includes(l.rel)
    )?.href;
    if (!approveUrl) {
      throw billingError(
        502,
        'PAYPAL_NO_APPROVAL',
        'PayPal gave no approval link'
      );
    }

    await this._repository.create({
      id: rowId,
      accountId,
      userId,
      paypalOrderId: order.id,
      packKey: pack.key,
      credits: pack.credits,
      priceCents: pack.priceCents,
      currency: pack.currency,
    });
    return { orderId: order.id, approveUrl };
  }

  // Captures the approved order and grants its credits once PayPal says the payment completed.
  async capture(organizationId: string, userId: string, orderId: string) {
    const accountId = await this.requireOwner(organizationId, userId);
    const row = await this.requireOrder(accountId, orderId);
    if (row.status === 'CAPTURED') {
      return this.view(row);
    }
    this.requireConfigured();

    try {
      await this._client.request(
        'POST',
        `/v2/checkout/orders/${row.paypalOrderId}/capture`,
        {},
        { requestId: `topup:capture:${row.id}` }
      );
    } catch (error) {
      if (!(error instanceof PaypalApiError) || error.status !== 422) {
        throw error;
      }
      const issue = issueOf(error);
      if (issue !== ALREADY_CAPTURED) {
        if (issue === INSTRUMENT_DECLINED) {
          await this._repository.setStatus(row.id, 'FAILED');
        }
        throw this.declined(issue);
      }
    }

    const { outcome, order } = await this.settle(row);
    if (outcome === 'declined') {
      throw this.declined();
    }
    return this.view(order);
  }

  // The state of one of the account's orders as stored; 404 for any other order.
  async get(organizationId: string, orderId: string) {
    const accountId = await this._accounts.getAccountIdForOrganization(
      organizationId
    );
    return this.view(await this.requireOrder(accountId, orderId));
  }

  // The order paid by this capture, with its account, or null.
  async findByCapture(captureId: string) {
    const row = await this._repository.findByCapture(captureId);
    return row
      ? { ...this.view(row), accountId: row.accountId, captureId }
      : null;
  }

  // Grants the order's credits for a completed capture PayPal announced; an event that is not ours is logged and skipped.
  private async onCaptureCompleted(event: PaypalEvent) {
    const capture = event.resource;
    const row = await this._repository.findByReference(
      capture?.custom_id,
      capture?.supplementary_data?.related_ids?.order_id
    );
    if (!row || typeof capture?.id !== 'string') {
      this._logger.log(`Capture event ${event.id} is not a top-up`);
      return;
    }
    if (row.captureId && row.captureId !== capture.id) {
      this._logger.warn(`Top-up ${row.id} already holds another capture`);
      return;
    }
    await this.settle(row, capture.id);
  }

  // Reads the order from PayPal and, when its capture is paid, grants the unrefunded share of the
  // credits under the capture's key (the same key on every path) and records the capture.
  private async settle(row: TopupOrder, captureId?: string) {
    const order = await this._client.request<PaypalOrder>(
      'GET',
      `/v2/checkout/orders/${row.paypalOrderId}`
    );
    const payments = order.purchase_units?.[0]?.payments;
    const captures = payments?.captures || [];
    const capture = captureId
      ? captures.find((c) => c.id === captureId)
      : captures.find((c) => PAID_STATUSES.includes(c.status)) ||
        captures[captures.length - 1];
    if (!capture) {
      return { outcome: 'pending' as Settled, order: row };
    }
    if (capture.status === 'DECLINED' || capture.status === 'FAILED') {
      const failed =
        row.status === 'CAPTURED'
          ? row
          : await this._repository.setStatus(row.id, 'FAILED');
      return { outcome: 'declined' as Settled, order: failed };
    }
    if (!PAID_STATUSES.includes(capture.status)) {
      const approved =
        row.status === 'CREATED'
          ? await this._repository.setStatus(row.id, 'APPROVED')
          : row;
      return { outcome: 'pending' as Settled, order: approved };
    }

    if (
      toCents(capture.amount) !== row.priceCents ||
      capture.amount?.currency_code !== row.currency
    ) {
      throw new Error(
        `Capture ${capture.id} does not match the amount of top-up ${row.id}`
      );
    }
    const credits = this.unrefundedCredits(
      row,
      capture.status,
      payments?.refunds || []
    );
    if (credits > 0) {
      await this._credits.grant(row.accountId, {
        type: 'TOPUP',
        amount: credits,
        grantKey: `paypal:capture:${capture.id}`,
      });
    }
    const captured = await this._repository.markCaptured(
      row.id,
      capture.id,
      credits > 0
    );
    return { outcome: 'captured' as Settled, order: captured };
  }

  // The order's credits less the share of the price already refunded, rounded down; none once fully refunded.
  private unrefundedCredits(
    row: TopupOrder,
    captureStatus: string,
    refunds: { status: string; amount?: PaypalMoney }[]
  ) {
    const refunded =
      captureStatus === 'REFUNDED'
        ? row.priceCents
        : Math.min(
            row.priceCents,
            refunds
              .filter((r) => !['CANCELLED', 'FAILED'].includes(r.status))
              .reduce((sum, r) => sum + (toCents(r.amount) || 0), 0)
          );
    return Math.floor(
      (row.credits * (row.priceCents - refunded)) / row.priceCents
    );
  }

  // The account id when the user owns the workspace's account; 403 NOT_ACCOUNT_OWNER otherwise.
  private async requireOwner(organizationId: string, userId: string) {
    const accountId = await this._accounts.getAccountIdForOrganization(
      organizationId
    );
    const account = await this._accounts.getAccountById(accountId);
    if (!account || account.ownerId !== userId) {
      throw billingError(
        403,
        'NOT_ACCOUNT_OWNER',
        'Only the account owner can buy credits'
      );
    }
    return accountId;
  }

  // The account's order with this PayPal order id; 404 when there is none.
  private async requireOrder(accountId: string, orderId: string) {
    const row = await this._repository.findForAccount(accountId, orderId);
    if (!row) {
      throw billingError(404, 'TOPUP_NOT_FOUND', 'This order does not exist');
    }
    return row;
  }

  // 503 BILLING_NOT_CONFIGURED while the PayPal env vars are missing.
  private requireConfigured() {
    if (!this._client.isConfigured()) {
      throw billingError(
        503,
        'BILLING_NOT_CONFIGURED',
        'Billing is not available right now'
      );
    }
  }

  // The 402 answer for a payment PayPal refused; nothing is granted.
  private declined(reason?: string) {
    return billingError(
      402,
      'PAYMENT_DECLINED',
      'PayPal declined the payment',
      reason ? { reason } : {}
    );
  }

  // The order as the API exposes it: the PayPal order id is its `orderId`.
  private view(row: TopupOrder): TopupView {
    return {
      orderId: row.paypalOrderId,
      packKey: row.packKey,
      credits: row.credits,
      priceCents: row.priceCents,
      currency: row.currency,
      status: row.status as TopupView['status'],
      grantedAt: row.grantedAt ? row.grantedAt.toISOString() : null,
    };
  }
}
