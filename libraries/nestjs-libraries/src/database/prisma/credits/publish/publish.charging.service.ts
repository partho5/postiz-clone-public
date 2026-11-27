// Publish charging: scheduling holds `post.publish` credits per channel,
// a publish commits them, and a delete, a removed channel or a permanent failure releases them.
import { HttpException, Injectable } from '@nestjs/common';
import { CreditLedger } from '@prisma/client';
import dayjs from 'dayjs';
import { uniq } from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import {
  CreditsService,
  InsufficientCreditsException,
} from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { PublishChargingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.repository';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';

const PUBLISH_ACTION = 'post.publish';

// A first row (one channel) of a post that a publish charge is for.
interface PublishRow {
  postId: string;
  integrationId: string;
  group: string;
  publishDate: Date | string;
}

// What reserveRequest held for a createPost request, for settleRequest.
export interface PublishRequest {
  // per channel entry: whether its group was fixed before the write
  keepGroup: boolean[];
  // posts of the groups the request edits, as they were before the write
  previous: string[];
  // first row of every channel entry
  firstRows: string[];
  // keys this request reserved (created or reserved again)
  reserved: string[];
}

@Injectable()
export class PublishChargingService {
  constructor(
    private _creditsService: CreditsService,
    private _publishChargingRepository: PublishChargingRepository
  ) {}

  // The idempotency key of one publish of a post on a channel (occurrence n ≥ 2 appends `:n`).
  publishKey(postId: string, integrationId: string, occurrence = 1) {
    this.checkOccurrence(occurrence);
    const key = `${this.postKeyPrefix(postId)}${integrationId}:publish`;
    return occurrence === 1 ? key : `${key}:${occurrence}`;
  }

  // What saving a group for these channels would reserve, and which channels it would release.
  async preview(
    organizationId: string,
    request: { group?: string; integrationIds: string[] }
  ) {
    if (
      !Array.isArray(request?.integrationIds) ||
      !request.integrationIds.every((id) => typeof id === 'string' && id) ||
      (request.group !== undefined && typeof request.group !== 'string')
    ) {
      throw new HttpException('Invalid charge preview request', 400);
    }
    const integrationIds = uniq(request.integrationIds);
    const rows = request.group
      ? await this._publishChargingRepository.firstRows(
          organizationId,
          request.group
        )
      : [];
    const status = await this.statuses(
      organizationId,
      rows.map((r) => this.publishKey(r.id, r.integrationId))
    );
    const statusOf = (row: (typeof rows)[number]) =>
      status.get(this.publishKey(row.id, row.integrationId));

    const newChannels = integrationIds.filter((id) => {
      const row = rows.find((r) => r.integrationId === id);
      return !row || !['RESERVED', 'COMMITTED'].includes(statusOf(row) || '');
    });
    const releasedChannels = rows
      .filter(
        (r) =>
          !integrationIds.includes(r.integrationId) &&
          statusOf(r) === 'RESERVED'
      )
      .map((r) => r.integrationId);
    const { amount } = await this._creditsService.quoteForOrganization(
      organizationId,
      PUBLISH_ACTION,
      newChannels.length
    );

    return { amount, newChannels, releasedChannels };
  }

  // Holds the credits of one occurrence of a post on a channel; a released key is reserved again.
  async reserveOccurrence(
    organizationId: string,
    postId: string,
    integrationId: string,
    occurrence: number,
    userId?: string
  ): Promise<CreditLedger> {
    const idempotencyKey = this.publishKey(postId, integrationId, occurrence);
    const [post] = await this._publishChargingRepository.posts(
      organizationId,
      [postId]
    );
    if (!post) {
      throw new HttpException('Post not found', 404);
    }
    if (post.integrationId !== integrationId) {
      throw new HttpException('The post is not on that channel', 400);
    }
    return this._creditsService.reserve(
      {
        organizationId,
        userId,
        actionKey: PUBLISH_ACTION,
        idempotencyKey,
        metadata: this.metadata(
          {
            postId,
            integrationId,
            group: post.group,
            publishDate: occurrence === 1 ? post.publishDate : new Date(),
          },
          occurrence
        ),
      },
      { reopenReleased: true }
    );
  }

  // Charges one published occurrence; its workspace comes from the post.
  async commitOccurrence(
    postId: string,
    integrationId: string,
    occurrence: number
  ): Promise<CreditLedger> {
    const idempotencyKey = this.publishKey(postId, integrationId, occurrence);
    const post = await this._publishChargingRepository.post(postId);
    return this._creditsService.commit(
      idempotencyKey,
      undefined,
      post?.organizationId
    );
  }

  // Gives back the credits of an occurrence that will not publish; a committed one stays charged.
  async releaseOccurrence(
    postId: string,
    integrationId: string,
    occurrence: number
  ): Promise<CreditLedger | null> {
    const idempotencyKey = this.publishKey(postId, integrationId, occurrence);
    const post = await this._publishChargingRepository.post(postId);
    if (!post) {
      return this._creditsService.release(idempotencyKey);
    }
    const [ledger] = await this._publishChargingRepository.ledgers(
      post.organizationId,
      [idempotencyKey]
    );
    if (ledger?.status === 'COMMITTED') {
      return ledger;
    }
    return this._creditsService.release(idempotencyKey, post.organizationId);
  }

  // Reserves a createPost request as a whole before anything is written: gives every new
  // first row its id and every new post its group, so the keys exist before the rows.
  async reserveRequest(
    organizationId: string,
    body: CreatePostDto,
    keepGroup: boolean
  ): Promise<PublishRequest> {
    const entries = body.posts || [];
    const groups = uniq(entries.map((e) => e.group).filter(Boolean));
    const firstIds = entries.map((e) => e.value?.[0]?.id).filter(Boolean);
    const [previous, existing] = await Promise.all([
      groups.length
        ? this._publishChargingRepository.groupPosts(organizationId, groups)
        : [],
      firstIds.length
        ? this._publishChargingRepository.posts(organizationId, firstIds)
        : [],
    ]);
    const knownGroups = new Set(previous.map((p) => p.group));
    const existingIds = new Set(existing.map((p) => p.id));
    const publishDate =
      body.type === 'now' ? dayjs().format('YYYY-MM-DDTHH:mm:00') : body.date;

    const rows: PublishRow[] = [];
    const keep = entries.map((entry) => {
      // A post with no rows yet gets its group here, as the write would draw one
      const fixed = !entry.group || (!keepGroup && !knownGroups.has(entry.group));
      if (fixed) {
        entry.group = uuidv4();
      }
      const first = entry.value[0];
      const isNew = !first.id || !existingIds.has(first.id);
      first.id = first.id || uuidv4();
      if (
        body.type === 'schedule' ||
        body.type === 'now' ||
        (body.type === 'update' && isNew)
      ) {
        rows.push({
          postId: first.id,
          integrationId: entry.integration.id,
          group: entry.group,
          publishDate,
        });
      }
      return fixed || keepGroup;
    });

    return {
      keepGroup: keep,
      previous: previous.map((p) => p.id),
      firstRows: entries.map((e) => e.value[0].id),
      reserved: await this.reserveRows(organizationId, rows),
    };
  }

  // After a createPost write (or its failure): releases what the rows no longer need,
  // and what this request reserved for rows that were not scheduled. A failed release
  // is logged; the reservation stays visible and the reconciliation job releases it.
  async settleRequest(organizationId: string, request: PublishRequest) {
    try {
      await this.releaseUnneeded(organizationId, [
        ...request.previous,
        ...request.firstRows,
      ]);
      if (!request.reserved.length) {
        return;
      }
      const posts = await this._publishChargingRepository.posts(
        organizationId,
        request.firstRows
      );
      const scheduled = new Set(
        posts
          .filter((p) => !p.deletedAt && !p.parentPostId && p.state === 'QUEUE')
          .map((p) => this.publishKey(p.id, p.integrationId))
      );
      await this.releaseKeys(
        organizationId,
        request.reserved.filter((key) => !scheduled.has(key))
      );
    } catch (err) {
      console.error('publish charging: settle failed', request.reserved, err);
    }
  }

  // Reserves the first publish of one post before it is scheduled (date or status change).
  async reservePost(
    organizationId: string,
    post: {
      id: string;
      integrationId: string;
      group: string;
      publishDate: Date | string;
      parentPostId: string | null;
    }
  ) {
    if (post.parentPostId) {
      return;
    }
    await this.reserveRows(organizationId, [
      {
        postId: post.id,
        integrationId: post.integrationId,
        group: post.group,
        publishDate: post.publishDate,
      },
    ]);
  }

  // Releases every reserved publish of a group's posts that no longer applies (deleted posts).
  async releaseGroup(organizationId: string, group: string) {
    const posts = await this._publishChargingRepository.groupPosts(
      organizationId,
      [group]
    );
    await this.releaseUnneeded(
      organizationId,
      posts.map((p) => p.id)
    );
  }

  // Releases every reserved publish of these posts that its row no longer justifies:
  // the row is deleted, a draft, a comment, or on another channel than the key.
  async releaseUnneeded(organizationId: string, postIds: string[]) {
    const ids = uniq(postIds);
    if (!ids.length) {
      return;
    }
    const [posts, ledgers] = await Promise.all([
      this._publishChargingRepository.posts(organizationId, ids),
      this._publishChargingRepository.reserved(
        organizationId,
        PUBLISH_ACTION,
        ids.map((id) => this.postKeyPrefix(id))
      ),
    ]);
    const kept = posts
      .filter((p) => !p.deletedAt && !p.parentPostId && p.state !== 'DRAFT')
      .map((p) => this.publishKey(p.id, p.integrationId));
    await this.releaseKeys(
      organizationId,
      ledgers
        .map((l) => l.idempotencyKey)
        .filter(
          (key) => !kept.some((k) => key === k || key.startsWith(`${k}:`))
        )
    );
  }

  // Reserves the first publish of these rows all or nothing: 402 for the whole set when the
  // account can't pay it, and nothing stays held. Returns the keys it reserved.
  private async reserveRows(organizationId: string, rows: PublishRow[]) {
    const keys = rows.map((r) => this.publishKey(r.postId, r.integrationId));
    const status = await this.statuses(organizationId, keys);
    const pending = rows.filter(
      (row, i) =>
        keys.indexOf(keys[i]) === i &&
        !['RESERVED', 'COMMITTED'].includes(status.get(keys[i]) || '')
    );
    if (!pending.length) {
      return [];
    }

    const price = await this._creditsService.quoteForOrganization(
      organizationId,
      PUBLISH_ACTION,
      pending.length
    );
    const { available } = await this._creditsService.balance(organizationId);
    if (available < price.amount) {
      throw new InsufficientCreditsException(price.amount, available);
    }

    const reserved: string[] = [];
    try {
      for (const row of pending) {
        const ledger = await this._creditsService.reserve(
          {
            organizationId,
            actionKey: PUBLISH_ACTION,
            idempotencyKey: this.publishKey(row.postId, row.integrationId),
            metadata: this.metadata(row, 1),
          },
          { reopenReleased: true }
        );
        reserved.push(ledger.idempotencyKey);
      }
    } catch (err) {
      // Never hide the real failure behind a failed release (as CreditsService.spend)
      await this.releaseKeys(organizationId, reserved).catch((releaseErr) =>
        console.error('publish charging: release failed', reserved, releaseErr)
      );
      if (err instanceof InsufficientCreditsException) {
        const { available } = await this._creditsService.balance(
          organizationId
        );
        throw new InsufficientCreditsException(price.amount, available);
      }
      throw err;
    }
    return reserved;
  }

  // Releases these reservations of a workspace.
  private async releaseKeys(organizationId: string, keys: string[]) {
    for (const key of keys) {
      await this._creditsService.release(key, organizationId);
    }
  }

  // Ledger status by key for a workspace's keys.
  private async statuses(organizationId: string, keys: string[]) {
    const ledgers = keys.length
      ? await this._publishChargingRepository.ledgers(organizationId, keys)
      : [];
    return new Map(ledgers.map((l) => [l.idempotencyKey, l.status as string]));
  }

  // Ledger metadata of a publish reservation, read by the reserved-posts list.
  private metadata(row: PublishRow, occurrence: number) {
    return {
      postId: row.postId,
      integrationId: row.integrationId,
      group: row.group,
      occurrence,
      publishDate: dayjs(row.publishDate).toISOString(),
    };
  }

  // Start of every publish key of a post, whatever the channel and occurrence.
  private postKeyPrefix(postId: string) {
    return `post:${postId}:integration:`;
  }

  // Occurrences are counted from 1.
  private checkOccurrence(occurrence: number) {
    if (!Number.isInteger(occurrence) || occurrence < 1) {
      throw new HttpException(`Invalid occurrence ${occurrence}`, 400);
    }
  }
}
