// Media retention (api.media-retention, RET-B3): reads and claims for the web delete and the two nightly
// sweeps (soft-deleted backlog, orphan objects). Prisma only; every read is a `contains` or an equality
// on one key, so a coincidence only keeps an object longer.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class MediaSweepRepository {
  // Receives the Prisma repositories of the media rows and of every table that can name a stored file.
  constructor(
    private _media: PrismaRepository<'media'>,
    private _post: PrismaRepository<'post'>,
    private _sets: PrismaRepository<'sets'>,
    private _signatures: PrismaRepository<'signatures'>,
    private _integration: PrismaRepository<'integration'>,
    private _organization: PrismaRepository<'organization'>,
    private _clipping: PrismaRepository<'clipping'>,
    private _clippingClip: PrismaRepository<'clippingClip'>,
    private _mobileUpload: PrismaRepository<'mobileUpload'>
  ) {}

  // The soft-deleted media rows with an object that may still exist (the video not yet freed, or a poster
  // still named, RET-B4), oldest first, `take` of them after the row `afterId` (the cursor kept across
  // runs; a row that no longer exists gives an empty page, so the run ends and the next one starts again
  // from the oldest). Rows still being normalized, and rows with no key, are left out.
  findDeletedCandidates(take: number, afterId?: string) {
    return this._media.model.media.findMany({
      where: {
        deletedAt: { not: null },
        OR: [{ purgedAt: null }, { posterKey: { not: null } }],
        status: { not: 'processing' },
        name: { not: '' },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        organizationId: true,
        status: true,
        purgedAt: true,
        posterKey: true,
      },
    });
  }

  // Takes the poster key off a soft-deleted row in one statement, so only one of two simultaneous callers
  // deletes the object; true when this call took it (api.media-retention, RET-B4).
  async claimPoster(organizationId: string, id: string, posterKey: string) {
    const { count } = await this._media.model.media.updateMany({
      where: { id, organizationId, deletedAt: { not: null }, posterKey },
      data: { posterKey: null },
    });
    return count === 1;
  }

  // Puts the poster key back (the object was not deleted), so a later run looks at the row again.
  async releasePoster(organizationId: string, id: string, posterKey: string) {
    const { count } = await this._media.model.media.updateMany({
      where: { id, organizationId, posterKey: null },
      data: { posterKey },
    });
    return count === 1;
  }

  // Marks a soft-deleted row's object as removed in one statement, so only one of two simultaneous
  // callers (the web delete, a sweep run) wins; true when this call made the mark.
  async claimDeleted(organizationId: string, id: string, at: Date) {
    const { count } = await this._media.model.media.updateMany({
      where: { id, organizationId, deletedAt: { not: null }, purgedAt: null },
      data: { purgedAt: at },
    });
    return count === 1;
  }

  // Takes a claim back (the object was kept or not deleted), so a later run looks at the row again.
  async releaseDeleted(organizationId: string, id: string) {
    const { count } = await this._media.model.media.updateMany({
      where: { id, organizationId, purgedAt: { not: null } },
      data: { purgedAt: null },
    });
    return count === 1;
  }

  // How many other live media rows, of any workspace, name the same object (by key, or inside their
  // path or thumbnail URL), plus 1 when the row itself is a user's picture, an agency logo or an OAuth app
  // picture (those point at the media row, not at the key).
  async countOtherUsers(id: string, key: string) {
    const rows = await this._media.model.media.count({
      where: {
        id: { not: id },
        deletedAt: null,
        OR: [
          { name: key },
          { path: { contains: key } },
          { thumbnail: { contains: key } },
        ],
      },
    });
    const picture = await this._media.model.media.count({
      where: {
        id,
        OR: [
          { userPicture: { some: {} } },
          { agencies: { some: {} } },
          { oauthApps: { some: {} } },
        ],
      },
    });
    return rows + picture;
  }

  // The first place, outside the media's own workspace's posts and sets (which the retention rule
  // reads), that names the key: other workspaces' posts and sets, signatures, channel pictures, workspace
  // avatars, clippings and a mobile upload that is open or was touched since `recentSince`. null when
  // none does. Guards a media row whose `name` was written by a client against a key it does not own.
  async findForeignReference(
    key: string,
    organizationId: string,
    recentSince: Date
  ) {
    return this.firstHit([
      [
        'post of another workspace',
        () =>
          this._post.model.post.findFirst({
            where: {
              organizationId: { not: organizationId },
              OR: this.postFields(key),
            },
            select: { id: true },
          }),
      ],
      [
        'set of another workspace',
        () =>
          this._sets.model.sets.findFirst({
            where: {
              organizationId: { not: organizationId },
              content: { contains: key },
            },
            select: { id: true },
          }),
      ],
      ...this.otherSources(key, recentSince),
    ]);
  }

  // The first place that names the key in the whole database, posts of every state and workspace
  // included (the orphan sweep has no media row to scope by); null when nothing does.
  async findAnyReference(key: string, recentSince: Date) {
    return this.firstHit([
      [
        'media',
        () =>
          this._media.model.media.findFirst({
            where: {
              OR: [
                { name: key },
                { posterKey: key },
                { path: { contains: key } },
                { thumbnail: { contains: key } },
              ],
            },
            select: { id: true },
          }),
      ],
      [
        'post',
        () =>
          this._post.model.post.findFirst({
            where: { OR: this.postFields(key) },
            select: { id: true },
          }),
      ],
      [
        'set',
        () =>
          this._sets.model.sets.findFirst({
            where: { content: { contains: key } },
            select: { id: true },
          }),
      ],
      ...this.otherSources(key, recentSince),
    ]);
  }

  // Which of these keys have a media row (live or soft-deleted, any workspace), by `name` or, for a
  // poster, `posterKey` (RET-B4).
  async findNamedKeys(keys: string[]) {
    if (!keys.length) {
      return [];
    }
    const rows = await this._media.model.media.findMany({
      where: { OR: [{ name: { in: keys } }, { posterKey: { in: keys } }] },
      select: { name: true, posterKey: true },
    });
    return rows.flatMap((r) => [r.name, r.posterKey || '']);
  }

  // The post columns that can carry a stored file's URL: the image list, the provider settings and the
  // body text.
  private postFields(key: string) {
    return [
      { image: { contains: key } },
      { settings: { contains: key } },
      { content: { contains: key } },
    ];
  }

  // The tables that name a file outside posts and sets: signatures, channel pictures, workspace
  // avatars, clippings and their clips, and the phone's uploads (open, or touched since `recentSince`).
  private otherSources(key: string, recentSince: Date) {
    return [
      [
        'signature',
        () =>
          this._signatures.model.signatures.findFirst({
            where: { content: { contains: key } },
            select: { id: true },
          }),
      ],
      [
        'channel picture',
        () =>
          this._integration.model.integration.findFirst({
            where: { picture: { contains: key } },
            select: { id: true },
          }),
      ],
      [
        'workspace avatar',
        () =>
          this._organization.model.organization.findFirst({
            where: { avatarUrl: { contains: key } },
            select: { id: true },
          }),
      ],
      [
        'clipping',
        () =>
          this._clipping.model.clipping.findFirst({
            where: { thumbnail: { contains: key } },
            select: { id: true },
          }),
      ],
      [
        'clip',
        () =>
          this._clippingClip.model.clippingClip.findFirst({
            where: {
              OR: [{ path: { contains: key } }, { thumbnail: { contains: key } }],
            },
            select: { id: true },
          }),
      ],
      [
        'mobile upload',
        () =>
          this._mobileUpload.model.mobileUpload.findFirst({
            where: {
              objectKey: key,
              OR: [
                { status: { in: ['pending', 'completing'] } },
                { updatedAt: { gte: recentSince } },
              ],
            },
            select: { id: true },
          }),
      ],
    ] as Array<[string, () => Promise<unknown>]>;
  }

  // Runs the lookups one after the other and answers the name of the first that finds a row.
  private async firstHit(lookups: Array<[string, () => Promise<unknown>]>) {
    for (const [source, look] of lookups) {
      if (await look()) {
        return source;
      }
    }
    return null;
  }
}
