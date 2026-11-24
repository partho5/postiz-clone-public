// Mobile activity log (api.activity-log): storing and reading the batches the app uploads.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// One batch to store; `log` is the already sanitised events.
export interface NewActivityLog {
  batchId: string;
  userId: string | null;
  deviceId: string;
  appVersion: string | null;
  device: string | null;
  eventCount: number;
  firstEventAt: Date;
  lastEventAt: Date;
  log: unknown;
}

// Which rows a timeline reads: a user's (the claimed rows included) or one device's, inside a time range.
export interface ActivityLogQuery {
  userId?: string;
  deviceId?: string;
  from: Date;
  to: Date;
}

// Reads and writes the `ActivityLog` rows.
@Injectable()
export class ActivityLogRepository {
  // Receives the Prisma repositories for `activityLog` and `user`.
  constructor(
    private _activityLog: PrismaRepository<'activityLog'>,
    private _user: PrismaRepository<'user'>
  ) {}

  // Stores a batch; null when its `batchId` is already stored (P2002), i.e. a retry.
  async create(data: NewActivityLog) {
    try {
      return await this._activityLog.model.activityLog.create({
        data: { ...data, log: data.log as Prisma.InputJsonValue },
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

  // Gives the user the device's anonymous rows; rows that already have a user stay as they are.
  async claimDevice(deviceId: string, userId: string) {
    const { count } = await this._activityLog.model.activityLog.updateMany({
      where: { deviceId, userId: null },
      data: { userId },
    });
    return count;
  }

  // The rows that overlap the range, oldest first, for a timeline.
  list(query: ActivityLogQuery) {
    return this._activityLog.model.activityLog.findMany({
      where: {
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.deviceId ? { deviceId: query.deviceId } : {}),
        firstEventAt: { lte: query.to },
        lastEventAt: { gte: query.from },
      },
      orderBy: { firstEventAt: 'asc' },
    });
  }

  // The user with this id, or whose email is this (any case), for a timeline's header; null when none.
  findUser(by: { id: string } | { email: string }) {
    return this._user.model.user.findFirst({
      where: {
        deletedAt: null,
        ...('id' in by
          ? { id: by.id }
          : { email: { equals: by.email, mode: 'insensitive' as const } }),
      },
      select: { id: true, email: true },
    });
  }

  // Who was active since a date, newest first: one group per user and device (a phone nobody signed in on has
  // a null user), with the events, first and last time, plus the emails of the users. `q` narrows it to the
  // users whose id or email contains it (email any case) and the device with exactly that id.
  async listActors(query: { since: Date; q?: string; limit: number }) {
    let where: Prisma.ActivityLogWhereInput = {
      lastEventAt: { gte: query.since },
    };
    if (query.q) {
      const found = await this._user.model.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            { id: query.q },
            { email: { contains: query.q, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: 50,
      });
      where = {
        ...where,
        OR: [
          { userId: { in: found.map((user) => user.id) } },
          { deviceId: query.q },
        ],
      };
    }
    const groups = await this._activityLog.model.activityLog.groupBy({
      by: ['userId', 'deviceId'],
      where,
      _sum: { eventCount: true },
      _min: { firstEventAt: true },
      _max: { lastEventAt: true },
      orderBy: { _max: { lastEventAt: 'desc' } },
      take: query.limit,
    });
    const ids = [
      ...new Set(
        groups.map((group) => group.userId).filter((id): id is string => !!id)
      ),
    ];
    const users = ids.length
      ? await this._user.model.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, email: true },
        })
      : [];
    return {
      groups,
      emails: new Map(users.map((user) => [user.id, user.email] as const)),
    };
  }

  // How many distinct devices the rows of a user came from.
  async deviceCount(userId: string) {
    const devices = await this._activityLog.model.activityLog.groupBy({
      by: ['deviceId'],
      where: { userId },
    });
    return devices.length;
  }

  // Deletes the rows received before the cutoff; answers how many went.
  async deleteReceivedBefore(cutoff: Date) {
    const { count } = await this._activityLog.model.activityLog.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    return count;
  }
}
