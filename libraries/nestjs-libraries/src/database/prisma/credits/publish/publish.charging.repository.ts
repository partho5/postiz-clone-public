// Publish charging: the posts a publish charge is for, and the
// publish reservations of an account.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';

const postFields = {
  id: true,
  organizationId: true,
  integrationId: true,
  group: true,
  publishDate: true,
  parentPostId: true,
  state: true,
  deletedAt: true,
} as const;

@Injectable()
export class PublishChargingRepository {
  constructor(
    private readonly _scope: MoneyScope,
    private readonly _post: PrismaRepository<'post'>
  ) {}

  // Posts of a workspace by id, deleted ones included.
  posts(organizationId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: { organizationId, id: { in: ids } },
      select: postFields,
    });
  }

  // One post by id in any workspace, deleted or not; null when it never existed.
  post(id: string) {
    return this._post.model.post.findUnique({
      where: { id },
      select: postFields,
    });
  }

  // Every post of these groups in a workspace, deleted ones included.
  groupPosts(organizationId: string, groups: string[]) {
    return this._post.model.post.findMany({
      where: { organizationId, group: { in: groups } },
      select: { id: true, group: true },
    });
  }

  // Live first rows (not deleted, not a comment) of a group in a workspace.
  firstRows(organizationId: string, group: string) {
    return this._post.model.post.findMany({
      where: { organizationId, group, deletedAt: null, parentPostId: null },
      select: postFields,
    });
  }

  // Ledger rows of the workspace's account under these keys.
  async ledgers(organizationId: string, keys: string[]) {
    const accountId = await this._scope.accountIdFor(organizationId);
    return this._scope.run(accountId, (tx) =>
      tx.creditLedger.findMany({
        where: { accountId, idempotencyKey: { in: keys } },
      })
    );
  }

  // Reserved ledger rows of the workspace whose key starts with one of the prefixes.
  async reserved(organizationId: string, actionKey: string, prefixes: string[]) {
    const accountId = await this._scope.accountIdFor(organizationId);
    return this._scope.run(accountId, (tx) =>
      tx.creditLedger.findMany({
        where: {
          accountId,
          organizationId,
          actionKey,
          status: 'RESERVED',
          OR: prefixes.map((prefix) => ({
            idempotencyKey: { startsWith: prefix },
          })),
        },
      })
    );
  }
}
