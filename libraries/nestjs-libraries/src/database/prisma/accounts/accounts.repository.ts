import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Prisma, Role } from '@prisma/client';

@Injectable()
export class AccountsRepository {
  constructor(
    private readonly _account: PrismaRepository<'account'>,
    private readonly _organization: PrismaRepository<'organization'>,
    private readonly _userOrganization: PrismaRepository<'userOrganization'>
  ) {}

  getAccountById(id: string) {
    return this._account.model.account.findUnique({
      where: { id },
    });
  }

  getAccountByOwner(ownerId: string) {
    return this._account.model.account.findUnique({
      where: { ownerId },
    });
  }

  getOrganizationAccountId(organizationId: string) {
    return this._organization.model.organization.findUnique({
      where: { id: organizationId },
      select: { accountId: true },
    });
  }

  // The owner of a workspace created before accounts existed: the earliest
  // super admin, then the earliest admin.
  async getOrganizationOwner(organizationId: string) {
    for (const role of [Role.SUPERADMIN, Role.ADMIN]) {
      const member = await this._userOrganization.model.userOrganization.findFirst({
        where: { organizationId, role, disabled: false },
        orderBy: { createdAt: 'asc' },
        select: { userId: true },
      });
      if (member) {
        return member.userId;
      }
    }
    return null;
  }

  // Prisma's upsert reads then inserts, so two first-time callers can both
  // insert. The unique ownerId turns the loser into a read of the winner.
  async upsertAccountForOwner(ownerId: string) {
    try {
      return await this._account.model.account.upsert({
        where: { ownerId },
        create: { ownerId },
        update: {},
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this._account.model.account.findUniqueOrThrow({
          where: { ownerId },
        });
      }
      throw err;
    }
  }

  // Only attaches when the workspace has no account yet, so two concurrent
  // callers can never move a workspace between accounts.
  attachOrganization(organizationId: string, accountId: string) {
    return this._organization.model.organization.updateMany({
      where: { id: organizationId, accountId: null },
      data: { accountId },
    });
  }

  // The oldest workspace this user is an active member of whose account they own; null when there is none.
  getOwnedOrganization(userId: string) {
    return this._organization.model.organization.findFirst({
      where: {
        deletedAt: null,
        account: { ownerId: userId },
        users: { some: { userId, disabled: false } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  }

  getAccountOrganizations(accountId: string) {
    return this._organization.model.organization.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true, name: true },
    });
  }
}
