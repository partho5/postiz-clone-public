// api.activity-log (S2-S4): what an upload keeps, the merge of a device's anonymous rows into a user, the
// timeline text and the 90-day purge. Runs on a hand-made repository; needs no database.
import {
  ActivityLogService,
  cleanEvent,
  cleanMeta,
} from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.log.service';
import { renderTimeline } from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.timeline';

const NOW = new Date('2026-10-20T12:00:00Z');
const T0 = NOW.getTime() - 60_000;
const BATCH = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

const event = (over: Record<string, unknown> = {}) => ({
  t: T0,
  tz: 360,
  s: 'sess1',
  a: 'app_open',
  ...over,
});

const batch = (events: unknown[], over: Record<string, unknown> = {}) =>
  ({
    batchId: BATCH,
    deviceId: DEVICE,
    app: { version: '1.0', build: 4 },
    device: { os: 'Android 14', model: 'Pixel 7' },
    events,
    ...over,
  }) as any;

describe('api.activity-log: cleanMeta / cleanEvent', () => {
  it('keeps scalar details and drops the rest', () => {
    expect(
      cleanMeta({
        duration_ms: 92000,
        source: 'button',
        on: true,
        nested: { a: 1 },
        list: [1],
        long: 'x'.repeat(65),
        Bad_Key: 1,
        nan: NaN,
      })
    ).toEqual({ duration_ms: 92000, source: 'button', on: true });
  });

  it('drops keys that sound like credentials', () => {
    expect(
      cleanMeta({ user_email: 'a@b.c', access_token: 'x', ok: 1, my_secret: 2 })
    ).toEqual({ ok: 1 });
  });

  it('keeps at most 10 keys and drops details over 512 bytes', () => {
    const many = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [`k${i}`, i])
    );
    expect(Object.keys(cleanMeta(many)!)).toHaveLength(10);
    const big = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, 'y'.repeat(60)])
    );
    expect(cleanMeta(big)).toBeUndefined();
  });

  it('drops an event with no usable time or action, repairs a bad tz or session', () => {
    const now = NOW.getTime();
    expect(cleanEvent(event({ t: 'now' }), now)).toBeNull();
    expect(cleanEvent(event({ t: 5 }), now)).toBeNull();
    expect(cleanEvent(event({ t: now + 5 * 86400000 }), now)).toBeNull();
    expect(cleanEvent(event({ a: 'Open App' }), now)).toBeNull();
    expect(cleanEvent('x', now)).toBeNull();
    expect(cleanEvent(event({ tz: 'x', s: 'bad session!' }), now)).toEqual({
      t: T0,
      tz: 0,
      s: '',
      a: 'app_open',
    });
  });
});

describe('api.activity-log: ActivityLogService', () => {
  let repo: any;
  let service: ActivityLogService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue({}),
      claimDevice: jest.fn().mockResolvedValue(0),
      deleteReceivedBefore: jest.fn().mockResolvedValue(3),
      findUser: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
      deviceCount: jest.fn().mockResolvedValue(2),
    };
    service = new ActivityLogService(repo);
  });

  it('stores an anonymous batch without claiming anything', async () => {
    await service.store(batch([event({ t: T0 + 5 }), event()]), undefined, NOW);
    const row = repo.create.mock.calls[0][0];
    expect(row).toMatchObject({
      batchId: BATCH,
      userId: null,
      deviceId: DEVICE,
      appVersion: '1.0 (4)',
      device: 'Android 14 · Pixel 7',
      eventCount: 2,
    });
    expect(row.log.map((e: any) => e.t)).toEqual([T0, T0 + 5]);
    expect(row.firstEventAt).toEqual(new Date(T0));
    expect(row.lastEventAt).toEqual(new Date(T0 + 5));
    expect(repo.claimDevice).not.toHaveBeenCalled();
  });

  it('stores a signed-in batch as the user and claims the device anonymous rows', async () => {
    await service.store(batch([event()]), 'user-1', NOW);
    expect(repo.create.mock.calls[0][0].userId).toBe('user-1');
    expect(repo.claimDevice).toHaveBeenCalledWith(DEVICE, 'user-1');
  });

  it('keeps the valid events when others are bad, and answers 400 when none is valid', async () => {
    await service.store(batch([event({ a: 'BAD' }), event()]), undefined, NOW);
    expect(repo.create.mock.calls[0][0].eventCount).toBe(1);
    await expect(
      service.store(batch([event({ a: 'BAD' }), 7]), undefined, NOW)
    ).rejects.toMatchObject({ status: 400 });
  });

  it('treats a repeated batch as stored (the repository answers null)', async () => {
    repo.create.mockResolvedValue(null);
    await expect(
      service.store(batch([event()]), 'user-1', NOW)
    ).resolves.toBeUndefined();
    expect(repo.claimDevice).toHaveBeenCalled();
  });

  it('purges what was received more than 90 days ago', async () => {
    await expect(service.deleteExpired(NOW)).resolves.toEqual({ deleted: 3 });
    expect(repo.deleteReceivedBefore).toHaveBeenCalledWith(
      new Date('2026-07-22T12:00:00Z')
    );
  });

  it('refuses a timeline without exactly one identity, and an unknown user', async () => {
    await expect(service.timeline({}, NOW)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.timeline({ userId: 'u', deviceId: 'd' }, NOW)
    ).rejects.toMatchObject({ status: 400 });
    repo.findUser.mockResolvedValue(null);
    await expect(
      service.timeline({ email: 'x@y.z' }, NOW)
    ).rejects.toMatchObject({ status: 404 });
  });

  it('builds a user timeline from the claimed rows, oldest first, in device time', async () => {
    repo.findUser.mockResolvedValue({ id: 'user-1', email: 'a@b.c' });
    repo.list.mockResolvedValue([
      {
        log: [
          {
            t: T0 + 2000,
            tz: 360,
            s: 's2',
            a: 'record_stop',
            m: { duration_ms: 92000, source: 'button' },
          },
        ],
      },
      { log: [{ t: T0, tz: 360, s: 's1', a: 'app_open' }] },
    ]);
    const text = await service.timeline({ userId: 'user-1' }, NOW);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('User user-1 a@b.c · devices 2');
    expect(lines.slice(3)).toEqual([
      '2026-10-20 17:59:00 | app_open',
      '-- new session --',
      '2026-10-20 17:59:02 | record_stop | duration_ms=92000 source=button',
    ]);
  });

  it('cuts a long timeline at the limit and says so', async () => {
    repo.findUser.mockResolvedValue({ id: 'user-1', email: 'a@b.c' });
    repo.list.mockResolvedValue([
      { log: [0, 1, 2].map((i) => ({ t: T0 + i, tz: 0, s: 's', a: 'tap' })) },
    ]);
    const text = await service.timeline({ userId: 'user-1', limit: '2' }, NOW);
    expect(text).toContain('2 events');
    expect(text).toContain('more events exist');
  });
});

describe('api.activity-log: renderTimeline', () => {
  it('quotes details that hold spaces and says when there is nothing', () => {
    const text = renderTimeline(
      ['Device d'],
      [
        {
          t: Date.UTC(2026, 1, 27, 8, 34, 7),
          tz: 360,
          s: 'a',
          a: 'setting_change',
          m: { key: 'camera name', value: 'front' },
        },
      ],
      false
    );
    expect(text).toContain(
      '2026-02-27 14:34:07 | setting_change | key="camera name" value=front'
    );
    expect(renderTimeline(['Device d'], [], false)).toContain(
      '(no events in this range)'
    );
  });
});

describe('api.activity-log: admin list and JSON timeline', () => {
  const at = (iso: string) => new Date(iso);
  const group = (
    userId: string | null,
    deviceId: string,
    events: number,
    first: string,
    last: string
  ) => ({
    userId,
    deviceId,
    _sum: { eventCount: events },
    _min: { firstEventAt: at(first) },
    _max: { lastEventAt: at(last) },
  });
  let repo: any;
  let service: ActivityLogService;

  beforeEach(() => {
    repo = {
      listActors: jest.fn().mockResolvedValue({
        groups: [],
        emails: new Map<string, string>(),
      }),
      findUser: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
      deviceCount: jest.fn().mockResolvedValue(2),
    };
    service = new ActivityLogService(repo);
  });

  it('puts a user once, with all their devices, and a phone nobody signed in on on its own, newest first', async () => {
    repo.listActors.mockResolvedValue({
      groups: [
        group('u1', 'd1', 10, '2026-10-19T08:00:00Z', '2026-10-20T09:00:00Z'),
        group(null, 'd9', 3, '2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z'),
        group('u1', 'd2', 5, '2026-10-18T08:00:00Z', '2026-10-19T09:00:00Z'),
      ],
      emails: new Map([['u1', 'a@b.c']]),
    });
    const out = await service.users({}, NOW);
    expect(out.items).toEqual([
      {
        userId: null,
        email: null,
        deviceId: 'd9',
        devices: 1,
        events: 3,
        firstEventAt: '2026-10-20T10:00:00.000Z',
        lastEventAt: '2026-10-20T11:00:00.000Z',
      },
      {
        userId: 'u1',
        email: 'a@b.c',
        deviceId: null,
        devices: 2,
        events: 15,
        firstEventAt: '2026-10-18T08:00:00.000Z',
        lastEventAt: '2026-10-20T09:00:00.000Z',
      },
    ]);
    expect(out.truncated).toBe(false);
  });

  it('asks for the last 7 days and 100 rows by default, and keeps days and limit inside their bounds', async () => {
    await service.users({}, NOW);
    expect(repo.listActors).toHaveBeenLastCalledWith({
      since: new Date('2026-10-13T12:00:00Z'),
      q: undefined,
      limit: 100,
    });
    await service.users({ days: '9999', limit: '99999', q: '  a@b ' }, NOW);
    expect(repo.listActors).toHaveBeenLastCalledWith({
      since: new Date('2026-07-22T12:00:00Z'),
      q: 'a@b',
      limit: 500,
    });
    await service.users({ days: '0', limit: '-5' }, NOW);
    const last = repo.listActors.mock.calls.pop()[0];
    expect(last.limit).toBe(1);
    expect(last.since).toEqual(new Date('2026-10-13T12:00:00Z'));
  });

  it('says when the row limit cut the list', async () => {
    repo.listActors.mockResolvedValue({
      groups: [
        group(null, 'd1', 1, '2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z'),
        group(null, 'd2', 1, '2026-10-20T10:00:00Z', '2026-10-20T10:30:00Z'),
      ],
      emails: new Map(),
    });
    expect((await service.users({ limit: '2' }, NOW)).truncated).toBe(true);
  });

  it('answers the timeline as data: device time, a flag where the session changes, the same cut as the text', async () => {
    repo.findUser.mockResolvedValue({ id: 'user-1', email: 'a@b.c' });
    repo.list.mockResolvedValue([
      {
        log: [
          { t: T0, tz: 360, s: 's1', a: 'app_open' },
          { t: T0 + 2000, tz: 360, s: 's2', a: 'tap', m: { item: 'x' } },
        ],
      },
    ]);
    const out = await service.timelineJson({ userId: 'user-1' }, NOW);
    expect(out.user).toEqual({ id: 'user-1', email: 'a@b.c' });
    expect(out.devices).toBe(2);
    expect(out.deviceId).toBeNull();
    expect(out.truncated).toBe(false);
    expect(out.events).toEqual([
      { t: T0, tz: 360, s: 's1', a: 'app_open', time: '2026-10-20 17:59:00', newSession: false },
      { t: T0 + 2000, tz: 360, s: 's2', a: 'tap', m: { item: 'x' }, time: '2026-10-20 17:59:02', newSession: true },
    ]);
  });

  it('answers a phone timeline with no user', async () => {
    const out = await service.timelineJson({ deviceId: 'd9' }, NOW);
    expect(out.user).toBeNull();
    expect(out.deviceId).toBe('d9');
    expect(out.devices).toBe(1);
    expect(out.events).toEqual([]);
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'd9', userId: undefined })
    );
  });
});
