// Mobile activity log (api.activity-log): checks an uploaded batch event by event and stores what is valid.
import { HttpException, Injectable } from '@nestjs/common';
import { ActivityLogRepository } from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.log.repository';
import {
  localTime,
  renderTimeline,
} from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.timeline';
import { ActivityBatchDto } from '@gitroom/nestjs-libraries/dtos/activity-log/activity.batch.dto';

// One user action as the app sends it: `t` epoch ms UTC, `tz` minutes east of UTC, `s` session id,
// `a` action name, `m` optional flat details.
export interface ActivityEvent {
  t: number;
  tz: number;
  s: string;
  a: string;
  m?: Record<string, string | number | boolean>;
}

const ACTION = /^[a-z0-9_]{1,48}$/;
const META_KEY = /^[a-z0-9_]{1,24}$/;
const SESSION = /^[A-Za-z0-9_-]{1,16}$/;
// Defence in depth: a key that sounds like a credential or an address is never stored, whatever the app sends.
const SENSITIVE_KEY = /email|token|password|authorization|secret/i;

export const META_MAX_KEYS = 10;
export const META_MAX_STRING = 64;
export const META_MAX_BYTES = 512;

// Events older than this are a wrong device clock, not history; events more than two days ahead too.
const EARLIEST_EVENT_MS = Date.UTC(2020, 0, 1);
const FUTURE_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

// The details of an event cut down to what the contract allows: at most 10 keys, plain keys, scalar
// values, strings up to 64 characters, 512 bytes in all (more than that and the details are dropped).
// Undefined when nothing is left.
export function cleanMeta(raw: unknown): ActivityEvent['m'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const kept: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= META_MAX_KEYS) {
      break;
    }
    if (!META_KEY.test(key) || SENSITIVE_KEY.test(key)) {
      continue;
    }
    const ok =
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= META_MAX_STRING);
    if (ok) {
      kept[key] = value as string | number | boolean;
      count++;
    }
  }
  if (!count || Buffer.byteLength(JSON.stringify(kept)) > META_MAX_BYTES) {
    return undefined;
  }
  return kept;
}

// One event checked against the contract, or null when it is unusable (no valid time or action name).
// A bad `tz` becomes 0 and a bad session id an empty one, since the action itself is still worth keeping.
export function cleanEvent(raw: unknown, now: number): ActivityEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const { t, tz, s, a, m } = raw as Record<string, unknown>;
  if (
    typeof t !== 'number' ||
    !Number.isFinite(t) ||
    t < EARLIEST_EVENT_MS ||
    t > now + FUTURE_SLACK_MS
  ) {
    return null;
  }
  if (typeof a !== 'string' || !ACTION.test(a)) {
    return null;
  }
  const event: ActivityEvent = {
    t: Math.trunc(t),
    tz:
      typeof tz === 'number' && Number.isInteger(tz) && Math.abs(tz) <= 840
        ? tz
        : 0,
    s: typeof s === 'string' && SESSION.test(s) ? s : '',
    a,
  };
  const meta = cleanMeta(m);
  if (meta) {
    event.m = meta;
  }
  return event;
}

// A short text field of the envelope, trimmed and cut, or undefined.
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

// The events a stored row holds; none when its JSON is not an array.
const eventsOf = (log: unknown) =>
  Array.isArray(log) ? (log as ActivityEvent[]) : [];

// `1.0 (4)` from `{ version, build }`.
function appVersionOf(app?: Record<string, unknown>) {
  const version = text(app?.version, 24);
  if (!version) {
    return null;
  }
  const build = app?.build;
  return typeof build === 'number' && Number.isFinite(build)
    ? `${version} (${Math.trunc(build)})`
    : version;
}

// `Android 14 / SDK 34 · Pixel 7` from `{ os, model }`.
function deviceOf(device?: Record<string, unknown>) {
  const parts = [text(device?.os, 32), text(device?.model, 64)].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

// What a timeline is asked for: exactly one identity, and a time range (default the last 7 days).
export class ActivityTimelineQuery {
  userId?: string;
  email?: string;
  deviceId?: string;
  from?: string;
  to?: string;
  limit?: string;
  // `json` answers data for the admin page; anything else answers text
  format?: string;
}

// What the admin list of active users and phones is asked for: a search text (email, user id or device id),
// how many days back (default 7, at most 90) and how many rows at most.
export class ActivityUsersQuery {
  q?: string;
  days?: string;
  limit?: string;
}

// One row of that list: a user (all their devices together) or a phone nobody signed in on.
export interface ActivityActor {
  userId: string | null;
  email: string | null;
  // set for a phone nobody signed in on; the timeline of that row is read by this id
  deviceId: string | null;
  devices: number;
  events: number;
  firstEventAt: string;
  lastEventAt: string;
}

// How long a batch is kept, counted from the day it was received.
export const ACTIVITY_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export const TIMELINE_DEFAULT_DAYS = 7;
export const TIMELINE_DEFAULT_LIMIT = 2000;
export const TIMELINE_MAX_LIMIT = 5000;

export const USERS_DEFAULT_DAYS = 7;
export const USERS_MAX_DAYS = 90;
export const USERS_DEFAULT_LIMIT = 100;
export const USERS_MAX_LIMIT = 500;

// A query-string number held between `min` and `max`, or `fallback` when it is missing or not a number.
const clampedInt = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
) => Math.min(Math.max(parseInt(value ?? '', 10) || fallback, min), max);

// A query-string date, or undefined when it is missing; 400 when it is not a date.
function dateOf(value?: string) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpException({ msg: `Not a date: ${value}` }, 400);
  }
  return date;
}

@Injectable()
export class ActivityLogService {
  // Receives the repository that stores the batches.
  constructor(private _activityLogRepository: ActivityLogRepository) {}

  // Stores the valid events of a batch (400 when none is valid). With a `userId` the batch is the user's
  // and the device's earlier anonymous rows become theirs too. A batch already stored is not stored again.
  async store(batch: ActivityBatchDto, userId?: string, now = new Date()) {
    const events = batch.events
      .map((event) => cleanEvent(event, now.getTime()))
      .filter((event): event is ActivityEvent => event !== null)
      .sort((a, b) => a.t - b.t);
    if (!events.length) {
      throw new HttpException({ msg: 'No valid events' }, 400);
    }
    await this._activityLogRepository.create({
      batchId: batch.batchId,
      userId: userId ?? null,
      deviceId: batch.deviceId,
      appVersion: appVersionOf(batch.app),
      device: deviceOf(batch.device),
      eventCount: events.length,
      firstEventAt: new Date(events[0].t),
      lastEventAt: new Date(events[events.length - 1].t),
      log: events,
    });
    if (userId) {
      await this._activityLogRepository.claimDevice(batch.deviceId, userId);
    }
  }

  // Deletes the batches received more than 90 days ago; answers how many went.
  async deleteExpired(now = new Date()) {
    const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * DAY_MS);
    return {
      deleted: await this._activityLogRepository.deleteReceivedBefore(cutoff),
    };
  }

  // Reads what a timeline shows: the user (or device), how many devices, the range and the events in time
  // order, cut at the limit. Throws 400 for a bad query and 404 for an unknown user.
  private async readTimeline(query: ActivityTimelineQuery, now: Date) {
    const identities = [query.userId, query.email, query.deviceId].filter(
      Boolean
    );
    if (identities.length !== 1) {
      throw new HttpException(
        { msg: 'Give exactly one of userId, email or deviceId' },
        400
      );
    }
    const to = dateOf(query.to) ?? now;
    const from =
      dateOf(query.from) ??
      new Date(to.getTime() - TIMELINE_DEFAULT_DAYS * DAY_MS);
    const limit = clampedInt(
      query.limit,
      TIMELINE_DEFAULT_LIMIT,
      1,
      TIMELINE_MAX_LIMIT
    );

    const user =
      query.userId || query.email
        ? await this._activityLogRepository.findUser(
            query.userId ? { id: query.userId } : { email: query.email! }
          )
        : null;
    if ((query.userId || query.email) && !user) {
      throw new HttpException({ msg: 'User not found' }, 404);
    }

    const rows = await this._activityLogRepository.list({
      userId: user?.id,
      deviceId: query.deviceId,
      from,
      to,
    });
    const all = rows
      .flatMap((row) => eventsOf(row.log))
      .filter((event) => event.t >= from.getTime() && event.t <= to.getTime())
      .sort((a, b) => a.t - b.t);
    const events = all.slice(0, limit);

    return {
      user,
      deviceId: query.deviceId,
      devices: user ? await this._activityLogRepository.deviceCount(user.id) : 1,
      from,
      to,
      events,
      truncated: all.length > events.length,
    };
  }

  // The text timeline of one user (the device rows they claimed included) or one device: each event on a
  // line `time | action | details` in the device's own time, oldest first, a marker where the session changes.
  async timeline(query: ActivityTimelineQuery, now = new Date()) {
    const found = await this.readTimeline(query, now);
    const header = [
      found.user
        ? `User ${found.user.id} ${found.user.email} · devices ${found.devices}`
        : `Device ${found.deviceId}`,
      `From ${found.from.toISOString()} to ${found.to.toISOString()} (UTC)` +
        ` · ${found.events.length} events`,
    ];
    return renderTimeline(header, found.events, found.truncated);
  }

  // The same timeline as data, for the admin page: every event also carries its time in the device's own
  // clock (`time`) and `newSession`, true where the session differs from the event before.
  async timelineJson(query: ActivityTimelineQuery, now = new Date()) {
    const found = await this.readTimeline(query, now);
    return {
      user: found.user,
      deviceId: found.deviceId ?? null,
      devices: found.devices,
      from: found.from.toISOString(),
      to: found.to.toISOString(),
      truncated: found.truncated,
      events: found.events.map((event, i) => ({
        ...event,
        time: localTime(event),
        newSession: i > 0 && found.events[i - 1].s !== event.s,
      })),
    };
  }

  // The admin list: who was active in the last days, newest first. A user appears once with all their
  // devices together; a phone nobody signed in on appears on its own. `truncated` says the row limit cut it.
  async users(query: ActivityUsersQuery, now = new Date()) {
    const days = clampedInt(query.days, USERS_DEFAULT_DAYS, 1, USERS_MAX_DAYS);
    const limit = clampedInt(
      query.limit,
      USERS_DEFAULT_LIMIT,
      1,
      USERS_MAX_LIMIT
    );
    const since = new Date(now.getTime() - days * DAY_MS);
    const { groups, emails } = await this._activityLogRepository.listActors({
      since,
      q: query.q?.trim() || undefined,
      limit,
    });

    const actors = new Map<
      string,
      Omit<ActivityActor, 'firstEventAt' | 'lastEventAt'> & {
        firstEventAt: Date;
        lastEventAt: Date;
      }
    >();
    for (const group of groups) {
      const key = group.userId ?? `device:${group.deviceId}`;
      const first = group._min.firstEventAt!;
      const last = group._max.lastEventAt!;
      const events = group._sum.eventCount ?? 0;
      const actor = actors.get(key);
      if (!actor) {
        actors.set(key, {
          userId: group.userId,
          email: group.userId ? emails.get(group.userId) ?? null : null,
          deviceId: group.userId ? null : group.deviceId,
          devices: 1,
          events,
          firstEventAt: first,
          lastEventAt: last,
        });
        continue;
      }
      actor.devices += 1;
      actor.events += events;
      if (first < actor.firstEventAt) {
        actor.firstEventAt = first;
      }
      if (last > actor.lastEventAt) {
        actor.lastEventAt = last;
      }
    }

    const items: ActivityActor[] = [...actors.values()]
      .sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime())
      .map((actor) => ({
        ...actor,
        firstEventAt: actor.firstEventAt.toISOString(),
        lastEventAt: actor.lastEventAt.toISOString(),
      }));
    return {
      days,
      since: since.toISOString(),
      truncated: groups.length >= limit,
      items,
    };
  }
}
