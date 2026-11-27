// Paid features (api.entitlements): reads the plan of an account. It never writes.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class EntitlementsRepository {
  // Receives the Prisma repositories for `account` and `organization`.
  constructor(
    private readonly _account: PrismaRepository<'account'>,
    private readonly _organization: PrismaRepository<'organization'>
  ) {}

  // The plan of the account this user owns; null when they have none yet.
  async ownPlan(userId: string) {
    const account = await this._account.model.account.findUnique({
      where: { ownerId: userId },
      select: { planKey: true },
    });
    return account?.planKey ?? null;
  }

  // The plan of the account that owns this workspace; null when the workspace is unknown or has no
  // account yet.
  async workspacePlan(organizationId: string) {
    const organization = await this._organization.model.organization.findUnique({
      where: { id: organizationId },
      select: { account: { select: { planKey: true } } },
    });
    return organization?.account?.planKey ?? null;
  }
}
