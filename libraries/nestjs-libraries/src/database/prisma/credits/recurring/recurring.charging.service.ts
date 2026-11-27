// Recurring charging: a repeating post holds its next occurrence's credits ahead of time,
// and is flagged in the calendar while that reservation cannot be paid.
import { HttpException, Injectable } from '@nestjs/common';
import { uniq } from 'lodash';
import { InsufficientCreditsException } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { PublishChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service';
import { RecurringChargingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.repository';

// A repeating post whose next occurrence could not be reserved.
export interface RecurringFlag {
  occurrence: number;
  dueAt: string;
  reason: 'INSUFFICIENT_CREDITS';
  since: string;
}

@Injectable()
export class RecurringChargingService {
  constructor(
    private _recurringChargingRepository: RecurringChargingRepository,
    private _publishChargingService: PublishChargingService
  ) {}

  // The flags of the workspace's live repeating posts among these ids, by post id.
  async flagsForPosts(
    organizationId: string,
    postIds: string[]
  ): Promise<Record<string, RecurringFlag>> {
    const ids = uniq(
      (Array.isArray(postIds) ? postIds : []).filter(
        (id) => typeof id === 'string' && id
      )
    );
    if (!ids.length) {
      return {};
    }
    const posts = await this._recurringChargingRepository.repeatingPosts(
      organizationId,
      ids
    );
    if (!posts.length) {
      return {};
    }
    const flags = await this._recurringChargingRepository.flags(posts);
    return Object.fromEntries(
      flags.map((f) => [
        f.postId,
        {
          occurrence: f.occurrence,
          dueAt: f.dueAt.toISOString(),
          reason: 'INSUFFICIENT_CREDITS' as const,
          since: f.flaggedAt!.toISOString(),
        },
      ])
    );
  }

  // Reserves occurrence n ≥ 2 of a repeating post ahead of its due time. Not enough credits
  // flags the post and answers reserved: false; null when the post no longer repeats on that
  // channel (deleted, repeat removed), in which case nothing stays held and the flag is cleared.
  async reserveNext(
    organizationId: string,
    postId: string,
    integrationId: string,
    occurrence: number,
    dueAt: Date
  ): Promise<{ reserved: boolean } | null> {
    if (!Number.isInteger(occurrence) || occurrence < 2) {
      throw new HttpException(`Invalid next occurrence ${occurrence}`, 400);
    }
    if (!(dueAt instanceof Date) || isNaN(dueAt.getTime())) {
      throw new HttpException('Invalid due date', 400);
    }
    if (!(await this.repeats(organizationId, postId, integrationId))) {
      await this.clearFlag(postId);
      return null;
    }

    try {
      await this._publishChargingService.reserveOccurrence(
        organizationId,
        postId,
        integrationId,
        occurrence
      );
    } catch (err) {
      if (err instanceof InsufficientCreditsException) {
        await this._recurringChargingRepository.record(
          postId,
          occurrence,
          dueAt,
          true
        );
        return { reserved: false };
      }
      throw err;
    }

    // A delete that ran while reserving released before this reservation existed
    if (!(await this.repeats(organizationId, postId, integrationId))) {
      await this._publishChargingService.releaseOccurrence(
        postId,
        integrationId,
        occurrence
      );
      await this.clearFlag(postId);
      return null;
    }
    await this._recurringChargingRepository.record(
      postId,
      occurrence,
      dueAt,
      false
    );
    return { reserved: true };
  }

  // Removes a post's "can't be paid" flag.
  async clearFlag(postId: string) {
    await this._recurringChargingRepository.clearFlag(postId);
  }

  // Whether the post is a live, repeating first row of this workspace on this channel.
  private async repeats(
    organizationId: string,
    postId: string,
    integrationId: string
  ) {
    const post = await this._recurringChargingRepository.post(postId);
    return (
      !!post &&
      post.organizationId === organizationId &&
      post.integrationId === integrationId &&
      !post.parentPostId &&
      !post.deletedAt &&
      !!post.intervalInDays
    );
  }
}
