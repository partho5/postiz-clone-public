// Free monthly grant: a free-plan account gets its free credits once per UTC month,
// the first only after a channel exists; unused ones expire at month end.
import { Injectable } from '@nestjs/common';
import { CreditGrantsService } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.service';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { FreeGrantRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.repository';

// Accounts read per page by the monthly run.
const ACCOUNT_PAGE = 100;

// `free:{accountId}:{YYYY-MM}`, the month being the UTC month of `at`.
const grantKeyFor = (accountId: string, at: Date) =>
  `free:${accountId}:${at.getUTCFullYear()}-${String(
    at.getUTCMonth() + 1
  ).padStart(2, '0')}`;

// The first instant of the UTC month after the one `at` falls in.
const nextMonthStart = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

@Injectable()
export class FreeGrantService {
  constructor(
    private _freeGrantRepository: FreeGrantRepository,
    private _creditGrantsService: CreditGrantsService,
    private _pricingService: PricingService
  ) {}

  // Whether the account is on the free plan and has ever had a channel.
  async isEligible(accountId: string) {
    const account = await this._freeGrantRepository.account(accountId);
    if (!account || account.planKey !== 'FREE') {
      return false;
    }
    return this._freeGrantRepository.hasEverHadChannel(accountId);
  }

  // Gives an eligible account the free credits of the UTC month of `at`, once. Not eligible,
  // a month already over or a free grant of 0 writes nothing.
  async ensureMonthlyGrant(accountId: string, at = new Date()) {
    const grantKey = grantKeyFor(accountId, at);
    const expiresAt = nextMonthStart(at);
    if (
      expiresAt.getTime() <= Date.now() ||
      !(await this.isEligible(accountId))
    ) {
      return { granted: false, grantKey, amount: 0 };
    }

    const amount = await this._pricingService.freeMonthlyGrant(at);
    if (amount <= 0) {
      return { granted: false, grantKey, amount: 0 };
    }
    const { created } = await this._creditGrantsService.grantUntil(accountId, {
      type: 'PROMO',
      amount,
      expiresAt,
      grantKey,
    });
    return { granted: created, grantKey, amount };
  }

  // Whether the workspace already has this channel, deleted or not (a reconnect).
  hasConnected(organizationId: string, internalId: string) {
    return this._freeGrantRepository.hasChannel(organizationId, internalId);
  }

  // Gives every eligible account the month's grant if it is missing. An account that fails
  // is logged and left for the next run.
  async runMonthlyGrants(at = new Date()) {
    let checked = 0;
    let granted = 0;
    let cursor: string | undefined;
    for (;;) {
      const ids = await this._freeGrantRepository.eligibleAccountIds(
        cursor,
        ACCOUNT_PAGE
      );
      for (const accountId of ids) {
        checked++;
        try {
          const result = await this.ensureMonthlyGrant(accountId, at);
          granted += result.granted ? 1 : 0;
        } catch (err) {
          console.error('credits: free grant failed', accountId, err);
        }
      }
      if (ids.length < ACCOUNT_PAGE) {
        return { checked, granted };
      }
      cursor = ids[ids.length - 1];
    }
  }
}
