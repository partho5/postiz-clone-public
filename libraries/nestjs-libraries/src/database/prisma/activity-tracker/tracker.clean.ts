// Activity tracker (api.activity-tracker): checks each uploaded activity and the envelope against the contract, with no Nest or Prisma.
import { isUUID } from 'class-validator';
import {
  TRACKER_LIMITS,
  TRACKER_META_KEY_RE,
  TRACKER_META_MAX_KEYS,
  TRACKER_NAME_RE,
  TRACKER_SESSION_RE,
} from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.config';

const DAY_MS = 24 * 60 * 60 * 1000;
// Activities older than this are a wrong device clock, and so are ones more than two days ahead.
const EARLIEST_MS = Date.UTC(2020, 0, 1);
const FUTURE_SLACK_MS = 2 * DAY_MS;
// An activity lasts at most a week.
const MAX_SPAN_MS = 7 * DAY_MS;
const MAX_TZ_MINUTES = 840;
// The largest value a Prisma Int column holds.
const MAX_INT = 2147483647;

// One cause of an error. A type alias, not an interface, so it can be stored as JSON.
export type CleanCause = {
  type: string | null;
  message: string | null;
};

// One activity as it is stored, apart from the batch's device and user.
export interface CleanActivity {
  id: string;
  seq: number;
  session: string;
  kind: 'activity' | 'error';
  name: string;
  description: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  tz: number;
  appBuild: number | null;
  screen: string | null;
  source: string | null;
  meta: Record<string, string | number | boolean> | null;
  errorType: string | null;
  errorMessage: string | null;
  errorStack: string | null;
  errorCauses: CleanCause[] | null;
  errorThread: string | null;
  fatal: boolean | null;
  lastActivity: string | null;
}

// The app and device details of a batch, each cut to its limit or null.
export interface CleanEnvelope {
  appVersion: string | null;
  appBuild: number | null;
  appPackage: string | null;
  os: string | null;
  sdk: number | null;
  manufacturer: string | null;
  model: string | null;
  locale: string | null;
}

// Whether v is a plain object, not null and not an array.
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// Whether v is a whole number from min up to the largest value an Int column holds.
const isIntFrom = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= MAX_INT;

// The text with NUL characters removed, trimmed and cut to `max` characters; null when it is not a string or is blank.
export function cut(v: unknown, max: number): string | null {
  if (typeof v !== 'string') {
    return null;
  }
  // Postgres text and jsonb refuse a NUL character, which would fail the whole batch's insert, so it is dropped here.
  const text = v.split('\u0000').join('').trim();
  if (!text) {
    return null;
  }
  return [...text].slice(0, max).join('');
}

// The activity kind when it is one of the two the contract allows, else null.
const kindOf = (v: unknown): CleanActivity['kind'] | null => {
  if (v === 'activity') {
    return 'activity';
  }
  if (v === 'error') {
    return 'error';
  }
  return null;
};

// The offset in minutes east of UTC when it is within the contract's range, else 0.
const tzOf = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= MAX_TZ_MINUTES
    ? v
    : 0;

// One meta value as the contract allows it: a string cut to its limit, a finite number or a boolean; else null.
const metaValueOf = (v: unknown): string | number | boolean | null => {
  if (typeof v === 'string') {
    return cut(v, TRACKER_LIMITS.metaString);
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'boolean') {
    return v;
  }
  return null;
};

// The flat details of an activity. A bad key or value is dropped on its own and at most 20 are kept; null when none are left.
export function cleanMeta(v: unknown): CleanActivity['meta'] {
  if (!isObject(v)) {
    return null;
  }
  const kept: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(v)) {
    if (count >= TRACKER_META_MAX_KEYS) {
      break;
    }
    const scalar = metaValueOf(value);
    if (!TRACKER_META_KEY_RE.test(key) || scalar === null) {
      continue;
    }
    kept[key] = scalar;
    count++;
  }
  return count ? kept : null;
}

// The first causes of an error, each type and message cut to its limit; null when there are none.
const causesOf = (v: unknown): CleanCause[] | null => {
  if (!Array.isArray(v)) {
    return null;
  }
  const causes = v
    .filter(isObject)
    .slice(0, TRACKER_LIMITS.causes)
    .map((cause) => ({
      type: cut(cause.type, TRACKER_LIMITS.errorType),
      message: cut(cause.message, TRACKER_LIMITS.causeMessage),
    }));
  return causes.length ? causes : null;
};

// One uploaded activity checked on its own: null when a rule drops it, else the cleaned row where a bad optional part is null.
export function cleanActivity(raw: unknown, now: number): CleanActivity | null {
  if (!isObject(raw)) {
    return null;
  }
  const {
    id,
    seq,
    session,
    name,
    description,
    startedAt,
    endedAt,
    tz,
    appBuild,
    screen,
    source,
    meta,
    error,
  } = raw;
  const kind = kindOf(raw.kind);
  if (typeof id !== 'string' || !isUUID(id)) {
    return null;
  }
  if (!isIntFrom(seq, 0)) {
    return null;
  }
  if (typeof session !== 'string' || !TRACKER_SESSION_RE.test(session)) {
    return null;
  }
  if (!kind) {
    return null;
  }
  if (typeof name !== 'string' || !TRACKER_NAME_RE.test(name)) {
    return null;
  }
  if (
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    startedAt < EARLIEST_MS ||
    startedAt > now + FUTURE_SLACK_MS
  ) {
    return null;
  }
  const start = Math.trunc(startedAt);
  // An end that breaks its rule is dropped, which makes the activity an instant one.
  const end =
    typeof endedAt === 'number' &&
    Number.isFinite(endedAt) &&
    endedAt >= start &&
    endedAt <= start + MAX_SPAN_MS
      ? Math.trunc(endedAt)
      : null;
  const err = isObject(error) ? error : null;
  return {
    id,
    seq,
    session,
    kind,
    name,
    description: cut(description, TRACKER_LIMITS.description),
    startedAt: new Date(start),
    endedAt: end === null ? null : new Date(end),
    durationMs: end === null ? null : end - start,
    tz: tzOf(tz),
    appBuild: isIntFrom(appBuild, 0) ? appBuild : null,
    screen: cut(screen, TRACKER_LIMITS.screen),
    source: cut(source, TRACKER_LIMITS.source),
    meta: cleanMeta(meta),
    errorType: cut(err?.type, TRACKER_LIMITS.errorType),
    errorMessage: cut(err?.message, TRACKER_LIMITS.errorMessage),
    errorStack: cut(err?.stack, TRACKER_LIMITS.errorStack),
    errorCauses: causesOf(err?.causes),
    errorThread: cut(err?.thread, TRACKER_LIMITS.thread),
    fatal: err && typeof err.fatal === 'boolean' ? err.fatal : null,
    lastActivity: cut(err?.lastActivity, TRACKER_LIMITS.lastActivity),
  };
}

// The app and device details of the batch envelope, each cut to its limit or null.
export function cleanEnvelope(app: unknown, device: unknown): CleanEnvelope {
  const a: Record<string, unknown> = isObject(app) ? app : {};
  const d: Record<string, unknown> = isObject(device) ? device : {};
  const { version, build, package: appPackage } = a;
  const { os, sdk, manufacturer, model, locale } = d;
  return {
    appVersion: cut(version, TRACKER_LIMITS.appVersion),
    appBuild: isIntFrom(build, 0) ? build : null,
    appPackage: cut(appPackage, TRACKER_LIMITS.appPackage),
    os: cut(os, TRACKER_LIMITS.os),
    sdk: isIntFrom(sdk, 0) ? sdk : null,
    manufacturer: cut(manufacturer, TRACKER_LIMITS.manufacturer),
    model: cut(model, TRACKER_LIMITS.model),
    locale: cut(locale, TRACKER_LIMITS.locale),
  };
}
