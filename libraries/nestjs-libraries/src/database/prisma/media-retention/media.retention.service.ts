// Media retention (api.media-retention): decides, for one media row, whether its file may be purged
// and when. Pure rules first, then the service that feeds them from the posts and purges what is due
// (RET-B2: claim the row, ask again, delete the R2 object) and refuses a purged file to a new post.
import { HttpException, Injectable } from '@nestjs/common';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { R2, R2_BUCKET } from '@gitroom/nestjs-libraries/upload/r2.uploader';
import { MediaRetentionRepository } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.repository';
import {
  MEDIA_ORIGIN_MOBILE,
  mediaRetentionConfig,
  MIN_UNREFERENCED_DAYS,
  STALE_THREAD_ROW_DAYS,
} from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.config';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// How many times the post workflow runs one row's publish call (its `iterate` list of 5, a retry after a
// token refresh or an error). The comment `sleep(delay)` sits inside that loop, so a retry sleeps again:
// a comment can wait up to this many times its delay (post.workflow.v1.1.4.ts). Over-retention only.
export const COMMENT_SLEEP_ATTEMPTS = 5;

// The most rows one page of a purge run reads, and the most pages one run reads (500 rows at most, so
// one run's reference scans stay bounded). A run that fills its pages hands back a cursor and the next
// run continues after it, so rows kept open for ever delay the others by one cycle, never for good.
export const MEDIA_PURGE_BATCH = 100;
export const MEDIA_PURGE_MAX_PAGES = 5;

// A post or auto-publish that names a purged file is refused with this error (410, the app re-uploads).
export class MediaPurgedException extends HttpException {
  // Answers 410 MEDIA_PURGED in the public API's shape { statusCode, code, message }.
  constructor() {
    super(
      {
        statusCode: 410,
        code: 'MEDIA_PURGED',
        message:
          'The file was removed from the server after its retention period; upload it again',
      },
      410
    );
  }
}

// The columns of a post row the channel state is read from.
export interface RetentionPostRow {
  id: string;
  group: string;
  state: string;
  releaseURL: string | null;
  intervalInDays: number | null;
  parentPostId: string | null;
  // Minutes the workflow waits before it posts this row, after the row it replies to
  delay: number;
  updatedAt: Date;
}

// The state of one channel (a group: the first post and its thread). `since` is when its last row
// reached the final state (its latest updatedAt: a later edit only delays the purge).
export type ChannelState =
  | { state: 'open' }
  | { state: 'published' | 'error'; since: Date };

type EndedChannel = Exclude<ChannelState, { state: 'open' }>;

// The media columns the rules read.
export interface RetentionMedia {
  id: string;
  name: string;
  organizationId: string;
  origin: string | null;
  purgedAt: Date | null;
  createdAt: Date;
}

export type RetentionVerdict =
  | {
      purge: false;
      reason: 'not-mobile' | 'purged' | 'forever' | 'open' | 'set';
    }
  | {
      purge: true;
      reason: 'published' | 'error' | 'unreferenced';
      purgeAt: Date;
    };

// Why the file is kept whatever the posts say, or undefined when the posts decide.
const keepReason = (
  media: Pick<RetentionMedia, 'origin' | 'purgedAt'>,
  config: ReturnType<typeof mediaRetentionConfig>
) => {
  if (media.origin !== MEDIA_ORIGIN_MOBILE) {
    return 'not-mobile' as const;
  }
  if (media.purgedAt) {
    return 'purged' as const;
  }
  return config.retentionDays === -1 ? ('forever' as const) : undefined;
};

// Minutes the workflow may sleep before this row can post: its own delay plus that of every row it
// replies to (each comment waits `delay` after the previous one), each times COMMENT_SLEEP_ATTEMPTS
// because a retry of the publish call sleeps again. A chain that cannot be followed (a parent deleted,
// a loop) counts every delay of the group, so the answer only ever errs long.
const chainDelayMinutes = (row: RetentionPostRow, group: RetentionPostRow[]) => {
  const byId = new Map(group.map((r) => [r.id, r]));
  const seen = new Set<string>();
  let total = 0;
  let current: RetentionPostRow | undefined = row;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    total += Math.max(0, current.delay || 0);
    if (current.parentPostId === null) {
      return total * COMMENT_SLEEP_ATTEMPTS;
    }
    current = byId.get(current.parentPostId);
  }
  return (
    group.reduce((sum, r) => sum + Math.max(0, r.delay || 0), 0) *
    COMMENT_SLEEP_ATTEMPTS
  );
};

// Whether a row is a thread row (a comment under the first post) still QUEUE long after the first post
// went out: a provider that cannot post comments never sends it, so it is not waited for. The wait
// runs from when the group last published (`publishedAt`, never the row's own updatedAt, which is when
// it was written) and is STALE_THREAD_ROW_DAYS plus the minutes the workflow may sleep before it.
const isStaleThreadRow = (
  row: RetentionPostRow,
  group: RetentionPostRow[],
  publishedAt: number,
  now: Date
) =>
  row.state === 'QUEUE' &&
  row.parentPostId !== null &&
  now.getTime() - publishedAt >=
    STALE_THREAD_ROW_DAYS * DAY_MS + chainDelayMinutes(row, group) * MINUTE_MS;

// The state of each channel, from the live rows of the groups. A group is final only when none of
// its rows repeats (intervalInDays), and then ERROR when any row is ERROR (the workflow marks the
// first post, a thread's later rows stay QUEUE), PUBLISHED when every row is PUBLISHED with a URL, or
// when the first post is and the rest are thread rows QUEUE for STALE_THREAD_ROW_DAYS; anything else
// (QUEUE, DRAFT, a PUBLISHED row without a URL) is open.
export const classifyChannels = (
  rows: RetentionPostRow[],
  now: Date = new Date()
): ChannelState[] => {
  const groups = new Map<string, RetentionPostRow[]>();
  for (const row of rows) {
    groups.set(row.group, [...(groups.get(row.group) || []), row]);
  }
  return [...groups.values()].map((group): ChannelState => {
    if (group.some((r) => r.intervalInDays !== null)) {
      return { state: 'open' };
    }
    const since = new Date(Math.max(...group.map((r) => r.updatedAt.getTime())));
    if (group.some((r) => r.state === 'ERROR')) {
      return { state: 'error', since };
    }
    const sent = (r: RetentionPostRow) =>
      r.state === 'PUBLISHED' && !!r.releaseURL;
    // When the group last published: a thread row waits from then, not from its own creation
    const publishedAt = Math.max(
      ...group.filter(sent).map((r) => r.updatedAt.getTime())
    );
    const published =
      group.every(sent) ||
      (group.some((r) => r.parentPostId === null && sent(r)) &&
        group.every(
          (r) => sent(r) || isStaleThreadRow(r, group, publishedAt, now)
        ));
    return published ? { state: 'published', since } : { state: 'open' };
  });
};

// Whether and when the file may be purged. Never while a channel is open or a set names the file;
// with no channel at all (never posted, or every post deleted) the error window (at least
// MIN_UNREFERENCED_DAYS) runs from createdAt or from the latest deletion of a post that carried it;
// with an ERROR channel the error window runs from the last channel's end, else the retention window.
export const retentionVerdict = (input: {
  media: RetentionMedia;
  channels: ChannelState[];
  referencedBySet: boolean;
  lastDeletedAt?: Date | null;
  config: ReturnType<typeof mediaRetentionConfig>;
}): RetentionVerdict => {
  const { media, channels, referencedBySet, lastDeletedAt, config } = input;
  const kept = keepReason(media, config);
  if (kept) {
    return { purge: false, reason: kept };
  }
  if (channels.some((c) => c.state === 'open')) {
    return { purge: false, reason: 'open' };
  }
  if (referencedBySet) {
    return { purge: false, reason: 'set' };
  }
  if (channels.length === 0) {
    const anchor = Math.max(
      media.createdAt.getTime(),
      lastDeletedAt?.getTime() ?? 0
    );
    const days = Math.max(config.errorRetentionDays, MIN_UNREFERENCED_DAYS);
    return {
      purge: true,
      reason: 'unreferenced',
      purgeAt: new Date(anchor + days * DAY_MS),
    };
  }
  const ended = channels.filter((c): c is EndedChannel => c.state !== 'open');
  const last = Math.max(...ended.map((c) => c.since.getTime()));
  const failed = ended.some((c) => c.state === 'error');
  const days = failed ? config.errorRetentionDays : config.retentionDays;
  return {
    purge: true,
    reason: failed ? 'error' : 'published',
    purgeAt: new Date(last + days * DAY_MS),
  };
};

@Injectable()
export class MediaRetentionService {
  // Receives the reader of the posts and sets that carry a media file.
  constructor(private _mediaRetentionRepository: MediaRetentionRepository) {}

  // The verdict for one media row of a workspace, read from the posts now. A row that is not the
  // phone's, is already purged, or is kept forever is answered without reading any post. The caller
  // purges only when `purge` is true and `purgeAt` has passed, and asks again right before deleting.
  async evaluate(
    media: RetentionMedia,
    now: Date = new Date()
  ): Promise<RetentionVerdict> {
    const config = mediaRetentionConfig();
    const kept = keepReason(media, config);
    if (kept) {
      return { purge: false, reason: kept };
    }

    const groups = await this._mediaRetentionRepository.findReferencingGroups(
      media.organizationId,
      media
    );
    const rows = groups.length
      ? await this._mediaRetentionRepository.findGroupRows(
          media.organizationId,
          groups
        )
      : [];
    const referencedBySet =
      (await this._mediaRetentionRepository.countSetReferences(
        media.organizationId,
        media
      )) > 0;

    // Only a file no live post carries reads the deletion clock
    const lastDeletedAt =
      groups.length || referencedBySet
        ? null
        : await this._mediaRetentionRepository.findLastDeletedAt(
            media.organizationId,
            media
          );

    return retentionVerdict({
      media,
      channels: classifyChannels(rows, now),
      referencedBySet,
      lastDeletedAt,
      config,
    });
  }

  // Whether a live post or set still needs the file (RET-B3, for a deletion the owner asked for, not a
  // retention purge): an open channel (queued, draft, repeating), a channel in ERROR still inside its
  // MEDIA_RETENTION_ERROR_DAYS window (Retry sends it again), or a set. A published channel is final and
  // does not keep the file, and an ERROR channel past its window no longer does.
  async isStillNeeded(
    media: Pick<RetentionMedia, 'id' | 'name' | 'organizationId'>,
    now: Date = new Date()
  ) {
    const groups = await this._mediaRetentionRepository.findReferencingGroups(
      media.organizationId,
      media
    );
    if (groups.length) {
      const rows = await this._mediaRetentionRepository.findGroupRows(
        media.organizationId,
        groups
      );
      const errorMs = mediaRetentionConfig().errorRetentionDays * DAY_MS;
      const needed = classifyChannels(rows, now).some(
        (c) =>
          c.state === 'open' ||
          (c.state === 'error' && c.since.getTime() + errorMs > now.getTime())
      );
      if (needed) {
        return true;
      }
    }
    return (
      (await this._mediaRetentionRepository.countSetReferences(
        media.organizationId,
        media
      )) > 0
    );
  }

  // Deletes the R2 object of every phone file whose verdict says it is due, and marks its row purged.
  // Reads pages of the oldest candidates after `cursor` (at most MEDIA_PURGE_MAX_PAGES of
  // MEDIA_PURGE_BATCH); one failing row is logged and left for the next run. Answers the cursor the next
  // run starts from: the last row read when the pages were full, null when the end was reached (the
  // next run starts again from the oldest). Does nothing when MEDIA_RETENTION_DAYS is -1.
  async purgeDue(now: Date = new Date(), cursor: string | null = null) {
    const config = mediaRetentionConfig();
    const result = {
      scanned: 0,
      purged: 0,
      kept: 0,
      failed: 0,
      cursor: null as string | null,
    };
    if (config.retentionDays === -1) {
      return result;
    }

    // No verdict can be due before the shorter of the two windows has passed since the upload
    const createdBefore = new Date(
      now.getTime() -
        Math.min(config.retentionDays, config.errorRetentionDays) * DAY_MS
    );
    let after: string | undefined = cursor || undefined;
    for (let page = 0; page < MEDIA_PURGE_MAX_PAGES; page++) {
      const rows = await this._mediaRetentionRepository.findPurgeCandidates(
        createdBefore,
        MEDIA_PURGE_BATCH,
        after
      );
      for (const row of rows) {
        result.scanned++;
        try {
          if (await this.purgeOne(row, now)) {
            result.purged++;
          } else {
            result.kept++;
          }
        } catch (err) {
          result.failed++;
          console.log('Error', err);
        }
      }
      if (rows.length < MEDIA_PURGE_BATCH) {
        // The end of the candidates: the next run wraps to the oldest
        result.cursor = null;
        break;
      }
      after = rows[rows.length - 1].id;
      result.cursor = after;
    }

    if (result.purged || result.failed) {
      console.log(
        `Media retention purge: ${result.purged} purged, ${result.failed} failed of ${result.scanned}`
      );
    }
    return result;
  }

  // Refuses (410 MEDIA_PURGED) a post that would publish a file the purge already deleted. Called
  // for the media ids of a post that can publish; a purged row elsewhere (the library) is untouched.
  async assertNotPurged(organizationId: string, mediaIds: string[]) {
    const purged = await this._mediaRetentionRepository.findPurgedIds(
      organizationId,
      mediaIds
    );
    if (purged.length) {
      throw new MediaPurgedException();
    }
  }

  // Purges one candidate when it is due: claims the row first (one run wins), asks again after the
  // claim (a post may have taken the file since the first look, and a post created after the claim
  // is refused by assertNotPurged), then deletes the object. Anything but a deleted object puts the
  // claim back. True when the object was deleted.
  private async purgeOne(media: RetentionMedia, now: Date) {
    const due = (verdict: RetentionVerdict) =>
      verdict.purge && verdict.purgeAt.getTime() <= now.getTime();

    if (!due(await this.evaluate(media, now))) {
      return false;
    }
    const claimed = await this._mediaRetentionRepository.claimPurge(
      media.organizationId,
      media.id,
      now
    );
    if (!claimed) {
      return false;
    }

    let deleted = false;
    try {
      // `media` still has no purgedAt, so this reads the posts again
      if (due(await this.evaluate(media, now))) {
        await this.deleteObject(media.name);
        deleted = true;
      }
    } finally {
      if (!deleted) {
        await this._mediaRetentionRepository
          .releasePurge(media.organizationId, media.id)
          .catch((err) => console.log('Error', err));
      }
    }
    return deleted;
  }

  // Deletes one object by its key (`Media.name`), never a prefix or a list; an empty key is refused
  // (it would not name an object) and an object already gone is fine. The sweeps use it as well.
  async deleteObject(key: string) {
    if (!key) {
      throw new Error('The media row has no object key');
    }
    try {
      await R2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (err) {
      const e = err as {
        name?: string;
        Code?: string;
        $metadata?: { httpStatusCode?: number };
      };
      const gone =
        ['NotFound', 'NoSuchKey'].includes(e?.name || '') ||
        ['NotFound', 'NoSuchKey'].includes(e?.Code || '') ||
        e?.$metadata?.httpStatusCode === 404;
      if (!gone) {
        throw err;
      }
    }
  }
}
