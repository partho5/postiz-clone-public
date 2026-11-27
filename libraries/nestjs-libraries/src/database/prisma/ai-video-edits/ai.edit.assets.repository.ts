// AI video editing (ai.video-editing): the shared cache of icon and mp4 clip files. A row names one provider file that
// is already in R2; it belongs to no workspace (the file is the same for everyone), so these reads and writes carry
// no organizationId.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// A hit marks the file as used at most this often, so reading a file does not write a row every time.
const TOUCH_AFTER_MS = 5 * 60 * 1000;

// A cached file as the resolver reads it.
export interface AiEditAssetRow {
  id: string;
  provider: string;
  providerId: string;
  kind: string;
  objectKey: string;
  nativeDurationMs: number | null;
  width: number | null;
  height: number | null;
  name: string | null;
  slug: string | null;
  price: number | null;
  query: string | null;
  colorCodes: Prisma.JsonValue | null;
  meta: Prisma.JsonValue | null;
  source: string | null;
  lastUsedAt: Date | null;
}

// What is stored for a downloaded file.
export interface NewAiEditAsset {
  provider: string;
  providerId: string;
  kind: string;
  objectKey: string;
  nativeDurationMs?: number;
  width?: number;
  height?: number;
  name?: string;
  slug?: string;
  price?: number;
  query?: string;
  colorCodes?: Prisma.InputJsonValue;
  meta?: Prisma.InputJsonValue;
  source?: string;
  lastUsedAt?: Date;
}

@Injectable()
export class AiEditAssetsRepository {
  // Receives the Prisma repository of the cached files.
  constructor(private _asset: PrismaRepository<'aiEditAsset'>) {}

  // The cached file of a provider id, marked as used now when it was not lately; null when it was never downloaded.
  async find(provider: string, providerId: string): Promise<AiEditAssetRow | null> {
    const row = await this._asset.model.aiEditAsset.findUnique({
      where: { provider_providerId: { provider, providerId } },
    });
    if (!row || (row.lastUsedAt && Date.now() - row.lastUsedAt.getTime() < TOUCH_AFTER_MS)) {
      return row;
    }
    return this._asset.model.aiEditAsset.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });
  }

  // Stores a downloaded file (used now); when another job stored the same file first (P2002) that row is the answer.
  async create(data: NewAiEditAsset): Promise<AiEditAssetRow> {
    try {
      return await this._asset.model.aiEditAsset.create({ data: { lastUsedAt: new Date(), ...data } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const found = await this.find(data.provider, data.providerId);
        if (found) return found;
      }
      throw err;
    }
  }

  // The files not used since `cutoff` (a row never used counts by its creation), at most `take` of them.
  async findUnusedSince(cutoff: Date, take: number): Promise<AiEditAssetRow[]> {
    return this._asset.model.aiEditAsset.findMany({
      where: {
        OR: [{ lastUsedAt: { lt: cutoff } }, { lastUsedAt: null, createdAt: { lt: cutoff } }],
      },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  // Removes the rows of these ids (their objects are already gone from R2); returns how many went.
  async deleteByIds(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const { count } = await this._asset.model.aiEditAsset.deleteMany({ where: { id: { in: ids } } });
    return count;
  }
}
