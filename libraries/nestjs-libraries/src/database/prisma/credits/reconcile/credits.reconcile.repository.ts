// Nightly credit reconciliation: the ledger and post reads that decide which reservations are stale.
import { Injectable } from '@nestjs/common';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class CreditsReconcileRepository {
  constructor(
    private readonly _scope: MoneyScope,
    private readonly _post: PrismaRepository<'post'>
  ) {}

  // The RESERVED ledger rows of one account last reserved before `before`, oldest first.
  staleCandidates(accountId: string, before: Date) {
    return this._scope.run(accountId, (tx) =>
      tx.creditLedger.findMany({
        where: { accountId, status: 'RESERVED', updatedAt: { lt: before } },
        orderBy: { updatedAt: 'asc' },
        select: {
          idempotencyKey: true,
          organizationId: true,
          updatedAt: true,
          metadata: true,
        },
      })
    );
  }

  // State, publish date and deletion of the given posts; an unknown id is absent from the answer.
  posts(ids: string[]) {
    return this._post.model.post.findMany({
      where: { id: { in: ids } },
      select: { id: true, state: true, publishDate: true, deletedAt: true },
    });
  }
}
