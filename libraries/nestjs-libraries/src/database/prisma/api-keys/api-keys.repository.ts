// Scoped API keys: reading and writing the `ApiKey` rows.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface NewApiKey {
  organizationId: string;
  name: string;
  prefix: string;
  secretHash: string;
  scopes: string[];
  createdBy: string;
}

// Reads and writes the `ApiKey` rows.
@Injectable()
export class ApiKeysRepository {
  // Receives the Prisma repository for `apiKey`.
  constructor(private _apiKey: PrismaRepository<'apiKey'>) {}

  // Stores a new key; null when the prefix is taken (P2002).
  async create(data: NewApiKey) {
    try {
      return await this._apiKey.model.apiKey.create({ data });
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

  // Every key of the workspace, revoked ones included, newest first.
  list(organizationId: string) {
    return this._apiKey.model.apiKey.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // The key with this prefix and whether its workspace is deleted, or null.
  findByPrefix(prefix: string) {
    return this._apiKey.model.apiKey.findUnique({
      where: { prefix },
      include: { organization: { select: { deletedAt: true } } },
    });
  }

  // The keys whose stored hash is this one, with whether their workspace is deleted.
  findBySecretHash(secretHash: string) {
    return this._apiKey.model.apiKey.findMany({
      where: { secretHash },
      include: { organization: { select: { deletedAt: true } } },
    });
  }

  // Revokes the workspace's key unless it is already revoked; false when the workspace has no such live key.
  async revoke(organizationId: string, id: string, now: Date) {
    const { count } = await this._apiKey.model.apiKey.updateMany({
      where: { id, organizationId, revokedAt: null },
      data: { revokedAt: now },
    });
    return count > 0;
  }

  // Whether the workspace has a key with this id, revoked or not.
  async exists(organizationId: string, id: string) {
    const count = await this._apiKey.model.apiKey.count({
      where: { id, organizationId },
    });
    return count > 0;
  }

  // Records a use, unless one was recorded after `staleBefore`.
  async touch(id: string, now: Date, staleBefore: Date) {
    await this._apiKey.model.apiKey.updateMany({
      where: {
        id,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }],
      },
      data: { lastUsedAt: now },
    });
  }
}
