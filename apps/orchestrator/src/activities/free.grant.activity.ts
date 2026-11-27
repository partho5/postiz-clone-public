// Free monthly grant: the daily run that gives every eligible account its month's credits.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { FreeGrantService } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.service';

@Injectable()
@Activity()
export class FreeGrantActivity {
  constructor(private _freeGrantService: FreeGrantService) {}

  // Grants the current month's free credits to every eligible account that lacks them.
  @ActivityMethod()
  async runMonthlyGrants() {
    return this._freeGrantService.runMonthlyGrants();
  }
}
