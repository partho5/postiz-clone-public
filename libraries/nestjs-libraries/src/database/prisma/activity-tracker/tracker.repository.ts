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

// The features left out of the top features: the screens and the app going to the background or coming back.
const HIDDEN_FEATURES = ['screen', 'app_foreground', 'app_background'];

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

  // How many devices the tracker has stored in all.
  async countDevices() {
    return this._device.model.trackerDevice.count();
  }

  // How many devices were last seen from `since` on.
  async countActiveDevices(since: Date) {
    return this._device.model.trackerDevice.count({
      where: { lastSeenAt: { gte: since } },
    });
  }

  // How many sessions started from `since` on.
  async countSessions(since: Date) {
    return this._session.model.trackerSession.count({
      where: { startedAt: { gte: since } },
    });
  }

  // How many activities of one kind ('activity' or 'error') started from `since` on.
  async countActivities(kind: 'activity' | 'error', since: Date) {
    return this._activity.model.trackerActivity.count({
      where: { kind, startedAt: { gte: since } },
    });
  }

  // The most used features from `since` on (name and description): the 100 with the most activities.
  async featureCounts(since: Date) {
    return this._activity.model.trackerActivity.groupBy({
      by: ['name', 'description'],
      where: this.featureWhere(since),
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
      take: 100,
    });
  }

  // One row per feature and device from `since` on, so the rows of one feature are the devices that used it.
  // Capped at 5000 rows and not ordered: past that, the device counts are approximate.
  async featureDevices(since: Date) {
    return this._activity.model.trackerActivity.groupBy({
      by: ['name', 'description', 'deviceId'],
      where: this.featureWhere(since),
      _count: { _all: true },
      take: 5000,
    });
  }

  // The activities that count as features from `since` on: every kind of activity but the screen and app background/foreground ones.
  private featureWhere(since: Date) {
    return {
      kind: 'activity',
      startedAt: { gte: since },
      name: { notIn: HIDDEN_FEATURES },
    };
  }

  // The sessions from `since` on, counted by the screen they ended on.
  async dropOffCounts(since: Date) {
    return this._session.model.trackerSession.groupBy({
      by: ['lastScreen'],
      where: { startedAt: { gte: since } },
      _count: { _all: true },
    });
  }

  // The sessions from `since` on, counted by how they started.
  async entrySourceCounts(since: Date) {
    return this._session.model.trackerSession.groupBy({
      by: ['entrySource'],
      where: { startedAt: { gte: since } },
      _count: { _all: true },
    });
  }

  // The error groups (type and screen) from `since` on: the 20 with the most errors, with the newest time of each.
  async errorGroups(since: Date) {
    return this._activity.model.trackerActivity.groupBy({
      by: ['errorType', 'screen'],
      where: { kind: 'error', startedAt: { gte: since } },
      _count: { _all: true },
      _max: { startedAt: true },
      orderBy: { _count: { id: 'desc' } },
      take: 20,
    });
  }

  // One row per error group and device from `since` on. Capped at 5000 rows and not ordered, like featureDevices.
  async errorDevices(since: Date) {
    return this._activity.model.trackerActivity.groupBy({
      by: ['errorType', 'screen', 'deviceId'],
      where: { kind: 'error', startedAt: { gte: since } },
      _count: { _all: true },
      take: 5000,
    });
  }

  // The id of the newest error of one group from `since` on, which the replay opens at; null when there is none.
  async newestErrorId(
    since: Date,
    errorType: string | null,
    screen: string | null
  ) {
    const row = await this._activity.model.trackerActivity.findFirst({
      where: { kind: 'error', startedAt: { gte: since }, errorType, screen },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  // The devices, newest first. `q` matches the email (contains) or the start of the device id, `hasErrors` keeps the
  // devices with errors, and `cursor` keeps the ones last seen before it.
  async listDevices(params: {
    q?: string;
    hasErrors: boolean;
    cursor?: Date;
    take: number;
  }) {
    const where: Prisma.TrackerDeviceWhereInput = {
      ...(params.q
        ? {
            OR: [
              { email: { contains: params.q, mode: 'insensitive' } },
              { deviceId: { startsWith: params.q } },
            ],
          }
        : {}),
      ...(params.hasErrors ? { errorCount: { gt: 0 } } : {}),
      ...(params.cursor ? { lastSeenAt: { lt: params.cursor } } : {}),
    };
    return this._device.model.trackerDevice.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
      take: params.take,
      select: {
        deviceId: true,
        email: true,
        userId: true,
        model: true,
        os: true,
        appVersion: true,
        firstSeenAt: true,
        lastSeenAt: true,
        activityCount: true,
        errorCount: true,
      },
    });
  }

  // The device with this id, or null.
  async findDevice(deviceId: string) {
    return this._device.model.trackerDevice.findUnique({
      where: { deviceId },
    });
  }

  // One device's sessions, newest first; `cursor` keeps the ones that started before it.
  async listSessions(params: {
    deviceId: string;
    cursor?: Date;
    take: number;
  }) {
    return this._session.model.trackerSession.findMany({
      where: {
        deviceId: params.deviceId,
        ...(params.cursor ? { startedAt: { lt: params.cursor } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: params.take,
    });
  }

  // The activities of one session in replay order. The error stack and causes are left out: the detail call loads them.
  async listTimeline(sessionKey: string, take: number) {
    return this._activity.model.trackerActivity.findMany({
      where: { sessionKey },
      orderBy: [{ startedAt: 'asc' }, { seq: 'asc' }],
      take,
      select: {
        id: true,
        deviceId: true,
        userId: true,
        sessionKey: true,
        seq: true,
        kind: true,
        name: true,
        description: true,
        startedAt: true,
        endedAt: true,
        durationMs: true,
        tz: true,
        appBuild: true,
        screen: true,
        source: true,
        meta: true,
        errorType: true,
        errorMessage: true,
        errorThread: true,
        fatal: true,
        lastActivity: true,
        receivedAt: true,
      },
    });
  }

  // One activity with every column, by its id; null when there is none.
  async findActivity(id: string) {
    return this._activity.model.trackerActivity.findUnique({ where: { id } });
  }
}
