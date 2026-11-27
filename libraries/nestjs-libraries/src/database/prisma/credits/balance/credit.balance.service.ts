// Balance header: what the header shows (available, reserved, low-balance, may-top-up) and
// the list of posts the reserved credits are held for, all read from the server's ledger.
import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { CreditBalanceRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.balance.repository';

// The balance of a workspace's account; canTopUp is true when the user owns that account.
export interface BalanceView {
  available: number;
  reserved: number;
  plan: string;
  allotment: number;
  low: boolean;
  canTopUp: boolean;
}

// One held reservation; the post fields are present for a publish reservation.
export interface ReservationItem {
  ledgerId: string;
  actionKey: string;
  amount: number;
  createdAt: string;
  postId?: string;
  integrationId?: string;
  group?: string;
  occurrence?: number;
  publishDate?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// The publish fields a reservation's metadata carries, each only when it has the expected type.
const publishMetadata = (metadata: Prisma.JsonValue) => {
  const meta: Prisma.JsonObject =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata
      : {};
  // The value when it is a non-empty string.
  const text = (value: unknown) =>
    typeof value === 'string' && value ? value : undefined;
  return {
    postId: text(meta.postId),
    integrationId: text(meta.integrationId),
    group: text(meta.group),
    publishDate: text(meta.publishDate),
    occurrence: Number.isInteger(meta.occurrence)
      ? (meta.occurrence as number)
      : undefined,
  };
};

@Injectable()
export class CreditBalanceService {
  constructor(
    private _creditsService: CreditsService,
    private _accountsService: AccountsService,
    private _pricingService: PricingService,
    private _creditBalanceRepository: CreditBalanceRepository
  ) {}

  // The account's available and reserved credits with its plan, the monthly allotment, whether the
  // balance is below the low-balance ratio of that allotment, and whether the user may buy credits.
  async view(organizationId: string, userId: string): Promise<BalanceView> {
    const accountId = await this._accountsService.getAccountIdForOrganization(
      organizationId
    );
    const [account, balance] = await Promise.all([
      this._accountsService.getAccountById(accountId),
      this._creditsService.balance(organizationId),
    ]);
    if (!account) {
      throw new HttpException('Account not found', 404);
    }
    const allotment = await this._pricingService.monthlyAllotment(
      account.planKey
    );
    return {
      available: balance.available,
      reserved: balance.reserved,
      plan: account.planKey,
      allotment,
      low: balance.available < allotment * this._pricingService.lowBalanceRatio(),
      canTopUp: account.ownerId === userId,
    };
  }

  // The workspace's reserved credits, newest first, one page at a time; the credits the account's
  // other workspaces hold are only totalled. A publish item names its post's live group and date,
  // falling back to the reservation's snapshot when the post is gone.
  async reservations(
    organizationId: string,
    query: { cursor?: string; limit?: number }
  ): Promise<{
    items: ReservationItem[];
    nextCursor: string | null;
    otherWorkspacesReserved: number;
  }> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new HttpException(`limit must be 1 to ${MAX_LIMIT}`, 400);
    }
    const accountId = await this._accountsService.getAccountIdForOrganization(
      organizationId
    );
    const page = await this._creditBalanceRepository.reserved(
      accountId,
      organizationId,
      query.cursor || undefined,
      limit
    );
    const rows = page.rows.slice(0, limit);
    const metadata = rows.map((row) => publishMetadata(row.metadata));
    const postIds = metadata.flatMap((m) => (m.postId ? [m.postId] : []));
    const livePosts = postIds.length
      ? await this._creditBalanceRepository.livePosts(organizationId, postIds)
      : [];
    const live = new Map(livePosts.map((post) => [post.id, post] as const));

    const items = rows.map((row, i): ReservationItem => {
      const meta = metadata[i];
      const post = meta.postId ? live.get(meta.postId) : undefined;
      return {
        ledgerId: row.id,
        actionKey: row.actionKey,
        amount: row.reserved,
        createdAt: row.createdAt.toISOString(),
        ...(meta.postId ? { postId: meta.postId } : {}),
        ...(meta.integrationId ? { integrationId: meta.integrationId } : {}),
        ...(post?.group || meta.group ? { group: post?.group || meta.group } : {}),
        ...(meta.occurrence !== undefined ? { occurrence: meta.occurrence } : {}),
        ...(post || meta.publishDate
          ? { publishDate: post?.publishDate.toISOString() || meta.publishDate }
          : {}),
      };
    });

    return {
      items,
      nextCursor:
        page.rows.length > limit ? items[items.length - 1].ledgerId : null,
      otherWorkspacesReserved: page.accountHeld - page.workspaceHeld,
    };
  }
}
