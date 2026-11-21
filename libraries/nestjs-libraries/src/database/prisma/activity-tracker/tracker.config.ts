// Activity tracker (api.activity-tracker): the limits and retention constants of the activity tracker.
export const TRACKER_MAX_ACTIVITIES = 50; // per batch
export const TRACKER_RETENTION_DAYS = 90;
export const TRACKER_KEEP_LAST_ROWS = 300; // per device, kept past retention
export const TRACKER_META_MAX_KEYS = 20;
export const TRACKER_LIMITS = {
  description: 120, screen: 60, source: 40, metaString: 200,
  errorType: 120, errorMessage: 1000, errorStack: 8000, causeMessage: 300, causes: 5,
  thread: 60, lastActivity: 120, appVersion: 24, appPackage: 100, os: 32, manufacturer: 40, model: 64, locale: 16,
} as const;
export const TRACKER_NAME_RE = /^[a-z0-9_]{1,40}$/;
export const TRACKER_META_KEY_RE = /^[a-z0-9_]{1,32}$/;
export const TRACKER_SESSION_RE = /^[A-Za-z0-9_-]{1,16}$/;
