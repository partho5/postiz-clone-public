// api.media-retention (RET-B1, RET-B2): the channel state of a post group, the retention verdict, the
// service that reads the posts for it, the purge run and the purged-media guard. Runs on a hand-made
// repository and R2 client, so it needs no database or R2.
import {
  ChannelState,
  classifyChannels,
  COMMENT_SLEEP_ATTEMPTS,
  MEDIA_PURGE_BATCH,
  MEDIA_PURGE_MAX_PAGES,
  MediaPurgedException,
  MediaRetentionService,
  RetentionMedia,
  RetentionPostRow,
  retentionVerdict,
} from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.service';
import { MediaRetentionRepository } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.repository';

const mockSend = jest.fn();

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: (...args: unknown[]) => mockSend(...args) },
  R2_BUCKET: 'test-bucket',
}));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-01T10:00:00.000Z');
const URL = 'https://platform.example/post/1';

const config = { retentionDays: 1, errorRetentionDays: 7 };

// A media row of the phone.
const media = (patch: Partial<RetentionMedia> = {}): RetentionMedia => ({
  id: 'media-1',
  name: 'key.mp4',
  organizationId: 'org-1',
  origin: 'mobile',
  purgedAt: null,
  createdAt: T0,
  ...patch,
});

// A post row of a group, with an id of its own unless the test names one.
let rowCount = 0;
const row = (patch: Partial<RetentionPostRow> = {}): RetentionPostRow => ({
  id: `row-${++rowCount}`,
  group: 'g1',
  state: 'PUBLISHED',
  releaseURL: URL,
  intervalInDays: null,
  parentPostId: null,
  delay: 0,
  updatedAt: T0,
  ...patch,
});

describe('api.media-retention: classifyChannels', () => {
  it('is published, since the latest row, when every row is PUBLISHED with a URL', () => {
    const later = new Date(T0.getTime() + HOUR);
    expect(
      classifyChannels([row(), row({ updatedAt: later })])
    ).toEqual([{ state: 'published', since: later }]);
  });

  it('is error when the first post is ERROR, though the thread rows stay QUEUE', () => {
    const failed = new Date(T0.getTime() + 2 * HOUR);
    expect(
      classifyChannels([
        row({ state: 'ERROR', releaseURL: null, updatedAt: failed }),
        row({ state: 'QUEUE', releaseURL: null }),
      ])
    ).toEqual([{ state: 'error', since: failed }]);
  });

  it.each([
    ['QUEUE', { state: 'QUEUE', releaseURL: null }],
    ['DRAFT', { state: 'DRAFT', releaseURL: null }],
    ['PUBLISHED without a URL', { releaseURL: null }],
    ['PUBLISHED with an empty URL', { releaseURL: '' }],
    ['PUBLISHED but repeating', { intervalInDays: 7 }],
  ])('is open for %s', (_name, patch) => {
    expect(classifyChannels([row(patch as Partial<RetentionPostRow>)])).toEqual([
      { state: 'open' },
    ]);
  });

  it('is open while one thread row is still QUEUE under a PUBLISHED first post', () => {
    expect(
      classifyChannels([row(), row({ state: 'QUEUE', releaseURL: null })])
    ).toEqual([{ state: 'open' }]);
  });

  it('is open while a thread row is QUEUE and was touched less than 2 days ago', () => {
    const now = new Date(T0.getTime() + 2 * DAY - HOUR);
    expect(
      classifyChannels(
        [
          row(),
          row({ state: 'QUEUE', releaseURL: null, parentPostId: 'root' }),
        ],
        now
      )
    ).toEqual([{ state: 'open' }]);
  });

  it('is published when the first post went out and the thread rows stayed QUEUE for 2 days', () => {
    const now = new Date(T0.getTime() + 2 * DAY);
    expect(
      classifyChannels(
        [
          row(),
          row({ state: 'QUEUE', releaseURL: null, parentPostId: 'root' }),
        ],
        now
      )
    ).toEqual([{ state: 'published', since: T0 }]);
  });

  // A thread row of the first post `root`, still QUEUE, written `createdDaysBefore` days before T0
  const queued = (patch: Partial<RetentionPostRow> = {}) =>
    row({
      state: 'QUEUE',
      releaseURL: null,
      parentPostId: 'root',
      updatedAt: new Date(T0.getTime() - 5 * DAY),
      ...patch,
    });

  it('keeps the channel open when the first post was published just now and the comment was created days earlier', () => {
    expect(
      classifyChannels([row({ id: 'root' }), queued()], T0)
    ).toEqual([{ state: 'open' }]);
    // a thread row's own age counts for nothing: 2 days run from the publish
    const almost = new Date(T0.getTime() + 2 * DAY - HOUR);
    expect(
      classifyChannels([row({ id: 'root' }), queued()], almost)
    ).toEqual([{ state: 'open' }]);
  });

  it('keeps a delayed comment open until 2 days plus its delay times the workflow attempts after the publish', () => {
    // the workflow sleeps the delay again on each of its COMMENT_SLEEP_ATTEMPTS retries
    const rows = [row({ id: 'root' }), queued({ delay: 24 * 60 })];
    const window = (2 + COMMENT_SLEEP_ATTEMPTS) * DAY;
    const before = new Date(T0.getTime() + window - HOUR);
    expect(classifyChannels(rows, before)).toEqual([{ state: 'open' }]);
    const after = new Date(T0.getTime() + window);
    expect(classifyChannels(rows, after)).toEqual([
      { state: 'published', since: T0 },
    ]);
  });

  it('sums the delays along the comment chain', () => {
    const rows = [
      row({ id: 'root' }),
      queued({ id: 'c1', delay: 24 * 60 }),
      queued({ id: 'c2', parentPostId: 'c1', delay: 2 * 24 * 60 }),
    ];
    // c2 posts 3 days after the first post at the earliest, up to 5 times that after retries
    const window = (2 + 3 * COMMENT_SLEEP_ATTEMPTS) * DAY;
    expect(
      classifyChannels(rows, new Date(T0.getTime() + window - HOUR))
    ).toEqual([{ state: 'open' }]);
    expect(
      classifyChannels(rows, new Date(T0.getTime() + window))
    ).toEqual([{ state: 'published', since: T0 }]);
  });

  it('counts every delay of the group when the chain cannot be followed', () => {
    const rows = [
      row({ id: 'root' }),
      queued({ id: 'c2', parentPostId: 'deleted', delay: 24 * 60 }),
      queued({ id: 'c3', parentPostId: 'c2', delay: 24 * 60 }),
    ];
    const window = (2 + 2 * COMMENT_SLEEP_ATTEMPTS) * DAY;
    expect(
      classifyChannels(rows, new Date(T0.getTime() + window - HOUR))
    ).toEqual([{ state: 'open' }]);
    expect(
      classifyChannels(rows, new Date(T0.getTime() + window))
    ).toMatchObject([{ state: 'published' }]);
  });

  it('stays open for old QUEUE thread rows when the first post is not PUBLISHED with a URL', () => {
    const now = new Date(T0.getTime() + 9 * DAY);
    const stale = row({
      state: 'QUEUE',
      releaseURL: null,
      parentPostId: 'root',
    });
    expect(
      classifyChannels([row({ state: 'QUEUE', releaseURL: null }), stale], now)
    ).toEqual([{ state: 'open' }]);
    expect(
      classifyChannels([row({ releaseURL: null }), stale], now)
    ).toEqual([{ state: 'open' }]);
  });

  it('is open for an old QUEUE row that is not a thread row', () => {
    const now = new Date(T0.getTime() + 9 * DAY);
    expect(
      classifyChannels([row(), row({ state: 'QUEUE', releaseURL: null })], now)
    ).toEqual([{ state: 'open' }]);
  });

  it('is open for a repeating ERROR group, so a series is never purged under its owner', () => {
    expect(
      classifyChannels([row({ state: 'ERROR', intervalInDays: 1 })])
    ).toEqual([{ state: 'open' }]);
  });

  it('gives one state per group', () => {
    const out = classifyChannels([
      row({ group: 'a' }),
      row({ group: 'b', state: 'ERROR', releaseURL: null }),
      row({ group: 'c', state: 'DRAFT', releaseURL: null }),
    ]);
    expect(out.map((c) => c.state)).toEqual(['published', 'error', 'open']);
  });

  it('is empty for no rows', () => {
    expect(classifyChannels([])).toEqual([]);
  });
});

describe('api.media-retention: retentionVerdict', () => {
  const published = (at: Date): ChannelState => ({
    state: 'published',
    since: at,
  });
  const failed = (at: Date): ChannelState => ({ state: 'error', since: at });
  const verdict = (
    channels: ChannelState[],
    patch: {
      media?: Partial<RetentionMedia>;
      referencedBySet?: boolean;
      config?: typeof config;
    } = {}
  ) =>
    retentionVerdict({
      media: media(patch.media),
      channels,
      referencedBySet: patch.referencedBySet || false,
      config: patch.config || config,
    });

  it('purges 24 hours after the last channel was published (default 1 day)', () => {
    const last = new Date(T0.getTime() + 3 * HOUR);
    expect(verdict([published(T0), published(last)])).toEqual({
      purge: true,
      reason: 'published',
      purgeAt: new Date(last.getTime() + DAY),
    });
  });

  it('purges right after the last URL when MEDIA_RETENTION_DAYS is 0', () => {
    expect(
      verdict([published(T0)], { config: { ...config, retentionDays: 0 } })
    ).toMatchObject({ purge: true, purgeAt: T0 });
  });

  it('purges N days after for MEDIA_RETENTION_DAYS=N', () => {
    expect(
      verdict([published(T0)], { config: { ...config, retentionDays: 3 } })
    ).toMatchObject({ purge: true, purgeAt: new Date(T0.getTime() + 3 * DAY) });
  });

  it('keeps forever when MEDIA_RETENTION_DAYS is -1, error channels included', () => {
    const forever = { ...config, retentionDays: -1 };
    expect(verdict([published(T0)], { config: forever })).toEqual({
      purge: false,
      reason: 'forever',
    });
    expect(verdict([failed(T0)], { config: forever })).toEqual({
      purge: false,
      reason: 'forever',
    });
  });

  it('uses the error window from the last channel end when any channel is ERROR', () => {
    const last = new Date(T0.getTime() + 5 * HOUR);
    expect(verdict([failed(T0), published(last)])).toEqual({
      purge: true,
      reason: 'error',
      purgeAt: new Date(last.getTime() + 7 * DAY),
    });
  });

  it('never purges while any channel is open, whatever the clock says', () => {
    expect(
      verdict([published(new Date(T0.getTime() - 30 * DAY)), { state: 'open' }])
    ).toEqual({ purge: false, reason: 'open' });
    expect(verdict([failed(T0), { state: 'open' }])).toEqual({
      purge: false,
      reason: 'open',
    });
  });

  it('keeps a file a set names', () => {
    expect(verdict([published(T0)], { referencedBySet: true })).toEqual({
      purge: false,
      reason: 'set',
    });
  });

  it('runs the error window from createdAt for a file no post carries', () => {
    expect(verdict([])).toEqual({
      purge: true,
      reason: 'unreferenced',
      purgeAt: new Date(T0.getTime() + 7 * DAY),
    });
  });

  it('waits at least a day for an unreferenced file when MEDIA_RETENTION_ERROR_DAYS is 0', () => {
    expect(
      verdict([], { config: { ...config, errorRetentionDays: 0 } })
    ).toEqual({
      purge: true,
      reason: 'unreferenced',
      purgeAt: new Date(T0.getTime() + DAY),
    });
  });

  it('starts the unreferenced wait at the latest deletion of a post that carried the file', () => {
    const deleted = new Date(T0.getTime() + 20 * DAY);
    expect(
      retentionVerdict({
        media: media(),
        channels: [],
        referencedBySet: false,
        lastDeletedAt: deleted,
        config,
      })
    ).toEqual({
      purge: true,
      reason: 'unreferenced',
      purgeAt: new Date(deleted.getTime() + 7 * DAY),
    });
  });

  it('keeps createdAt as the anchor when the deletion came before it', () => {
    expect(
      retentionVerdict({
        media: media(),
        channels: [],
        referencedBySet: false,
        lastDeletedAt: new Date(T0.getTime() - DAY),
        config,
      })
    ).toMatchObject({ purgeAt: new Date(T0.getTime() + 7 * DAY) });
  });

  it('never touches a row that is not the phone\'s, whatever the posts say', () => {
    for (const origin of [null, 'web']) {
      expect(verdict([published(T0)], { media: { origin } })).toEqual({
        purge: false,
        reason: 'not-mobile',
      });
      expect(verdict([], { media: { origin } })).toEqual({
        purge: false,
        reason: 'not-mobile',
      });
    }
  });

  it('does not purge a file twice', () => {
    expect(
      verdict([published(T0)], { media: { purgedAt: new Date(T0) } })
    ).toEqual({ purge: false, reason: 'purged' });
  });
});

describe('api.media-retention: MediaRetentionService.evaluate', () => {
  const savedDays = process.env.MEDIA_RETENTION_DAYS;
  const savedErrorDays = process.env.MEDIA_RETENTION_ERROR_DAYS;
  let rows: RetentionPostRow[];
  let setCount: number;
  let lastDeletedAt: Date | null;
  let calls: string[];
  let service: MediaRetentionService;

  beforeEach(() => {
    delete process.env.MEDIA_RETENTION_DAYS;
    delete process.env.MEDIA_RETENTION_ERROR_DAYS;
    rows = [];
    setCount = 0;
    lastDeletedAt = null;
    calls = [];
    const repository = {
      findReferencingGroups: async () => {
        calls.push('groups');
        return [...new Set(rows.map((r) => r.group))];
      },
      findGroupRows: async (_org: string, groups: string[]) => {
        calls.push('rows');
        return rows.filter((r) => groups.includes(r.group));
      },
      countSetReferences: async () => {
        calls.push('sets');
        return setCount;
      },
      findLastDeletedAt: async () => {
        calls.push('deleted');
        return lastDeletedAt;
      },
    } as unknown as MediaRetentionRepository;
    service = new MediaRetentionService(repository);
  });

  afterAll(() => {
    for (const [name, value] of [
      ['MEDIA_RETENTION_DAYS', savedDays],
      ['MEDIA_RETENTION_ERROR_DAYS', savedErrorDays],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('answers a web-library row without reading any post', async () => {
    expect(await service.evaluate(media({ origin: null }))).toEqual({
      purge: false,
      reason: 'not-mobile',
    });
    expect(calls).toEqual([]);
  });

  it('answers a forever setting without reading any post', async () => {
    process.env.MEDIA_RETENTION_DAYS = '-1';
    expect(await service.evaluate(media())).toEqual({
      purge: false,
      reason: 'forever',
    });
    expect(calls).toEqual([]);
  });

  it('purges a day after the only channel was published', async () => {
    rows = [row()];
    expect(await service.evaluate(media())).toEqual({
      purge: true,
      reason: 'published',
      purgeAt: new Date(T0.getTime() + DAY),
    });
  });

  it('keeps the file while a second channel of the request is still queued', async () => {
    rows = [
      row({ group: 'a' }),
      row({ group: 'b', state: 'QUEUE', releaseURL: null }),
    ];
    expect(await service.evaluate(media())).toEqual({
      purge: false,
      reason: 'open',
    });
  });

  it('keeps the file for a set that names it', async () => {
    rows = [row()];
    setCount = 1;
    expect(await service.evaluate(media())).toEqual({
      purge: false,
      reason: 'set',
    });
  });

  it('treats a file no post carries as unreferenced and does not read rows', async () => {
    expect(await service.evaluate(media())).toMatchObject({
      purge: true,
      reason: 'unreferenced',
    });
    expect(calls).toEqual(['groups', 'sets', 'deleted']);
  });

  it('starts an unreferenced file\'s wait at the deletion of its post, so deleting a post is not an instant purge', async () => {
    lastDeletedAt = new Date(T0.getTime() + 30 * DAY);
    expect(await service.evaluate(media())).toEqual({
      purge: true,
      reason: 'unreferenced',
      purgeAt: new Date(lastDeletedAt.getTime() + 7 * DAY),
    });
  });

  it('does not read the deletion clock for a file a live post carries', async () => {
    rows = [row()];
    await service.evaluate(media());
    expect(calls).toEqual(['groups', 'rows', 'sets']);
  });
});

describe('api.media-retention: MediaRetentionService.purgeDue', () => {
  const NOW = new Date(T0.getTime() + 10 * DAY);
  const savedDays = process.env.MEDIA_RETENTION_DAYS;
  const savedErrorDays = process.env.MEDIA_RETENTION_ERROR_DAYS;
  let medias: any[];
  let posts: RetentionPostRow[];
  let referenceFor: Record<string, string[]>;
  let afterClaim: (() => void) | undefined;
  let service: MediaRetentionService;
  let claimCalls: string[];
  let releaseCalls: string[];
  let candidateCalls: number;

  // A stored media row of the phone, old enough to be due.
  const stored = (id: string, patch: Record<string, unknown> = {}) => {
    const m = {
      id,
      name: `${id}.mp4`,
      organizationId: 'org-1',
      origin: 'mobile',
      purgedAt: null,
      createdAt: T0,
      ...patch,
    };
    medias.push(m);
    referenceFor[id] = ['g-' + id];
    posts.push(row({ group: 'g-' + id }));
    return m;
  };

  beforeEach(() => {
    delete process.env.MEDIA_RETENTION_DAYS;
    delete process.env.MEDIA_RETENTION_ERROR_DAYS;
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    medias = [];
    posts = [];
    referenceFor = {};
    afterClaim = undefined;
    claimCalls = [];
    releaseCalls = [];
    candidateCalls = 0;
    const repository = {
      findPurgeCandidates: async (
        createdBefore: Date,
        take: number,
        afterId?: string
      ) => {
        candidateCalls++;
        // The database's order, a cursor that works on any row, then the filter; rows are copies
        const ordered = medias
          .filter((m) => m.origin === 'mobile' && m.createdAt <= createdBefore)
          .sort((a, b) => a.createdAt - b.createdAt);
        const from = afterId ? ordered.findIndex((m) => m.id === afterId) + 1 : 0;
        return ordered
          .slice(from)
          .filter((m) => m.purgedAt === null)
          .slice(0, take)
          .map((m) => ({ ...m }));
      },
      // One statement in the database; here the same check and write with no await in between
      claimPurge: async (_org: string, id: string, at: Date) => {
        const found = medias.find(
          (m) => m.id === id && m.origin === 'mobile' && m.purgedAt === null
        );
        if (found) {
          found.purgedAt = at;
          claimCalls.push(id);
          afterClaim?.();
        }
        return !!found;
      },
      releasePurge: async (_org: string, id: string) => {
        const found = medias.find((m) => m.id === id && m.purgedAt !== null);
        if (found) {
          found.purgedAt = null;
          releaseCalls.push(id);
        }
        return !!found;
      },
      // The groups of the posts that carry the file, by the id in the file name
      findReferencingGroups: async (_org: string, m: { id: string }) =>
        referenceFor[m.id] || [],
      findGroupRows: async (_org: string, groups: string[]) =>
        posts.filter((p) => groups.includes(p.group)),
      countSetReferences: async () => 0,
      findLastDeletedAt: async () => null,
      findPurgedIds: async (_org: string, ids: string[]) =>
        medias.filter((m) => ids.includes(m.id) && m.purgedAt).map((m) => m.id),
    } as unknown as MediaRetentionRepository;
    service = new MediaRetentionService(repository);
  });

  afterAll(() => {
    for (const [name, value] of [
      ['MEDIA_RETENTION_DAYS', savedDays],
      ['MEDIA_RETENTION_ERROR_DAYS', savedErrorDays],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('deletes the R2 object by its key and marks the row purged', async () => {
    const m = stored('a');
    const result = await service.purgeDue(NOW);
    expect(result).toEqual({
      scanned: 1,
      purged: 1,
      kept: 0,
      failed: 0,
      cursor: null,
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'a.mp4',
    });
    expect(m.purgedAt).toEqual(NOW);
  });

  it('keeps a file that is not due yet, without claiming it', async () => {
    stored('a', { createdAt: new Date(NOW.getTime() - HOUR) });
    posts = [row({ group: 'g-a', updatedAt: new Date(NOW.getTime() - HOUR) })];
    expect(await service.purgeDue(NOW)).toMatchObject({ purged: 0 });
    expect(claimCalls).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps a file a queued post still carries', async () => {
    stored('a');
    posts = [row({ group: 'g-a', state: 'QUEUE', releaseURL: null })];
    expect(await service.purgeDue(NOW)).toEqual({
      scanned: 1,
      purged: 0,
      kept: 1,
      failed: 0,
      cursor: null,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does nothing when MEDIA_RETENTION_DAYS is -1', async () => {
    process.env.MEDIA_RETENTION_DAYS = '-1';
    stored('a');
    expect(await service.purgeDue(NOW)).toEqual({
      scanned: 0,
      purged: 0,
      kept: 0,
      failed: 0,
      cursor: null,
    });
    expect(candidateCalls).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('never touches a row without the phone origin', async () => {
    const web = stored('web', { origin: null });
    expect(await service.purgeDue(NOW)).toMatchObject({ scanned: 0 });
    expect(web.purgedAt).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('skips a row another run claimed first, and deletes nothing for it', async () => {
    const m = stored('a');
    // The other run claims between this run's first look and its claim
    const original = (service as any)._mediaRetentionRepository.claimPurge;
    (service as any)._mediaRetentionRepository.claimPurge = async (
      ...args: any[]
    ) => {
      m.purgedAt = new Date(NOW.getTime() - 1);
      return original(...args);
    };
    expect(await service.purgeDue(NOW)).toMatchObject({ purged: 0, kept: 1 });
    expect(mockSend).not.toHaveBeenCalled();
    expect(m.purgedAt).toEqual(new Date(NOW.getTime() - 1));
  });

  it('releases the claim and deletes nothing when a post took the file after the first look', async () => {
    const m = stored('a');
    afterClaim = () => {
      posts.push(row({ group: 'g-new', state: 'QUEUE', releaseURL: null }));
      referenceFor.a = ['g-a', 'g-new'];
    };
    expect(await service.purgeDue(NOW)).toMatchObject({ purged: 0, kept: 1 });
    expect(claimCalls).toEqual(['a']);
    expect(releaseCalls).toEqual(['a']);
    expect(m.purgedAt).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('puts the claim back when R2 fails, so the next run retries', async () => {
    const m = stored('a');
    mockSend.mockRejectedValueOnce(new Error('R2 down'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await service.purgeDue(NOW)).toMatchObject({ purged: 0, failed: 1 });
    log.mockRestore();
    expect(m.purgedAt).toBeNull();
    expect(await service.purgeDue(NOW)).toMatchObject({ purged: 1, failed: 0 });
    expect(m.purgedAt).toEqual(NOW);
  });

  it('treats an object already gone as deleted', async () => {
    const m = stored('a');
    mockSend.mockRejectedValueOnce({ name: 'NoSuchKey' });
    expect(await service.purgeDue(NOW)).toMatchObject({ purged: 1 });
    expect(m.purgedAt).toEqual(NOW);
  });

  it('goes on with the next row after one fails', async () => {
    stored('a');
    const b = stored('b', { createdAt: new Date(T0.getTime() + HOUR) });
    mockSend.mockRejectedValueOnce(new Error('R2 down'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await service.purgeDue(NOW)).toMatchObject({
      scanned: 2,
      purged: 1,
      failed: 1,
    });
    log.mockRestore();
    expect(b.purgedAt).toEqual(NOW);
  });

  it('reads a second page when the first is full of kept files', async () => {
    for (let i = 0; i < MEDIA_PURGE_BATCH; i++) {
      stored(`old-${i}`, { createdAt: new Date(T0.getTime() + i) });
      posts[posts.length - 1] = row({
        group: `g-old-${i}`,
        state: 'QUEUE',
        releaseURL: null,
      });
    }
    const due = stored('due', { createdAt: new Date(T0.getTime() + DAY) });
    expect(await service.purgeDue(NOW)).toMatchObject({
      scanned: MEDIA_PURGE_BATCH + 1,
      purged: 1,
    });
    expect(due.purgedAt).toEqual(NOW);
  });
});

describe('api.media-retention: MediaRetentionService.purgeDue cursor', () => {
  const NOW = new Date(T0.getTime() + 10 * DAY);
  const PAGES = MEDIA_PURGE_MAX_PAGES * MEDIA_PURGE_BATCH;
  const savedDays = process.env.MEDIA_RETENTION_DAYS;
  let medias: any[];
  let service: MediaRetentionService;

  beforeEach(() => {
    delete process.env.MEDIA_RETENTION_DAYS;
    delete process.env.MEDIA_RETENTION_ERROR_DAYS;
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    medias = [];
    // Every file is held open by a queued post, the rows a purge can never take
    const repository = {
      findPurgeCandidates: async (
        _createdBefore: Date,
        take: number,
        afterId?: string
      ) => {
        const at = afterId ? medias.findIndex((m) => m.id === afterId) : -1;
        if (afterId && at === -1) {
          return [];
        }
        return medias
          .slice(at + 1)
          .filter((m) => m.purgedAt === null)
          .slice(0, take)
          .map((m) => ({ ...m }));
      },
      findReferencingGroups: async (_org: string, m: { id: string }) => [
        'g-' + m.id,
      ],
      findGroupRows: async (_org: string, groups: string[]) =>
        groups.map((g) =>
          row({ group: g, state: 'QUEUE', releaseURL: null })
        ),
      countSetReferences: async () => 0,
      findLastDeletedAt: async () => null,
      claimPurge: async (_org: string, id: string, at: Date) => {
        const found = medias.find((m) => m.id === id && m.purgedAt === null);
        if (found) {
          found.purgedAt = at;
        }
        return !!found;
      },
      releasePurge: async () => true,
    } as unknown as MediaRetentionRepository;
    service = new MediaRetentionService(repository);
  });

  afterAll(() => {
    if (savedDays === undefined) {
      delete process.env.MEDIA_RETENTION_DAYS;
    } else {
      process.env.MEDIA_RETENTION_DAYS = savedDays;
    }
  });

  const add = (id: string) => {
    medias.push({
      id,
      name: `${id}.mp4`,
      organizationId: 'org-1',
      origin: 'mobile',
      purgedAt: null,
      createdAt: T0,
    });
  };

  it('answers no cursor when the end of the rows was reached', async () => {
    add('a');
    const result = await service.purgeDue(NOW);
    expect(result).toMatchObject({ scanned: 1, cursor: null });
  });

  it('continues after the cursor, so 500 rows held open cannot hide the next ones', async () => {
    for (let i = 0; i < PAGES; i++) {
      add(`held-${i}`);
    }
    add('tail');

    const first = await service.purgeDue(NOW);
    expect(first).toMatchObject({
      scanned: PAGES,
      cursor: `held-${PAGES - 1}`,
    });

    // The next run starts after the 500th row and reaches the one the first run never read
    const second = await service.purgeDue(NOW, first.cursor);
    expect(second).toMatchObject({ scanned: 1, cursor: null });

    // At the end the cursor is null, so the run after wraps to the oldest row
    const third = await service.purgeDue(NOW, second.cursor);
    expect(third).toMatchObject({ scanned: PAGES, cursor: `held-${PAGES - 1}` });
  });

  it('answers a null cursor when the cursor row no longer exists, so the next run wraps', async () => {
    add('a');
    const result = await service.purgeDue(NOW, 'gone');
    expect(result).toMatchObject({ scanned: 0, cursor: null });
  });
});

describe('api.media-retention: MediaRetentionService.assertNotPurged', () => {
  const service = (purged: string[]) =>
    new MediaRetentionService({
      findPurgedIds: async (_org: string, ids: string[]) =>
        ids.filter((id) => purged.includes(id)),
    } as unknown as MediaRetentionRepository);

  it('refuses with 410 MEDIA_PURGED when a named media was purged', async () => {
    let error: any;
    try {
      await service(['m2']).assertNotPurged('org-1', ['m1', 'm2']);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MediaPurgedException);
    expect(error.getStatus()).toBe(410);
    expect(error.getResponse()).toMatchObject({
      statusCode: 410,
      code: 'MEDIA_PURGED',
    });
  });

  it('lets a post through when none of its media was purged', async () => {
    await expect(
      service(['other']).assertNotPurged('org-1', ['m1'])
    ).resolves.toBeUndefined();
  });
});
