// AI charging: every user-initiated AI request reserves credits before anything is generated,
// commits what it used, and gives the rest back; free-plan AI spend is capped per UTC month.
import { HttpException, Injectable } from '@nestjs/common';
import { CreditLedger, Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { isPlainObject } from 'lodash';
import {
  CapReachedError,
  CreditsRepository,
  IdempotencyConflictError,
  InsufficientCreditsError,
} from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import {
  CreditsService,
  InsufficientCreditsException,
} from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';
import { editBlocks } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/edit.blocks';

dayjs.extend(utc);

export type AiKind = 'text' | 'image' | 'video' | 'clip' | 'captions' | 'edit';

// The levels of an AI video edit (ai.video-editing); each is its own action, ai.edit.<level>.
export const AI_EDIT_LEVELS = ['basic', 'standard', 'heavy'] as const;
export type AiEditLevel = (typeof AI_EDIT_LEVELS)[number];

export interface AiChargeRequest {
  organizationId: string;
  userId?: string;
  kind: AiKind;
  // images: how many; clip: source minutes (rounded up); captions: whole minutes of speech, which the caller
  // works out with captionMinutes (rounded down); edit: seconds of the recording, charged per started 3 minutes
  quantity?: number;
  // edit: the level, which names the action
  editLevel?: AiEditLevel;
  // video: the VideoManager type and its customParams
  videoType?: string;
  videoParams?: unknown;
  idempotencyKey: string;
  metadata?: Prisma.InputJsonValue;
}

export interface AiEstimate {
  actionKey: string;
  unitCost: number;
  units: number;
  amount: number;
  // null when the plan has no cap
  cap: { limit: number; used: number } | null;
}

// Every AI action key starts with this; the free-plan cap counts them all together.
const AI_ACTION_PREFIX = 'ai.';

// The free plan's monthly AI cap is reached; nothing is generated or charged.
export class AiCapReachedException extends HttpException {
  constructor(cap: number, used: number) {
    super(
      {
        statusCode: 402,
        code: 'AI_CAP_REACHED',
        message: `The free plan includes ${cap} AI credits a month and ${used} are used. Upgrade to keep generating.`,
        cap,
        used,
      },
      402
    );
  }
}

@Injectable()
export class AiChargingService {
  constructor(
    private _creditsService: CreditsService,
    private _creditsRepository: CreditsRepository,
    private _accountsService: AccountsService,
    private _pricingService: PricingService,
    private _videoManager: VideoManager
  ) {}

  // Reserves the credits, runs the generation, then commits what it used (actualUnits of the
  // result, the whole reservation when it says nothing) or releases everything when it throws.
  async charge<T>(
    request: AiChargeRequest,
    run: () => Promise<T>,
    actualUnits?: (result: T) => number | undefined
  ): Promise<T> {
    await this.reserve(request);
    let result: T;
    try {
      result = await run();
    } catch (err) {
      // The real failure is what the caller must see; a reservation that could not be
      // released stays visible as reserved and is released by the reconciliation job
      await this.finish(
        request.idempotencyKey,
        { ok: false },
        request.organizationId
      ).catch((releaseErr) =>
        console.error(
          'ai charging: release failed',
          request.idempotencyKey,
          releaseErr
        )
      );
      throw err;
    }
    await this.finish(
      request.idempotencyKey,
      { ok: true, actualUnits: actualUnits?.(result) },
      request.organizationId
    );
    return result;
  }

  // Holds the credits of a request whose generation finishes elsewhere (a workflow); refused with
  // 402 when they are not there or the free-plan cap would be passed. Safe to repeat with one key.
  async reserve(request: AiChargeRequest): Promise<CreditLedger> {
    const account = await this.account(request.organizationId);
    const { actionKey, units } = this.priced(request);
    const quote = await this._creditsService.quote(
      actionKey,
      units,
      account.planKey
    );
    const cap =
      account.planKey === 'FREE'
        ? {
            limit: await this._pricingService.freeMonthlyAiCap(),
            actionKeyPrefix: AI_ACTION_PREFIX,
            since: this.monthStart(),
          }
        : undefined;

    try {
      const { ledger } = await this._creditsRepository.reserve({
        accountId: account.id,
        organizationId: request.organizationId,
        userId: request.userId,
        actionKey,
        actionVersion: quote.actionVersion,
        quantity: units,
        unitCost: quote.unitCost,
        idempotencyKey: request.idempotencyKey,
        metadata: {
          kind: request.kind,
          ...(request.videoType ? { videoType: request.videoType } : {}),
          ...(request.editLevel ? { editLevel: request.editLevel } : {}),
          ...(isPlainObject(request.metadata)
            ? (request.metadata as object)
            : {}),
        },
        // a retry of a request whose earlier attempt was released holds the credits again
        reopenReleased: true,
        cap,
      });
      return ledger;
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  // Ends a reserved request: commits it (actualUnits of the action, at the price it was reserved
  // at, never more than reserved) or releases it. Repeating it changes nothing. A backend caller
  // passes the workspace id; only the orchestrator may finish by key alone.
  async finish(
    idempotencyKey: string,
    outcome: { ok: true; actualUnits?: number } | { ok: false },
    organizationId?: string
  ): Promise<void> {
    if (!outcome.ok) {
      await this._creditsService.release(idempotencyKey, organizationId);
      return;
    }

    let actual: number | undefined;
    if (outcome.actualUnits !== undefined) {
      if (!Number.isFinite(outcome.actualUnits)) {
        throw new HttpException(`Invalid units ${outcome.actualUnits}`, 400);
      }
      const accountId =
        organizationId === undefined
          ? undefined
          : await this._accountsService.getAccountIdForOrganization(
              organizationId
            );
      const ledger = await this._creditsRepository.ledgerByKey(
        idempotencyKey,
        accountId
      );
      if (ledger) {
        actual = Math.min(
          ledger.reserved,
          Math.ceil(Math.max(0, outcome.actualUnits)) * ledger.unitCost
        );
      }
    }
    await this._creditsService.commit(idempotencyKey, actual, organizationId);
  }

  // What a request would cost this workspace's account now, and where the free-plan cap stands.
  async estimate(
    organizationId: string,
    request: Omit<AiChargeRequest, 'organizationId' | 'idempotencyKey'>
  ): Promise<AiEstimate> {
    const account = await this.account(organizationId);
    const { actionKey, units } = this.priced(request);
    const quote = await this._creditsService.quote(
      actionKey,
      units,
      account.planKey
    );
    return {
      actionKey,
      unitCost: quote.unitCost,
      units,
      amount: quote.amount,
      cap:
        account.planKey === 'FREE'
          ? {
              limit: await this._pricingService.freeMonthlyAiCap(),
              used: await this._creditsRepository.spentSince(account.id, {
                actionKeyPrefix: AI_ACTION_PREFIX,
                since: this.monthStart(),
              }),
            }
          : null,
    };
  }

  // The action a request is charged under and how many units of it.
  private priced(
    request: Pick<
      AiChargeRequest,
      'kind' | 'quantity' | 'videoType' | 'videoParams' | 'editLevel'
    >
  ) {
    switch (request.kind) {
      case 'text':
        return { actionKey: 'ai.text', units: 1 };
      case 'image':
        return {
          actionKey: 'ai.image',
          units: this.wholeUnits(request.quantity ?? 1),
        };
      case 'clip':
        return {
          actionKey: 'ai.clip.per_minute',
          units: this.wholeUnits(Math.ceil(request.quantity ?? 1)),
        };
      case 'captions':
        return {
          actionKey: 'ai.captions.per_minute',
          units: this.wholeUnits(request.quantity ?? 1),
        };
      case 'video':
        return {
          actionKey: 'ai.video.per_second',
          units: this.videoSeconds(request.videoType, request.videoParams),
        };
      case 'edit':
        return {
          actionKey: `ai.edit.${this.editLevel(request.editLevel)}`,
          units: editBlocks(this.wholeUnits(request.quantity ?? 1)),
        };
      default:
        throw new HttpException(`Unknown AI kind ${request.kind}`, 400);
    }
  }

  // A count of units: an integer of at least one.
  private wholeUnits(quantity: number) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new HttpException(`Invalid quantity ${quantity}`, 400);
    }
    return quantity;
  }

  // The level of an AI edit, one of AI_EDIT_LEVELS.
  private editLevel(level?: string) {
    if (!AI_EDIT_LEVELS.includes(level as AiEditLevel)) {
      throw new HttpException(`Invalid edit level ${level}`, 400);
    }
    return level as AiEditLevel;
  }

  // The longest video the type can make for these params: what a video reserves.
  private videoSeconds(videoType?: string, videoParams?: unknown) {
    if (
      !videoType ||
      !this._videoManager.getAllVideos().some((v) => v.identifier === videoType)
    ) {
      throw new HttpException(`Video type ${videoType} not found`, 400);
    }
    const seconds = this._videoManager
      .getVideoByName(videoType)!
      .instance.maxSeconds(videoParams);
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new HttpException(`Video type ${videoType} has no length`, 500);
    }
    return seconds;
  }

  // The account of a workspace, with its plan.
  private async account(organizationId: string) {
    const accountId = await this._accountsService.getAccountIdForOrganization(
      organizationId
    );
    return (await this._accountsService.getAccountById(accountId))!;
  }

  // The start of the current UTC month, when the free-plan cap begins counting.
  private monthStart() {
    return dayjs.utc().startOf('month').toDate();
  }

  // The HTTP answer for what the engine's reserve throws: 402 with the credits or the cap, 409 for a key held elsewhere.
  private toHttp(err: unknown) {
    if (err instanceof InsufficientCreditsError) {
      return new InsufficientCreditsException(err.required, err.available);
    }
    if (err instanceof CapReachedError) {
      return new AiCapReachedException(err.limit, err.used);
    }
    if (err instanceof IdempotencyConflictError) {
      return new HttpException(err.message, 409);
    }
    return err;
  }
}
