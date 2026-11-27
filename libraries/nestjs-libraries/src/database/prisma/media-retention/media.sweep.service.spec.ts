// api.media-retention (RET-B3): the web delete that frees the R2 object, the soft-deleted backlog sweep
// and the orphan object sweep. Runs on hand-made repositories and a hand-made R2 client, so it needs no
// database or R2.
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  MEDIA_SWEEP_BATCH,
  MEDIA_SWEEP_MAX_PAGES,
  MediaSweepService,
  ORPHAN_MAX_CHECKS,
} from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.sweep.service';
import { MediaSweepRepository } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.sweep.repository';
import { MediaRetentionService } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.service';
import { MediaRetentionRepository } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.repository';

const mockSend = jest.fn();

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: (...args: unknown[]) => mockSend(...args) },
  R2_BUCKET: 'test-bucket',
}));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-15T00:00:00.000Z');
const URL = 'https://platform.example/post/1';

const ENV = [
  'STORAGE_PROVIDER',
  'MEDIA_RETENTION_DAYS',
  'MEDIA_RETENTION_ERROR_DAYS',
  'MEDIA_SWEEP_DELETE',
] as const;

interface FakeMedia {
  id: string;
  name: string;
  organizationId: string;
  status: string;
  deletedAt: Date | null;
  purgedAt: Date | null;
  createdAt: Date;
  posterKey?: string | null;
}

let medias: FakeMedia[];
let posts: any[];
let referenceFor: Record<string, string[]>;
let setsFor: Record<string, number>;
let foreign: Record<string, string>;
let anyRefs: Record<string, string>;
let claimCalls: string[];
let releaseCalls: string[];
let posterClaims: string[];
let posterReleases: string[];
let listPages: Array<Array<{ Key: string; LastModified: Date; Size: number }>>;
let listCalls: any[];
let service: MediaSweepService;

const savedEnv: Record<string, string | undefined> = {};

// A soft-deleted media row with no post.
const deleted = (id: string, patch: Partial<FakeMedia> = {}) => {
  const m: FakeMedia = {
    id,
    name: `${id}.mp4`,
    organizationId: 'org-1',
    status: 'ready',
    deletedAt: new Date(NOW.getTime() - DAY),
    purgedAt: null,
    createdAt: new Date(NOW.getTime() - 5 * DAY),
    ...patch,
  };
  medias.push(m);
  return m;
};

// A post row of a group that carries the media `id`.
const carriedBy = (id: string, patch: Record<string, unknown> = {}) => {
  const group = `g-${id}-${posts.length}`;
  referenceFor[id] = [...(referenceFor[id] || []), group];
  posts.push({
    id: `p-${posts.length}`,
    group,
    state: 'PUBLISHED',
    releaseURL: URL,
    intervalInDays: null,
    parentPostId: null,
    delay: 0,
    updatedAt: new Date(NOW.getTime() - 3 * DAY),
    ...patch,
  });
};

// The R2 answer to a listing page by its position, and to every delete.
const r2 = () => async (command: unknown) => {
  if (command instanceof ListObjectsV2Command) {
    listCalls.push((command as any).input);
    const startAfter = (command as any).input.StartAfter as string | undefined;
    const all = listPages.flat();
    const rest = startAfter ? all.filter((o) => o.Key > startAfter) : all;
    const page = rest.slice(0, (command as any).input.MaxKeys);
    return { Contents: page, IsTruncated: rest.length > page.length };
  }
  return {};
};

const deleteCalls = () =>
  mockSend.mock.calls
    .map((c) => c[0])
    .filter((c) => !(c instanceof ListObjectsV2Command))
    .map((c) => c.input);

beforeEach(() => {
  for (const name of ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.STORAGE_PROVIDER = 'cloudflare';
  mockSend.mockReset();
  mockSend.mockImplementation(r2());
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  medias = [];
  posts = [];
  referenceFor = {};
  setsFor = {};
  foreign = {};
  anyRefs = {};
  claimCalls = [];
  releaseCalls = [];
  posterClaims = [];
  posterReleases = [];
  listPages = [];
  listCalls = [];

  const sweepRepository = {
    findDeletedCandidates: async (take: number, afterId?: string) => {
      const ordered = medias
        .filter(
          (m) =>
            m.deletedAt !== null &&
            (m.purgedAt === null || !!m.posterKey) &&
            m.status !== 'processing' &&
            m.name !== ''
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const at = afterId ? ordered.findIndex((m) => m.id === afterId) : -1;
      if (afterId && at === -1) {
        return [];
      }
      return ordered.slice(at + 1, at + 1 + take).map((m) => ({ ...m }));
    },
    claimDeleted: async (_org: string, id: string, at: Date) => {
      const found = medias.find(
        (m) => m.id === id && m.deletedAt !== null && m.purgedAt === null
      );
      if (found) {
        found.purgedAt = at;
        claimCalls.push(id);
      }
      return !!found;
    },
    releaseDeleted: async (_org: string, id: string) => {
      const found = medias.find((m) => m.id === id && m.purgedAt !== null);
      if (found) {
        found.purgedAt = null;
        releaseCalls.push(id);
      }
      return !!found;
    },
    claimPoster: async (_org: string, id: string, key: string) => {
      const found = medias.find(
        (m) => m.id === id && m.deletedAt !== null && m.posterKey === key
      );
      if (found) {
        found.posterKey = null;
        posterClaims.push(key);
      }
      return !!found;
    },
    releasePoster: async (_org: string, id: string, key: string) => {
      const found = medias.find((m) => m.id === id && !m.posterKey);
      if (found) {
        found.posterKey = key;
        posterReleases.push(key);
      }
      return !!found;
    },
    countOtherUsers: async (id: string, key: string) =>
      medias.filter((m) => m.id !== id && m.deletedAt === null && m.name === key)
        .length,
    findForeignReference: async (key: string) => foreign[key] || null,
    findAnyReference: async (key: string) => anyRefs[key] || null,
    findNamedKeys: async (keys: string[]) =>
      medias
        .flatMap((m) => [m.name, m.posterKey || ''])
        .filter((k) => keys.includes(k)),
  } as unknown as MediaSweepRepository;

  const retentionRepository = {
    findReferencingGroups: async (_org: string, m: { id: string }) =>
      referenceFor[m.id] || [],
    findGroupRows: async (_org: string, groups: string[]) =>
      posts.filter((p) => groups.includes(p.group)),
    countSetReferences: async (_org: string, m: { id: string }) =>
      setsFor[m.id] || 0,
  } as unknown as MediaRetentionRepository;

  service = new MediaSweepService(
    sweepRepository,
    new MediaRetentionService(retentionRepository)
  );
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const name of ENV) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
});

describe('api.media-retention: the poster is freed with the media (RET-B4)', () => {
  it('deletes the poster object after the video when the user deletes the media', async () => {
    const m = deleted('a', { posterKey: 'posterkey00000000001.jpg' });
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
    expect(deleteCalls()).toEqual([
      { Bucket: 'test-bucket', Key: 'a.mp4' },
      { Bucket: 'test-bucket', Key: 'posterkey00000000001.jpg' },
    ]);
    expect(m.posterKey).toBeNull();
    expect(m.purgedAt).toEqual(NOW);
  });

  it('keeps the poster while the video is kept for a queued post', async () => {
    const m = deleted('a', { posterKey: 'posterkey00000000001.jpg' });
    carriedBy('a', { state: 'QUEUE', releaseURL: null });
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(deleteCalls()).toEqual([]);
    expect(m.posterKey).toBe('posterkey00000000001.jpg');
  });

  it('frees only the poster of a media whose video was purged earlier', async () => {
    const m = deleted('a', {
      purgedAt: new Date(NOW.getTime() - 2 * DAY),
      posterKey: 'posterkey00000000001.jpg',
    });
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
    expect(deleteCalls()).toEqual([
      { Bucket: 'test-bucket', Key: 'posterkey00000000001.jpg' },
    ]);
    expect(claimCalls).toEqual([]);
  });

  it('keeps the claim and puts the poster key back when the poster delete fails, so the sweep retries the poster alone', async () => {
    const m = deleted('a', { posterKey: 'posterkey00000000001.jpg' });
    mockSend.mockImplementation(async (command: any) => {
      if (command.input.Key === 'posterkey00000000001.jpg') {
        throw new Error('socket hang up');
      }
      return {};
    });
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(m.posterKey).toBe('posterkey00000000001.jpg');
    expect(m.purgedAt).toEqual(NOW);
    expect(releaseCalls).toEqual([]);
    expect(posterReleases).toEqual(['posterkey00000000001.jpg']);

    mockSend.mockImplementation(r2());
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
    expect(m.posterKey).toBeNull();
  });

  it('does not delete a poster key that is not upload-shaped', async () => {
    const m = deleted('a', { posterKey: 'folder/poster.jpg' });
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
    expect(deleteCalls()).toEqual([{ Bucket: 'test-bucket', Key: 'a.mp4' }]);
  });

  it('the backlog sweep reads a purged row that still has a poster, and a dry run deletes nothing', async () => {
    const m = deleted('a', {
      purgedAt: new Date(NOW.getTime() - 2 * DAY),
      posterKey: 'posterkey00000000001.jpg',
    });
    const dry = await service.sweepDeleted(NOW);
    expect(dry).toMatchObject({ scanned: 1, freed: 1, dryRun: true });
    expect(deleteCalls()).toEqual([]);

    process.env.MEDIA_SWEEP_DELETE = 'true';
    const live = await service.sweepDeleted(NOW);
    expect(live).toMatchObject({ scanned: 1, freed: 1, dryRun: false });
    expect(deleteCalls()).toEqual([
      { Bucket: 'test-bucket', Key: 'posterkey00000000001.jpg' },
    ]);
    expect(m.posterKey).toBeNull();
  });

  it('the orphan sweep does not count a key a poster names as unnamed', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    deleted('a', {
      deletedAt: null,
      posterKey: 'posterkey00000000001.jpg',
      purgedAt: new Date(NOW.getTime() - 2 * DAY),
    });
    listPages = [
      [
        {
          Key: 'posterkey00000000001.jpg',
          LastModified: new Date(NOW.getTime() - 5 * DAY),
          Size: 50000,
        },
      ],
    ];
    const out = await service.sweepOrphans(NOW);
    expect(out.orphans).toBe(0);
    expect(deleteCalls()).toEqual([]);
  });
});

describe('api.media-retention: web delete frees the object (RET-B3)', () => {
  it('deletes the R2 object by its key and marks the row purged when nothing needs it', async () => {
    const m = deleted('a');
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
    expect(deleteCalls()).toEqual([{ Bucket: 'test-bucket', Key: 'a.mp4' }]);
    expect(m.purgedAt).toEqual(NOW);
    expect(m.deletedAt).not.toBeNull();
  });

  it('keeps the object, and the row soft-deleted only, while a queued post carries it', async () => {
    const m = deleted('a');
    carriedBy('a', { state: 'QUEUE', releaseURL: null });
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(deleteCalls()).toEqual([]);
    expect(releaseCalls).toEqual(['a']);
    expect(m.purgedAt).toBeNull();
  });

  it('keeps the object while a draft, a repeating post or a failed post (Retry) carries it', async () => {
    for (const patch of [
      { state: 'DRAFT', releaseURL: null },
      { intervalInDays: 7 },
      { state: 'ERROR', releaseURL: null },
    ]) {
      mockSend.mockClear();
      const m = deleted(`x${medias.length}`);
      carriedBy(m.id, patch);
      expect(await service.freeDeletedObject(m, NOW)).toBe(false);
      expect(deleteCalls()).toEqual([]);
    }
  });

  it('frees the object once the error window of a failed channel has passed', async () => {
    const m = deleted('a');
    carriedBy('a', {
      state: 'ERROR',
      releaseURL: null,
      updatedAt: new Date(NOW.getTime() - 8 * DAY),
    });
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
    expect(deleteCalls()).toHaveLength(1);
  });

  it('frees the object when only a published post carries it', async () => {
    const m = deleted('a');
    carriedBy('a');
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
    expect(deleteCalls()).toHaveLength(1);
  });

  it('keeps the object while a set of the workspace names it', async () => {
    const m = deleted('a');
    setsFor.a = 1;
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(deleteCalls()).toEqual([]);
  });

  it('never deletes an object another live media row names by the same key', async () => {
    const m = deleted('a', { name: 'shared.mp4' });
    medias.push({
      ...m,
      id: 'other',
      organizationId: 'org-2',
      deletedAt: null,
    });
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(deleteCalls()).toEqual([]);
    expect(m.purgedAt).toBeNull();
  });

  it('frees the object when the other row naming the key is itself deleted', async () => {
    const m = deleted('a', { name: 'shared.mp4' });
    deleted('b', { name: 'shared.mp4' });
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
  });

  it('keeps the object when another workspace or a picture names it', async () => {
    const m = deleted('a');
    foreign['a.mp4'] = 'channel picture';
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(deleteCalls()).toEqual([]);
  });

  it('does not fail the user delete when R2 fails, and leaves the row for the sweep', async () => {
    const m = deleted('a');
    mockSend.mockRejectedValueOnce(new Error('R2 down'));
    await expect(service.freeDeletedObject(m, NOW)).resolves.toBe(false);
    expect(m.purgedAt).toBeNull();
    expect(m.deletedAt).not.toBeNull();
  });

  it('treats an object already gone as freed', async () => {
    const m = deleted('a');
    mockSend.mockRejectedValueOnce({ name: 'NoSuchKey' });
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
    expect(m.purgedAt).toEqual(NOW);
  });

  it('never deletes an empty key, a folder or an odd name a client wrote', async () => {
    for (const name of ['', 'folder/a.mp4', '../a.mp4', 'a.mp4?x=1', 'a b.mp4']) {
      const m = deleted(`n${medias.length}`, { name });
      expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    }
    expect(claimCalls).toEqual([]);
    expect(deleteCalls()).toEqual([]);
  });

  it('leaves a file the normalizer is still working on', async () => {
    const m = deleted('a', { status: 'processing' });
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(deleteCalls()).toEqual([]);
  });

  it('does nothing when storage is not R2', async () => {
    process.env.STORAGE_PROVIDER = 'local';
    const m = deleted('a');
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(claimCalls).toEqual([]);
    expect(deleteCalls()).toEqual([]);
  });

  it('frees the object of a user delete even when MEDIA_RETENTION_DAYS is -1', async () => {
    process.env.MEDIA_RETENTION_DAYS = '-1';
    const m = deleted('a');
    expect(await service.freeDeletedObject(m, NOW)).toBe(true);
  });

  it('does not delete when another caller already claimed the row', async () => {
    const m = deleted('a', { purgedAt: new Date(NOW.getTime() - 1) });
    expect(await service.freeDeletedObject(m, NOW)).toBe(false);
    expect(deleteCalls()).toEqual([]);
  });
});

describe('api.media-retention: sweepDeleted (RET-B3)', () => {
  it('is a dry run unless MEDIA_SWEEP_DELETE is true: reads, counts, changes nothing', async () => {
    const m = deleted('a');
    const result = await service.sweepDeleted(NOW);
    expect(result).toEqual({
      scanned: 1,
      freed: 1,
      kept: 0,
      failed: 0,
      cursor: null,
      dryRun: true,
    });
    expect(claimCalls).toEqual([]);
    expect(deleteCalls()).toEqual([]);
    expect(m.purgedAt).toBeNull();
  });

  it('frees the backlog row and marks it purged when MEDIA_SWEEP_DELETE is true', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    const m = deleted('a');
    const kept = deleted('b');
    carriedBy('b', { state: 'QUEUE', releaseURL: null });
    const result = await service.sweepDeleted(NOW);
    expect(result).toMatchObject({
      scanned: 2,
      freed: 1,
      kept: 1,
      failed: 0,
      dryRun: false,
    });
    expect(deleteCalls()).toEqual([{ Bucket: 'test-bucket', Key: 'a.mp4' }]);
    expect(m.purgedAt).toEqual(NOW);
    expect(kept.purgedAt).toBeNull();
  });

  it('claims the row before it touches R2, and a second run finds nothing to do', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    deleted('a');
    await service.sweepDeleted(NOW);
    expect(claimCalls).toEqual(['a']);
    mockSend.mockClear();
    expect(await service.sweepDeleted(NOW)).toMatchObject({ scanned: 0 });
    expect(deleteCalls()).toEqual([]);
  });

  it('does nothing when MEDIA_RETENTION_DAYS is -1', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    process.env.MEDIA_RETENTION_DAYS = '-1';
    deleted('a');
    expect(await service.sweepDeleted(NOW)).toMatchObject({ scanned: 0 });
    expect(deleteCalls()).toEqual([]);
  });

  it('counts a failing row, puts its claim back and goes on with the next', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    const a = deleted('a');
    const b = deleted('b', { createdAt: new Date(NOW.getTime() - 4 * DAY) });
    mockSend.mockRejectedValueOnce(new Error('R2 down'));
    const result = await service.sweepDeleted(NOW);
    expect(result).toMatchObject({ scanned: 2, freed: 1, failed: 1 });
    expect(a.purgedAt).toBeNull();
    expect(b.purgedAt).toEqual(NOW);
  });

  it('carries a cursor when its pages were full, so held rows cannot hide the rest', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    const pages = MEDIA_SWEEP_MAX_PAGES * MEDIA_SWEEP_BATCH;
    for (let i = 0; i < pages; i++) {
      const m = deleted(`held${i}`, { createdAt: new Date(NOW.getTime() - 9 * DAY + i) });
      carriedBy(m.id, { state: 'QUEUE', releaseURL: null });
    }
    deleted('tail', { createdAt: new Date(NOW.getTime() - 2 * DAY) });

    const first = await service.sweepDeleted(NOW);
    expect(first).toMatchObject({ scanned: pages, cursor: `held${pages - 1}` });
    const second = await service.sweepDeleted(NOW, first.cursor);
    expect(second).toMatchObject({ scanned: 1, freed: 1, cursor: null });
  });
});

describe('api.media-retention: sweepOrphans (RET-B3)', () => {
  const OLD = new Date(NOW.getTime() - 3 * DAY);
  const YOUNG = new Date(NOW.getTime() - HOUR);
  const object = (Key: string, LastModified = OLD) => ({
    Key,
    LastModified,
    Size: 1024,
  });

  it('is a dry run unless MEDIA_SWEEP_DELETE is true: lists and logs, deletes nothing', async () => {
    listPages = [[object('AbCdEfGhIj.mp4')]];
    const result = await service.sweepOrphans(NOW);
    expect(result).toEqual({
      listed: 1,
      orphans: 1,
      deleted: 0,
      kept: 0,
      failed: 0,
      cursor: null,
      dryRun: true,
    });
    expect(deleteCalls()).toEqual([]);
  });

  it('deletes an old upload-shaped object no media row and no table names, by its single key', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    listPages = [[object('AbCdEfGhIj.mp4')]];
    const result = await service.sweepOrphans(NOW);
    expect(result).toMatchObject({ orphans: 1, deleted: 1, dryRun: false });
    expect(deleteCalls()).toEqual([
      { Bucket: 'test-bucket', Key: 'AbCdEfGhIj.mp4' },
    ]);
  });

  it('keeps an object a media row names, a young object and an object a table still names', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    deleted('x', { name: 'NamedByRow1.mp4', deletedAt: null });
    anyRefs['UsedByPost01.png'] = 'post';
    listPages = [
      [
        object('NamedByRow1.mp4'),
        object('FreshUpload1.mp4', YOUNG),
        object('UsedByPost01.png'),
      ],
    ];
    const result = await service.sweepOrphans(NOW);
    expect(result).toMatchObject({ orphans: 0, deleted: 0, kept: 1 });
    expect(deleteCalls()).toEqual([]);
  });

  it('keeps an object a soft-deleted media row still names (the backlog sweep owns it)', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    deleted('x', { name: 'SoftDelete01.mp4' });
    listPages = [[object('SoftDelete01.mp4')]];
    await service.sweepOrphans(NOW);
    expect(deleteCalls()).toEqual([]);
  });

  it('keeps the key of an open or recent mobile upload', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    anyRefs['PhoneUpload0000000000.mp4'] = 'mobile upload';
    listPages = [[object('PhoneUpload0000000000.mp4')]];
    expect(await service.sweepOrphans(NOW)).toMatchObject({
      orphans: 0,
      kept: 1,
    });
    expect(deleteCalls()).toEqual([]);
  });

  it('never touches an object that is not upload-shaped', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    listPages = [
      [
        object('clip-3f2a9c-source.mp4'),
        object('clipping-3f2a9c-transcript.json'),
        object('folder/AbCdEfGhIj.mp4'),
        object('short.mp4'),
        object('AbCdEfGhIj'),
      ],
    ];
    const result = await service.sweepOrphans(NOW);
    expect(result).toMatchObject({ listed: 5, orphans: 0, deleted: 0 });
    expect(deleteCalls()).toEqual([]);
  });

  it('reads the references once more before it deletes, so a row written since wins', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    listPages = [[object('AbCdEfGhIj.mp4')]];
    let looks = 0;
    (service as any)._mediaSweepRepository.findAnyReference = async () =>
      ++looks === 1 ? null : 'post';
    const result = await service.sweepOrphans(NOW);
    expect(result).toMatchObject({ orphans: 0, deleted: 0, kept: 1 });
    expect(deleteCalls()).toEqual([]);
  });

  it('does nothing when MEDIA_RETENTION_DAYS is -1, and never lists', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    process.env.MEDIA_RETENTION_DAYS = '-1';
    listPages = [[object('AbCdEfGhIj.mp4')]];
    expect(await service.sweepOrphans(NOW)).toMatchObject({ listed: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does nothing when storage is not R2', async () => {
    process.env.STORAGE_PROVIDER = 'local';
    listPages = [[object('AbCdEfGhIj.mp4')]];
    expect(await service.sweepOrphans(NOW)).toMatchObject({ listed: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('counts a failed delete and goes on with the next key', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    listPages = [[object('AaaaaaaaaA.mp4'), object('BbbbbbbbbB.mp4')]];
    mockSend.mockImplementationOnce(r2());
    mockSend.mockRejectedValueOnce(new Error('R2 down'));
    const result = await service.sweepOrphans(NOW);
    expect(result).toMatchObject({ deleted: 1, failed: 1 });
  });

  it('stops at the check limit and lists on after the last key it finished', async () => {
    process.env.MEDIA_SWEEP_DELETE = 'true';
    const keys = Array.from(
      { length: ORPHAN_MAX_CHECKS + 5 },
      (_, i) => `Key${String(i).padStart(7, '0')}.mp4`
    );
    listPages = [keys.map((k) => object(k))];

    const first = await service.sweepOrphans(NOW);
    expect(first).toMatchObject({ deleted: ORPHAN_MAX_CHECKS });
    expect(first.cursor).toBe(keys[ORPHAN_MAX_CHECKS - 1]);

    const second = await service.sweepOrphans(NOW, first.cursor);
    expect(listCalls[listCalls.length - 1]).toMatchObject({
      StartAfter: keys[ORPHAN_MAX_CHECKS - 1],
    });
    expect(second).toMatchObject({ deleted: 5, cursor: null });
  });
});
