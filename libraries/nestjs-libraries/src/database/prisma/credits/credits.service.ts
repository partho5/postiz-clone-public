import { HttpException, Injectable } from '@nestjs/common';
import { CreditBucketType, Prisma } from '@prisma/client';
import {
  CreditLedgerStateError,
  CreditsRepository,
  IdempotencyConflictError,
  InsufficientCreditsError,
} from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import {
  MoneyScope,
  MoneyScopeRequiredError,
} from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import dayjs from 'dayjs';

export class InsufficientCreditsException extends HttpException {
  constructor(required: number, available: number) {
    super(
      {
        statusCode: 402,
        code: 'INSUFFICIENT_CREDITS',
        message: `This needs ${required} credits and you have ${available}. Top up to continue.`,
        required,
        available,
      },
      402
    );
  }
}

export interface CreditRequest {
  organizationId: string;
  userId?: string;
  actionKey: string;
  quantity?: number;
  idempotencyKey: string;
  metadata?: Prisma.InputJsonValue;
}

@Injectable()
export class CreditsService {
  constructor(
    private _creditsRepository: CreditsRepository,
    private _accountsService: AccountsService,
    private _moneyScope: MoneyScope
  ) {}

  // Unknown actions fail closed: nothing billable runs without a price.
  async quote(actionKey: string, quantity: number, planKey: string) {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new HttpException(`Invalid quantity ${quantity}`, 400);
    }
    const action = await this._creditsRepository.getAction(actionKey, planKey);
    if (!action) {
      throw new HttpException(`Unknown credit action ${actionKey}`, 500);
    }
    const unitCost = action.planOverrides[0]?.cost ?? action.cost;
    return {
      actionKey,
      actionVersion: action.version,
      unitCost,
      quantity,
      amount: unitCost * quantity,
    };
  }

  async quoteForOrganization(
    organizationId: string,
    actionKey: string,
    quantity = 1
  ) {
    const account = await this.getAccount(organizationId);
    return this.quote(actionKey, quantity, account.planKey);
  }

  // Takes the credits now. They are either committed when the action
  // succeeds or released when it fails. Safe to retry with the same key;
  // reopenReleased reserves a released key again at today's price.
  async reserve(
    request: CreditRequest,
    options: { reopenReleased?: boolean } = {}
  ) {
    const account = await this.getAccount(request.organizationId);
    const price = await this.quote(
      request.actionKey,
      request.quantity ?? 1,
      account.planKey
    );

    try {
      const { ledger } = await this._creditsRepository.reserve({
        accountId: account.id,
        organizationId: request.organizationId,
        userId: request.userId,
        actionKey: request.actionKey,
        actionVersion: price.actionVersion,
        quantity: price.quantity,
        unitCost: price.unitCost,
        idempotencyKey: request.idempotencyKey,
        metadata: request.metadata,
        reopenReleased: options.reopenReleased,
      });
      return ledger;
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  // actual < reserved gives the difference back (variable-cost actions
  // reserve their maximum estimate). Backend code passes the workspace id;
  // only the orchestrator may commit by key alone.
  async commit(
    idempotencyKey: string,
    actual?: number,
    organizationId?: string
  ) {
    try {
      return await this._creditsRepository.commit(
        idempotencyKey,
        actual,
        await this.scopedAccountId(organizationId)
      );
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  // Returns the credits of a reservation; workspace id as in commit.
  async release(idempotencyKey: string, organizationId?: string) {
    try {
      return await this._creditsRepository.release(
        idempotencyKey,
        await this.scopedAccountId(organizationId)
      );
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  // For immediate actions: reserve, run, then commit on success or release
  // on failure. run may return the actual cost in credits.
  async spend<T>(
    request: CreditRequest,
    run: () => Promise<T>,
    actual?: (result: T) => number | undefined
  ): Promise<T> {
    await this.reserve(request);
    let result: T;
    try {
      result = await run();
    } catch (err) {
      // Never hide the real failure behind a failed release. A reservation
      // left behind stays visible as reserved and can be released later.
      await this.release(request.idempotencyKey, request.organizationId).catch(
        (releaseErr) =>
          console.error(
            'credits: release failed',
            request.idempotencyKey,
            releaseErr
          )
      );
      throw err;
    }
    await this.commit(
      request.idempotencyKey,
      actual?.(result),
      request.organizationId
    );
    return result;
  }

  async grant(
    accountId: string,
    params: {
      type: CreditBucketType;
      amount: number;
      expiresInDays?: number;
      grantKey?: string;
    }
  ) {
    if (!Number.isInteger(params.amount) || params.amount <= 0) {
      throw new HttpException(`Invalid grant amount ${params.amount}`, 400);
    }
    try {
      return await this._creditsRepository.grant({
        accountId,
        type: params.type,
        amount: params.amount,
        expiresAt: params.expiresInDays
          ? dayjs().add(params.expiresInDays, 'day').toDate()
          : null,
        grantKey: params.grantKey,
      });
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  async balance(organizationId: string) {
    const accountId = await this._accountsService.getAccountIdForOrganization(
      organizationId
    );
    return this._creditsRepository.balance(accountId);
  }

  reconcile(accountId: string) {
    return this._creditsRepository.reconcile(accountId);
  }

  listAccountIds(cursor: string | undefined, take: number) {
    return this._creditsRepository.listAccountIds(cursor, take);
  }

  // Account a commit or release is limited to, when the caller named a workspace.
  private scopedAccountId(organizationId?: string) {
    return organizationId === undefined
      ? undefined
      : this._moneyScope.accountIdFor(organizationId);
  }

  private async getAccount(organizationId: string) {
    const accountId = await this._accountsService.getAccountIdForOrganization(
      organizationId
    );
    return (await this._accountsService.getAccountById(accountId))!;
  }

  private toHttp(err: unknown) {
    if (err instanceof InsufficientCreditsError) {
      return new InsufficientCreditsException(err.required, err.available);
    }
    if (err instanceof IdempotencyConflictError) {
      return new HttpException(err.message, 409);
    }
    if (err instanceof CreditLedgerStateError) {
      return new HttpException(err.message, 409);
    }
    if (err instanceof MoneyScopeRequiredError) {
      // Surfaces as a 500 without the key; the log keeps it.
      console.error(
        'credits: commit or release without a workspace',
        err.idempotencyKey
      );
    }
    return err;
  }
}
