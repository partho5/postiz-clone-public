// Mobile direct upload (api.mobile-direct-upload): a phone sends a finished recording straight to R2
// in presigned parts. This service opens the multipart upload for a workspace, signs the part URLs,
// reads what R2 already has, and finishes (verifies and turns into media) or aborts it; the bytes
// never cross this server. The same routes carry the speech audio of a caption job (ai.video-captions,
// `purpose: 'transcript_audio'`): a WAV with its own size cap, pending cap and throttle bucket, that
// finishes as just its id (no media row) and is deleted once transcribed or after a day. The small video of an
// AI edit job (ai.video-editing, `purpose: 'edit_proxy'`) is the same kind of work file: an .mp4 with its own
// size cap and pending cap, counted in the audio throttle bucket, finishing as its id and closed after a day.
import { HttpException, Injectable } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MobileUploadRepository } from '@gitroom/nestjs-libraries/database/prisma/mobile-upload/mobile.upload.repository';
import {
  MOBILE_UPLOAD_PURPOSE_AUDIO,
  MOBILE_UPLOAD_PURPOSE_EDIT_PROXY,
  MobileUploadCreateDto,
  MobileUploadPurpose,
} from '@gitroom/nestjs-libraries/dtos/mobile-upload/mobile.upload.create.dto';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { mediaUrl } from '@gitroom/helpers/utils/media.base.url';
import { MEDIA_ORIGIN_MOBILE } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.config';
import {
  checkUploadedObjectType,
  deleteObject,
  EDIT_PROXY_EXT_TO_MIME,
  multipartExtToMime,
  normalizeExtension,
  posterType,
  R2,
  R2_BUCKET,
  TRANSCRIPT_AUDIO_EXT_TO_MIME,
} from '@gitroom/nestjs-libraries/upload/r2.uploader';

// Every part but the last is exactly this many bytes (16 MiB; R2 needs equal parts of at least 5 MiB).
export const MOBILE_UPLOAD_PART_SIZE = 16 * 1024 * 1024;

// The most parts an upload may have (the R2 limit).
export const MOBILE_UPLOAD_MAX_PARTS = 10000;

// The most part numbers one sign request may name.
export const MOBILE_UPLOAD_MAX_SIGN_PARTS = 20;

// How long a presigned part URL works, in seconds.
export const MOBILE_UPLOAD_URL_EXPIRES_IN = 900;

// The most pending uploads a workspace may hold.
export const MOBILE_UPLOAD_MAX_PENDING = 5;

// The most pending caption audio uploads a workspace may hold, counted apart from the media ones.
export const MOBILE_UPLOAD_AUDIO_MAX_PENDING = 5;

// The most pending AI edit proxy uploads a workspace may hold (one job sends up to 4), counted apart too.
export const MOBILE_UPLOAD_EDIT_PROXY_MAX_PENDING = 4;

// How long a row lives before the sweep may expire it.
const ROW_LIFETIME_MS = 24 * 60 * 60 * 1000;

// How long a row may stay completing before the sweep takes it (a complete that died).
const COMPLETING_TIMEOUT_MS = 30 * 60 * 1000;

// The most rows one sweep closes.
export const MOBILE_UPLOAD_SWEEP_BATCH = 100;

// The largest poster image `complete` accepts, in bytes once decoded (api.media-retention, RET-B4).
export const MOBILE_UPLOAD_POSTER_MAX_BYTES = 512 * 1024;

// The largest file when MOBILE_UPLOAD_MAX_BYTES is not set (4 GiB).
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

// The largest caption audio when AI_CAPTIONS_MAX_AUDIO_BYTES is not set (120 MiB: over an hour of 16 kHz mono).
const DEFAULT_AUDIO_MAX_BYTES = 120 * 1024 * 1024;

// The largest AI edit proxy when AI_EDIT_MAX_PROXY_BYTES is not set (16 MiB, what the perception model takes).
const DEFAULT_EDIT_PROXY_MAX_BYTES = 16 * 1024 * 1024;

// How long a completed work file (caption audio or edit proxy) may wait for its job before the sweep closes it: a
// job reads it within minutes of its creation and deletes it itself, so what is left after a day was never used.
const AUDIO_LIFETIME_MS = 24 * 60 * 60 * 1000;

// An error of the upload routes, in the public API's shape { statusCode, code, message }.
export class MobileUploadException extends HttpException {
  // Answers `status` with the stable `code` the app switches on.
  constructor(status: number, code: string, message: string) {
    super({ statusCode: status, code, message }, status);
  }
}

// True when an S3 client error is the named R2 error (by its error name or code).
function isStorageError(err: unknown, ...names: string[]) {
  const e = err as { name?: string; Code?: string } | undefined;
  return names.includes(e?.name || '') || names.includes(e?.Code || '');
}

// True for a work file of an AI job (a caption job's speech audio or an edit job's proxy video): it makes no media
// row and takes no poster. A row with no purpose (before it existed) is media.
function isWorkFile(row: { purpose?: string | null }) {
  return (
    row.purpose === MOBILE_UPLOAD_PURPOSE_AUDIO ||
    row.purpose === MOBILE_UPLOAD_PURPOSE_EDIT_PROXY
  );
}

// The file types an upload made for the purpose may be: a WAV for caption audio, an mp4 for an edit proxy,
// the web and video types for media.
function typesFor(purpose?: string | null) {
  if (purpose === MOBILE_UPLOAD_PURPOSE_AUDIO) {
    return TRANSCRIPT_AUDIO_EXT_TO_MIME;
  }
  if (purpose === MOBILE_UPLOAD_PURPOSE_EDIT_PROXY) {
    return EDIT_PROXY_EXT_TO_MIME;
  }
  return multipartExtToMime();
}

// The most pending uploads of the purpose a workspace may hold.
function maxPending(purpose: MobileUploadPurpose) {
  if (purpose === MOBILE_UPLOAD_PURPOSE_AUDIO) {
    return MOBILE_UPLOAD_AUDIO_MAX_PENDING;
  }
  if (purpose === MOBILE_UPLOAD_PURPOSE_EDIT_PROXY) {
    return MOBILE_UPLOAD_EDIT_PROXY_MAX_PENDING;
  }
  return MOBILE_UPLOAD_MAX_PENDING;
}

// True when a HeadObject failure says the object is not there (and not that R2 could not be asked).
function isObjectMissing(err: unknown) {
  const e = err as { $metadata?: { httpStatusCode?: number } } | undefined;
  return (
    isStorageError(err, 'NotFound', 'NoSuchKey') ||
    e?.$metadata?.httpStatusCode === 404
  );
}

// The state of one upload, as GET /public/v1/upload/multipart/:id answers it.
export interface MobileUploadStatus {
  status: string;
  size: number;
  partSize: number;
  partCount: number;
  parts: Array<{ n: number; etag: string; size: number }>;
}

@Injectable()
export class MobileUploadService {
  // Receives the storage of the upload rows and the media service that stores a finished upload.
  constructor(
    private _mobileUploadRepository: MobileUploadRepository,
    private _mediaService: MediaService
  ) {}

  // Opens a multipart upload in R2 for the file and stores the row that owns it; answers 400
  // UNSUPPORTED_TYPE or FILE_TOO_LARGE, and 429 TOO_MANY_PENDING_UPLOADS. A `transcript_audio` upload
  // takes only a .wav, up to AI_CAPTIONS_MAX_AUDIO_BYTES, and an `edit_proxy` upload only an .mp4, up to
  // AI_EDIT_MAX_PROXY_BYTES; each has its own pending cap.
  async create(organizationId: string, body: MobileUploadCreateDto) {
    const purpose = body.purpose || 'media';
    const types = typesFor(purpose);
    const ext = normalizeExtension(body.filename, types);
    if (!ext) {
      throw new MobileUploadException(
        400,
        'UNSUPPORTED_TYPE',
        'Unsupported file type'
      );
    }

    const partCount = Math.ceil(body.size / MOBILE_UPLOAD_PART_SIZE);
    if (
      body.size > this.maxBytes(purpose) ||
      partCount > MOBILE_UPLOAD_MAX_PARTS
    ) {
      throw new MobileUploadException(
        400,
        'FILE_TOO_LARGE',
        'The file is larger than the upload limit'
      );
    }

    const pending = await this._mobileUploadRepository.countPendingByOrg(
      organizationId,
      purpose
    );
    if (pending >= maxPending(purpose)) {
      throw new MobileUploadException(
        429,
        'TOO_MANY_PENDING_UPLOADS',
        'Too many uploads are in progress for this workspace'
      );
    }

    const objectKey = makeId(20) + ext;
    const created = await R2.send(
      new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: objectKey,
        ContentType: types[ext],
      })
    );
    if (!created.UploadId) {
      throw new Error('R2 did not return an upload id');
    }

    try {
      const row = await this._mobileUploadRepository.create({
        organizationId,
        objectKey,
        uploadId: created.UploadId,
        filename: body.filename,
        size: body.size,
        partSize: MOBILE_UPLOAD_PART_SIZE,
        partCount,
        expiresAt: new Date(Date.now() + ROW_LIFETIME_MS),
        purpose,
      });
      return {
        id: row.id,
        partSize: MOBILE_UPLOAD_PART_SIZE,
        partCount,
      };
    } catch (err) {
      // No row owns the R2 upload, so nothing would ever abort it
      await R2.send(
        new AbortMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: objectKey,
          UploadId: created.UploadId,
        })
      ).catch(() => undefined);
      throw err;
    }
  }

  // Presigned PUT URLs for the named parts of a pending upload, each for that part's exact length;
  // answers 404 UPLOAD_NOT_FOUND, 409 UPLOAD_NOT_PENDING and 400 INVALID_PARTS.
  async signParts(organizationId: string, id: string, partNumbers: number[]) {
    const row = await this.getOwned(organizationId, id);
    if (row.status !== 'pending') {
      throw this.notPending();
    }

    const valid =
      Array.isArray(partNumbers) &&
      partNumbers.length >= 1 &&
      partNumbers.length <= MOBILE_UPLOAD_MAX_SIGN_PARTS &&
      new Set(partNumbers).size === partNumbers.length &&
      partNumbers.every(
        (n) => Number.isInteger(n) && n >= 1 && n <= row.partCount
      );
    if (!valid) {
      throw new MobileUploadException(
        400,
        'INVALID_PARTS',
        `Name 1 to ${MOBILE_UPLOAD_MAX_SIGN_PARTS} different part numbers between 1 and ${row.partCount}`
      );
    }

    const size = Number(row.size);
    const urls: Record<string, string> = {};
    await Promise.all(
      partNumbers.map(async (n) => {
        urls[String(n)] = await getSignedUrl(
          R2,
          new UploadPartCommand({
            Bucket: R2_BUCKET,
            Key: row.objectKey,
            UploadId: row.uploadId,
            PartNumber: n,
            // Signed into the URL, so R2 refuses a part of any other length
            ContentLength:
              n === row.partCount
                ? size - (row.partCount - 1) * row.partSize
                : row.partSize,
          }),
          { expiresIn: MOBILE_UPLOAD_URL_EXPIRES_IN }
        );
      })
    );
    return { urls, expiresIn: MOBILE_UPLOAD_URL_EXPIRES_IN };
  }

  // The upload's state and the parts R2 already has (none once it is no longer pending, as R2 no
  // longer holds a multipart upload for it). A pending row whose R2 upload is gone becomes expired,
  // unless its finished object is there (a complete that ended 502): then it stays pending with no
  // parts, for the phone to call complete again. Answers 404 UPLOAD_NOT_FOUND and 502 STORAGE_ERROR.
  async status(organizationId: string, id: string): Promise<MobileUploadStatus> {
    const row = await this.getOwned(organizationId, id);
    const parts: MobileUploadStatus['parts'] = [];

    let status = row.status;

    if (row.status === 'pending') {
      try {
        let marker: string | undefined;
        do {
          const page = await R2.send(
            new ListPartsCommand({
              Bucket: R2_BUCKET,
              Key: row.objectKey,
              UploadId: row.uploadId,
              PartNumberMarker: marker,
            })
          );
          for (const part of page.Parts || []) {
            parts.push({
              n: part.PartNumber!,
              etag: part.ETag!,
              size: part.Size!,
            });
          }
          marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
        } while (marker);
      } catch (err) {
        if (!isStorageError(err, 'NoSuchUpload')) {
          throw err;
        }
        parts.length = 0;
        let present: boolean;
        try {
          present = await this.objectExists(row.objectKey);
        } catch (headErr) {
          // R2 could not say whether the object is there: do not expire a row that may be finished
          console.log('Error', headErr);
          throw this.storageError('The upload could not be checked');
        }
        if (!present) {
          // R2 holds neither the upload nor the object (a lifecycle rule or an outside abort)
          await this._mobileUploadRepository.transitionStatus(
            organizationId,
            id,
            'pending',
            'expired'
          );
          status = 'expired';
        }
      }
    }

    return {
      status,
      size: Number(row.size),
      partSize: row.partSize,
      partCount: row.partCount,
      parts,
    };
  }

  // Turns a finished upload into a media row: claims the row so one caller runs R2's complete, then
  // verifies size and type before the bytes are trusted; answers { id, path } as POST /upload does and
  // the same media again on a repeat. Answers 404 UPLOAD_NOT_FOUND, 409 UPLOAD_NOT_PENDING, 400
  // INVALID_PARTS, INVALID_POSTER, SIZE_MISMATCH, UNSUPPORTED_TYPE and CONTENT_TYPE_MISMATCH, 502
  // STORAGE_ERROR. An optional `poster` (base64 image) is checked before the row is claimed and stored
  // after the media exists; a failure to store it never fails the call (api.media-retention, RET-B4).
  // A work file (`transcript_audio`, `edit_proxy`) goes through the same checks but makes no media: it answers
  // { id } (the upload's id, the same on a repeat) and takes no poster.
  async complete(
    organizationId: string,
    id: string,
    parts: Array<{ n: number; etag: string }>,
    poster?: string
  ) {
    const row = await this.getOwned(organizationId, id);
    const posterFile = isWorkFile(row)
      ? null
      : await this.readPoster(poster);
    if (row.status === 'completed') {
      return this.answerCompleted(organizationId, row, posterFile);
    }
    if (row.status !== 'pending') {
      throw this.notPending();
    }

    const valid =
      Array.isArray(parts) &&
      parts.length === row.partCount &&
      parts.every(
        (p) =>
          !!p &&
          Number.isInteger(p.n) &&
          p.n >= 1 &&
          p.n <= row.partCount &&
          typeof p.etag === 'string' &&
          p.etag.trim() !== ''
      ) &&
      new Set(parts.map((p) => p.n)).size === row.partCount;
    if (!valid) {
      throw new MobileUploadException(
        400,
        'INVALID_PARTS',
        `Send every part from 1 to ${row.partCount}, each with its etag`
      );
    }

    const claimed = await this._mobileUploadRepository.transitionStatus(
      organizationId,
      id,
      'pending',
      'completing'
    );
    if (!claimed) {
      // Another call (or an abort) moved the row first: answer from where it is now
      const current = await this.getOwned(organizationId, id);
      if (current.status === 'completed') {
        return this.answerCompleted(organizationId, current, posterFile);
      }
      throw this.notPending();
    }

    await this.completeInStorage(organizationId, row, parts);

    try {
      await this.verifyObject(row);
    } catch (err) {
      if (err instanceof MobileUploadException) {
        // The object is wrong (size or type): it is not kept
        await this.discard(organizationId, row);
        throw err;
      }
      // R2 could not be asked: the finished object is fine as far as is known, so keep it and let the
      // call be repeated (R2 then answers NoSuchUpload with the object present and the checks run again)
      console.log('Error', err);
      await this.settle(organizationId, id, 'completing', 'pending');
      throw this.storageError('The uploaded file could not be checked');
    }

    if (isWorkFile(row)) {
      return this.finishWorkFile(organizationId, row);
    }

    // The same call and the same public path as POST /public/v1/upload, marked as the phone's origin
    let media: { id: string; path: string };
    try {
      media = await this._mediaService.saveFile(
        organizationId,
        row.objectKey,
        this.publicPath(row.objectKey),
        undefined,
        MEDIA_ORIGIN_MOBILE
      );
    } catch (err) {
      await this.discard(organizationId, row);
      throw err;
    }
    const marked = await this._mobileUploadRepository
      .markCompleted(organizationId, id, media.id)
      .catch((err) => {
        // The media is live: a failure to store its id on the row is logged, not surfaced
        console.log('Error', err);
        return undefined;
      });
    if (marked === false) {
      // The row was no longer `completing` (moved by another call): answer from where it is now
      console.log(
        'Error',
        `Upload ${id} left completing before its media was stored`
      );
      const current = await this.getOwned(organizationId, id);
      if (current.status === 'completed') {
        return this.withPoster(
          organizationId,
          this.storedMedia(current),
          posterFile
        );
      }
      throw this.notPending();
    }
    return this.withPoster(
      organizationId,
      { id: media.id, path: media.path },
      posterFile
    );
  }

  // Aborts a pending upload in R2 and marks it aborted; 204 on aborted or expired as well. Answers
  // 404 UPLOAD_NOT_FOUND and, for a completed or completing upload, 409 UPLOAD_NOT_PENDING.
  async abort(organizationId: string, id: string) {
    const row = await this.getOwned(organizationId, id);
    if (row.status === 'aborted' || row.status === 'expired') {
      return;
    }
    if (row.status !== 'pending') {
      throw this.notPending();
    }

    const won = await this._mobileUploadRepository.transitionStatus(
      organizationId,
      id,
      'pending',
      'aborted'
    );
    if (!won) {
      const current = await this.getOwned(organizationId, id);
      if (current.status === 'aborted' || current.status === 'expired') {
        return;
      }
      throw this.notPending();
    }

    try {
      await R2.send(
        new AbortMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: row.objectKey,
          UploadId: row.uploadId,
        })
      );
    } catch (err) {
      if (isStorageError(err, 'NoSuchUpload')) {
        return;
      }
      // The multipart upload is still in R2: keep the row pending so the abort can be repeated
      await this._mobileUploadRepository.transitionStatus(
        organizationId,
        id,
        'aborted',
        'pending'
      );
      throw this.storageError('The upload could not be aborted');
    }
  }

  // Closes the uploads nobody finished: a pending row past its expiry and a completing row left for
  // 30 minutes are claimed as expired, then their R2 upload is aborted and, when the upload is gone,
  // the finished object is deleted unless a media row uses it. One batch of the oldest rows; one
  // failing row is logged and left for the next sweep. Never touches completed media rows; a completed
  // work file (caption audio or edit proxy) untouched for a day is closed by `sweepAudio`, and its count is
  // added to the answer.
  async sweep() {
    const now = new Date();
    const completingBefore = new Date(now.getTime() - COMPLETING_TIMEOUT_MS);
    const stale = await this._mobileUploadRepository.findStale(
      now,
      completingBefore,
      MOBILE_UPLOAD_SWEEP_BATCH
    );

    let expired = 0;
    let failed = 0;
    for (const row of stale) {
      try {
        if (await this.expireStale(row, now, completingBefore)) {
          expired++;
        }
      } catch (err) {
        failed++;
        console.log('Error', err);
      }
    }

    if (stale.length) {
      console.log(
        `Mobile upload sweep: ${expired} expired, ${failed} failed of ${stale.length}`
      );
    }

    const audio = await this.sweepAudio(now);
    return { expired: expired + audio.expired, failed: failed + audio.failed };
  }

  // Closes the work files nobody used (caption audio for ai.video-captions, edit proxies for ai.video-editing):
  // a completed one untouched for a day is marked expired and, when no caption or edit job names it, its object
  // is deleted (a job that has it deletes it itself once it is read). One batch of the oldest rows; one failing
  // row is logged and left for the next sweep.
  private async sweepAudio(now: Date) {
    const before = new Date(now.getTime() - AUDIO_LIFETIME_MS);
    const old = await this._mobileUploadRepository.findOldAudio(
      before,
      MOBILE_UPLOAD_SWEEP_BATCH
    );

    let expired = 0;
    let failed = 0;
    for (const row of old) {
      try {
        if (!(await this._mobileUploadRepository.hasCaption(row.id))) {
          await deleteObject(row.objectKey);
        }
        if (await this._mobileUploadRepository.expireAudio(row.id, before)) {
          expired++;
        }
      } catch (err) {
        failed++;
        console.log('Error', err);
      }
    }

    if (old.length) {
      console.log(
        `Mobile upload audio sweep: ${expired} expired, ${failed} failed of ${old.length}`
      );
    }
    return { expired, failed };
  }

  // Claims one stale row as expired (so a complete or abort arriving now finds it closed), then
  // frees its R2 side; R2 failing puts the row back for the next sweep. False when the row moved first.
  private async expireStale(
    row: {
      id: string;
      organizationId: string;
      objectKey: string;
      uploadId: string;
      status: string;
    },
    now: Date,
    completingBefore: Date
  ) {
    const from = row.status;
    const claimed = await this._mobileUploadRepository.expireStale(
      row.id,
      now,
      completingBefore
    );
    if (!claimed) {
      return false;
    }

    try {
      await this.releaseStorage(row);
    } catch (err) {
      await this.settle(row.organizationId, row.id, 'expired', from);
      throw err;
    }
    return true;
  }

  // Aborts the row's multipart upload; when R2 no longer holds it, a finished object (a complete that
  // ended 502, or died) is deleted unless a media row uses it. Throws when R2 cannot say or delete.
  private async releaseStorage(row: {
    organizationId: string;
    objectKey: string;
    uploadId: string;
  }) {
    try {
      await R2.send(
        new AbortMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: row.objectKey,
          UploadId: row.uploadId,
        })
      );
      return;
    } catch (err) {
      if (!isStorageError(err, 'NoSuchUpload')) {
        throw err;
      }
    }

    if (
      (await this.objectExists(row.objectKey)) &&
      !(await this._mobileUploadRepository.hasMedia(
        row.organizationId,
        row.objectKey
      ))
    ) {
      await R2.send(
        new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.objectKey })
      );
    }
  }

  // Runs R2's CompleteMultipartUpload for a claimed row. A part R2 refuses sends the row back to
  // pending (the phone can fix the part and call again), an upload R2 no longer holds ends it as
  // expired unless its object is already there (an earlier call finished it in R2), and any other
  // error sends it back to pending too, as nothing is known to have changed.
  private async completeInStorage(
    organizationId: string,
    row: { id: string; objectKey: string; uploadId: string },
    parts: Array<{ n: number; etag: string }>
  ) {
    try {
      await R2.send(
        new CompleteMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: row.objectKey,
          UploadId: row.uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.n - b.n)
              .map((p) => ({ PartNumber: p.n, ETag: p.etag })),
          },
        })
      );
      return;
    } catch (err) {
      if (isStorageError(err, 'NoSuchUpload')) {
        let present: boolean;
        try {
          present = await this.objectExists(row.objectKey);
        } catch (headErr) {
          // R2 could not say whether the object is there: do not expire a row that may be finished
          console.log('Error', headErr);
          await this.settle(organizationId, row.id, 'completing', 'pending');
          throw this.storageError('The upload could not be completed');
        }
        if (present) {
          return;
        }
        await this.settle(organizationId, row.id, 'completing', 'expired');
        throw this.notPending();
      }

      await this.settle(organizationId, row.id, 'completing', 'pending');
      if (
        isStorageError(err, 'InvalidPart', 'InvalidPartOrder', 'EntityTooSmall')
      ) {
        throw new MobileUploadException(
          400,
          'INVALID_PARTS',
          'R2 refused the parts: upload the part again and send the new etag'
        );
      }
      throw this.storageError('The upload could not be completed');
    }
  }

  // True when the finished object is in R2, false when R2 says it is not there; any other HeadObject
  // failure is thrown, as R2 then could not say.
  private async objectExists(objectKey: string) {
    try {
      await R2.send(
        new HeadObjectCommand({ Bucket: R2_BUCKET, Key: objectKey })
      );
      return true;
    } catch (err) {
      if (isObjectMissing(err)) {
        return false;
      }
      throw err;
    }
  }

  // Checks the finished object is the declared size and the type its extension says (a WAV for a caption audio,
  // an mp4 for an edit proxy).
  private async verifyObject(row: {
    objectKey: string;
    size: bigint;
    purpose?: string | null;
  }) {
    const head = await R2.send(
      new HeadObjectCommand({ Bucket: R2_BUCKET, Key: row.objectKey })
    );
    if (Number(head.ContentLength) !== Number(row.size)) {
      throw new MobileUploadException(
        400,
        'SIZE_MISMATCH',
        'The uploaded file is not the declared size'
      );
    }

    const type = isWorkFile(row)
      ? await checkUploadedObjectType(row.objectKey, typesFor(row.purpose))
      : await checkUploadedObjectType(row.objectKey);
    if (type === 'unsupported') {
      throw new MobileUploadException(
        400,
        'UNSUPPORTED_TYPE',
        'Unsupported file type'
      );
    }
    if (type === 'mismatch') {
      throw new MobileUploadException(
        400,
        'CONTENT_TYPE_MISMATCH',
        'File contents do not match declared type'
      );
    }
  }

  // Moves a claimed row on after a failure; a database error here is logged so it never hides the
  // error being answered (the sweep clears a row left `completing`).
  private async settle(
    organizationId: string,
    id: string,
    from: string,
    to: string
  ) {
    await this._mobileUploadRepository
      .transitionStatus(organizationId, id, from, to)
      .catch((err) => console.log('Error', err));
  }

  // Deletes the finished object (best-effort) and ends the claimed row as aborted.
  private async discard(
    organizationId: string,
    row: { id: string; objectKey: string }
  ) {
    await R2.send(
      new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.objectKey })
    ).catch(() => undefined);
    await this.settle(organizationId, row.id, 'completing', 'aborted');
  }

  // The poster of the complete body, decoded and checked, or null when none was sent. The type is the one
  // the bytes have (magic bytes), never one the client declares; answers 400 INVALID_POSTER.
  private async readPoster(poster?: string) {
    if (poster === undefined || poster === null) {
      return null;
    }
    const invalid = () =>
      new MobileUploadException(
        400,
        'INVALID_POSTER',
        'The poster must be a base64 jpeg, png or webp image of at most 512 KiB'
      );
    if (
      typeof poster !== 'string' ||
      poster.length % 4 !== 0 ||
      poster.length > Math.ceil(MOBILE_UPLOAD_POSTER_MAX_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(poster)
    ) {
      throw invalid();
    }
    const data = Buffer.from(poster, 'base64');
    const type =
      data.length > 0 && data.length <= MOBILE_UPLOAD_POSTER_MAX_BYTES
        ? await posterType(data)
        : null;
    if (!type) {
      throw invalid();
    }
    return { data, ...type };
  }

  // Adds `poster` (its public URL) to the answer once the poster object is stored and named on the media.
  // The video is already a live media, so a failure here is logged and the answer stays { id, path }; a
  // media that already has a poster keeps it, checked before anything is written (a repeat of complete
  // sends the same one again).
  private async withPoster(
    organizationId: string,
    media: { id: string; path: string },
    poster: { data: Buffer; ext: string; mime: string } | null
  ) {
    if (!poster) {
      return media;
    }
    const key = makeId(20) + poster.ext;
    try {
      // A repeat of complete on a media that has a poster keeps it: nothing is written
      if (await this._mediaService.hasPoster(organizationId, media.id)) {
        return media;
      }
      await R2.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: poster.data,
          ContentType: poster.mime,
        })
      );
      if (await this._mediaService.setPoster(organizationId, media.id, key)) {
        return { ...media, poster: this.publicPath(key) };
      }
    } catch (err) {
      console.log('Error', err);
    }
    // Not named by any row: do not leave the object behind (best-effort; the orphan sweep is the backstop)
    await R2.send(
      new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })
    ).catch(() => undefined);
    return media;
  }

  // What complete answers for a completed upload: the media it became (with the poster, if one was sent), or
  // for a work file (caption audio, edit proxy) just its id.
  private async answerCompleted(
    organizationId: string,
    row: {
      id: string;
      mediaId: string | null;
      objectKey: string;
      purpose?: string | null;
    },
    poster: { data: Buffer; ext: string; mime: string } | null
  ) {
    if (isWorkFile(row)) {
      return { id: row.id };
    }
    return this.withPoster(organizationId, this.storedMedia(row), poster);
  }

  // Ends a verified work file upload (caption audio, edit proxy) as completed. It makes no media row; the answer
  // is the upload's id.
  private async finishWorkFile(organizationId: string, row: { id: string }) {
    let marked: boolean;
    try {
      marked = await this._mobileUploadRepository.markCompleted(
        organizationId,
        row.id
      );
    } catch (err) {
      // The object is whole but not recorded: back to pending, so the call can be repeated
      console.log('Error', err);
      await this.settle(organizationId, row.id, 'completing', 'pending');
      throw this.storageError('The upload could not be completed');
    }
    if (!marked) {
      // The row was no longer `completing` (moved by another call): answer from where it is now
      const current = await this.getOwned(organizationId, row.id);
      if (current.status === 'completed') {
        return { id: current.id };
      }
      throw this.notPending();
    }
    return { id: row.id };
  }

  // The media a completed upload became, as complete answers it; the path is the one the media row got.
  private storedMedia(row: { mediaId: string | null; objectKey: string }) {
    if (!row.mediaId) {
      throw this.notPending();
    }
    return { id: row.mediaId, path: this.publicPath(row.objectKey) };
  }

  // The public URL of an object, as the media row of POST /upload stores it.
  private publicPath(objectKey: string) {
    return mediaUrl(objectKey);
  }

  // 409 UPLOAD_NOT_PENDING.
  private notPending() {
    return new MobileUploadException(
      409,
      'UPLOAD_NOT_PENDING',
      'The upload is not pending'
    );
  }

  // 502 STORAGE_ERROR: R2 failed in a way the phone may retry.
  private storageError(message: string) {
    return new MobileUploadException(502, 'STORAGE_ERROR', message);
  }

  // The upload of the workspace; 404 UPLOAD_NOT_FOUND when the id is not the workspace's.
  private async getOwned(organizationId: string, id: string) {
    const row = await this._mobileUploadRepository.findByIdAndOrg(
      organizationId,
      id
    );
    if (!row) {
      throw new MobileUploadException(
        404,
        'UPLOAD_NOT_FOUND',
        'Upload not found'
      );
    }
    return row;
  }

  // The largest file an upload may declare: for a caption audio AI_CAPTIONS_MAX_AUDIO_BYTES or the 120 MiB
  // default, for an edit proxy AI_EDIT_MAX_PROXY_BYTES or the 16 MiB default, for media MOBILE_UPLOAD_MAX_BYTES
  // or the 4 GiB default.
  private maxBytes(purpose: MobileUploadPurpose) {
    const [env, fallback] =
      purpose === MOBILE_UPLOAD_PURPOSE_AUDIO
        ? [process.env.AI_CAPTIONS_MAX_AUDIO_BYTES, DEFAULT_AUDIO_MAX_BYTES]
        : purpose === MOBILE_UPLOAD_PURPOSE_EDIT_PROXY
        ? [process.env.AI_EDIT_MAX_PROXY_BYTES, DEFAULT_EDIT_PROXY_MAX_BYTES]
        : [process.env.MOBILE_UPLOAD_MAX_BYTES, DEFAULT_MAX_BYTES];
    const configured = Math.floor(Number(env));
    return configured > 0 ? configured : fallback;
  }
}
