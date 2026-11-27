// Money-table row-level security: the one way credits code reaches
// CreditBucket, CreditLedger and CreditEntry, in a transaction scoped to one account.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';

// A reservation was committed or released by key alone on the API role,
// which can only see the ledger of an account it is told about.
export class MoneyScopeRequiredError extends Error {
  constructor(public idempotencyKey: string) {
    super(
      `Commit or release of ${idempotencyKey} needs the workspace id on the API database role`
    );
  }
}

@Injectable()
export class MoneyScope {
  constructor(
    private readonly _transaction: PrismaTransaction,
    private readonly _accountsService: AccountsService
  ) {}

  // Runs fn in one transaction scoped to accountId; with lock, the account row lock is held first.
  run<T>(
    accountId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { lock?: boolean } = {}
  ): Promise<T> {
    if (typeof accountId !== 'string' || !accountId) {
      throw new Error('MoneyScope.run needs an account id');
    }
    return this._transaction.model.$transaction(
      async (tx) => {
        // The only raw SQL outside migrations: the account the policies admit.
        await tx.$executeRaw`SELECT set_config('app.account_id', ${accountId}, true)`;
        if (options.lock) {
          // A second change of the same account waits here until this one commits.
          await tx.account.update({
            where: { id: accountId },
            data: { lockVersion: { increment: 1 } },
            select: { id: true },
          });
        }
        return fn(tx);
      },
      { maxWait: 15000, timeout: 15000 }
    );
  }

  // Account of a workspace, for callers that hold only a workspace id.
  accountIdFor(organizationId: string): Promise<string> {
    return this._accountsService.getAccountIdForOrganization(organizationId);
  }
}
