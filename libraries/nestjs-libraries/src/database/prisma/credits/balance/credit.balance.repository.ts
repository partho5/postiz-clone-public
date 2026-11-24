// Balance header: the reserved ledger rows of a workspace, the credits an account holds
// in reservations, and the live posts those reservations name.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';

@Injectable()
export class CreditBalanceRepository {
  constructor(
    private readonly _scope: MoneyScope,
    private readonly _post: PrismaRepository<'post'>
  ) {}

  // One page of the workspace's RESERVED ledger rows, newest first, with the credits the whole
  // account and this workspace hold in reservations, read in one transaction. `take` rows are
  // asked for plus one so the caller can tell whether another page follows.
  async reserved(
    accountId: string,
    organizationId: string,
    cursor: string | undefined,
    take: number
  ) {
    return this._scope.run(accountId, async (tx) => {
      const [rows, account, workspace] = await Promise.all([
        tx.creditLedger.findMany({
          where: { accountId, organizationId, status: 'RESERVED' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: take + 1,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        }),
        tx.creditLedger.aggregate({
          where: { accountId, status: 'RESERVED' },
          _sum: { reserved: true },
        }),
        tx.creditLedger.aggregate({
          where: { accountId, organizationId, status: 'RESERVED' },
          _sum: { reserved: true },
        }),
      ]);
      return {
        rows,
        accountHeld: account._sum.reserved || 0,
        workspaceHeld: workspace._sum.reserved || 0,
      };
    });
  }

  // The live (not deleted) posts of a workspace among these ids.
  livePosts(organizationId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: { organizationId, id: { in: ids }, deletedAt: null },
      select: { id: true, group: true, publishDate: true },
    });
  }
}
