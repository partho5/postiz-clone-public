// Nightly credit reconciliation: alerts on any account whose ledger and buckets disagree,
// and releases reservations held for work that is dead. It never repairs a credit row.
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { TemporalService } from 'nestjs-temporal-core';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { CreditsReconcileRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/reconcile/credits.reconcile.repository';

const ACCOUNT_PAGE = 100;
// A publish reservation is stale once its post has had no workflow for this long.
const PUBLISH_STALE_DAYS = 3;
// Any other reservation (AI, video, clip, connect) is stale after this long.
const OTHER_STALE_HOURS = 24;
// Post ids go into a Temporal visibility query; anything else is not a post id.
const POST_ID = /^[\w-]+$/;

export interface AccountDrift {
  accountId: string;
  buckets: number;
  ledgers: number;
}

@Injectable()
export class CreditsReconcileService {
  constructor(
    private _creditsService: CreditsService,
    private _creditsReconcileRepository: CreditsReconcileRepository,
    private _temporalService: TemporalService
  ) {}

  // Runs `reconcile` on every account and alerts on each one that has drift; writes nothing.
  async reconcileAll(): Promise<{ accounts: number; drifted: AccountDrift[] }> {
    let accounts = 0;
    const drifted: AccountDrift[] = [];
    await this.eachAccount(async (accountId) => {
      accounts++;
      try {
        const drift = await this.confirmedDrift(accountId);
        if (drift) {
          drifted.push(drift);
          this.alertDrift(drift);
        }
      } catch (err) {
        this.alertFailure('reconcile failed', accountId, err);
      }
    });
    return { accounts, drifted };
  }

  // Releases the reservations whose work is dead; answers the idempotency keys it released.
  async releaseStale(now: Date = new Date()): Promise<{ released: string[] }> {
    const released: string[] = [];
    await this.eachAccount(async (accountId) => {
      try {
        const stale = await this.staleReservations(accountId, now);
        for (const reservation of stale) {
          if (await this.releaseOne(reservation)) {
            released.push(reservation.idempotencyKey);
          }
        }
      } catch (err) {
        this.alertFailure('release stale failed', accountId, err);
      }
    });
    return { released };
  }

  // Calls fn for every account id, a page at a time.
  private async eachAccount(fn: (accountId: string) => Promise<void>) {
    let cursor: string | undefined;
    while (true) {
      const page = await this._creditsService.listAccountIds(
        cursor,
        ACCOUNT_PAGE
      );
      for (const { id } of page) {
        await fn(id);
      }
      if (page.length < ACCOUNT_PAGE) {
        return;
      }
      cursor = page[page.length - 1].id;
    }
  }

  // Drift of one account, or null. A second read confirms it: `reconcile` reads without a lock,
  // so a reservation landing between its reads looks like drift once and is gone the next time.
  private async confirmedDrift(accountId: string) {
    let drift = await this.drift(accountId);
    if (drift) {
      drift = await this.drift(accountId);
    }
    return drift;
  }

  // The drift counts of one account as of now, or null when its ledger and buckets agree.
  private async drift(accountId: string): Promise<AccountDrift | null> {
    const { buckets, ledgers } = await this._creditsService.reconcile(
      accountId
    );
    return buckets.length || ledgers.length
      ? { accountId, buckets: buckets.length, ledgers: ledgers.length }
      : null;
  }

  // One error log line and one Sentry event for an account with drift.
  private alertDrift(drift: AccountDrift) {
    console.error(
      `credits: reconcile drift account ${drift.accountId}: ${drift.buckets} buckets, ${drift.ledgers} ledgers`
    );
    Sentry.captureMessage('Credit ledger and buckets disagree', {
      level: 'error',
      extra: { ...drift },
    });
  }

  // Logs and reports a failure without stopping the run.
  private alertFailure(message: string, subject: string, err: unknown) {
    console.error(`credits: ${message}`, subject, err);
    Sentry.captureException(err, { extra: { subject, message } });
  }

  // The RESERVED rows of one account that are old enough and whose work is dead.
  private async staleReservations(accountId: string, now: Date) {
    const candidates = await this._creditsReconcileRepository.staleCandidates(
      accountId,
      dayjs(now).subtract(OTHER_STALE_HOURS, 'hour').toDate()
    );
    const publishBefore = dayjs(now).subtract(PUBLISH_STALE_DAYS, 'day');
    const publish = candidates.filter((c) => this.postIdOf(c.metadata));
    const dead = new Set(
      await this.deadPublishKeys(
        publish.filter((c) => dayjs(c.updatedAt).isBefore(publishBefore)),
        now
      )
    );
    return candidates.filter(
      (c) => !this.postIdOf(c.metadata) || dead.has(c.idempotencyKey)
    );
  }

  // Keys of the publish reservations whose post has no workflow running or closed within the
  // grace period and is not a scheduled future post.
  private async deadPublishKeys(
    reservations: { idempotencyKey: string; metadata: unknown }[],
    now: Date
  ) {
    if (!reservations.length) {
      return [];
    }
    const posts = new Map(
      (
        await this._creditsReconcileRepository.posts(
          reservations.map((r) => this.postIdOf(r.metadata)!)
        )
      ).map((p) => [p.id, p])
    );
    const since = dayjs(now).subtract(PUBLISH_STALE_DAYS, 'day').toDate();
    const dead: string[] = [];
    for (const reservation of reservations) {
      const postId = this.postIdOf(reservation.metadata)!;
      const post = posts.get(postId);
      const scheduled =
        !!post &&
        !post.deletedAt &&
        post.state === 'QUEUE' &&
        dayjs(post.publishDate).isAfter(now);
      if (scheduled) {
        continue;
      }
      try {
        if (!(await this.hasRecentWorkflow(postId, since))) {
          dead.push(reservation.idempotencyKey);
        }
      } catch (err) {
        // Not knowing whether the workflow is alive keeps the reservation; the rest still run.
        this.alertFailure(
          'release stale failed',
          reservation.idempotencyKey,
          err
        );
      }
    }
    return dead;
  }

  // Whether a workflow of the post is running or closed after `since`. Without a Temporal
  // client or with a failing query this throws, so nothing is released on a guess.
  private async hasRecentWorkflow(postId: string, since: Date) {
    const client = this._temporalService.client?.getRawClient();
    if (!client) {
      throw new Error('Temporal client is not available');
    }
    const workflows = client.workflow.list({
      query: `postId="${postId}" AND (ExecutionStatus="Running" OR CloseTime > "${since.toISOString()}")`,
    });
    for await (const _ of workflows) {
      return true;
    }
    return false;
  }

  // The post a reservation is held for, when its metadata names one.
  private postIdOf(metadata: unknown): string | null {
    const postId = (metadata as { postId?: unknown } | null)?.postId;
    return typeof postId === 'string' && POST_ID.test(postId) ? postId : null;
  }

  // Releases one reservation through the engine; true when it is released now.
  private async releaseOne(reservation: {
    idempotencyKey: string;
    organizationId: string | null;
  }) {
    try {
      const ledger = await this._creditsService.release(
        reservation.idempotencyKey,
        reservation.organizationId ?? undefined
      );
      return ledger?.status === 'RELEASED';
    } catch (err) {
      this.alertFailure(
        'release stale failed',
        reservation.idempotencyKey,
        err
      );
      return false;
    }
  }
}
