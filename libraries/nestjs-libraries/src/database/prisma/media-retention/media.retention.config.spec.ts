// api.media-retention (RET-B1): MEDIA_RETENTION_DAYS and MEDIA_RETENTION_ERROR_DAYS, read with safe
// fallbacks. Pure: reads process.env only.
import {
  DEFAULT_ERROR_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
  mediaRetentionConfig,
  mediaSweepConfig,
} from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.config';

describe('api.media-retention: mediaRetentionConfig', () => {
  const saved = {
    days: process.env.MEDIA_RETENTION_DAYS,
    errorDays: process.env.MEDIA_RETENTION_ERROR_DAYS,
  };

  // Sets or removes the two variables for one test.
  const env = (days?: string, errorDays?: string) => {
    for (const [name, value] of [
      ['MEDIA_RETENTION_DAYS', days],
      ['MEDIA_RETENTION_ERROR_DAYS', errorDays],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };

  afterAll(() => env(saved.days, saved.errorDays));

  it('defaults to 1 day and 7 error days when unset or empty', () => {
    env(undefined, undefined);
    expect(mediaRetentionConfig()).toEqual({
      retentionDays: DEFAULT_RETENTION_DAYS,
      errorRetentionDays: DEFAULT_ERROR_RETENTION_DAYS,
    });
    env('', '  ');
    expect(mediaRetentionConfig()).toEqual({
      retentionDays: 1,
      errorRetentionDays: 7,
    });
  });

  it('reads -1 (forever), 0 (right after the last URL) and N for MEDIA_RETENTION_DAYS', () => {
    for (const value of [-1, 0, 1, 30]) {
      env(String(value), undefined);
      expect(mediaRetentionConfig().retentionDays).toBe(value);
    }
  });

  it('reads 0 and N for MEDIA_RETENTION_ERROR_DAYS', () => {
    for (const value of [0, 3, 14]) {
      env(undefined, String(value));
      expect(mediaRetentionConfig().errorRetentionDays).toBe(value);
    }
  });

  it('trims spaces around a value', () => {
    env(' 3 ', ' 5 ');
    expect(mediaRetentionConfig()).toEqual({
      retentionDays: 3,
      errorRetentionDays: 5,
    });
  });

  it('falls back to the default for garbage, fractions and values below the minimum', () => {
    for (const value of ['abc', '1.5', '1e3', '--1', '-2', '1 day']) {
      env(value, value);
      expect(mediaRetentionConfig()).toEqual({
        retentionDays: 1,
        errorRetentionDays: 7,
      });
    }
  });

  it('does not take -1 for the error days', () => {
    env(undefined, '-1');
    expect(mediaRetentionConfig().errorRetentionDays).toBe(7);
  });

  it('reads the variables again on every call', () => {
    env('2', undefined);
    expect(mediaRetentionConfig().retentionDays).toBe(2);
    env('4', undefined);
    expect(mediaRetentionConfig().retentionDays).toBe(4);
  });
});

describe('api.media-retention: mediaSweepConfig (RET-B3)', () => {
  const saved = process.env.MEDIA_SWEEP_DELETE;

  afterAll(() => {
    if (saved === undefined) {
      delete process.env.MEDIA_SWEEP_DELETE;
    } else {
      process.env.MEDIA_SWEEP_DELETE = saved;
    }
  });

  it('is a dry run unless the variable is the text true', () => {
    for (const value of [undefined, '', 'false', '1', 'yes', 'tru', 'on']) {
      if (value === undefined) {
        delete process.env.MEDIA_SWEEP_DELETE;
      } else {
        process.env.MEDIA_SWEEP_DELETE = value;
      }
      expect(mediaSweepConfig().deleteEnabled).toBe(false);
    }
  });

  it('deletes only on true, with spaces and capitals tolerated', () => {
    for (const value of ['true', ' TRUE ', 'True']) {
      process.env.MEDIA_SWEEP_DELETE = value;
      expect(mediaSweepConfig().deleteEnabled).toBe(true);
    }
  });
});
