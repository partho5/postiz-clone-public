// Publish charging: the publish workflow's reserve, commit and release.
import { HttpException, Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { ApplicationFailure } from '@temporalio/activity';
import { PublishChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service';
import { InsufficientCreditsException } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';

@Injectable()
@Activity()
export class PublishChargingActivity {
  constructor(private _publishChargingService: PublishChargingService) {}

  // Holds the credits of one occurrence; not enough credits fails with type insufficient_credits.
  @ActivityMethod()
  async reservePublish(
    organizationId: string,
    postId: string,
    integrationId: string,
    occurrence: number
  ) {
    await this.run(() =>
      this._publishChargingService.reserveOccurrence(
        organizationId,
        postId,
        integrationId,
        occurrence
      )
    );
  }

  // Charges an occurrence that was published.
  @ActivityMethod()
  async commitPublish(postId: string, integrationId: string, occurrence: number) {
    await this.run(() =>
      this._publishChargingService.commitOccurrence(
        postId,
        integrationId,
        occurrence
      )
    );
  }

  // Gives back the credits of an occurrence that will not publish.
  @ActivityMethod()
  async releasePublish(
    postId: string,
    integrationId: string,
    occurrence: number
  ) {
    await this.run(() =>
      this._publishChargingService.releaseOccurrence(
        postId,
        integrationId,
        occurrence
      )
    );
  }

  // A money answer that a retry cannot change fails the activity for good;
  // anything else (database unreachable) is retried.
  private async run(charge: () => Promise<unknown>) {
    try {
      await charge();
    } catch (err) {
      if (err instanceof InsufficientCreditsException) {
        throw ApplicationFailure.nonRetryable(
          err.message,
          'insufficient_credits',
          err.getResponse()
        );
      }
      if (err instanceof HttpException && err.getStatus() < 500) {
        throw ApplicationFailure.nonRetryable(err.message, 'credit_ledger_state');
      }
      throw err;
    }
  }
}
