// Activity tracker (api.activity-tracker): the cleaning rules and the batch store, on hand-made repositories with no database.
import { HttpException } from '@nestjs/common';
import { TrackerBatchDto } from '@gitroom/nestjs-libraries/dtos/activity-tracker/tracker.batch.dto';
import {
  cleanActivity,
  cleanMeta,
} from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.clean';
import {
  NewTrackerActivity,
  TrackerRepository,
} from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.repository';
import { TrackerService } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = NOW - 60_000;
const BATCH = '8c0e1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const DEVICE = '3f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7';
const USER = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

// A valid v4 uuid for the n-th activity of a test.
const uuidOf = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

// A valid activity of session `sess1`, starting at `T` plus `offset`; `over` replaces any field.
const activity = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuidOf(n),
  seq: n,
  session: 'sess1',
  kind: 'activity',
  name: 'click',
  description: 'edit topics',
  startedAt: T + n,
  endedAt: null,
  tz: 360,
  appBuild: 4,
  screen: 'MainActivity',
  source: 'launcher',
  meta: { on: true },
  ...over,
});

// A batch of the given raw activities, with the envelope the app sends.
const batch = (activities: unknown[]): TrackerBatchDto => ({
  batchId: BATCH,
  deviceId: DEVICE,
  sentAt: NOW,
  app: {
    version: '1.0',
    build: 4,
    package: 'com.jovoc.facecampresentationrecorder',
  },
  device: {
    os: 'Android 14',
    sdk: 34,
    manufacturer: 'Google',
    model: 'Pixel 7',
    locale: 'en-US',
  },
  activities,
});

// A hand-made repository that records what the service asks of it. `accepted` answers how many rows were new.
const fakeRepository = (
  options: { accepted?: (rows: NewTrackerActivity[]) => number; email?: string | null } = {}
) => {
  const insertActivities = jest.fn(async (rows: NewTrackerActivity[]) =>
    options.accepted ? options.accepted(rows) : rows.length
  );
  const upsertDevice = jest.fn(async () => undefined);
  const findSession = jest.fn(async () => null);
  const upsertSession = jest.fn(async () => undefined);
  const userEmail = jest.fn(async () => options.email ?? null);
  const linkDevice = jest.fn(async () => undefined);
  const claimDevice = jest.fn(async () => undefined);
  const repo = {
    insertActivities,
    upsertDevice,
    findSession,
    upsertSession,
    userEmail,
    linkDevice,
    claimDevice,
  };
  return {
    service: new TrackerService(repo as unknown as TrackerRepository),
    insertActivities,
    upsertDevice,
    upsertSession,
    linkDevice,
    claimDevice,
  };
};

describe('api.activity-tracker: cleanActivity', () => {
  it('keeps a valid activity and computes its duration', () => {
    const cleaned = cleanActivity(
      activity(1, { endedAt: T + 1 + 2500 }),
      NOW
    );
    expect(cleaned).toMatchObject({
      id: uuidOf(1),
      seq: 1,
      kind: 'activity',
      name: 'click',
      durationMs: 2500,
    });
  });

  it.each([
    ['a bad uuid', { id: 'not-a-uuid' }],
    ['a name with a capital letter', { name: 'Click' }],
    ['a name with a space', { name: 'double click' }],
    ['a negative seq', { seq: -1 }],
    ['a start in 2019', { startedAt: Date.UTC(2019, 5, 1) }],
    ['a start three days ahead', { startedAt: NOW + 3 * DAY }],
  ])('drops an activity with %s', (_, over) => {
    expect(cleanActivity(activity(1, over), NOW)).toBeNull();
  });

  it('drops an end that is before the start, keeping the activity as an instant one', () => {
    const cleaned = cleanActivity(activity(1, { endedAt: T - 1 }), NOW);
    expect(cleaned).toMatchObject({ endedAt: null, durationMs: null });
  });

  it('turns an offset outside the range into 0', () => {
    expect(cleanActivity(activity(1, { tz: 9999 }), NOW)?.tz).toBe(0);
  });

  it('cuts a description of 500 characters to 120', () => {
    const cleaned = cleanActivity(
      activity(1, { description: 'd'.repeat(500) }),
      NOW
    );
    expect(cleaned?.description).toHaveLength(120);
  });

  it('cuts an error stack of 20 000 characters to 8000 and keeps at most 5 causes', () => {
    const cleaned = cleanActivity(
      activity(1, {
        kind: 'error',
        name: 'crash',
        error: {
          type: 'java.lang.NullPointerException',
          stack: 'x'.repeat(20000),
          fatal: true,
          causes: Array.from({ length: 7 }, (_, i) => ({
            type: `java.io.Cause${i}`,
            message: 'boom',
          })),
        },
      }),
      NOW
    );
    expect(cleaned?.errorStack).toHaveLength(8000);
    expect(cleaned?.errorCauses).toHaveLength(5);
    expect(cleaned?.fatal).toBe(true);
  });
});

describe('api.activity-tracker: cleanMeta', () => {
  it('drops nested values and keys that are not plain', () => {
    expect(
      cleanMeta({ ok: 1, nested: { a: 1 }, list: [1], 'Bad-Key': 2 })
    ).toEqual({ ok: 1 });
  });

  it('keeps at most 20 keys of 25', () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`k${i}`, i])
    );
    expect(Object.keys(cleanMeta(many)!)).toHaveLength(20);
  });

  it('returns null for an empty object', () => {
    expect(cleanMeta({})).toBeNull();
  });

  it('cuts a string value of 300 characters to 200', () => {
    expect(cleanMeta({ s: 'x'.repeat(300) })).toEqual({ s: 'x'.repeat(200) });
  });
});

describe('api.activity-tracker: store', () => {
  it('stores the 3 valid activities and drops the invalid one', async () => {
    const { service, insertActivities } = fakeRepository();
    const result = await service.store(
      batch([
        activity(1),
        activity(2),
        activity(3),
        activity(4, { name: 'Bad Name' }),
      ])
    );
    expect(result).toEqual({ accepted: 3, duplicates: 0, dropped: 1 });
    expect(insertActivities.mock.calls[0][0]).toHaveLength(3);
  });

  it('counts the rows the store already had as duplicates', async () => {
    const { service } = fakeRepository({ accepted: () => 1 });
    const result = await service.store(
      batch([activity(1), activity(2), activity(3)])
    );
    expect(result).toEqual({ accepted: 1, duplicates: 2, dropped: 0 });
  });

  it('adds nothing to the device counts when the whole batch is a retry', async () => {
    const { service, upsertDevice } = fakeRepository({ accepted: () => 0 });
    await service.store(
      batch([activity(1), activity(2, { kind: 'error', name: 'crash' })])
    );
    expect(upsertDevice).toHaveBeenCalledWith(
      DEVICE,
      expect.objectContaining({ appVersion: '1.0', os: 'Android 14' }),
      expect.any(Date),
      0,
      0
    );
  });

  it('rejects a batch with no valid activity with a 400 and stores nothing', async () => {
    const { service, insertActivities } = fakeRepository();
    const error = await service
      .store(batch([{ id: 'bad' }, 'nonsense']))
      .catch((err) => err);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(400);
    expect(insertActivities).not.toHaveBeenCalled();
  });

  it('links the device to the user and copies the email when the batch has a user', async () => {
    const { service, linkDevice, claimDevice } = fakeRepository({
      email: 'maker@example.com',
    });
    await service.store(batch([activity(1)]), USER);
    expect(linkDevice).toHaveBeenCalledWith(DEVICE, USER, 'maker@example.com');
    expect(claimDevice).toHaveBeenCalledWith(DEVICE, USER);
  });

  it('leaves the device unlinked for an anonymous batch', async () => {
    const { service, linkDevice, claimDevice } = fakeRepository();
    await service.store(batch([activity(1)]));
    expect(linkDevice).not.toHaveBeenCalled();
    expect(claimDevice).not.toHaveBeenCalled();
  });

  it('writes one rollup per session with its span, screens, entry source and counts', async () => {
    const { service, upsertSession } = fakeRepository();
    await service.store(
      batch([
        activity(1, {
          session: 'a',
          name: 'app_open',
          source: 'notification',
          screen: 'Splash',
          startedAt: T + 1,
        }),
        activity(2, {
          session: 'a',
          name: 'click',
          screen: 'Home',
          startedAt: T + 1000,
        }),
        activity(3, {
          session: 'a',
          name: 'record',
          screen: 'Record',
          startedAt: T + 5000,
          endedAt: T + 9000,
        }),
        activity(4, {
          session: 'b',
          name: 'app_foreground',
          source: 'launcher',
          screen: 'Login',
          startedAt: T + 20000,
        }),
        activity(5, {
          session: 'b',
          kind: 'error',
          name: 'crash',
          screen: 'Settings',
          startedAt: T + 21000,
        }),
      ])
    );
    const rollups = upsertSession.mock.calls.map((call) => call[0]);
    expect(rollups).toHaveLength(2);
    expect(rollups).toContainEqual(
      expect.objectContaining({
        key: `${DEVICE}:a`,
        startedAt: new Date(T + 1),
        endedAt: new Date(T + 9000),
        firstScreen: 'Splash',
        lastScreen: 'Record',
        entrySource: 'notification',
        activityCount: 3,
        errorCount: 0,
      })
    );
    expect(rollups).toContainEqual(
      expect.objectContaining({
        key: `${DEVICE}:b`,
        startedAt: new Date(T + 20000),
        endedAt: new Date(T + 21000),
        firstScreen: 'Login',
        lastScreen: 'Settings',
        entrySource: 'launcher',
        activityCount: 2,
        errorCount: 1,
      })
    );
  });
});
