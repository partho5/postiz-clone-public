// Grant lifecycle: credits granted until a fixed instant, and
// taking a grant back when its payment is reversed.
import { HttpException, Injectable } from '@nestjs/common';
import { CreditBucketType } from '@prisma/client';
import {
  CreditsRepository,
  IdempotencyConflictError,
} from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import {
  CreditGrantsRepository,
  InvalidGrantError,
  OverRevokeError,
  UnknownGrantError,
} from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.repository';

// Bucket types a grant may have; REVERSAL buckets are written only by a revoke.
const GRANT_TYPES: CreditBucketType[] = ['GRANT', 'TOPUP', 'PROMO', 'REFUND'];

@Injectable()
export class CreditGrantsService {
  constructor(
    private _creditsRepository: CreditsRepository,
    private _grantsRepository: CreditGrantsRepository
  ) {}

  // Grants credits that expire at expiresAt (null: never). A grantKey this
  // account already used returns its first bucket, whatever the other params.
  async grantUntil(
    accountId: string,
    params: {
      type: CreditBucketType;
      amount: number;
      expiresAt: Date | null;
      grantKey: string;
    }
  ) {
    this.checkKey(params.grantKey);
    const existing = await this._grantsRepository.getGrant(
      accountId,
      params.grantKey
    );
    if (existing) {
      return { bucket: existing, created: false };
    }

    if (!GRANT_TYPES.includes(params.type)) {
      throw new HttpException(`Invalid grant type ${params.type}`, 400);
    }
    if (!Number.isInteger(params.amount) || params.amount <= 0) {
      throw new HttpException(`Invalid grant amount ${params.amount}`, 400);
    }
    if (
      params.expiresAt !== null &&
      (!(params.expiresAt instanceof Date) ||
        !(params.expiresAt.getTime() > Date.now()))
    ) {
      throw new HttpException(`Invalid grant expiry ${params.expiresAt}`, 400);
    }

    try {
      return await this._creditsRepository.grant({
        accountId,
        type: params.type,
        amount: params.amount,
        expiresAt: params.expiresAt,
        grantKey: params.grantKey,
      });
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  // Takes amount (default: the whole grant) of the grant under grantKey back,
  // into debt where it was already used. Idempotent on reversalKey.
  async revokeGrant(
    accountId: string,
    grantKey: string,
    reversalKey: string,
    amount?: number
  ) {
    this.checkKey(grantKey);
    this.checkKey(reversalKey);
    if (
      amount !== undefined &&
      (!Number.isInteger(amount) || amount <= 0)
    ) {
      throw new HttpException(`Invalid revoke amount ${amount}`, 400);
    }

    try {
      return await this._grantsRepository.revoke({
        accountId,
        grantKey,
        reversalKey,
        amount,
      });
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  // The bucket under grantKey in this account, or null.
  getGrant(accountId: string, grantKey: string) {
    this.checkKey(grantKey);
    return this._grantsRepository.getGrant(accountId, grantKey);
  }

  // A grant or reversal key must be a non-empty string.
  private checkKey(key: string) {
    if (typeof key !== 'string' || !key) {
      throw new HttpException(`Invalid grant key ${key}`, 400);
    }
  }

  // The HTTP answer for a repository error; anything else passes through.
  private toHttp(err: unknown) {
    if (err instanceof UnknownGrantError) {
      return new HttpException(err.message, 404);
    }
    if (err instanceof IdempotencyConflictError) {
      return new HttpException(err.message, 409);
    }
    if (err instanceof InvalidGrantError || err instanceof OverRevokeError) {
      return new HttpException(err.message, 400);
    }
    return err;
  }
}
