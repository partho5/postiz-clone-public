// Media retention (api.media-retention): the settings read from the environment, and the origin value
// of the media rows the retention purge may touch.

// Media.origin of a file the phone uploaded straight to R2; every other row has no origin.
export const MEDIA_ORIGIN_MOBILE = 'mobile';

// MEDIA_RETENTION_DAYS when unset or malformed: purge 24 hours after the last channel's URL.
export const DEFAULT_RETENTION_DAYS = 1;

// MEDIA_RETENTION_ERROR_DAYS when unset or malformed: keep a failed post's file a week, so Retry works.
export const DEFAULT_ERROR_RETENTION_DAYS = 7;

// The shortest wait before a file no live post carries is purged, in days, whatever
// MEDIA_RETENTION_ERROR_DAYS says: 0 would delete a recording the instant its post is deleted or
// before the app has posted it.
export const MIN_UNREFERENCED_DAYS = 1;

// How long a QUEUE thread row under a PUBLISHED first post may sit untouched before the channel counts
// as published (a provider that cannot post comments leaves its later rows QUEUE for ever), in days.
export const STALE_THREAD_ROW_DAYS = 2;

// How old an R2 object must be before the orphan sweep may delete it when no media row names it, in
// days: a fresh upload gets its media row at `complete` / `save-media` time, after the object exists.
export const ORPHAN_GRACE_DAYS = 2;

// An integer of at least `min` from the environment; unset, malformed (text, a fraction) or below
// `min` gives the fallback, so a typo never turns the purge off or makes it immediate.
const integerFrom = (name: string, fallback: number, min: number) => {
  const raw = (process.env[name] || '').trim();
  if (!/^-?\d+$/.test(raw)) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min ? value : fallback;
};

// The current retention settings, read on every call so a changed variable applies without a restart.
// retentionDays: -1 keep forever, 0 purge right after the last channel's URL, N days after.
// errorRetentionDays: days a file is kept once a channel ended in ERROR (0 or more).
export const mediaRetentionConfig = () => ({
  retentionDays: integerFrom('MEDIA_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, -1),
  errorRetentionDays: integerFrom(
    'MEDIA_RETENTION_ERROR_DAYS',
    DEFAULT_ERROR_RETENTION_DAYS,
    0
  ),
});

// Whether the nightly sweeps (soft-deleted backlog, orphan objects) really delete. Anything but the
// text `true` leaves them in dry run: they read and log what they would delete and change nothing.
export const mediaSweepConfig = () => ({
  deleteEnabled:
    (process.env.MEDIA_SWEEP_DELETE || '').trim().toLowerCase() === 'true',
});
