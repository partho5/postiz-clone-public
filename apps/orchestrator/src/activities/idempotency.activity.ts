// Idempotency-Key: the activity the daily cleanup workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { IdempotencyService } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.service';

@Injectable()
@Activity()
export class IdempotencyActivity {
  constructor(private _idempotencyService: IdempotencyService) {}

  // Deletes every idempotency record past its expiry; answers how many went.
  @ActivityMethod()
  async deleteExpired(): Promise<{ deleted: number }> {
    return this._idempotencyService.deleteExpired();
  }
}
