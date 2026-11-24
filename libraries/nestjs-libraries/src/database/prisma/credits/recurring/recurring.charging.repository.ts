// Recurring charging: the next occurrence of a repeating post, its "can't be paid" flag,
// and the post rows those depend on.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class RecurringChargingRepository {
  constructor(
    private readonly _recurringCharge: PrismaRepository<'recurringCharge'>,
    private readonly _post: PrismaRepository<'post'>
  ) {}

  // One post by id, deleted or not, with what decides whether it still repeats.
  post(id: string) {
    return this._post.model.post.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        integrationId: true,
        parentPostId: true,
        intervalInDays: true,
        deletedAt: true,
      },
    });
  }

  // Ids of the live repeating posts of a workspace among these ids.
  async repeatingPosts(organizationId: string, ids: string[]) {
    const posts = await this._post.model.post.findMany({
      where: {
        organizationId,
        id: { in: ids },
        deletedAt: null,
        intervalInDays: { not: null },
      },
      select: { id: true },
    });
    return posts.map((p) => p.id);
  }

  // Flagged next occurrences of these posts.
  flags(postIds: string[]) {
    return this._recurringCharge.model.recurringCharge.findMany({
      where: { postId: { in: postIds }, flaggedAt: { not: null } },
    });
  }

  // Records the next occurrence of a post; flagged keeps the first flag time, unflagged clears it.
  async record(
    postId: string,
    occurrence: number,
    dueAt: Date,
    flagged: boolean
  ) {
    const existing = await this._recurringCharge.model.recurringCharge.findUnique(
      { where: { postId } }
    );
    const data = {
      occurrence,
      dueAt,
      flaggedAt: flagged ? existing?.flaggedAt || new Date() : null,
    };
    // Prisma's upsert reads then inserts, so two first writers can both insert.
    // The primary key turns the loser into an update of the winner's row.
    try {
      return await this._recurringCharge.model.recurringCharge.upsert({
        where: { postId },
        create: { postId, ...data },
        update: data,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this._recurringCharge.model.recurringCharge.update({
          where: { postId },
          data,
        });
      }
      throw err;
    }
  }

  // Removes the flag of a post, keeping its next occurrence.
  clearFlag(postId: string) {
    return this._recurringCharge.model.recurringCharge.updateMany({
      where: { postId },
      data: { flaggedAt: null },
    });
  }
}
