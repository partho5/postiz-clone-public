// Free monthly grant: the account and channel reads that decide who is eligible.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class FreeGrantRepository {
  constructor(
    private readonly _account: PrismaRepository<'account'>,
    private readonly _integration: PrismaRepository<'integration'>
  ) {}

  // The plan of one account, or null when it does not exist.
  account(accountId: string) {
    return this._account.model.account.findUnique({
      where: { id: accountId },
      select: { id: true, planKey: true },
    });
  }

  // Whether any workspace of the account has ever had a channel, deleted or not.
  async hasEverHadChannel(accountId: string) {
    const channel = await this._integration.model.integration.findFirst({
      where: { organization: { accountId } },
      select: { id: true },
    });
    return !!channel;
  }

  // Whether the workspace already has this channel, deleted or not.
  async hasChannel(organizationId: string, internalId: string) {
    const channel = await this._integration.model.integration.findUnique({
      where: { organizationId_internalId: { organizationId, internalId } },
      select: { id: true },
    });
    return !!channel;
  }

  // Ids of free-plan accounts that have ever had a channel, after `cursor`, in id order.
  async eligibleAccountIds(cursor: string | undefined, take: number) {
    const accounts = await this._account.model.account.findMany({
      where: {
        planKey: 'FREE',
        ...(cursor ? { id: { gt: cursor } } : {}),
        organizations: { some: { Integration: { some: {} } } },
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true },
    });
    return accounts.map((account) => account.id);
  }
}
