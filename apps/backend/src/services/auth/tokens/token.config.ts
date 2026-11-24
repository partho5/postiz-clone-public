// Token auth: the lifetimes and limits read from the environment.

// A positive integer from the environment, the fallback when unset; a malformed value is a configuration error.
const positiveInt = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
};

// The current token settings, read on every call so a changed variable applies without a restart.
export const tokenConfig = () => ({
  accessTtlSeconds: positiveInt('ACCESS_TOKEN_TTL_SECONDS', 900),
  refreshTtlDays: positiveInt('REFRESH_TOKEN_TTL_DAYS', 36500),
  graceSeconds: positiveInt('REFRESH_GRACE_SECONDS', 60),
  failLimit: positiveInt('AUTH_FAIL_LIMIT', 10),
  failWindowSeconds: positiveInt('AUTH_FAIL_WINDOW_SECONDS', 900),
});
