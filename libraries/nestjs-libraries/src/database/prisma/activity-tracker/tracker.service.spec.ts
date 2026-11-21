// Activity tracker (api.activity-tracker): the cleaning rules, the batch store and the retention run, on hand-made repositories with no database.
import { HttpException } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AdminTrackerController } from '@gitroom/backend/api/routes/admin.tracker.controller';
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

  it('removes NUL characters from text, which the database would refuse', () => {
    const cleaned = cleanActivity(
      activity(1, { description: 'edit\u0000 topics' }),
      NOW
    );
    expect(cleaned?.description).toBe('edit topics');
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

// Hand-made Prisma methods of one table for the read side: each answers an empty result unless `answers` overrides it.
const emptyTable = (answers: Record<string, jest.Mock> = {}) => ({
  count: jest.fn(async () => 0),
  groupBy: jest.fn(async () => []),
  findMany: jest.fn(async () => []),
  findFirst: jest.fn(async () => null),
  findUnique: jest.fn(async () => null),
  ...answers,
});

// A read-side service on hand-made tables. The repository is the real one, so the queries it builds are the ones checked here.
const readService = (
  tables: {
    device?: Record<string, jest.Mock>;
    session?: Record<string, jest.Mock>;
    activity?: Record<string, jest.Mock>;
  } = {}
) => {
  const device = emptyTable(tables.device);
  const session = emptyTable(tables.session);
  const activity = emptyTable(tables.activity);
  const repo = new TrackerRepository(
    {
      model: { trackerDevice: device },
    } as unknown as PrismaRepository<'trackerDevice'>,
    {
      model: { trackerSession: session },
    } as unknown as PrismaRepository<'trackerSession'>,
    {
      model: { trackerActivity: activity },
    } as unknown as PrismaRepository<'trackerActivity'>,
    { model: { user: emptyTable() } } as unknown as PrismaRepository<'user'>
  );
  return { service: new TrackerService(repo), device, session, activity };
};

describe('api.activity-tracker: read API', () => {
  it('gives each timeline row its gap in ms from the row before, null for the first', async () => {
    const { service } = readService({
      session: {
        findUnique: jest.fn(async () => ({ key: `${DEVICE}:sess1` })),
      },
      activity: {
        findMany: jest.fn(async () => [
          { id: uuidOf(1), startedAt: new Date(T) },
          { id: uuidOf(2), startedAt: new Date(T + 300) },
          { id: uuidOf(3), startedAt: new Date(T + 3900) },
        ]),
      },
    });
    const { items } = await service.timeline(`${DEVICE}:sess1`);
    expect(items.map((item) => item.gapMs)).toEqual([null, 300, 3600]);
  });

  it('reads the devices last seen before the cursor', async () => {
    const cursor = new Date(NOW - DAY).toISOString();
    const { service, device } = readService();
    await service.devices({ cursor });
    expect(device.findMany.mock.calls[0][0].where).toMatchObject({
      lastSeenAt: { lt: new Date(cursor) },
    });
  });

  it.each([
    ['0', 1],
    ['500', 90],
    ['abc', 7],
  ])('counts back %s days as %i after clamping', async (days, expected) => {
    const { service } = readService();
    const { since } = await service.overview(days);
    expect(Math.round((Date.now() - Date.parse(since)) / DAY)).toBe(expected);
  });

  it('counts the devices of each feature from the device rows and ranks by devices', async () => {
    const { service } = readService({
      activity: {
        groupBy: jest.fn(async ({ by }: { by: string[] }) => {
          const fields = by.join(',');
          if (fields === 'name,description') {
            return [
              {
                name: 'click',
                description: 'edit topics',
                _count: { _all: 5 },
              },
              {
                name: 'toggle',
                description: 'ai captions',
                _count: { _all: 9 },
              },
              { name: 'click', description: null, _count: { _all: 1 } },
            ];
          }
          if (fields === 'name,description,deviceId') {
            return [
              {
                name: 'click',
                description: 'edit topics',
                deviceId: 'A',
                _count: { _all: 2 },
              },
              {
                name: 'click',
                description: 'edit topics',
                deviceId: 'B',
                _count: { _all: 3 },
              },
              {
                name: 'toggle',
                description: 'ai captions',
                deviceId: 'A',
                _count: { _all: 9 },
              },
              {
                name: 'click',
                description: null,
                deviceId: 'C',
                _count: { _all: 1 },
              },
            ];
          }
          return [];
        }),
      },
    });
    const { topFeatures } = await service.overview('7');
    expect(topFeatures).toEqual([
      { name: 'click', description: 'edit topics', devices: 2, count: 5 },
      { name: 'toggle', description: 'ai captions', devices: 1, count: 9 },
      { name: 'click', description: null, devices: 1, count: 1 },
    ]);
  });
});

describe('api.activity-tracker: admin read API access', () => {
  const service = {
    overview: jest.fn(),
    devices: jest.fn(),
    sessions: jest.fn(),
    timeline: jest.fn(),
    activity: jest.fn(),
  };
  const controller = new AdminTrackerController(
    service as unknown as TrackerService
  );
  const notAdmin = { isSuperAdmin: false } as User;

  it.each([
    ['overview', () => controller.overview(notAdmin)],
    ['devices', () => controller.devices(notAdmin)],
    ['sessions', () => controller.sessions(notAdmin)],
    ['timeline', () => controller.timeline(notAdmin)],
    ['activity', () => controller.activity(notAdmin, uuidOf(1))],
  ])(
    'answers 403 from %s to a user who is not a super admin',
    async (_, call) => {
      const error = await call().catch((err) => err);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(403);
      Object.values(service).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    }
  );
});

// A hand-made repository for the retention run. `rows` holds each device's activity start times and is changed by the
// deletes, like the table is. The session options answer the session queries. nthNewestStartedAt answers null for a device
// with fewer rows than asked for, as the real query does.
const retentionRepository = (
  rows: Record<string, Date[]>,
  sessions: { keys?: string[]; withActivities?: string[] } = {}
) => {
  const devicesWithRowsBefore = jest.fn(async (cutoff: Date) =>
    Object.keys(rows).filter((deviceId) =>
      rows[deviceId].some((at) => at.getTime() < cutoff.getTime())
    )
  );
  const nthNewestStartedAt = jest.fn(
    async (deviceId: string, n: number) =>
      [...rows[deviceId]].sort((a, b) => b.getTime() - a.getTime())[n - 1] ??
      null
  );
  const deleteActivitiesBefore = jest.fn(
    async (deviceId: string, before: Date) => {
      const kept = rows[deviceId].filter(
        (at) => at.getTime() >= before.getTime()
      );
      const deleted = rows[deviceId].length - kept.length;
      rows[deviceId] = kept;
      return deleted;
    }
  );
  const sessionKeysEndedBefore = jest.fn(async () => sessions.keys ?? []);
  const sessionKeysWithActivities = jest.fn(async (keys: string[]) =>
    keys.filter((key) => (sessions.withActivities ?? []).includes(key))
  );
  const deleteSessions = jest.fn(async () => undefined);
  const repo = {
    devicesWithRowsBefore,
    nthNewestStartedAt,
    deleteActivitiesBefore,
    sessionKeysEndedBefore,
    sessionKeysWithActivities,
    deleteSessions,
  };
  return {
    service: new TrackerService(repo as unknown as TrackerRepository),
    nthNewestStartedAt,
    deleteActivitiesBefore,
    deleteSessions,
  };
};

describe('api.activity-tracker: retention', () => {
  const HOUR = 60 * 60 * 1000;
  const now = new Date(NOW);
  const cutoff = new Date(NOW - 90 * DAY);
  const daysAgo = (days: number) => new Date(NOW - days * DAY);

  it('deletes the rows before the cutoff when the newest 300 are all newer than it', async () => {
    // 999 rows an hour apart, all recent, and one row 120 days old.
    const rows = [
      ...Array.from({ length: 999 }, (_, i) => new Date(NOW - i * HOUR)),
      daysAgo(120),
    ];
    const { service, deleteActivitiesBefore } = retentionRepository({
      [DEVICE]: rows,
    });
    const result = await service.deleteExpired(now);
    expect(deleteActivitiesBefore).toHaveBeenCalledWith(DEVICE, cutoff);
    expect(result).toEqual({ devices: 1, deleted: 1 });
  });

  it('keeps the newest 300 when the 300th is older than the cutoff, deleting only the rows older than it', async () => {
    // 320 rows, all older than the cutoff: the 300th newest is 399 days old, so the last 20 go.
    const rows = Array.from({ length: 320 }, (_, i) => daysAgo(100 + i));
    const { service, deleteActivitiesBefore } = retentionRepository({
      [DEVICE]: rows,
    });
    const result = await service.deleteExpired(now);
    expect(deleteActivitiesBefore).toHaveBeenCalledWith(DEVICE, daysAgo(399));
    expect(result).toEqual({ devices: 1, deleted: 20 });
  });

  it('deletes nothing from a device with 120 rows', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => daysAgo(100 + i));
    const { service, nthNewestStartedAt, deleteActivitiesBefore } =
      retentionRepository({ [DEVICE]: rows });
    const result = await service.deleteExpired(now);
    expect(nthNewestStartedAt).toHaveBeenCalledWith(DEVICE, 300);
    expect(deleteActivitiesBefore).not.toHaveBeenCalled();
    expect(result).toEqual({ devices: 1, deleted: 0 });
  });

  it('deletes the sessions that ended before the cutoff and have no activities left, keeping the rest', async () => {
    const rows = Array.from({ length: 320 }, (_, i) => daysAgo(100 + i));
    const { service, deleteSessions } = retentionRepository(
      { [DEVICE]: rows },
      {
        keys: [`${DEVICE}:a`, `${DEVICE}:b`, `${DEVICE}:c`],
        withActivities: [`${DEVICE}:b`],
      }
    );
    await service.deleteExpired(now);
    expect(deleteSessions).toHaveBeenCalledWith([`${DEVICE}:a`, `${DEVICE}:c`]);
  });
});
