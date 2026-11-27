// Nightly credit reconciliation: the activities the daily workflow runs.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { CreditsReconcileService } from '@gitroom/nestjs-libraries/database/prisma/credits/reconcile/credits.reconcile.service';

@Injectable()
@Activity()
export class CreditsReconcileActivity {
  constructor(private _creditsReconcileService: CreditsReconcileService) {}

  // Checks every account's ledger against its buckets and alerts on drift; answers the counts.
  @ActivityMethod()
  async reconcileAll() {
    const { accounts, drifted } =
      await this._creditsReconcileService.reconcileAll();
    return { accounts, drifted: drifted.length };
  }

  // Releases the reservations held for dead work; answers how many.
  @ActivityMethod()
  async releaseStale() {
    const { released } = await this._creditsReconcileService.releaseStale();
    return { released: released.length };
  }
}
