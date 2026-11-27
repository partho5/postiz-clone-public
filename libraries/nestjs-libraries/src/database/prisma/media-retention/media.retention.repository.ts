// Media retention (api.media-retention): reads which posts and sets still carry a media file.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MEDIA_ORIGIN_MOBILE } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.config';

// What identifies a file inside the JSON text of a post: its media id, and its object key (the end of
// every stored URL, so it still matches after the media base URL is rebased).
interface MediaNeedles {
  id: string;
  name: string;
}

@Injectable()
export class MediaRetentionRepository {
  // Receives the Prisma repositories for the posts and the sets that may hold a media reference, and
  // for the media rows the purge claims.
  constructor(
    private _post: PrismaRepository<'post'>,
    private _sets: PrismaRepository<'sets'>,
    private _media: PrismaRepository<'media'>
  ) {}

  // The groups (one per channel of a request) of the workspace's live posts that carry the media in
  // their image list or provider settings. Both columns are JSON text, so the match is `contains`:
  // a false positive only keeps a file longer.
  async findReferencingGroups(organizationId: string, media: MediaNeedles) {
    const posts = await this._post.model.post.findMany({
      where: {
        organizationId,
        deletedAt: null,
        OR: this.needles(media).flatMap((needle) => [
          { image: { contains: needle } },
          { settings: { contains: needle } },
        ]),
      },
      select: { group: true },
      distinct: ['group'],
    });
    return posts.map((p) => p.group);
  }

  // Every live row of these groups (the first post and its thread), with what the channel state needs.
  findGroupRows(organizationId: string, groups: string[]) {
    return this._post.model.post.findMany({
      where: { organizationId, deletedAt: null, group: { in: groups } },
      select: {
        id: true,
        group: true,
        state: true,
        releaseURL: true,
        intervalInDays: true,
        parentPostId: true,
        delay: true,
        updatedAt: true,
      },
    });
  }

  // When the latest deleted post that carried the media was deleted; null when none was. A file whose
  // only posts were deleted starts its unreferenced wait from then, not from its upload.
  async findLastDeletedAt(organizationId: string, media: MediaNeedles) {
    const post = await this._post.model.post.findFirst({
      where: {
        organizationId,
        deletedAt: { not: null },
        OR: this.needles(media).flatMap((needle) => [
          { image: { contains: needle } },
          { settings: { contains: needle } },
        ]),
      },
      orderBy: { deletedAt: 'desc' },
      select: { deletedAt: true },
    });
    return post?.deletedAt ?? null;
  }

  // How many of the workspace's sets (saved post templates) name the media.
  countSetReferences(organizationId: string, media: MediaNeedles) {
    return this._sets.model.sets.count({
      where: {
        organizationId,
        OR: this.needles(media).map((needle) => ({
          content: { contains: needle },
        })),
      },
    });
  }

  // The phone's media rows not purged yet and uploaded by `createdBefore`, oldest first, `take` of
  // them after the row `afterId` (the paging cursor, kept across runs; a row that no longer exists gives
  // an empty page, so the run ends and the next one starts again from the oldest), with the columns the
  // rules read.
  findPurgeCandidates(createdBefore: Date, take: number, afterId?: string) {
    return this._media.model.media.findMany({
      where: {
        origin: MEDIA_ORIGIN_MOBILE,
        purgedAt: null,
        createdAt: { lte: createdBefore },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        organizationId: true,
        origin: true,
        purgedAt: true,
        createdAt: true,
      },
    });
  }

  // Marks the phone's media purged in one statement, so only one of two simultaneous runs wins;
  // true when this call made the mark.
  async claimPurge(organizationId: string, id: string, at: Date) {
    const { count } = await this._media.model.media.updateMany({
      where: {
        id,
        organizationId,
        origin: MEDIA_ORIGIN_MOBILE,
        purgedAt: null,
      },
      data: { purgedAt: at },
    });
    return count === 1;
  }

  // Takes a claim back (the file was not deleted), so the next run looks at the row again.
  async releasePurge(organizationId: string, id: string) {
    const { count } = await this._media.model.media.updateMany({
      where: { id, organizationId, purgedAt: { not: null } },
      data: { purgedAt: null },
    });
    return count === 1;
  }

  // Which of these media ids of the workspace are purged (their file is gone from R2).
  async findPurgedIds(organizationId: string, ids: string[]) {
    const wanted = [...new Set(ids.filter((id) => !!id))];
    if (!wanted.length) {
      return [];
    }
    const rows = await this._media.model.media.findMany({
      where: { organizationId, id: { in: wanted }, purgedAt: { not: null } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // The strings to look for; an empty one would match every row.
  private needles(media: MediaNeedles) {
    return [media.id, media.name].filter((needle) => !!needle);
  }
}
