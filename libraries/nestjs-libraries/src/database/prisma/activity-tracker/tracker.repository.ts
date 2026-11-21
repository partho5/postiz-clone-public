// Activity tracker (api.activity-tracker): reads and writes the device, session and activity rows.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  CleanActivity,
  CleanEnvelope,
} from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.clean';

// One activity row to store: the cleaned activity with its device, its user and its session key.
export type NewTrackerActivity = Omit<CleanActivity, 'session'> & {
  deviceId: string;
  userId: string | null;
  sessionKey: string;
};

// One session rollup row as it is stored.
export type TrackerSessionRow = {
  key: string;
  deviceId: string;
  userId: string | null;
  session: string;
  startedAt: Date;
  endedAt: Date;
  entrySource: string | null;
  firstScreen: string | null;
  lastScreen: string | null;
  activityCount: number;
  errorCount: number;
  appBuild: number | null;
};

// Reads and writes the tracker tables.
@Injectable()
export class TrackerRepository {
  // Receives the Prisma repositories for the device, session and activity tables and for the user.
  constructor(
    private _device: PrismaRepository<'trackerDevice'>,
    private _session: PrismaRepository<'trackerSession'>,
    private _activity: PrismaRepository<'trackerActivity'>,
    private _user: PrismaRepository<'user'>
  ) {}

  // Stores the activity rows in one insert. An id that is already stored is skipped; returns how many were new.
  async insertActivities(rows: NewTrackerActivity[]) {
    const { count } = await this._activity.model.trackerActivity.createMany({
      data: rows.map((row) => ({
        ...row,
        meta: row.meta ?? Prisma.DbNull,
        errorCauses: row.errorCauses ?? Prisma.DbNull,
      })),
      skipDuplicates: true,
    });
    return count;
  }

  // Creates the device with its first counts, or refreshes its last-seen time and details and adds to its counts.
  async upsertDevice(
    deviceId: string,
    envelope: CleanEnvelope,
    now: Date,
    addActivities: number,
    addErrors: number
  ) {
    // A detail the batch did not send is undefined, so Prisma keeps the stored value on update.
    const details = {
      appVersion: envelope.appVersion ?? undefined,
      appBuild: envelope.appBuild ?? undefined,
      os: envelope.os ?? undefined,
      sdk: envelope.sdk ?? undefined,
      manufacturer: envelope.manufacturer ?? undefined,
      model: envelope.model ?? undefined,
      locale: envelope.locale ?? undefined,
    };
    await this._device.model.trackerDevice.upsert({
      where: { deviceId },
      create: {
        ...details,
        deviceId,
        firstSeenAt: now,
        lastSeenAt: now,
        activityCount: addActivities,
        errorCount: addErrors,
      },
      update: {
        ...details,
        lastSeenAt: now,
        activityCount: { increment: addActivities },
        errorCount: { increment: addErrors },
      },
    });
  }

  // The stored rollup of one session, or null when the session is new.
  async findSession(key: string) {
    return this._session.model.trackerSession.findUnique({ where: { key } });
  }

  // Creates or replaces the rollup of one session.
  async upsertSession(row: TrackerSessionRow) {
    const { key, ...data } = row;
    await this._session.model.trackerSession.upsert({
      where: { key },
      create: row,
      update: data,
    });
  }

  // Sets the user of a device and the email copied from that user.
  async linkDevice(deviceId: string, userId: string, email: string | null) {
    await this._device.model.trackerDevice.update({
      where: { deviceId },
      data: { userId, email },
    });
  }

  // Gives the user the device's activities and sessions that have no user yet; rows that have one stay as they are.
  async claimDevice(deviceId: string, userId: string) {
    await this._activity.model.trackerActivity.updateMany({
      where: { deviceId, userId: null },
      data: { userId },
    });
    await this._session.model.trackerSession.updateMany({
      where: { deviceId, userId: null },
      data: { userId },
    });
  }

  // The email of a user, or null when there is no such user.
  async userEmail(userId: string) {
    const user = await this._user.model.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email ?? null;
  }
}
