// api.mobile-direct-upload (DU-B2..DU-B4): create, sign parts, status, complete, abort and the sweep of the
// phone's direct upload, and (ai.video-captions, AC3) the speech audio of a caption job that uses the same routes
// with `purpose: 'transcript_audio'`, and (ai.video-editing, T2.1) the proxy video of an AI edit job with
// `purpose: 'edit_proxy'`. Runs on a hand-made repository, media service, R2 client and presigner, so
// it needs no database or R2.
import { HttpException } from '@nestjs/common';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { MobileUploadRepository } from '@gitroom/nestjs-libraries/database/prisma/mobile-upload/mobile.upload.repository';
import {
  MOBILE_UPLOAD_AUDIO_MAX_PENDING,
  MOBILE_UPLOAD_EDIT_PROXY_MAX_PENDING,
  MOBILE_UPLOAD_MAX_PENDING,
  MOBILE_UPLOAD_PART_SIZE,
  MOBILE_UPLOAD_POSTER_MAX_BYTES,
  MOBILE_UPLOAD_SWEEP_BATCH,
  MobileUploadService,
} from '@gitroom/nestjs-libraries/database/prisma/mobile-upload/mobile.upload.service';

const mockSend = jest.fn();
const mockSign = jest.fn();
const mockCheckType = jest.fn();
const mockDeleteObject = jest.fn();

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: (...args: unknown[]) => mockSend(...args) },
  R2_BUCKET: 'test-bucket',
  // The extension when the map (video types unless another is given) allows it, as the real one does
  normalizeExtension: (
    name: string,
    types: Record<string, string> = { '.mp4': 'video/mp4' }
  ) => {
    const ext = (/\.[a-z0-9]+$/i.exec(name)?.[0] || '').toLowerCase();
    return types[ext] ? ext : null;
  },
  multipartExtToMime: () => ({ '.mp4': 'video/mp4' }),
  TRANSCRIPT_AUDIO_EXT_TO_MIME: { '.wav': 'audio/wav' },
  EDIT_PROXY_EXT_TO_MIME: { '.mp4': 'video/mp4' },
  checkUploadedObjectType: (...args: unknown[]) => mockCheckType(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
  // The magic bytes of the three poster types, as the real one finds them
  posterType: async (data: Buffer) => {
    if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
      return { ext: '.jpg', mime: 'image/jpeg' };
    }
    if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
      return { ext: '.png', mime: 'image/png' };
    }
    return null;
  },
}));

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({ MediaService: class {} })
);

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockSign(...args),
}));

const ORG = 'org-1';
const MIB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

// True for a row the sweep may close: pending past its expiry, completing untouched since the cutoff.
const isStale = (r: any, now: Date, completingBefore: Date) =>
  (r.status === 'pending' && r.expiresAt <= now) ||
  (r.status === 'completing' && r.updatedAt <= completingBefore);

// True for a completed work file (caption audio, edit proxy) untouched since `before`, which the audio sweep
// may close.
const isOldAudio = (r: any, before: Date) =>
  ['transcript_audio', 'edit_proxy'].includes(r.purpose) &&
  r.status === 'completed' &&
  r.updatedAt <= before;

// The error a call rejects with, or undefined when it resolves.
const failure = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return err as HttpException;
  }
  return undefined;
};

// The code of an HttpException of the upload routes.
const codeOf = (err?: HttpException) => (err?.getResponse() as any)?.code;

describe('api.mobile-direct-upload: MobileUploadService', () => {
  const savedMax = process.env.MOBILE_UPLOAD_MAX_BYTES;
  const savedAudioMax = process.env.AI_CAPTIONS_MAX_AUDIO_BYTES;
  const savedProxyMax = process.env.AI_EDIT_MAX_PROXY_BYTES;
  let rows: any[];
  let medias: any[];
  // The upload ids a caption job names
  let captions: string[];
  let headLength: number;
  let repo: any;
  let service: MobileUploadService;

  // A stored upload of the workspace, `partCount` parts long.
  const row = (over: Record<string, unknown> = {}) => {
    const stored = {
      id: 'up-1',
      organizationId: ORG,
      objectKey: 'key.mp4',
      uploadId: 'r2-upload',
      filename: 'a.mp4',
      size: BigInt(40 * MIB),
      partSize: MOBILE_UPLOAD_PART_SIZE,
      partCount: 3,
      status: 'pending',
      ...over,
    };
    rows.push(stored);
    return stored;
  };

  beforeEach(() => {
    delete process.env.MOBILE_UPLOAD_MAX_BYTES;
    delete process.env.AI_CAPTIONS_MAX_AUDIO_BYTES;
    delete process.env.AI_EDIT_MAX_PROXY_BYTES;
    rows = [];
    medias = [];
    captions = [];
    headLength = 40 * MIB;
    mockSend.mockReset();
    mockSign.mockReset();
    mockCheckType.mockReset();
    mockCheckType.mockResolvedValue('ok');
    mockDeleteObject.mockReset();
    mockDeleteObject.mockResolvedValue(undefined);
    process.env.CLOUDFLARE_BUCKET_URL = 'https://cdn.test/bucket';
    mockSign.mockImplementation(
      async (_client: unknown, command: any) =>
        `https://r2.test/${command.input.Key}?part=${command.input.PartNumber}`
    );
    mockSend.mockImplementation(async (command: any) => {
      if (command.constructor.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'r2-upload' };
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        return { ContentLength: headLength };
      }
      return {};
    });
    const repository = {
      create: async (data: any) => {
        const stored = { id: `up-${rows.length + 1}`, status: 'pending', ...data };
        rows.push(stored);
        return stored;
      },
      findByIdAndOrg: async (org: string, id: string) =>
        rows.find((r) => r.id === id && r.organizationId === org) || null,
      // A row with no purpose (made before the column existed) is media
      countPendingByOrg: async (org: string, purpose: string) =>
        rows.filter(
          (r) =>
            r.organizationId === org &&
            r.status === 'pending' &&
            (r.purpose || 'media') === purpose
        ).length,
      // One statement in the database; here the same check and write with no await in between
      transitionStatus: async (
        org: string,
        id: string,
        from: string,
        to: string
      ) => {
        const found = rows.find(
          (r) => r.id === id && r.organizationId === org && r.status === from
        );
        if (found) {
          found.status = to;
        }
        return !!found;
      },
      findStale: async (now: Date, completingBefore: Date, take: number) =>
        rows.filter((r) => isStale(r, now, completingBefore)).slice(0, take),
      // One statement in the database; here the same check and write with no await in between
      expireStale: async (id: string, now: Date, completingBefore: Date) => {
        const found = rows.find(
          (r) => r.id === id && isStale(r, now, completingBefore)
        );
        if (found) {
          found.status = 'expired';
        }
        return !!found;
      },
      hasMedia: async (org: string, objectKey: string) =>
        medias.some((m) => m.org === org && m.name === objectKey),
      markCompleted: async (org: string, id: string, mediaId?: string) => {
        const found = rows.find(
          (r) =>
            r.id === id && r.organizationId === org && r.status === 'completing'
        );
        if (found) {
          found.status = 'completed';
          if (mediaId) {
            found.mediaId = mediaId;
          }
        }
        return !!found;
      },
      findOldAudio: async (before: Date, take: number) =>
        rows.filter((r) => isOldAudio(r, before)).slice(0, take),
      // One statement in the database; here the same check and write with no await in between
      expireAudio: async (id: string, before: Date) => {
        const found = rows.find((r) => r.id === id && isOldAudio(r, before));
        if (found) {
          found.status = 'expired';
        }
        return !!found;
      },
      hasCaption: async (id: string) => captions.includes(id),
    } as unknown as MobileUploadRepository;
    repo = repository;
    const mediaService = {
      saveFile: async (
        org: string,
        name: string,
        path: string,
        originalName?: string,
        origin?: string
      ) => {
        const media = {
          id: `media-${medias.length + 1}`,
          name,
          path,
          org,
          origin,
        };
        medias.push(media);
        return media;
      },
      // One statement in the database; here the same check and write with no await in between
      hasPoster: async (org: string, id: string) =>
        !!medias.find((m) => m.id === id && m.org === org)?.posterKey,
      setPoster: async (org: string, id: string, posterKey: string) => {
        const found = medias.find((m) => m.id === id && m.org === org);
        if (!found || found.posterKey) {
          return false;
        }
        found.posterKey = posterKey;
        return true;
      },
    } as unknown as MediaService;
    service = new MobileUploadService(repository, mediaService);
  });

  afterAll(() => {
    if (savedMax === undefined) {
      delete process.env.MOBILE_UPLOAD_MAX_BYTES;
    } else {
      process.env.MOBILE_UPLOAD_MAX_BYTES = savedMax;
    }
    if (savedAudioMax === undefined) {
      delete process.env.AI_CAPTIONS_MAX_AUDIO_BYTES;
    } else {
      process.env.AI_CAPTIONS_MAX_AUDIO_BYTES = savedAudioMax;
    }
    if (savedProxyMax === undefined) {
      delete process.env.AI_EDIT_MAX_PROXY_BYTES;
    } else {
      process.env.AI_EDIT_MAX_PROXY_BYTES = savedProxyMax;
    }
  });

  describe('create', () => {
    it('opens the R2 upload, stores the row for 24 hours and answers id, partSize and partCount', async () => {
      const out = await service.create(ORG, {
        filename: 'clip.MP4',
        size: 40 * MIB,
      });

      expect(out).toEqual({
        id: 'up-1',
        partSize: MOBILE_UPLOAD_PART_SIZE,
        partCount: 3,
      });
      const command = mockSend.mock.calls[0][0];
      expect(command.input.Bucket).toBe('test-bucket');
      expect(command.input.ContentType).toBe('video/mp4');
      expect(command.input.Key).toMatch(/^[A-Za-z0-9]+\.mp4$/);
      expect(rows[0].objectKey).toBe(command.input.Key);
      expect(rows[0].uploadId).toBe('r2-upload');
      const lifetime = rows[0].expiresAt.getTime() - Date.now();
      expect(lifetime).toBeGreaterThan(23.9 * 3600 * 1000);
      expect(lifetime).toBeLessThanOrEqual(24 * 3600 * 1000);
    });

    it('400 UNSUPPORTED_TYPE for an extension that is not allowed', async () => {
      const err = await failure(
        service.create(ORG, { filename: 'notes.txt', size: MIB })
      );

      expect(err?.getStatus()).toBe(400);
      expect(codeOf(err)).toBe('UNSUPPORTED_TYPE');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('400 FILE_TOO_LARGE above the default 4 GiB and above MOBILE_UPLOAD_MAX_BYTES', async () => {
      const big = await failure(
        service.create(ORG, { filename: 'a.mp4', size: 4 * 1024 * MIB + 1 })
      );
      process.env.MOBILE_UPLOAD_MAX_BYTES = String(10 * MIB);
      const small = await failure(
        service.create(ORG, { filename: 'a.mp4', size: 10 * MIB + 1 })
      );

      expect(big?.getStatus()).toBe(400);
      expect(codeOf(big)).toBe('FILE_TOO_LARGE');
      expect(codeOf(small)).toBe('FILE_TOO_LARGE');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('accepts exactly the limit', async () => {
      const out = await service.create(ORG, {
        filename: 'a.mp4',
        size: 4 * 1024 * MIB,
      });

      expect(out.partCount).toBe(256);
    });

    it('429 TOO_MANY_PENDING_UPLOADS for the sixth pending upload of a workspace', async () => {
      for (let i = 0; i < MOBILE_UPLOAD_MAX_PENDING; i++) {
        row({ id: `p-${i}` });
      }
      row({ id: 'other', organizationId: 'org-2' });
      row({ id: 'done', status: 'completed' });

      const err = await failure(
        service.create(ORG, { filename: 'a.mp4', size: MIB })
      );

      expect(err?.getStatus()).toBe(429);
      expect(codeOf(err)).toBe('TOO_MANY_PENDING_UPLOADS');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('aborts the R2 upload when the row cannot be stored', async () => {
      const failing = new MobileUploadService(
        {
          countPendingByOrg: async () => 0,
          create: async () => {
            throw new Error('database down');
          },
        } as unknown as MobileUploadRepository,
        {} as unknown as MediaService
      );

      const err = await failure(
        failing.create(ORG, { filename: 'a.mp4', size: MIB })
      );

      expect(err?.message).toBe('database down');
      expect(mockSend.mock.calls[1][0].constructor.name).toBe(
        'AbortMultipartUploadCommand'
      );
    });
  });

  describe('signParts', () => {
    it("404 UPLOAD_NOT_FOUND for another workspace's upload", async () => {
      row({ organizationId: 'org-2' });

      const err = await failure(service.signParts(ORG, 'up-1', [1]));

      expect(err?.getStatus()).toBe(404);
      expect(codeOf(err)).toBe('UPLOAD_NOT_FOUND');
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('409 UPLOAD_NOT_PENDING for an upload that is not pending', async () => {
      for (const status of ['completing', 'completed', 'aborted', 'expired']) {
        rows = [];
        row({ status });

        const err = await failure(service.signParts(ORG, 'up-1', [1]));

        expect(err?.getStatus()).toBe(409);
        expect(codeOf(err)).toBe('UPLOAD_NOT_PENDING');
      }
    });

    it('400 INVALID_PARTS for part 0, part partCount+1, a duplicate and a fraction', async () => {
      row();

      for (const numbers of [[0], [4], [1, 1], [1.5], [], [1, 2, 3, 4]]) {
        const err = await failure(service.signParts(ORG, 'up-1', numbers));

        expect(err?.getStatus()).toBe(400);
        expect(codeOf(err)).toBe('INVALID_PARTS');
      }
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('400 INVALID_PARTS for 21 part numbers', async () => {
      row({ partCount: 100, size: BigInt(100 * MOBILE_UPLOAD_PART_SIZE) });

      const err = await failure(
        service.signParts(
          ORG,
          'up-1',
          Array.from({ length: 21 }, (_, i) => i + 1)
        )
      );

      expect(err?.getStatus()).toBe(400);
      expect(codeOf(err)).toBe('INVALID_PARTS');
    });

    it('signs 20 parts for 15 minutes, each for its exact length (the remainder for the last)', async () => {
      row({ partCount: 20, size: BigInt(19 * MOBILE_UPLOAD_PART_SIZE + 5 * MIB) });

      const out = await service.signParts(
        ORG,
        'up-1',
        Array.from({ length: 20 }, (_, i) => i + 1)
      );

      expect(out.expiresIn).toBe(900);
      expect(Object.keys(out.urls)).toHaveLength(20);
      expect(out.urls['1']).toBe('https://r2.test/key.mp4?part=1');
      const lengths = new Map<number, number>(
        mockSign.mock.calls.map(([, command, options]) => {
          expect(options).toEqual({ expiresIn: 900 });
          expect(command.input.UploadId).toBe('r2-upload');
          return [command.input.PartNumber, command.input.ContentLength];
        })
      );
      expect(lengths.get(1)).toBe(MOBILE_UPLOAD_PART_SIZE);
      expect(lengths.get(19)).toBe(MOBILE_UPLOAD_PART_SIZE);
      expect(lengths.get(20)).toBe(5 * MIB);
    });
  });

  describe('status', () => {
    it("404 UPLOAD_NOT_FOUND for another workspace's upload", async () => {
      row({ organizationId: 'org-2' });

      const err = await failure(service.status(ORG, 'up-1'));

      expect(err?.getStatus()).toBe(404);
      expect(codeOf(err)).toBe('UPLOAD_NOT_FOUND');
    });

    it('lists every part R2 has, following the page markers, with the size as a number', async () => {
      row();
      mockSend
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 1, ETag: '"a"', Size: MOBILE_UPLOAD_PART_SIZE }],
          IsTruncated: true,
          NextPartNumberMarker: '1',
        })
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 2, ETag: '"b"', Size: MOBILE_UPLOAD_PART_SIZE }],
          IsTruncated: false,
        });

      const out = await service.status(ORG, 'up-1');

      expect(out).toEqual({
        status: 'pending',
        size: 40 * MIB,
        partSize: MOBILE_UPLOAD_PART_SIZE,
        partCount: 3,
        parts: [
          { n: 1, etag: '"a"', size: MOBILE_UPLOAD_PART_SIZE },
          { n: 2, etag: '"b"', size: MOBILE_UPLOAD_PART_SIZE },
        ],
      });
      expect(mockSend.mock.calls[0][0].input.PartNumberMarker).toBeUndefined();
      expect(mockSend.mock.calls[1][0].input.PartNumberMarker).toBe('1');
    });

    it('marks a pending row expired, with no parts, when R2 has neither the upload nor the object', async () => {
      const stored = row();
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'ListPartsCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        throw Object.assign(new Error('missing'), { name: 'NotFound' });
      });

      const out = await service.status(ORG, 'up-1');

      expect(out.status).toBe('expired');
      expect(out.parts).toEqual([]);
      expect(stored.status).toBe('expired');
    });

    it('keeps a pending row pending, with no parts and no expiry, when R2 lost the upload but holds the finished object', async () => {
      const stored = row();
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'ListPartsCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        return { ContentLength: headLength };
      });

      const out = await service.status(ORG, 'up-1');

      expect(out).toEqual({
        status: 'pending',
        size: 40 * MIB,
        partSize: MOBILE_UPLOAD_PART_SIZE,
        partCount: 3,
        parts: [],
      });
      expect(stored.status).toBe('pending');
      const names = mockSend.mock.calls.map(([c]) => c.constructor.name);
      expect(names).toContain('HeadObjectCommand');
      expect(names).not.toContain('DeleteObjectCommand');
    });

    it('keeps the row pending and answers 502 STORAGE_ERROR when HeadObject cannot say whether the object is there', async () => {
      const stored = row();
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'ListPartsCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        throw new Error('socket hang up');
      });

      const err = await failure(service.status(ORG, 'up-1'));

      expect(err?.getStatus()).toBe(502);
      expect(codeOf(err)).toBe('STORAGE_ERROR');
      expect(stored.status).toBe('pending');
    });

    it('does not ask R2 about an upload that is no longer pending', async () => {
      row({ status: 'completed' });

      const out = await service.status(ORG, 'up-1');

      expect(out.status).toBe('completed');
      expect(out.parts).toEqual([]);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
  describe('complete', () => {
    // The parts list a phone sends for a 3-part upload.
    const parts = [
      { n: 1, etag: '"a"' },
      { n: 2, etag: '"b"' },
      { n: 3, etag: '"c"' },
    ];

    // The names of the R2 commands sent so far, in order.
    const sent = () => mockSend.mock.calls.map(([c]) => c.constructor.name);

    it('completes in R2, checks size and type, creates the media like POST /upload and answers { id, path }', async () => {
      const stored = row();

      const out = await service.complete(ORG, 'up-1', [...parts].reverse());

      expect(out).toEqual({ id: 'media-1', path: 'https://cdn.test/bucket/key.mp4' });
      expect(sent()).toEqual([
        'CompleteMultipartUploadCommand',
        'HeadObjectCommand',
      ]);
      const command = mockSend.mock.calls[0][0];
      expect(command.input.UploadId).toBe('r2-upload');
      expect(command.input.MultipartUpload.Parts).toEqual([
        { PartNumber: 1, ETag: '"a"' },
        { PartNumber: 2, ETag: '"b"' },
        { PartNumber: 3, ETag: '"c"' },
      ]);
      expect(mockCheckType).toHaveBeenCalledWith('key.mp4');
      expect(medias).toHaveLength(1);
      expect(medias[0]).toMatchObject({
        org: ORG,
        name: 'key.mp4',
        path: 'https://cdn.test/bucket/key.mp4',
        origin: 'mobile',
      });
      expect(stored.status).toBe('completed');
      expect(stored.mediaId).toBe('media-1');
    });

    it('answers the same { id, path } on a second complete and creates one media row and one R2 complete', async () => {
      row();

      const first = await service.complete(ORG, 'up-1', parts);
      const second = await service.complete(ORG, 'up-1', parts);

      expect(second).toEqual(first);
      expect(medias).toHaveLength(1);
      expect(
        sent().filter((n) => n === 'CompleteMultipartUploadCommand')
      ).toHaveLength(1);
    });

    it("404 UPLOAD_NOT_FOUND for another workspace's upload", async () => {
      row({ organizationId: 'org-2' });

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(404);
      expect(codeOf(err)).toBe('UPLOAD_NOT_FOUND');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('409 UPLOAD_NOT_PENDING for a completing, aborted or expired upload', async () => {
      for (const status of ['completing', 'aborted', 'expired']) {
        rows = [];
        row({ status });

        const err = await failure(service.complete(ORG, 'up-1', parts));

        expect(err?.getStatus()).toBe(409);
        expect(codeOf(err)).toBe('UPLOAD_NOT_PENDING');
      }
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('400 INVALID_PARTS unless the list is exactly 1..partCount, each with an etag', async () => {
      row();
      const bad: unknown[] = [
        [],
        parts.slice(0, 2),
        [...parts, { n: 4, etag: '"d"' }],
        [parts[0], parts[0], parts[2]],
        [parts[0], parts[1], { n: 4, etag: '"d"' }],
        [parts[0], parts[1], { n: 3, etag: '' }],
        [parts[0], parts[1], { n: 3 }],
        [parts[0], parts[1], { n: 2.5, etag: '"c"' }],
        'nope',
        undefined,
      ];

      for (const list of bad) {
        const err = await failure(service.complete(ORG, 'up-1', list as any));

        expect(err?.getStatus()).toBe(400);
        expect(codeOf(err)).toBe('INVALID_PARTS');
      }
      expect(mockSend).not.toHaveBeenCalled();
      expect(rows[0].status).toBe('pending');
    });

    it('400 SIZE_MISMATCH deletes the object and marks the row aborted', async () => {
      const stored = row();
      headLength = 40 * MIB - 1;

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(400);
      expect(codeOf(err)).toBe('SIZE_MISMATCH');
      expect(sent()).toContain('DeleteObjectCommand');
      expect(mockSend.mock.calls.at(-1)![0].input.Key).toBe('key.mp4');
      expect(mockCheckType).not.toHaveBeenCalled();
      expect(medias).toHaveLength(0);
      expect(stored.status).toBe('aborted');
    });

    it('400 CONTENT_TYPE_MISMATCH deletes the object, marks the row aborted and creates no media', async () => {
      const stored = row();
      mockCheckType.mockResolvedValue('mismatch');

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(400);
      expect(codeOf(err)).toBe('CONTENT_TYPE_MISMATCH');
      expect(sent()).toContain('DeleteObjectCommand');
      expect(medias).toHaveLength(0);
      expect(stored.status).toBe('aborted');
    });

    describe('poster (api.media-retention, RET-B4)', () => {
      // A poster as the phone sends it: base64 of an image whose bytes start with the type's magic bytes.
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50)]);
      const poster = jpeg.toString('base64');
      const puts = () =>
        mockSend.mock.calls
          .map(([c]) => c)
          .filter((c) => c.constructor.name === 'PutObjectCommand');

      it('stores the poster object, names it on the media and answers its URL', async () => {
        row();

        const out: any = await service.complete(ORG, 'up-1', parts, poster);

        expect(puts()).toHaveLength(1);
        const put = puts()[0].input;
        expect(put.Bucket).toBe('test-bucket');
        expect(put.Key).toMatch(/^[A-Za-z0-9]{20}\.jpg$/);
        expect(put.ContentType).toBe('image/jpeg');
        expect(Buffer.from(put.Body).equals(jpeg)).toBe(true);
        expect(medias[0].posterKey).toBe(put.Key);
        expect(out).toEqual({
          id: 'media-1',
          path: 'https://cdn.test/bucket/key.mp4',
          poster: `https://cdn.test/bucket/${put.Key}`,
        });
      });

      it('answers { id, path } and stores nothing when no poster is sent', async () => {
        row();

        const out = await service.complete(ORG, 'up-1', parts);

        expect(out).toEqual({ id: 'media-1', path: 'https://cdn.test/bucket/key.mp4' });
        expect(puts()).toHaveLength(0);
      });

      it('400 INVALID_POSTER, before the row is claimed, for text, a wrong type, an empty or an oversized poster', async () => {
        const stored = row();
        const big = Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff]),
          Buffer.alloc(MOBILE_UPLOAD_POSTER_MAX_BYTES),
        ]).toString('base64');
        const gif = Buffer.from('GIF89a-not-allowed').toString('base64');

        // a length that is not a multiple of 4 is refused, never silently cut by the decoder
        const truncated = poster.slice(0, -1);
        for (const bad of ['not base64!', '', gif, big, truncated, poster + 'A']) {
          const err = await failure(service.complete(ORG, 'up-1', parts, bad));
          expect(err?.getStatus()).toBe(400);
          expect(codeOf(err)).toBe('INVALID_POSTER');
        }
        expect(stored.status).toBe('pending');
        expect(sent()).toEqual([]);
        expect(medias).toHaveLength(0);
      });

      it('takes the type from the bytes, so a png is stored as .png', async () => {
        row();
        const png = Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          Buffer.alloc(20),
        ]);

        await service.complete(ORG, 'up-1', parts, png.toString('base64'));

        expect(puts()[0].input.Key).toMatch(/\.png$/);
        expect(puts()[0].input.ContentType).toBe('image/png');
      });

      it('still answers the media when the poster cannot be stored, and deletes what it wrote', async () => {
        const stored = row();
        mockSend.mockImplementation(async (command: any) => {
          if (command.constructor.name === 'PutObjectCommand') {
            throw new Error('socket hang up');
          }
          if (command.constructor.name === 'HeadObjectCommand') {
            return { ContentLength: headLength };
          }
          return {};
        });

        const out = await service.complete(ORG, 'up-1', parts, poster);

        expect(out).toEqual({ id: 'media-1', path: 'https://cdn.test/bucket/key.mp4' });
        expect(stored.status).toBe('completed');
        expect(medias[0].posterKey).toBeUndefined();
      });

      it('attaches the poster on a repeat of complete, once: a media that has one keeps it', async () => {
        row();
        await service.complete(ORG, 'up-1', parts);

        const first: any = await service.complete(ORG, 'up-1', parts, poster);
        const second: any = await service.complete(ORG, 'up-1', parts, poster);

        expect(first.poster).toBeDefined();
        expect(second).toEqual({ id: 'media-1', path: 'https://cdn.test/bucket/key.mp4' });
        expect(medias[0].posterKey).toBe(puts()[0].input.Key);
        // the poster is looked up first: the repeat writes no second object, so none is deleted
        expect(puts()).toHaveLength(1);
        expect(sent()).not.toContain('DeleteObjectCommand');
      });
    });

    it('runs R2 complete once when a second call arrives while the first holds the claim', async () => {
      const stored = row();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'CompleteMultipartUploadCommand') {
          await gate;
        }
        if (command.constructor.name === 'HeadObjectCommand') {
          return { ContentLength: headLength };
        }
        return {};
      });

      const first = service.complete(ORG, 'up-1', parts);
      await new Promise((resolve) => setImmediate(resolve));
      const second = await failure(service.complete(ORG, 'up-1', parts));
      release();
      const out = await first;

      expect(stored.status).toBe('completed');
      expect(second?.getStatus()).toBe(409);
      expect(codeOf(second)).toBe('UPLOAD_NOT_PENDING');
      expect(out.id).toBe('media-1');
      expect(
        sent().filter((n) => n === 'CompleteMultipartUploadCommand')
      ).toHaveLength(1);
      expect(medias).toHaveLength(1);
    });

    it('loses the claim to a call that completed it meanwhile and answers its media', async () => {
      row();
      const racing = service as any;
      const original = racing._mobileUploadRepository.transitionStatus;
      racing._mobileUploadRepository.transitionStatus = async (
        ...args: any[]
      ) => {
        // the other call finishes between the first read and this claim
        rows[0].status = 'completed';
        rows[0].mediaId = 'media-9';
        return original(...args);
      };

      const out = await service.complete(ORG, 'up-1', parts);

      expect(out).toEqual({
        id: 'media-9',
        path: 'https://cdn.test/bucket/key.mp4',
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('sends the row back to pending and answers 400 INVALID_PARTS when R2 refuses a part', async () => {
      const stored = row();
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('bad part'), { name: 'InvalidPart' })
      );

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(400);
      expect(codeOf(err)).toBe('INVALID_PARTS');
      expect(stored.status).toBe('pending');
    });

    it('sends the row back to pending and answers 502 STORAGE_ERROR on another R2 error', async () => {
      const stored = row();
      mockSend.mockRejectedValueOnce(new Error('socket hang up'));

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(502);
      expect(codeOf(err)).toBe('STORAGE_ERROR');
      expect(stored.status).toBe('pending');
    });

    it('expires the row with 409 when R2 has neither the upload nor the object', async () => {
      const stored = row();
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'CompleteMultipartUploadCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        throw Object.assign(new Error('missing'), { name: 'NotFound' });
      });

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(409);
      expect(codeOf(err)).toBe('UPLOAD_NOT_PENDING');
      expect(stored.status).toBe('expired');
    });

    it('finishes from the object when R2 no longer has the upload but already has the object', async () => {
      const stored = row();
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'CompleteMultipartUploadCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        return { ContentLength: headLength };
      });

      const out = await service.complete(ORG, 'up-1', parts);

      expect(out.id).toBe('media-1');
      expect(stored.status).toBe('completed');
    });

    it('keeps the object and the row pending, answers 502 STORAGE_ERROR when HeadObject fails after R2 completed, and finishes on the repeat', async () => {
      const stored = row();
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'HeadObjectCommand') {
          throw new Error('socket hang up');
        }
        return {};
      });

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(502);
      expect(codeOf(err)).toBe('STORAGE_ERROR');
      expect(stored.status).toBe('pending');
      expect(sent()).not.toContain('DeleteObjectCommand');
      expect(medias).toHaveLength(0);

      // The repeat: R2 no longer has the multipart upload, the object is there, the checks run again
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'CompleteMultipartUploadCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        return { ContentLength: headLength };
      });

      const out = await service.complete(ORG, 'up-1', parts);

      expect(out.id).toBe('media-1');
      expect(stored.status).toBe('completed');
      expect(sent()).not.toContain('DeleteObjectCommand');
    });

    it('keeps the object and the row pending when the type check cannot read the object', async () => {
      const stored = row();
      mockCheckType.mockRejectedValue(new Error('read failed'));

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(502);
      expect(codeOf(err)).toBe('STORAGE_ERROR');
      expect(stored.status).toBe('pending');
      expect(sent()).not.toContain('DeleteObjectCommand');
    });

    it('does not expire the row when HeadObject fails (not NotFound) after NoSuchUpload', async () => {
      const stored = row();
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'CompleteMultipartUploadCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        throw new Error('socket hang up');
      });

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(502);
      expect(codeOf(err)).toBe('STORAGE_ERROR');
      expect(stored.status).toBe('pending');
    });

    it('answers the stored media when the row left completing before the media id was stored', async () => {
      row();
      const racing = service as any;
      racing._mobileUploadRepository.markCompleted = async () => {
        // another call completed the row with its own media
        rows[0].status = 'completed';
        rows[0].mediaId = 'media-9';
        return false;
      };

      const out = await service.complete(ORG, 'up-1', parts);

      expect(out).toEqual({
        id: 'media-9',
        path: 'https://cdn.test/bucket/key.mp4',
      });
    });

    it('answers 409 UPLOAD_NOT_PENDING when the row left completing and is not completed', async () => {
      row();
      const racing = service as any;
      racing._mobileUploadRepository.markCompleted = async () => {
        rows[0].status = 'expired';
        return false;
      };

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(409);
      expect(codeOf(err)).toBe('UPLOAD_NOT_PENDING');
    });

    it('still answers the R2 error when the database fails moving the row back', async () => {
      row();
      const racing = service as any;
      const original = racing._mobileUploadRepository.transitionStatus;
      racing._mobileUploadRepository.transitionStatus = async (
        ...args: any[]
      ) => {
        if (args[2] === 'completing') {
          throw new Error('database down');
        }
        return original(...args);
      };
      mockSend.mockRejectedValueOnce(new Error('socket hang up'));

      const err = await failure(service.complete(ORG, 'up-1', parts));

      expect(err?.getStatus()).toBe(502);
      expect(codeOf(err)).toBe('STORAGE_ERROR');
    });
  });

  describe('abort', () => {
    it("404 UPLOAD_NOT_FOUND for another workspace's upload", async () => {
      row({ organizationId: 'org-2' });

      const err = await failure(service.abort(ORG, 'up-1'));

      expect(err?.getStatus()).toBe(404);
      expect(codeOf(err)).toBe('UPLOAD_NOT_FOUND');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('aborts the R2 upload of a pending row and marks it aborted', async () => {
      const stored = row();

      await service.abort(ORG, 'up-1');

      expect(stored.status).toBe('aborted');
      const command = mockSend.mock.calls[0][0];
      expect(command.constructor.name).toBe('AbortMultipartUploadCommand');
      expect(command.input.UploadId).toBe('r2-upload');
    });

    it('is idempotent: a repeat, and an expired row, do nothing and ask R2 nothing', async () => {
      row({ status: 'aborted' });
      row({ id: 'up-2', status: 'expired' });

      await expect(service.abort(ORG, 'up-1')).resolves.toBeUndefined();
      await expect(service.abort(ORG, 'up-2')).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('409 UPLOAD_NOT_PENDING for a completed or completing upload, nothing deleted', async () => {
      for (const status of ['completed', 'completing']) {
        rows = [];
        row({ status });

        const err = await failure(service.abort(ORG, 'up-1'));

        expect(err?.getStatus()).toBe(409);
        expect(codeOf(err)).toBe('UPLOAD_NOT_PENDING');
        expect(rows[0].status).toBe(status);
      }
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('treats an R2 upload that is already gone as aborted', async () => {
      const stored = row();
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('gone'), { name: 'NoSuchUpload' })
      );

      await expect(service.abort(ORG, 'up-1')).resolves.toBeUndefined();
      expect(stored.status).toBe('aborted');
    });

    it('keeps the row pending and answers 502 STORAGE_ERROR when R2 fails, so the abort can be repeated', async () => {
      const stored = row();
      mockSend.mockRejectedValueOnce(new Error('socket hang up'));

      const err = await failure(service.abort(ORG, 'up-1'));

      expect(err?.getStatus()).toBe(502);
      expect(codeOf(err)).toBe('STORAGE_ERROR');
      expect(stored.status).toBe('pending');
    });
  });

  describe('sweep', () => {
    // A row past its 24 hour life; `over` changes it.
    const expired = (over: Record<string, unknown> = {}) =>
      row({ expiresAt: new Date(Date.now() - HOUR), ...over });

    // The names of the R2 commands sent so far, in order.
    const sent = () => mockSend.mock.calls.map(([c]) => c.constructor.name);

    // R2 answers: the multipart upload is gone, the object is there (`present`) or not.
    const uploadGone = (present: boolean) =>
      mockSend.mockImplementation(async (command: any) => {
        const name = command.constructor.name;
        if (name === 'AbortMultipartUploadCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        if (name === 'HeadObjectCommand' && !present) {
          throw Object.assign(new Error('missing'), { name: 'NotFound' });
        }
        return { ContentLength: headLength };
      });

    it('expires a pending row past its expiry and aborts its R2 upload', async () => {
      const stored = expired();
      const fresh = row({
        id: 'up-2',
        expiresAt: new Date(Date.now() + HOUR),
      });

      const out = await service.sweep();

      expect(out).toEqual({ expired: 1, failed: 0 });
      expect(stored.status).toBe('expired');
      expect(fresh.status).toBe('pending');
      expect(sent()).toEqual(['AbortMultipartUploadCommand']);
      expect(mockSend.mock.calls[0][0].input.UploadId).toBe('r2-upload');
    });

    it('deletes the finished object when the upload is gone and the object is in R2', async () => {
      const stored = expired();
      uploadGone(true);

      const out = await service.sweep();

      expect(out).toEqual({ expired: 1, failed: 0 });
      expect(stored.status).toBe('expired');
      expect(sent()).toEqual([
        'AbortMultipartUploadCommand',
        'HeadObjectCommand',
        'DeleteObjectCommand',
      ]);
      expect(mockSend.mock.calls[2][0].input.Key).toBe('key.mp4');
    });

    it('deletes nothing when the upload is gone and so is the object', async () => {
      const stored = expired();
      uploadGone(false);

      await service.sweep();

      expect(stored.status).toBe('expired');
      expect(sent()).not.toContain('DeleteObjectCommand');
    });

    it('keeps the object when a media row uses it', async () => {
      const stored = row({
        status: 'completing',
        updatedAt: new Date(Date.now() - HOUR),
      });
      medias.push({ id: 'media-1', name: 'key.mp4', org: ORG });
      uploadGone(true);

      await service.sweep();

      expect(stored.status).toBe('expired');
      expect(sent()).not.toContain('DeleteObjectCommand');
    });

    it('never touches a completed row or its media', async () => {
      const stored = expired({
        status: 'completed',
        mediaId: 'media-1',
        updatedAt: new Date(Date.now() - 48 * HOUR),
      });

      const out = await service.sweep();

      expect(out).toEqual({ expired: 0, failed: 0 });
      expect(stored.status).toBe('completed');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('expires a completing row untouched for over 30 minutes, not a younger one', async () => {
      const old = row({
        status: 'completing',
        updatedAt: new Date(Date.now() - 31 * 60 * 1000),
      });
      const young = row({
        id: 'up-2',
        status: 'completing',
        updatedAt: new Date(Date.now() - 5 * 60 * 1000),
      });

      const out = await service.sweep();

      expect(out).toEqual({ expired: 1, failed: 0 });
      expect(old.status).toBe('expired');
      expect(young.status).toBe('completing');
      expect(sent()).toEqual(['AbortMultipartUploadCommand']);
    });

    it('logs the failing row, puts it back, and still closes the rest of the batch', async () => {
      const first = expired({ id: 'up-1', uploadId: 'bad' });
      const second = expired({ id: 'up-2', uploadId: 'good' });
      const completing = row({
        id: 'up-3',
        uploadId: 'bad-too',
        status: 'completing',
        updatedAt: new Date(Date.now() - HOUR),
      });
      mockSend.mockImplementation(async (command: any) => {
        if (String(command.input.UploadId).startsWith('bad')) {
          throw new Error('socket hang up');
        }
        return {};
      });

      const out = await service.sweep();

      expect(out).toEqual({ expired: 1, failed: 2 });
      expect(first.status).toBe('pending');
      expect(second.status).toBe('expired');
      expect(completing.status).toBe('completing');
    });

    it('puts the row back when HeadObject cannot say whether the object is there', async () => {
      const stored = expired();
      mockSend.mockImplementation(async (command: any) => {
        if (command.constructor.name === 'AbortMultipartUploadCommand') {
          throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        }
        throw new Error('socket hang up');
      });

      const out = await service.sweep();

      expect(out).toEqual({ expired: 0, failed: 1 });
      expect(stored.status).toBe('pending');
    });

    it('closes at most one batch, the oldest first', async () => {
      for (let i = 0; i < MOBILE_UPLOAD_SWEEP_BATCH + 1; i++) {
        expired({ id: `up-${i}` });
      }

      const out = await service.sweep();

      expect(out.expired).toBe(MOBILE_UPLOAD_SWEEP_BATCH);
      expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    });
  });

  describe('transcript_audio (ai.video-captions)', () => {
    const AUDIO_MAX = 120 * MIB;
    const audio = { purpose: 'transcript_audio' as const };

    // The parts list a phone sends for a one-part audio upload.
    const parts = [{ n: 1, etag: '"a"' }];

    // A stored caption audio upload of 3 MiB (one part); `over` changes it.
    const audioRow = (over: Record<string, unknown> = {}) =>
      row({
        objectKey: 'voice.wav',
        filename: 'voice.wav',
        size: BigInt(3 * MIB),
        partCount: 1,
        purpose: 'transcript_audio',
        ...over,
      });

    // The names of the R2 commands sent so far, in order.
    const sent = () => mockSend.mock.calls.map(([c]) => c.constructor.name);

    describe('create', () => {
      it('opens an audio/wav upload and stores the row with its purpose', async () => {
        const out = await service.create(ORG, {
          filename: 'voice.WAV',
          size: 3 * MIB,
          ...audio,
        });

        expect(out).toEqual({
          id: 'up-1',
          partSize: MOBILE_UPLOAD_PART_SIZE,
          partCount: 1,
        });
        const command = mockSend.mock.calls[0][0];
        expect(command.input.ContentType).toBe('audio/wav');
        expect(command.input.Key).toMatch(/^[A-Za-z0-9]+\.wav$/);
        expect(rows[0].purpose).toBe('transcript_audio');
      });

      it('stores purpose media when none is sent and when media is named', async () => {
        await service.create(ORG, { filename: 'a.mp4', size: MIB });
        await service.create(ORG, {
          filename: 'a.mp4',
          size: MIB,
          purpose: 'media',
        });

        expect(rows.map((r) => r.purpose)).toEqual(['media', 'media']);
      });

      it('400 UNSUPPORTED_TYPE for a .wav as media and for an .mp4 as audio', async () => {
        const wavAsMedia = await failure(
          service.create(ORG, { filename: 'voice.wav', size: MIB })
        );
        const wavNamedMedia = await failure(
          service.create(ORG, {
            filename: 'voice.wav',
            size: MIB,
            purpose: 'media',
          })
        );
        const mp4AsAudio = await failure(
          service.create(ORG, { filename: 'clip.mp4', size: MIB, ...audio })
        );

        for (const err of [wavAsMedia, wavNamedMedia, mp4AsAudio]) {
          expect(err?.getStatus()).toBe(400);
          expect(codeOf(err)).toBe('UNSUPPORTED_TYPE');
        }
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('400 FILE_TOO_LARGE above 120 MiB and above AI_CAPTIONS_MAX_AUDIO_BYTES, and accepts exactly the limit', async () => {
        const big = await failure(
          service.create(ORG, {
            filename: 'a.wav',
            size: AUDIO_MAX + 1,
            ...audio,
          })
        );
        const atLimit = await service.create(ORG, {
          filename: 'a.wav',
          size: AUDIO_MAX,
          ...audio,
        });
        process.env.AI_CAPTIONS_MAX_AUDIO_BYTES = String(10 * MIB);
        const small = await failure(
          service.create(ORG, {
            filename: 'a.wav',
            size: 10 * MIB + 1,
            ...audio,
          })
        );

        expect(big?.getStatus()).toBe(400);
        expect(codeOf(big)).toBe('FILE_TOO_LARGE');
        expect(codeOf(small)).toBe('FILE_TOO_LARGE');
        expect(atLimit.partCount).toBe(8);
      });

      it('keeps the two size limits apart', async () => {
        process.env.MOBILE_UPLOAD_MAX_BYTES = String(10 * MIB);
        const audioOverMediaLimit = await service.create(ORG, {
          filename: 'a.wav',
          size: 20 * MIB,
          ...audio,
        });
        delete process.env.MOBILE_UPLOAD_MAX_BYTES;
        process.env.AI_CAPTIONS_MAX_AUDIO_BYTES = String(MIB);
        const mediaOverAudioLimit = await service.create(ORG, {
          filename: 'a.mp4',
          size: 20 * MIB,
        });

        expect(audioOverMediaLimit.partCount).toBe(2);
        expect(mediaOverAudioLimit.partCount).toBe(2);
      });

      it('429 TOO_MANY_PENDING_UPLOADS for the sixth pending audio upload, which video uploads do not count towards', async () => {
        for (let i = 0; i < MOBILE_UPLOAD_AUDIO_MAX_PENDING; i++) {
          audioRow({ id: `a-${i}` });
        }
        row({ id: 'video' });

        const err = await failure(
          service.create(ORG, { filename: 'a.wav', size: MIB, ...audio })
        );
        const video = await service.create(ORG, {
          filename: 'a.mp4',
          size: MIB,
        });

        expect(err?.getStatus()).toBe(429);
        expect(codeOf(err)).toBe('TOO_MANY_PENDING_UPLOADS');
        expect(video.partCount).toBe(1);
      });

      it('pending video uploads at their cap do not block an audio upload', async () => {
        for (let i = 0; i < MOBILE_UPLOAD_MAX_PENDING; i++) {
          row({ id: `p-${i}` });
        }

        const out = await service.create(ORG, {
          filename: 'a.wav',
          size: MIB,
          ...audio,
        });
        const video = await failure(
          service.create(ORG, { filename: 'a.mp4', size: MIB })
        );

        expect(out.partCount).toBe(1);
        expect(codeOf(video)).toBe('TOO_MANY_PENDING_UPLOADS');
      });
    });

    describe('complete', () => {
      beforeEach(() => {
        headLength = 3 * MIB;
      });

      it('completes in R2, checks size and the WAV type, makes no media and answers { id }', async () => {
        const stored = audioRow();

        const out = await service.complete(ORG, 'up-1', parts);

        expect(out).toEqual({ id: 'up-1' });
        expect(sent()).toEqual([
          'CompleteMultipartUploadCommand',
          'HeadObjectCommand',
        ]);
        expect(mockCheckType).toHaveBeenCalledWith('voice.wav', {
          '.wav': 'audio/wav',
        });
        expect(medias).toHaveLength(0);
        expect(stored.status).toBe('completed');
        expect(stored.mediaId).toBeUndefined();
      });

      it('answers the same { id } on a second complete and runs one R2 complete', async () => {
        audioRow();

        const first = await service.complete(ORG, 'up-1', parts);
        const second = await service.complete(ORG, 'up-1', parts);

        expect(second).toEqual(first);
        expect(second).toEqual({ id: 'up-1' });
        expect(
          sent().filter((n) => n === 'CompleteMultipartUploadCommand')
        ).toHaveLength(1);
      });

      it('ignores a poster sent with the audio, even an invalid one', async () => {
        audioRow();

        const out = await service.complete(ORG, 'up-1', parts, 'not a poster!');

        expect(out).toEqual({ id: 'up-1' });
        expect(sent()).not.toContain('PutObjectCommand');
      });

      it("404 UPLOAD_NOT_FOUND for another workspace's audio", async () => {
        audioRow({ organizationId: 'org-2' });

        const err = await failure(service.complete(ORG, 'up-1', parts));

        expect(err?.getStatus()).toBe(404);
        expect(codeOf(err)).toBe('UPLOAD_NOT_FOUND');
      });

      it('400 SIZE_MISMATCH deletes the object, marks the row aborted and makes no media', async () => {
        const stored = audioRow({ size: BigInt(2 * MIB) });

        const err = await failure(service.complete(ORG, 'up-1', parts));

        expect(codeOf(err)).toBe('SIZE_MISMATCH');
        expect(sent()).toContain('DeleteObjectCommand');
        expect(stored.status).toBe('aborted');
        expect(medias).toHaveLength(0);
      });

      it('400 CONTENT_TYPE_MISMATCH deletes the object, marks the row aborted and makes no media', async () => {
        const stored = audioRow();
        mockCheckType.mockResolvedValue('mismatch');

        const err = await failure(service.complete(ORG, 'up-1', parts));

        expect(err?.getStatus()).toBe(400);
        expect(codeOf(err)).toBe('CONTENT_TYPE_MISMATCH');
        expect(sent()).toContain('DeleteObjectCommand');
        expect(stored.status).toBe('aborted');
        expect(medias).toHaveLength(0);
      });

      it('sends the row back to pending and answers 502 STORAGE_ERROR when the row cannot be marked completed', async () => {
        const stored = audioRow();
        jest
          .spyOn(repo, 'markCompleted')
          .mockRejectedValueOnce(new Error('database down'));

        const err = await failure(service.complete(ORG, 'up-1', parts));

        expect(err?.getStatus()).toBe(502);
        expect(codeOf(err)).toBe('STORAGE_ERROR');
        expect(stored.status).toBe('pending');
      });
    });

    describe('sweep', () => {
      // A completed audio untouched for 25 hours; `over` changes it.
      const old = (over: Record<string, unknown> = {}) =>
        audioRow({
          status: 'completed',
          updatedAt: new Date(Date.now() - 25 * HOUR),
          ...over,
        });

      it('deletes the object of a completed audio untouched for a day that no caption names, and expires the row once', async () => {
        const stored = old();

        const first = await service.sweep();
        const second = await service.sweep();

        expect(first).toEqual({ expired: 1, failed: 0 });
        expect(second).toEqual({ expired: 0, failed: 0 });
        expect(stored.status).toBe('expired');
        expect(mockDeleteObject).toHaveBeenCalledTimes(1);
        expect(mockDeleteObject).toHaveBeenCalledWith('voice.wav');
      });

      it('leaves the object to the caption job that names it, and still expires the row', async () => {
        const stored = old();
        captions.push('up-1');

        const out = await service.sweep();

        expect(out).toEqual({ expired: 1, failed: 0 });
        expect(stored.status).toBe('expired');
        expect(mockDeleteObject).not.toHaveBeenCalled();
      });

      it('leaves an audio completed within a day, a pending audio and a completed media row alone', async () => {
        const fresh = old({
          id: 'fresh',
          updatedAt: new Date(Date.now() - 23 * HOUR),
        });
        const pending = audioRow({ id: 'pending' });
        const media = row({
          id: 'media',
          status: 'completed',
          mediaId: 'media-1',
          updatedAt: new Date(Date.now() - 48 * HOUR),
        });

        const out = await service.sweep();

        expect(out).toEqual({ expired: 0, failed: 0 });
        expect(fresh.status).toBe('completed');
        expect(pending.status).toBe('pending');
        expect(media.status).toBe('completed');
        expect(mockDeleteObject).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('logs a failing delete, keeps that row completed for the next sweep and still closes the rest', async () => {
        const first = old({ id: 'a-1', objectKey: 'bad.wav' });
        const second = old({ id: 'a-2', objectKey: 'good.wav' });
        mockDeleteObject.mockImplementation(async (key: string) => {
          if (key === 'bad.wav') {
            throw new Error('socket hang up');
          }
        });

        const out = await service.sweep();

        expect(out).toEqual({ expired: 1, failed: 1 });
        expect(first.status).toBe('completed');
        expect(second.status).toBe('expired');
      });

      it('adds the audio count to the answer of the sweep of unfinished uploads', async () => {
        const pending = row({ expiresAt: new Date(Date.now() - HOUR) });
        const stored = old({ id: 'a-1' });

        const out = await service.sweep();

        expect(out).toEqual({ expired: 2, failed: 0 });
        expect(pending.status).toBe('expired');
        expect(stored.status).toBe('expired');
      });
    });
  });

  describe('edit_proxy (ai.video-editing)', () => {
    const PROXY_MAX = 16 * MIB;
    const proxy = { purpose: 'edit_proxy' as const };

    // The parts list a phone sends for a one-part proxy upload.
    const parts = [{ n: 1, etag: '"p"' }];

    // A stored edit proxy upload of 6 MiB (one part); `over` changes it.
    const proxyRow = (over: Record<string, unknown> = {}) =>
      row({
        objectKey: 'proxy.mp4',
        filename: 'proxy.mp4',
        size: BigInt(6 * MIB),
        partCount: 1,
        purpose: 'edit_proxy',
        ...over,
      });

    // The names of the R2 commands sent so far, in order.
    const sent = () => mockSend.mock.calls.map(([c]) => c.constructor.name);

    describe('create', () => {
      it('opens a video/mp4 upload and stores the row with its purpose', async () => {
        const out = await service.create(ORG, {
          filename: 'proxy.MP4',
          size: 6 * MIB,
          ...proxy,
        });

        expect(out).toEqual({
          id: 'up-1',
          partSize: MOBILE_UPLOAD_PART_SIZE,
          partCount: 1,
        });
        const command = mockSend.mock.calls[0][0];
        expect(command.input.ContentType).toBe('video/mp4');
        expect(command.input.Key).toMatch(/^[A-Za-z0-9]+\.mp4$/);
        expect(rows[0].purpose).toBe('edit_proxy');
      });

      it('400 UNSUPPORTED_TYPE for anything but an .mp4', async () => {
        for (const filename of ['voice.wav', 'clip.mov', 'image.png', 'proxy']) {
          const err = await failure(
            service.create(ORG, { filename, size: MIB, ...proxy })
          );
          expect(err?.getStatus()).toBe(400);
          expect(codeOf(err)).toBe('UNSUPPORTED_TYPE');
        }
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('400 FILE_TOO_LARGE above 16 MiB and above AI_EDIT_MAX_PROXY_BYTES, and accepts exactly the limit', async () => {
        const big = await failure(
          service.create(ORG, {
            filename: 'p.mp4',
            size: PROXY_MAX + 1,
            ...proxy,
          })
        );
        const atLimit = await service.create(ORG, {
          filename: 'p.mp4',
          size: PROXY_MAX,
          ...proxy,
        });
        process.env.AI_EDIT_MAX_PROXY_BYTES = String(4 * MIB);
        const small = await failure(
          service.create(ORG, {
            filename: 'p.mp4',
            size: 4 * MIB + 1,
            ...proxy,
          })
        );

        expect(big?.getStatus()).toBe(400);
        expect(codeOf(big)).toBe('FILE_TOO_LARGE');
        expect(codeOf(small)).toBe('FILE_TOO_LARGE');
        expect(atLimit.partCount).toBe(1);
      });

      it('keeps its size limit apart from the media and audio ones', async () => {
        process.env.AI_EDIT_MAX_PROXY_BYTES = String(MIB);
        const media = await service.create(ORG, {
          filename: 'a.mp4',
          size: 20 * MIB,
        });
        const audio = await service.create(ORG, {
          filename: 'a.wav',
          size: 20 * MIB,
          purpose: 'transcript_audio',
        });
        delete process.env.AI_EDIT_MAX_PROXY_BYTES;
        process.env.MOBILE_UPLOAD_MAX_BYTES = String(MIB);
        process.env.AI_CAPTIONS_MAX_AUDIO_BYTES = String(MIB);
        const proxied = await service.create(ORG, {
          filename: 'p.mp4',
          size: 10 * MIB,
          ...proxy,
        });

        expect(media.partCount).toBe(2);
        expect(audio.partCount).toBe(2);
        expect(proxied.partCount).toBe(1);
      });

      it('429 TOO_MANY_PENDING_UPLOADS for the fifth pending proxy, which video and audio uploads do not count towards', async () => {
        expect(MOBILE_UPLOAD_EDIT_PROXY_MAX_PENDING).toBe(4);
        for (let i = 0; i < MOBILE_UPLOAD_EDIT_PROXY_MAX_PENDING; i++) {
          proxyRow({ id: `p-${i}` });
        }

        const err = await failure(
          service.create(ORG, { filename: 'p.mp4', size: MIB, ...proxy })
        );
        const video = await service.create(ORG, {
          filename: 'a.mp4',
          size: MIB,
        });
        const audio = await service.create(ORG, {
          filename: 'a.wav',
          size: MIB,
          purpose: 'transcript_audio',
        });

        expect(err?.getStatus()).toBe(429);
        expect(codeOf(err)).toBe('TOO_MANY_PENDING_UPLOADS');
        expect(video.partCount).toBe(1);
        expect(audio.partCount).toBe(1);
      });

      it('pending video and audio uploads at their caps do not block a proxy', async () => {
        for (let i = 0; i < MOBILE_UPLOAD_MAX_PENDING; i++) {
          row({ id: `v-${i}` });
        }
        for (let i = 0; i < MOBILE_UPLOAD_AUDIO_MAX_PENDING; i++) {
          row({ id: `a-${i}`, purpose: 'transcript_audio' });
        }

        const out = await service.create(ORG, {
          filename: 'p.mp4',
          size: MIB,
          ...proxy,
        });

        expect(out.partCount).toBe(1);
      });
    });

    describe('complete', () => {
      beforeEach(() => {
        headLength = 6 * MIB;
      });

      it('completes in R2, checks size and the mp4 type, makes no media and answers { id }', async () => {
        const stored = proxyRow();

        const out = await service.complete(ORG, 'up-1', parts);

        expect(out).toEqual({ id: 'up-1' });
        expect(sent()).toEqual([
          'CompleteMultipartUploadCommand',
          'HeadObjectCommand',
        ]);
        expect(mockCheckType).toHaveBeenCalledWith('proxy.mp4', {
          '.mp4': 'video/mp4',
        });
        expect(medias).toHaveLength(0);
        expect(stored.status).toBe('completed');
        expect(stored.mediaId).toBeUndefined();
      });

      it('answers the same { id } on a second complete and ignores a poster', async () => {
        proxyRow();

        const first = await service.complete(ORG, 'up-1', parts, 'not a poster!');
        const second = await service.complete(ORG, 'up-1', parts);

        expect(first).toEqual({ id: 'up-1' });
        expect(second).toEqual(first);
        expect(sent()).not.toContain('PutObjectCommand');
        expect(
          sent().filter((n) => n === 'CompleteMultipartUploadCommand')
        ).toHaveLength(1);
      });

      it('400 CONTENT_TYPE_MISMATCH deletes the object, marks the row aborted and makes no media', async () => {
        const stored = proxyRow();
        mockCheckType.mockResolvedValue('mismatch');

        const err = await failure(service.complete(ORG, 'up-1', parts));

        expect(codeOf(err)).toBe('CONTENT_TYPE_MISMATCH');
        expect(sent()).toContain('DeleteObjectCommand');
        expect(stored.status).toBe('aborted');
        expect(medias).toHaveLength(0);
      });
    });

    describe('sweep', () => {
      // A completed proxy untouched for 25 hours; `over` changes it.
      const old = (over: Record<string, unknown> = {}) =>
        proxyRow({
          status: 'completed',
          updatedAt: new Date(Date.now() - 25 * HOUR),
          ...over,
        });

      it('deletes the object of a completed proxy untouched for a day that no job names, and expires the row', async () => {
        const stored = old();

        const out = await service.sweep();

        expect(out).toEqual({ expired: 1, failed: 0 });
        expect(stored.status).toBe('expired');
        expect(mockDeleteObject).toHaveBeenCalledWith('proxy.mp4');
      });

      it('leaves the object to the edit job that names it, and still expires the row', async () => {
        const stored = old();
        captions.push('up-1');

        const out = await service.sweep();

        expect(out).toEqual({ expired: 1, failed: 0 });
        expect(stored.status).toBe('expired');
        expect(mockDeleteObject).not.toHaveBeenCalled();
      });

      it('leaves a proxy completed within a day alone', async () => {
        const fresh = old({ updatedAt: new Date(Date.now() - 23 * HOUR) });

        const out = await service.sweep();

        expect(out).toEqual({ expired: 0, failed: 0 });
        expect(fresh.status).toBe('completed');
        expect(mockDeleteObject).not.toHaveBeenCalled();
      });
    });
  });
});
