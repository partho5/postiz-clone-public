// Media retention (api.media-retention, RET-B3): frees the R2 object of a media row the user deleted, and
// the two nightly sweeps: the soft-deleted backlog and the orphan objects (no media row names them).
// Both sweeps are a dry run (read, log, change nothing) until MEDIA_SWEEP_DELETE=true.
import { Injectable } from '@nestjs/common';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { R2, R2_BUCKET } from '@gitroom/nestjs-libraries/upload/r2.uploader';
import { MediaRetentionService } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.service';
import { MediaSweepRepository } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.sweep.repository';
import {
  mediaRetentionConfig,
  mediaSweepConfig,
  ORPHAN_GRACE_DAYS,
} from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.config';

const DAY_MS = 24 * 60 * 60 * 1000;

// The soft-deleted backlog: rows per page, pages per run (500 rows, so one run's reference scans stay
// bounded). A run that fills its pages hands back a cursor and the next run continues after it.
export const MEDIA_SWEEP_BATCH = 100;
export const MEDIA_SWEEP_MAX_PAGES = 5;

// The orphan sweep: keys listed per R2 request, requests per run, and keys per run whose references
// are scanned (the expensive part; most keys are answered by one query on `Media.name`). A run that
// hits a limit hands back the last key it finished, and the next run lists after it.
export const ORPHAN_LIST_PAGE = 1000;
export const ORPHAN_MAX_LIST_PAGES = 3;
export const ORPHAN_MAX_CHECKS = 200;

// The key of a file a media row names: one flat name (no folder) of letters, digits, `_` and `-`, and a
// short extension. A client can write any `name` through save-media, so nothing else is ever deleted.
const MEDIA_ROW_KEY = /^[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9]{2,5}$/;

// The key an upload writes: 10 to 32 letters and digits and an extension (`makeId(10)` for the web and
// simple uploads, `makeId(20)` for multipart and the phone). The orphan sweep deletes only these, so
// clipping intermediates (`clip-<id>-source.mp4`, transcripts) and anything else in the bucket are not
// touched whatever the database says.
const UPLOAD_KEY = /^[A-Za-z0-9]{10,32}\.[A-Za-z0-9]{2,5}$/;

// What the sweeps answer, for the activity and the log.
export interface DeletedSweepResult {
  scanned: number;
  // Objects deleted; in a dry run, the objects that would be
  freed: number;
  kept: number;
  failed: number;
  cursor: string | null;
  dryRun: boolean;
}

export interface OrphanSweepResult {
  listed: number;
  // Keys no media row names, old enough, and named nowhere else
  orphans: number;
  // Objects deleted (0 in a dry run)
  deleted: number;
  // Keys a table still names, so they stay
  kept: number;
  failed: number;
  cursor: string | null;
  dryRun: boolean;
}

// The columns of a soft-deleted media row the free needs.
export interface DeletedMedia {
  id: string;
  name: string;
  organizationId: string;
  status: string;
  // Set when the video object is already gone (a retention purge or an earlier free)
  purgedAt?: Date | null;
  // The poster object key (RET-B4); freed with the video, or alone when the video was purged
  posterKey?: string | null;
}

@Injectable()
export class MediaSweepService {
  // Receives the reads and claims of the sweeps and the retention service (the reference rule and the
  // single-key delete).
  constructor(
    private _mediaSweepRepository: MediaSweepRepository,
    private _mediaRetentionService: MediaRetentionService
  ) {}

  // Frees the R2 object of a media row the user just deleted in the web library (the row is already
  // soft-deleted and stays so). Not behind MEDIA_SWEEP_DELETE or MEDIA_RETENTION_DAYS: the user asked
  // for it. Never throws: a failure is logged and the nightly sweep retries. True when the object went.
  async freeDeletedObject(media: DeletedMedia, now: Date = new Date()) {
    try {
      if (!this.canFree(media)) {
        return false;
      }
      return (await this.freeOne(media, now, false)) === 'freed';
    } catch (err) {
      console.log('Error', err);
      return false;
    }
  }

  // The backlog of soft-deleted rows whose object still exists: reads pages of them after `cursor` (at
  // most MEDIA_SWEEP_MAX_PAGES of MEDIA_SWEEP_BATCH), frees each one nothing needs, and answers the
  // cursor of the next run (null at the end, so the next run wraps to the oldest). One failing row is
  // logged and left for the next run. Does nothing when MEDIA_RETENTION_DAYS is -1 or storage is not
  // R2; a dry run when MEDIA_SWEEP_DELETE is not true.
  async sweepDeleted(
    now: Date = new Date(),
    cursor: string | null = null
  ): Promise<DeletedSweepResult> {
    const dryRun = !mediaSweepConfig().deleteEnabled;
    const result: DeletedSweepResult = {
      scanned: 0,
      freed: 0,
      kept: 0,
      failed: 0,
      cursor: null,
      dryRun,
    };
    if (mediaRetentionConfig().retentionDays === -1 || !this.cloudStorage()) {
      return result;
    }

    let after: string | undefined = cursor || undefined;
    for (let page = 0; page < MEDIA_SWEEP_MAX_PAGES; page++) {
      const rows = await this._mediaSweepRepository.findDeletedCandidates(
        MEDIA_SWEEP_BATCH,
        after
      );
      for (const row of rows) {
        result.scanned++;
        try {
          if (!this.canFree(row)) {
            result.kept++;
          } else if ((await this.freeOne(row, now, dryRun)) === 'kept') {
            result.kept++;
          } else {
            result.freed++;
          }
        } catch (err) {
          result.failed++;
          console.log('Error', err);
        }
      }
      if (rows.length < MEDIA_SWEEP_BATCH) {
        result.cursor = null;
        break;
      }
      after = rows[rows.length - 1].id;
      result.cursor = after;
    }

    console.log(
      `Media deleted sweep${dryRun ? ' (dry run)' : ''}: ${result.freed} ${
        dryRun ? 'would be freed' : 'freed'
      }, ${result.kept} kept, ${result.failed} failed of ${result.scanned}`
    );
    return result;
  }

  // The orphan objects: lists the bucket after `cursor` (a key; null from the start), and for every
  // upload-shaped key at least ORPHAN_GRACE_DAYS old that no media row names and no table names
  // anywhere, deletes the object (a dry run only logs it). Answers the last key it finished, or null
  // at the end of the bucket, so the next run lists on from there. Does nothing when
  // MEDIA_RETENTION_DAYS is -1 or storage is not R2.
  async sweepOrphans(
    now: Date = new Date(),
    cursor: string | null = null
  ): Promise<OrphanSweepResult> {
    const dryRun = !mediaSweepConfig().deleteEnabled;
    const result: OrphanSweepResult = {
      listed: 0,
      orphans: 0,
      deleted: 0,
      kept: 0,
      failed: 0,
      cursor: null,
      dryRun,
    };
    if (mediaRetentionConfig().retentionDays === -1 || !this.cloudStorage()) {
      return result;
    }

    // Younger objects may be an upload whose media row is not written yet
    const graceEnd = new Date(now.getTime() - ORPHAN_GRACE_DAYS * DAY_MS);
    let startAfter: string | undefined = cursor || undefined;
    let checks = 0;
    let stopped = false;

    for (let page = 0; page < ORPHAN_MAX_LIST_PAGES && !stopped; page++) {
      const listed = await R2.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          MaxKeys: ORPHAN_LIST_PAGE,
          ...(startAfter ? { StartAfter: startAfter } : {}),
        })
      );
      const objects = (listed.Contents || []).filter((o) => !!o.Key);
      result.listed += objects.length;

      const old = objects
        .filter(
          (o) =>
            UPLOAD_KEY.test(o.Key!) &&
            !!o.LastModified &&
            o.LastModified.getTime() <= graceEnd.getTime()
        )
        .map((o) => o.Key!);
      // One query answers every key a media row names, which is nearly all of them
      const named = new Set(await this._mediaSweepRepository.findNamedKeys(old));
      const unnamed = new Set(old.filter((key) => !named.has(key)));

      for (const object of objects) {
        const key = object.Key!;
        if (unnamed.has(key)) {
          if (checks >= ORPHAN_MAX_CHECKS) {
            // Stop here: the next run lists after the last key that was finished
            stopped = true;
            break;
          }
          checks++;
          await this.sweepOrphan(key, object.Size, graceEnd, dryRun, result);
        }
        result.cursor = key;
      }

      if (stopped) {
        break;
      }
      if (!listed.IsTruncated || !objects.length) {
        // The end of the bucket: the next run starts again from the first key
        result.cursor = null;
        break;
      }
      startAfter = objects[objects.length - 1].Key;
    }

    console.log(
      `Media orphan sweep${dryRun ? ' (dry run)' : ''}: ${result.orphans} orphans, ${
        result.deleted
      } deleted, ${result.kept} still named, ${result.failed} failed, of ${
        result.listed
      } listed`
    );
    return result;
  }

  // Looks at one key no media row names: a table that still names it keeps it; otherwise it is an
  // orphan, logged in a dry run, and deleted after the references are read once more (a row written
  // since the first look wins). One failure is counted and logged, never thrown.
  private async sweepOrphan(
    key: string,
    size: number | undefined,
    graceEnd: Date,
    dryRun: boolean,
    result: OrphanSweepResult
  ) {
    try {
      if (await this._mediaSweepRepository.findAnyReference(key, graceEnd)) {
        result.kept++;
        return;
      }
      if (dryRun) {
        result.orphans++;
        console.log(
          `Media orphan sweep (dry run): would delete ${key} (${size ?? '?'} bytes)`
        );
        return;
      }
      if (
        (await this._mediaSweepRepository.findNamedKeys([key])).length ||
        (await this._mediaSweepRepository.findAnyReference(key, graceEnd))
      ) {
        result.kept++;
        return;
      }
      result.orphans++;
      await this._mediaRetentionService.deleteObject(key);
      result.deleted++;
    } catch (err) {
      result.failed++;
      console.log('Error', err);
    }
  }

  // Frees one soft-deleted row's object. A dry run only answers; otherwise it claims the row first (one
  // caller wins; a post made after the claim is refused as MEDIA_PURGED), asks again, deletes the
  // object by its key (then its poster, RET-B4) and keeps the claim once the video is gone; a poster
  // that fails is put back and retried alone. A row whose video was purged earlier has only its poster left. 'freed' also means "would be".
  private async freeOne(media: DeletedMedia, now: Date, dryRun: boolean) {
    if (media.purgedAt) {
      return (await this.freePoster(media, dryRun)) ? 'freed' : 'kept';
    }
    if (dryRun) {
      return (await this.mayFree(media, now)) ? 'freed' : 'kept';
    }
    const claimed = await this._mediaSweepRepository.claimDeleted(
      media.organizationId,
      media.id,
      now
    );
    if (!claimed) {
      return 'kept';
    }

    let deleted = false;
    try {
      if (await this.mayFree(media, now)) {
        await this._mediaRetentionService.deleteObject(media.name);
        // The video is gone: the claim stays even if the poster delete throws below, and the next
        // sweep retries the poster alone (a purged row that still names one).
        deleted = true;
        await this.freePoster(media, false);
      }
    } finally {
      if (!deleted) {
        await this._mediaSweepRepository
          .releaseDeleted(media.organizationId, media.id)
          .catch((err) => console.log('Error', err));
      }
    }
    return deleted ? 'freed' : 'kept';
  }

  // Deletes the poster object of a soft-deleted row (api.media-retention, RET-B4). The key is written only
  // by `complete`, one random key per media, so no other row or post names it. The key is taken off the row
  // in one statement first (one caller wins) and put back when the delete fails, so the sweep retries; an
  // object lost after the claim is an orphan for the orphan sweep. True when there was a poster to free.
  private async freePoster(media: DeletedMedia, dryRun: boolean) {
    const key = media.posterKey;
    if (!key || !MEDIA_ROW_KEY.test(key)) {
      return false;
    }
    if (dryRun) {
      return true;
    }
    if (
      !(await this._mediaSweepRepository.claimPoster(
        media.organizationId,
        media.id,
        key
      ))
    ) {
      return false;
    }
    try {
      await this._mediaRetentionService.deleteObject(key);
    } catch (err) {
      await this._mediaSweepRepository
        .releasePoster(media.organizationId, media.id, key)
        .catch((e) => console.log('Error', e));
      throw err;
    }
    return true;
  }

  // Nothing needs the object any more: no queued, draft, repeating or failed post and no set of the
  // workspace carries it, no other live media row, picture, other workspace's post or set, or other
  // table names it.
  private async mayFree(media: DeletedMedia, now: Date) {
    if (await this._mediaRetentionService.isStillNeeded(media, now)) {
      return false;
    }
    if (
      (await this._mediaSweepRepository.countOtherUsers(media.id, media.name)) >
      0
    ) {
      return false;
    }
    const recentSince = new Date(now.getTime() - ORPHAN_GRACE_DAYS * DAY_MS);
    return !(await this._mediaSweepRepository.findForeignReference(
      media.name,
      media.organizationId,
      recentSince
    ));
  }

  // The object may be freed only on R2, for a row still not being normalized and a key of the
  // upload's shape (a client can write any `name`; a folder or an odd name is never deleted).
  private canFree(media: DeletedMedia) {
    return (
      this.cloudStorage() &&
      media.status !== 'processing' &&
      MEDIA_ROW_KEY.test(media.name || '')
    );
  }

  private cloudStorage() {
    return process.env.STORAGE_PROVIDER === 'cloudflare';
  }
}
