// Recurring charging: the publish workflow's reserve-ahead of a repeating post's next
// occurrence, and its "can't be paid" flag.
import { HttpException, Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { ApplicationFailure } from '@temporalio/activity';
import { RecurringChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.service';

@Injectable()
@Activity()
export class RecurringChargingActivity {
  constructor(private _recurringChargingService: RecurringChargingService) {}

  // Holds the credits of the next occurrence; not enough credits flags the post and answers
  // reserved: false. A post that no longer repeats fails with type recurring_chain_ended.
  @ActivityMethod()
  async reserveNextOccurrence(
    organizationId: string,
    postId: string,
    integrationId: string,
    occurrence: number,
    dueAt: string
  ): Promise<{ reserved: boolean }> {
    let result: { reserved: boolean } | null;
    try {
      result = await this._recurringChargingService.reserveNext(
        organizationId,
        postId,
        integrationId,
        occurrence,
        new Date(dueAt)
      );
    } catch (err) {
      // A money answer that a retry cannot change fails for good; anything else is retried
      if (err instanceof HttpException && err.getStatus() < 500) {
        throw ApplicationFailure.nonRetryable(err.message, 'credit_ledger_state');
      }
      throw err;
    }
    if (!result) {
      throw ApplicationFailure.nonRetryable(
        'The post no longer repeats',
        'recurring_chain_ended'
      );
    }
    return result;
  }

  // Removes a post's "can't be paid" flag.
  @ActivityMethod()
  async clearRecurringFlag(postId: string) {
    await this._recurringChargingService.clearFlag(postId);
  }
}
