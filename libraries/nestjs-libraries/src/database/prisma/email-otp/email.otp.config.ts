// Email one-time-code sign-in: the code life, tries and request limits read from the environment.

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

// A non-negative integer from the environment (0 switches the feature off), the fallback when unset.
const nonNegativeInt = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
};

// The current one-time-code settings, read on every call so a changed variable applies without a restart.
export const otpConfig = () => {
  const config = {
    ttlSeconds: positiveInt('OTP_TTL_SECONDS', 600),
    maxTries: positiveInt('OTP_MAX_TRIES', 5),
    requestLimit: positiveInt('OTP_REQUEST_LIMIT', 5),
    requestWindowSeconds: positiveInt('OTP_REQUEST_WINDOW_SECONDS', 900),
    resendCooldownSeconds: nonNegativeInt('OTP_RESEND_COOLDOWN_SECONDS', 30),
  };
  if (config.resendCooldownSeconds > config.requestWindowSeconds) {
    throw new Error(
      'OTP_RESEND_COOLDOWN_SECONDS must not exceed OTP_REQUEST_WINDOW_SECONDS'
    );
  }
  return config;
};
