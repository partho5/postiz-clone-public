// Daily PayPal poll: the activity the daily workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { ReversalsService } from '@gitroom/nestjs-libraries/database/prisma/billing/reversals/reversals.service';

@Injectable()
@Activity()
export class PaypalPollActivity {
  constructor(private _reversalsService: ReversalsService) {}

  // Replays PayPal's recent events and syncs every PayPal subscription; answers the counts.
  @ActivityMethod()
  async dailyPoll() {
    return this._reversalsService.dailyPoll();
  }
}
