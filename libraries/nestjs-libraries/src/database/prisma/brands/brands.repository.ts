// Brand profile: reading and writing a workspace's brand columns, and creating a workspace
// for a user who already has one.
import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface NewBrand {
  id: string;
  userId: string;
  accountId: string | null;
  name: string;
  slug: string;
  color: string;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  profile: Prisma.InputJsonValue;
}

export interface BrandChanges {
  name?: string;
  color?: string;
  avatarUrl?: string;
  timezone?: string;
  locale?: string;
  profile?: Prisma.InputJsonValue;
}

// Reads and writes the brand columns of `Organization` and the creator's membership.
@Injectable()
export class BrandsRepository {
  // Receives the Prisma repositories for `organization` and `userOrganization`.
  constructor(
    private _organization: PrismaRepository<'organization'>,
    private _userOrganization: PrismaRepository<'userOrganization'>
  ) {}

  // The workspace a brand creation is booked against: the user's earliest enabled SUPERADMIN
  // membership in a workspace that is not deleted; null when there is none.
  async findPayerOrganization(userId: string) {
    const member = await this._userOrganization.model.userOrganization.findFirst({
      where: {
        userId,
        role: Role.SUPERADMIN,
        disabled: false,
        organization: { deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    });
    return member?.organizationId ?? null;
  }

  // The names and stored slugs of the account's workspaces that are not deleted.
  accountSlugs(accountId: string) {
    return this._organization.model.organization.findMany({
      where: { accountId, deletedAt: null },
      select: { name: true, slug: true },
    });
  }

  // Writes the workspace with the user as its SUPERADMIN; null when the slug is taken in the account (P2002).
  async create(data: NewBrand) {
    try {
      return await this._organization.model.organization.create({
        data: {
          id: data.id,
          name: data.name,
          slug: data.slug,
          color: data.color,
          avatarUrl: data.avatarUrl,
          timezone: data.timezone,
          locale: data.locale,
          profile: data.profile,
          accountId: data.accountId,
          allowTrial: false,
          isTrailing: false,
          users: { create: { role: Role.SUPERADMIN, userId: data.userId } },
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return null;
      }
      throw err;
    }
  }

  // Hides a workspace whose creation did not complete, in one statement.
  async discard(organizationId: string) {
    await this._organization.model.organization.update({
      where: { id: organizationId },
      data: { deletedAt: new Date() },
    });
  }

  // The workspace that is not deleted, or null.
  findById(organizationId: string) {
    return this._organization.model.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
    });
  }

  // Writes the given brand fields of a workspace and returns the row.
  update(organizationId: string, changes: BrandChanges) {
    return this._organization.model.organization.update({
      where: { id: organizationId },
      data: changes,
    });
  }

  // The user's enabled membership of a workspace that is not deleted, with its role; null when there is none.
  findMembership(userId: string, organizationId: string) {
    return this._userOrganization.model.userOrganization.findFirst({
      where: {
        userId,
        organizationId,
        disabled: false,
        organization: { deletedAt: null },
      },
      select: { role: true, organization: true },
    });
  }

  // The workspaces the user is an enabled member of that are not deleted, oldest first, each with the user's role.
  listForUser(userId: string) {
    return this._organization.model.organization.findMany({
      where: {
        deletedAt: null,
        users: { some: { userId, disabled: false } },
      },
      include: { users: { where: { userId, disabled: false }, select: { role: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
