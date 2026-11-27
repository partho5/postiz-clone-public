// Activity tracker (api.activity-tracker): checks an uploaded batch activity by activity, stores what is valid, and deletes the rows past retention.
import { HttpException, Injectable } from '@nestjs/common';
import { TrackerBatchDto } from '@gitroom/nestjs-libraries/dtos/activity-tracker/tracker.batch.dto';
import {
  CleanActivity,
  cleanActivity,
  cleanEnvelope,
} from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.clean';
import {
  TRACKER_KEEP_LAST_ROWS,
  TRACKER_RETENTION_DAYS,
} from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.config';
import { TrackerRepository } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.repository';

// The key of a session in the database: its device and the session id the app made.
const sessionKeyOf = (deviceId: string, session: string) =>
  `${deviceId}:${session}`;

// Whether an activity was cleaned to a row, as opposed to dropped.
const isClean = (a: CleanActivity | null): a is CleanActivity => a !== null;

const DAY_MS = 24 * 60 * 60 * 1000;
// Devices per page of the retention run. A device with 300 rows or fewer keeps them all, so it matches every run;
// the page cap bounds one run's time and database load, and a run that reaches it starts over from the first device.
const DEVICE_PAGE = 500;
const MAX_DEVICE_PAGES = 20;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;
const MAX_LIMIT = 100;
const DEFAULT_DEVICE_LIMIT = 50;
const DEFAULT_FEED_LIMIT = 100;
const TOP_FEATURES = 30;
const DROP_OFF = 15;

// The whole number in a query string, or `fallback` when it is missing or not a number.
const wholeOr = (raw: string | undefined, fallback: number) => {
  const n =
    raw === undefined || raw.trim() === '' ? NaN : Math.trunc(Number(raw));
  return Number.isFinite(n) ? n : fallback;
};

// The period of the overview in days: 1 to 90, 7 when the query string is not a number.
const clampDays = (raw?: string) =>
  Math.min(MAX_DAYS, Math.max(1, wholeOr(raw, DEFAULT_DAYS)));

// A page size from a query string: 1 to 100, `fallback` when the query string is not a number.
const clampLimit = (raw: string | undefined, fallback: number) =>
  Math.min(MAX_LIMIT, Math.max(1, wholeOr(raw, fallback)));

// A cursor from a query string as a date, or undefined when it is missing or is not a date.
const cursorOf = (raw?: string) => {
  if (!raw) {
    return undefined;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

// The key of a group made of these parts, so the groups of two queries can be matched.
const keyOf = (...parts: unknown[]) => JSON.stringify(parts);

// How many rows each key has. Each row of a groupBy by device is one device, so this counts the devices of each key.
const devicesPerKey = <T>(rows: T[], keyOfRow: (row: T) => string) => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOfRow(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

// Receives the repository that stores devices, sessions and activities.
@Injectable()
export class TrackerService {
  constructor(private _tracker: TrackerRepository) {}

  // Stores a batch: its valid activities, the device and session rollups, and the device's user when the token gave one.
  async store(body: TrackerBatchDto, userId?: string) {
    const now = Date.now();
    const ok = body.activities
      .map((raw) => cleanActivity(raw, now))
      .filter(isClean);
    if (!ok.length) {
      throw new HttpException({ msg: 'No valid activities' }, 400);
    }
    const { deviceId } = body;
    const rows = ok.map(({ session, ...activity }) => ({
      ...activity,
      deviceId,
      userId: userId ?? null,
      sessionKey: sessionKeyOf(deviceId, session),
    }));
    const accepted = await this._tracker.insertActivities(rows);
    // createMany does not say which rows it skipped, and a retried batch is skipped in full. So the rollups add
    // the share of the valid rows that were new: nothing for a full retry, all of them for a first upload.
    const share = (n: number) => Math.round((n * accepted) / ok.length);
    const errors = ok.filter((a) => a.kind === 'error').length;
    await this._tracker.upsertDevice(
      deviceId,
      cleanEnvelope(body.app, body.device),
      new Date(now),
      share(ok.length),
      share(errors)
    );
    const bySession = new Map<string, CleanActivity[]>();
    for (const activity of ok) {
      const list = bySession.get(activity.session) ?? [];
      list.push(activity);
      bySession.set(activity.session, list);
    }
    for (const [session, activities] of bySession) {
      await this.mergeSession(deviceId, session, activities, userId, share);
    }
    if (userId) {
      const email = await this._tracker.userEmail(userId);
      await this._tracker.linkDevice(deviceId, userId, email);
      await this._tracker.claimDevice(deviceId, userId);
    }
    return {
      accepted,
      duplicates: ok.length - accepted,
      dropped: body.activities.length - ok.length,
    };
  }

  // Adds one batch's activities of a session to the session's stored rollup: its time span, first and last screen, entry source and counts.
  private async mergeSession(
    deviceId: string,
    session: string,
    activities: CleanActivity[],
    userId: string | undefined,
    share: (n: number) => number
  ) {
    const bySeq = [...activities].sort((a, b) => a.seq - b.seq);
    const withScreen = bySeq.filter((a) => a.screen !== null);
    const withBuild = bySeq.filter((a) => a.appBuild !== null);
    const entry = bySeq.find(
      (a) => a.name === 'app_open' || a.name === 'app_foreground'
    );
    const startedAt = new Date(
      Math.min(...activities.map((a) => a.startedAt.getTime()))
    );
    const endedAt = new Date(
      Math.max(...activities.map((a) => (a.endedAt ?? a.startedAt).getTime()))
    );
    const existing = await this._tracker.findSession(
      sessionKeyOf(deviceId, session)
    );
    // The schema keeps no last seq, so the last screen moves only when this batch ends at or after the stored end.
    const isLater =
      !existing || endedAt.getTime() >= existing.endedAt.getTime();
    await this._tracker.upsertSession({
      key: sessionKeyOf(deviceId, session),
      deviceId,
      userId: existing?.userId ?? userId ?? null,
      session,
      startedAt:
        existing && existing.startedAt.getTime() < startedAt.getTime()
          ? existing.startedAt
          : startedAt,
      endedAt:
        existing && existing.endedAt.getTime() > endedAt.getTime()
          ? existing.endedAt
          : endedAt,
      entrySource: existing?.entrySource ?? entry?.source ?? null,
      firstScreen: existing?.firstScreen ?? withScreen[0]?.screen ?? null,
      lastScreen:
        (isLater ? withScreen[withScreen.length - 1]?.screen : undefined) ??
        existing?.lastScreen ??
        null,
      activityCount:
        (existing?.activityCount ?? 0) + share(activities.length),
      errorCount:
        (existing?.errorCount ?? 0) +
        share(activities.filter((a) => a.kind === 'error').length),
      appBuild:
        withBuild[withBuild.length - 1]?.appBuild ?? existing?.appBuild ?? null,
    });
  }

  // The super admin's overview of the last `days` days: the totals, the top features, where sessions end, how they start and the top errors.
  async overview(days?: string) {
    const since = new Date(Date.now() - clampDays(days) * DAY_MS);
    const [
      devices,
      activeDevices,
      sessions,
      activities,
      errors,
      topFeatures,
      dropOff,
      entrySources,
      topErrors,
    ] = await Promise.all([
      this._tracker.countDevices(),
      this._tracker.countActiveDevices(since),
      this._tracker.countSessions(since),
      this._tracker.countActivities('activity', since),
      this._tracker.countActivities('error', since),
      this.topFeatures(since),
      this.dropOff(since),
      this.entrySources(since),
      this.topErrors(since),
    ]);
    return {
      since: since.toISOString(),
      devices,
      activeDevices,
      sessions,
      activities,
      errors,
      topFeatures,
      dropOff,
      entrySources,
      topErrors,
    };
  }

  // The features ranked by how many devices used them, then by how many times. The candidates are the 100 most used.
  private async topFeatures(since: Date) {
    const [counts, devices] = await Promise.all([
      this._tracker.featureCounts(since),
      this._tracker.featureDevices(since),
    ]);
    const devicesOf = devicesPerKey(devices, (row) =>
      keyOf(row.name, row.description)
    );
    return counts
      .map((row) => ({
        name: row.name,
        description: row.description,
        devices: devicesOf.get(keyOf(row.name, row.description)) ?? 0,
        count: row._count._all,
      }))
      .sort((a, b) => b.devices - a.devices || b.count - a.count)
      .slice(0, TOP_FEATURES);
  }

  // The screens where sessions ended, most sessions first.
  private async dropOff(since: Date) {
    const rows = await this._tracker.dropOffCounts(since);
    return rows
      .map((row) => ({ screen: row.lastScreen, sessions: row._count._all }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, DROP_OFF);
  }

  // How the sessions started (the source of their first app open or foreground), most sessions first.
  private async entrySources(since: Date) {
    const rows = await this._tracker.entrySourceCounts(since);
    return rows
      .map((row) => ({ source: row.entrySource, sessions: row._count._all }))
      .sort((a, b) => b.sessions - a.sessions);
  }

  // The error groups with how many devices hit each, when each last happened, and the id of its newest error to open the replay at.
  private async topErrors(since: Date) {
    const [groups, devices] = await Promise.all([
      this._tracker.errorGroups(since),
      this._tracker.errorDevices(since),
    ]);
    const devicesOf = devicesPerKey(devices, (row) =>
      keyOf(row.errorType, row.screen)
    );
    return Promise.all(
      groups.map(async (group) => ({
        errorType: group.errorType,
        screen: group.screen,
        count: group._count._all,
        devices: devicesOf.get(keyOf(group.errorType, group.screen)) ?? 0,
        lastAt: group._max.startedAt,
        sampleId: await this._tracker.newestErrorId(
          since,
          group.errorType,
          group.screen
        ),
      }))
    );
  }

  // One page of the devices, newest first, filtered by `q` (email or device id start) and `hasErrors`. `cursor` is the lastSeenAt to continue from.
  async devices(query: {
    q?: string;
    hasErrors?: string;
    cursor?: string;
    limit?: string;
  }) {
    const limit = clampLimit(query.limit, DEFAULT_DEVICE_LIMIT);
    const page = await this._tracker.listDevices({
      q: query.q?.trim() || undefined,
      hasErrors: query.hasErrors === 'true',
      cursor: cursorOf(query.cursor),
      take: limit + 1,
    });
    const items = page.slice(0, limit);
    return {
      items,
      nextCursor:
        page.length > limit
          ? items[items.length - 1].lastSeenAt.toISOString()
          : null,
    };
  }

  // One page of the activity log, newest first: every device's activities, or one device's when `deviceId` is given.
  // `cursor` is the id of the last row of the page before; `at` starts the page at that activity (unknown, or another
  // device's: 404). Each page carries the email, model and OS of its devices, and the device itself when `deviceId` is given (unknown device: 404).
  async feed(query: {
    deviceId?: string;
    cursor?: string;
    at?: string;
    limit?: string;
  }) {
    const device = query.deviceId
      ? await this._tracker.findDevice(query.deviceId)
      : null;
    if (query.deviceId && !device) {
      throw new HttpException({ msg: 'Device not found' }, 404);
    }
    // The log opens at `at` only when that activity exists (and is the device's, on a device's log).
    const opensAt = !query.cursor && !!query.at;
    if (opensAt) {
      const row = await this._tracker.findActivity(query.at as string);
      if (!row || (query.deviceId && row.deviceId !== query.deviceId)) {
        throw new HttpException({ msg: 'Activity not found' }, 404);
      }
    }
    const limit = clampLimit(query.limit, DEFAULT_FEED_LIMIT);
    const page = await this._tracker.listFeed({
      deviceId: query.deviceId,
      cursor: query.cursor || query.at || undefined,
      inclusive: opensAt,
      take: limit + 1,
    });
    const items = page.slice(0, limit);
    const devices = await this._tracker.devicesByIds([
      ...new Set(items.map((row) => row.deviceId)),
    ]);
    return {
      device,
      items,
      devices,
      nextCursor: page.length > limit ? items[items.length - 1].id : null,
    };
  }

  // One activity with every column, for the error detail panel. Unknown id: 404.
  async activity(id: string) {
    const row = await this._tracker.findActivity(id);
    if (!row) {
      throw new HttpException({ msg: 'Activity not found' }, 404);
    }
    return row;
  }

  // The daily retention run: deletes the rows older than TRACKER_RETENTION_DAYS for every device with old rows, keeping each device's newest rows.
  // Pages through the devices by deviceId, DEVICE_PAGE at a time, up to MAX_DEVICE_PAGES pages. Answers how many devices were handled and how many activity rows went.
  async deleteExpired(now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - TRACKER_RETENTION_DAYS * DAY_MS);
    let devices = 0;
    let deleted = 0;
    let after: string | undefined;
    for (let page = 0; page < MAX_DEVICE_PAGES; page++) {
      const deviceIds = await this._tracker.devicesWithRowsBefore({
        cutoff,
        after,
        take: DEVICE_PAGE,
      });
      for (const deviceId of deviceIds) {
        deleted += await this.deleteDeviceExpired(deviceId, cutoff);
      }
      devices += deviceIds.length;
      if (deviceIds.length < DEVICE_PAGE) {
        break;
      }
      after = deviceIds[deviceIds.length - 1];
    }
    return { devices, deleted };
  }

  // Deletes one device's old activities, but never its newest TRACKER_KEEP_LAST_ROWS, then its sessions left with no activities.
  // Answers how many activities went; a device with that many rows or fewer keeps all of them.
  private async deleteDeviceExpired(deviceId: string, cutoff: Date) {
    const keepFrom = await this._tracker.nthNewestStartedAt(
      deviceId,
      TRACKER_KEEP_LAST_ROWS
    );
    if (keepFrom === null) {
      return 0;
    }
    const before = new Date(Math.min(cutoff.getTime(), keepFrom.getTime()));
    const deleted = await this._tracker.deleteActivitiesBefore(
      deviceId,
      before
    );
    await this.deleteOrphanSessions(deviceId, cutoff);
    return deleted;
  }

  // Deletes the device's sessions that ended before the cutoff and have no activities left.
  private async deleteOrphanSessions(deviceId: string, cutoff: Date) {
    const keys = await this._tracker.sessionKeysEndedBefore(deviceId, cutoff);
    if (!keys.length) {
      return;
    }
    const used = new Set(await this._tracker.sessionKeysWithActivities(keys));
    const orphans = keys.filter((key) => !used.has(key));
    if (orphans.length) {
      await this._tracker.deleteSessions(orphans);
    }
  }
}
