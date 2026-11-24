// Token auth: storing signed-in devices and the hashes of their refresh tokens.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface NewDeviceSession {
  id: string;
  userId: string;
  name: string | null;
  userAgent: string | null;
  ip: string | null;
  refreshHash: string;
  refreshExpiresAt: Date;
  now: Date;
}

export interface RotatedRefresh {
  refreshHash: string;
  refreshExpiresAt: Date;
  rotatedAt: Date;
  userAgent?: string;
  ip?: string;
}

// Reads and writes the `DeviceSession` rows.
@Injectable()
export class DeviceSessionsRepository {
  // Receives the Prisma repository for `deviceSession`.
  constructor(private _deviceSession: PrismaRepository<'deviceSession'>) {}

  // Stores a new session whose current refresh token has the given hash.
  create(session: NewDeviceSession) {
    const { now, ...data } = session;
    return this._deviceSession.model.deviceSession.create({
      data: { ...data, createdAt: now, lastSeenAt: now },
    });
  }

  // The session with this id, revoked or not, or null.
  findById(id: string) {
    return this._deviceSession.model.deviceSession.findUnique({
      where: { id },
    });
  }

  // Makes the presented hash the previous one and the new hash the current one; false when the
  // session no longer holds the presented hash as current, is revoked or expired, or its user is gone.
  async rotate(
    id: string,
    presentedHash: string,
    next: RotatedRefresh
  ): Promise<boolean> {
    const { count } = await this._deviceSession.model.deviceSession.updateMany({
      where: {
        id,
        refreshHash: presentedHash,
        revokedAt: null,
        refreshExpiresAt: { gt: next.rotatedAt },
        user: { deletedAt: null, activated: true },
      },
      data: {
        previousRefreshHash: presentedHash,
        refreshHash: next.refreshHash,
        refreshExpiresAt: next.refreshExpiresAt,
        rotatedAt: next.rotatedAt,
        lastSeenAt: next.rotatedAt,
        ...(next.userAgent ? { userAgent: next.userAgent } : {}),
        ...(next.ip ? { ip: next.ip } : {}),
      },
    });
    return count > 0;
  }

  // Revokes a session that is still live, whoever owns it; false when it was already revoked or unknown.
  async revoke(id: string, now: Date): Promise<boolean> {
    const { count } = await this._deviceSession.model.deviceSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
    return count > 0;
  }

  // Revokes a live session only when it belongs to the user; false when it does not.
  async revokeForUser(
    id: string,
    userId: string,
    now: Date
  ): Promise<boolean> {
    const { count } = await this._deviceSession.model.deviceSession.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return count > 0;
  }

  // The user's sessions that are not revoked, newest activity first.
  listLive(userId: string) {
    return this._deviceSession.model.deviceSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  // Records activity on a session unless it was recorded after `staleBefore`.
  async touch(id: string, now: Date, staleBefore: Date) {
    await this._deviceSession.model.deviceSession.updateMany({
      where: { id, lastSeenAt: { lt: staleBefore } },
      data: { lastSeenAt: now },
    });
  }
}
