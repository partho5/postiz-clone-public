// AI video editing (ai.video-editing): the AI edit jobs of a workspace. The phone asks for an edit of a recording at
// one level: the credits for its started 3-minute blocks are held, and a workflow gets the words (from a READY
// caption, else by transcribing the uploaded speech audio), plans the edit with the pure planner core, validates it
// and commits the credits (or gives them back when no plan was made). A caption it reuses has its held credits given
// back once the plan is made (the transcript is paid for in the edit). The workflow's steps are the `...Edit` methods
// at the end, one per activity. The server never touches video: the phone renders the plan.
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { ApplicationFailure, TypedSearchAttributes } from '@temporalio/common';
import dayjs from 'dayjs';
import { TemporalService } from 'nestjs-temporal-core';
import { CLEF_MODEL, ClefOmniClient } from '@gitroom/nestjs-libraries/ai-video-edit/clef.omni.client';
import { iconQueries, slotTexts, usedAssets } from '@gitroom/nestjs-libraries/ai-video-edit/assets/edit.asset.files';
import {
  AssetReport,
  EditAssetsService,
  ResolvedAssets,
} from '@gitroom/nestjs-libraries/ai-video-edit/assets/edit.assets.service';
import {
  ContractView,
  contractView,
} from '@gitroom/nestjs-libraries/ai-video-edit/contract/edit.contract.view';
import {
  EDIT_LEVELS,
  EditLevel,
  LEVEL_RULES,
  EditRequest,
  EditStatus,
  EditWord,
  Palette,
  Plan,
  PlanAsset,
} from '@gitroom/nestjs-libraries/ai-video-edit/contract/edit.contract';
import { PALETTE } from '@gitroom/nestjs-libraries/ai-video-edit/contract/edit.styles';
import { SlotScores } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.assembler';
import {
  CheckResult,
  clientCheck,
  isUnusable,
  unreachableAssets,
} from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.clientcheck';
import {
  ClefAnswers,
  ClefQuestion,
  PickAsk,
  PieceTarget,
  batches,
  commentaryQuestions,
  mergePieces,
  pieceQuestions,
  pickQuestions,
  readPiece,
  targetsByPiece,
  withFallbackPicks,
} from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.perception';
import {
  PlanEditInput,
  perceptionTargets,
  planAndValidate,
} from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.pipeline';
import {
  WriterAnswer,
  WrittenTexts,
  readTexts,
  writerSlots,
} from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.texts';
import { Direction, Moment, applyLabels, buildMoments } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.moments';
import { buildMap } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.timeline';
import { toEditWords } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.words';
import { EDIT_DIRECTOR_PROMPT, directorMessages } from '@gitroom/nestjs-libraries/ai-video-edit/edit.director.prompt';
import { EDIT_WRITER_PROMPT, writerMessages } from '@gitroom/nestjs-libraries/ai-video-edit/edit.writer.prompt';
import { LlmUsage } from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';
import { BrandsService } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import { EditLlmService } from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm.service';
import { EditDirection, EditTextsDraft, directorEditLlm, iconEditLlm, writerEditLlm } from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm';
import {
  AiVideoEditsRepository,
  NewAiVideoEdit,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.repository';
import {
  TraceEntry,
  TraceService,
  TraceStep,
  traceMode,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.service';
import {
  FailureCause,
  UsageStep,
  activityTrace,
  addUsage,
  clientCheckTrace,
  correlation,
  failureCause,
  iconsTrace,
  plannerInputTrace,
  plannerTrace,
  usageOfLog,
  usagePayload,
  writerDecisions,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.helpers';
import {
  TraceBundle,
  bundleOf,
  requestForTrace,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.bundle';
import { AiCaptionsService } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';
import { AiChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';
import { AiVideoEditCreateDto } from '@gitroom/nestjs-libraries/dtos/ai-video-edits/ai.video.edit.create.dto';
import { AiVideoEditRenderReportDto } from '@gitroom/nestjs-libraries/dtos/ai-video-edits/ai.video.edit.render.report.dto';
import {
  MOBILE_UPLOAD_PURPOSE_AUDIO,
  MOBILE_UPLOAD_PURPOSE_EDIT_PROXY,
} from '@gitroom/nestjs-libraries/dtos/mobile-upload/mobile.upload.create.dto';
import {
  MuseTranscribeError,
  MuseTranscriptionService,
} from '@gitroom/nestjs-libraries/muse/muse.transcription.service';
import { AiCaptionsNotConfigured } from '@gitroom/nestjs-libraries/muse/transcription.provider';
import type {
  Transcription,
  TranscriptionProvider,
  TranscriptSegment,
  TranscriptWord,
} from '@gitroom/nestjs-libraries/muse/transcription.provider';
import { organizationId } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { deleteObject, readObject } from '@gitroom/nestjs-libraries/upload/r2.uploader';

const FINAL_STATUSES: EditStatus[] = ['READY', 'NO_SPEECH', 'FAILED'];

// The longest recording an edit takes when AI_EDIT_MAX_SECONDS is not set, in seconds.
const DEFAULT_MAX_SECONDS = 600;

// A job in progress that has not changed for this long is dead: its workflow was lost, or the process stopped
// between holding the credits and starting it. Every step of a live job changes its row well within this (the
// longest step is 3 tries of 15 minutes to transcribe, with the waits between them), so a live job is never taken
// for a dead one.
const STALE_HOURS = 3;

// Perception asks about this many proxy pieces at a time, and stops asking for more once it has run this long (the
// activity may run 10 minutes): the plan is then made with the scores it has.
const PERCEPTION_PARALLEL = 3;
const PERCEPTION_BUDGET_MS = 6 * 60 * 1000;

// A recording with fewer spoken words than this has nothing to edit around.
const MIN_SPOKEN_WORDS = 3;

// The transcriber behind `_transcription` (Muse), as the trace names it.
const TRANSCRIBER = 'muse';

// The longest a step waits for one trace row: a trace that hangs is given up on, never waited for.
const TRACE_TIMEOUT_MS = 2000;

// The longest a step spends on a list of trace rows (the planner's decisions): rows left over are given up on.
const TRACE_BATCH_MS = 10000;

// A READY edit's serve is logged the first time it is read and then at most once in this long (per process); the edits
// remembered for it are bounded, the oldest forgotten first.
const SERVE_LOG_MS = 60 * 1000;
const MAX_SERVED = 1000;

// The most receipts (`render_report` rows) one edit keeps, and the receipts remembered by this process to answer a repeat
// that races its first (bounded, the oldest forgotten first).
const MAX_RECEIPTS = 50;
const MAX_REMEMBERED_RECEIPTS = 1000;

// Whether a plan the client check finds unusable ends the job as FAILED (`AI_EDIT_CLIENT_CHECK_BLOCK=1`). Off by default:
// the findings are traced and kept in `log.client_check` and the job is delivered all the same, until the lints are proven.
const blocksUnusable = () => process.env.AI_EDIT_CLIENT_CHECK_BLOCK === '1';

// What the customer reads. The reason itself (a provider's answer, a stack) is only logged.
const FAILED_TEXT = 'The AI edit could not be made for this recording.';
const AUDIO_FAILED_TEXT = 'The audio of this recording could not be transcribed.';
const NO_SPEECH_TEXT = 'No speech was found in this recording.';
const NOT_STARTED_TEXT = 'The AI edit could not be started.';

// The answer of `create`: the job (made now or before; `status` is where it stands now) and the credits it holds.
export interface AiVideoEditCreated {
  id: string;
  status: EditStatus;
  cost: number;
}

// An edit as the phone reads it: the plan and its assets once it is READY.
export interface AiVideoEditView {
  id: string;
  status: EditStatus;
  error?: string;
  cost: number;
  plan?: Plan;
  assets?: PlanAsset[];
}

// What each level costs this workspace for one length of recording.
export type AiVideoEditQuote = Record<EditLevel, number>;

// An error of the edit routes, in the public API's shape { statusCode, code, message }.
export class AiVideoEditsException extends HttpException {
  // Answers `status` with the stable `code` the app switches on.
  constructor(status: number, code: string, message: string) {
    super({ statusCode: status, code, message }, status);
  }
}

// A reason retrying can't change (an audio the transcriber cannot take, a caption deleted meanwhile): the workflow
// stops and the message is the text the customer reads.
export class AiVideoEditsStop extends ApplicationFailure {
  constructor(message: string) {
    super(message, 'ai_video_edit_stop', true);
  }
}

// The idempotency key of the credits held for an edit: its id, so the job holds them once.
const creditsKey = (editId: string) => `ai:edit:${editId}`;

// The id of the workflow that runs an edit.
const workflowIdOf = (editId: string) => `ai_video_edit_${editId}`;

// The longest recording an edit takes, in seconds (AI_EDIT_MAX_SECONDS, default 600).
const maxSeconds = () => {
  const value = Number(process.env.AI_EDIT_MAX_SECONDS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_SECONDS;
};

// Whole seconds charged for a length: rounded up, at least 1 (every edit costs one block).
const chargedSeconds = (seconds: number) =>
  Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 1;

// The palette of a plan: the multi colours, or the workspace colour as the single accent when the request asks for
// brand text and the workspace has a usable colour.
const paletteFor = (textColors: string | undefined, brandColor?: string): Palette =>
  textColors === 'brand' && brandColor && /^#[0-9a-f]{6}$/i.test(brandColor)
    ? { mode: 'brand', colors: [brandColor.toUpperCase()] }
    : { mode: 'multi', colors: [...PALETTE.multi] };

// The workspace's brand as an edit reads it: its colour, its voice and its banned words.
interface EditBrand {
  color?: string;
  voice?: string;
  bannedWords: string[];
}

// The ids a trace row needs of an edit.
type TraceEdit = { id: string; sessionId: string };

// What a step records of a failure that is not in `log` (a timeout or a cancellation never reaches the step's catch).
const NO_CAUSE = { step: null, error_class: 'not_recorded', error_code: null, retryable: null };

// A short hash of a list of questions: which prompt a perception call was made with.
const questionsHash = (questions: ClefQuestion[]) =>
  createHash('sha256')
    .update(JSON.stringify(questions.map((q) => [q.id, q.type, q.instruction, q.criteria])))
    .digest('hex')
    .slice(0, 16);

// The words of a recording and where they came from.
interface SourcedWords {
  words: EditWord[];
  language?: string;
  source: 'caption' | 'audio';
  rawWordCount: number;
}

// An edit job as the repository gives it.
type StoredEdit = NonNullable<
  Awaited<ReturnType<AiVideoEditsRepository['getEditById']>>
>;

@Injectable()
export class AiVideoEditsService {
  private readonly _logger = new Logger(AiVideoEditsService.name);

  // When each READY edit's serve was last logged, by edit id (insertion order is the order of the last log).
  private readonly _served = new Map<string, number>();

  // The receipts this process took, as `editId:attemptId` (a second post of the same attempt is then known at once).
  private readonly _receipts = new Set<string>();

  // Receives the storage of the jobs, the credits service that holds and settles their cost, the transcriber, the
  // workflow engine and the trace every step writes to.
  constructor(
    private _aiVideoEditsRepository: AiVideoEditsRepository,
    private _aiChargingService: AiChargingService,
    // the one transcriber; this service only knows its interface
    @Inject(MuseTranscriptionService)
    private _transcription: TranscriptionProvider,
    private _temporalService: TemporalService,
    private _clef: ClefOmniClient,
    private _editLlm: EditLlmService,
    private _brands: BrandsService,
    private _assets: EditAssetsService,
    private _aiCaptions: AiCaptionsService,
    private _trace: TraceService
  ) {}

  // The engine contract: levels, speed rules, outputs, effect registry, text looks, palette, phrases and sounds.
  contract(): ContractView {
    return contractView();
  }

  // Starts the AI edit of a recording at a level. A repeat for the same recording and level answers the job it
  // made and holds nothing again, unless that job FAILED: then it is replaced by a new one. Refuses with 404 CAPTION_NOT_FOUND, AUDIO_NOT_FOUND or UPLOAD_NOT_FOUND, 409
  // UPLOAD_NOT_COMPLETE, 400 AUDIO_NOT_SUPPORTED or VIDEO_TOO_LONG, 402 INSUFFICIENT_CREDITS or AI_CAP_REACHED
  // (nothing held, no job kept) and 503 AI_EDIT_NOT_CONFIGURED. A repeat that finds its job dead ends it first.
  // `requestId` is the request's `x-request-id`, written on the trace rows of the call.
  async create(
    orgId: string,
    userId: string | undefined,
    body: AiVideoEditCreateDto,
    requestId?: string
  ): Promise<AiVideoEditCreated> {
    const started = Date.now();
    let replaced: string | undefined;
    const existing = await this._aiVideoEditsRepository.findBySession(
      orgId,
      body.sessionId,
      body.level
    );
    if (existing) {
      const again = await this.repeated(existing);
      if (again.status !== 'FAILED') {
        await this.trace(
          existing,
          { step: 'create', kind: 'decision', payload: { decision: 'repeat', status: again.status, cost: again.cost } },
          requestId
        );
        return again;
      }
      // A failed edit is tried again: its credits were given back and its uploads deleted, so the phone sends new
      // ones and a new job takes the recording and level
      replaced = existing.id;
      await this._aiVideoEditsRepository.deleteEdit(orgId, existing.id);
    }

    // What is charged is the length the server can read (the audio, or the caption made from it) and never less
    // than the length the request plans for.
    const sourceSeconds = Math.max(
      await this.wordsSeconds(orgId, body),
      body.request.video.duration_ms / 1000
    );
    if (Math.floor(sourceSeconds) > maxSeconds()) {
      throw new AiVideoEditsException(
        400,
        'VIDEO_TOO_LONG',
        `The video is longer than ${Math.floor(maxSeconds() / 60)} minutes`
      );
    }
    // Basic reads no proxy: pieces it is sent are left to the sweep of old uploads
    const proxyUploadIds =
      body.level === 'basic' ? [] : [...new Set(body.proxyUploadIds || [])];
    await this.requireProxies(orgId, proxyUploadIds);

    // The decision calls of the level need their provider's key: without it the edit is refused here, before anything
    // is held, rather than planned without texts or icons.
    if (LEVEL_RULES[body.level].writer && !this._editLlm.isConfigured(writerEditLlm())) {
      throw this.notConfigured();
    }
    if (this._assets.iconsWanted(body.level) && !this._editLlm.isConfigured(iconEditLlm())) {
      throw this.notConfigured();
    }

    const client = this._temporalService.client.getRawClient();
    if (!client) {
      throw this.notConfigured();
    }

    const seconds = chargedSeconds(sourceSeconds);
    const cost = await this.costOf(orgId, body.level, seconds);
    const data: NewAiVideoEdit = {
      organizationId: orgId,
      userId,
      sessionId: body.sessionId,
      level: body.level,
      ...(body.aiCaptionId
        ? { aiCaptionId: body.aiCaptionId }
        : { audioUploadId: body.audioUploadId }),
      proxyUploadIds,
      request: body.request as unknown as Prisma.InputJsonValue,
      sourceSeconds: seconds,
      cost,
    };
    const edit = await this._aiVideoEditsRepository.createEdit(data);
    if (!edit) {
      // two creates for one recording and level raced and the other won
      const winner = await this._aiVideoEditsRepository.findBySession(
        orgId,
        body.sessionId,
        body.level
      );
      if (winner) {
        await this.trace(winner, { step: 'create', kind: 'decision', payload: { decision: 'repeat_raced' } }, requestId);
        return this.repeated(winner);
      }
      // the winner could not hold its credits and removed its row; this create holds nothing either
      throw new AiVideoEditsException(
        409,
        'EDIT_CONFLICT',
        'The same edit was asked for at the same time; try again'
      );
    }

    await this.trace(
      edit,
      {
        step: 'create',
        kind: 'input',
        payload: {
          level: body.level,
          sourceSeconds: seconds,
          videoDurationMs: body.request.video.duration_ms,
          aiCaptionId: body.aiCaptionId ?? null,
          audioUploadId: body.audioUploadId ?? null,
          proxyUploadIds,
          replacedEditId: replaced ?? null,
          request: requestForTrace(body.request),
        },
      },
      requestId
    );
    await this.trace(
      edit,
      {
        step: 'create',
        kind: 'decision',
        payload: {
          decision: replaced ? 'replaced_failed_edit' : 'new_edit',
          caption_reuse: !!body.aiCaptionId,
          uploads_accepted: proxyUploadIds.length + (body.aiCaptionId ? 0 : 1),
          proxies_ignored: body.level === 'basic' ? new Set(body.proxyUploadIds || []).size : 0,
        },
      },
      requestId
    );

    let hold: { id?: string } | undefined;
    try {
      hold = await this._aiChargingService.reserve({
        organizationId: orgId,
        userId,
        kind: 'edit',
        editLevel: body.level,
        quantity: seconds,
        idempotencyKey: creditsKey(edit.id),
        metadata: { route: 'ai-edits' },
      });
    } catch (err) {
      // Nothing is held, so nothing is made: the recording may ask again (402 passes on as it came)
      await this._aiVideoEditsRepository.deleteEdit(orgId, edit.id);
      throw err;
    }

    // before the workflow starts, so the row comes before every row of the workflow's own steps
    await this.trace(
      edit,
      {
        step: 'create',
        kind: 'output',
        durationMs: Date.now() - started,
        ok: true,
        payload: {
          status: 'PENDING',
          cost,
          credit_key_id: creditsKey(edit.id),
          holdId: hold?.id ?? null,
          workflowId: workflowIdOf(edit.id),
        },
      },
      requestId
    );

    try {
      await client.workflow.start('aiVideoEditWorkflowV101', {
        workflowId: workflowIdOf(edit.id),
        taskQueue: 'main',
        args: [{ editId: edit.id }],
        typedSearchAttributes: new TypedSearchAttributes([
          {
            key: organizationId,
            value: orgId,
          },
        ]),
      });
    } catch (err) {
      // no workflow means nothing will ever move the edit on
      this._logger.error(
        `Could not start the workflow of edit ${edit.id}: ${
          (err as Error).message
        }`
      );
      const cause = failureCause(err, 'create');
      await this.trace(
        edit,
        {
          step: 'create',
          kind: 'error',
          durationMs: Date.now() - started,
          ok: false,
          payload: { ...cause, message: (err as Error)?.message ?? '' },
        },
        requestId
      );
      try {
        await this.settle(edit, false, 'workflow_not_started', requestId);
      } catch (releaseErr) {
        // a hold that could not be released is released by the reconciliation job
        this._logger.error(
          `Could not release the credits of edit ${edit.id}: ${
            (releaseErr as Error).message
          }`
        );
      }
      const failure = { ...cause, client_error: NOT_STARTED_TEXT, outcome_code: 'failed' };
      await this._aiVideoEditsRepository.updateEdit(orgId, edit.id, {
        status: 'FAILED',
        error: NOT_STARTED_TEXT,
        log: { failure } as unknown as Prisma.InputJsonValue,
      });
      await this.trace(edit, { step: 'fail', kind: 'error', ok: false, payload: failure }, requestId);
      await this.removeUploads(edit, requestId);
      throw this.notConfigured();
    }

    return { id: edit.id, status: 'PENDING', cost };
  }

  // An edit as the phone reads it; 404 EDIT_NOT_FOUND for another workspace's or a deleted one. The plan and its
  // assets are given once it is READY, as the exact body stored when it became READY (`delivered`; an edit made
  // before it was stored is built from its plan and assets, the same body); a job that ended without one costs
  // nothing. A job that stopped moving is ended first (`expire`) and read as the edit it now is. The serve of a READY
  // edit is logged in the trace (`logServe`); `appVersion` is the request's sanitised `x-app-version`.
  async get(orgId: string, id: string, appVersion?: string): Promise<AiVideoEditView> {
    let edit = await this._aiVideoEditsRepository.getEdit(orgId, id);
    if (edit && this.isStale(edit)) {
      await this.expire(id);
      edit = await this._aiVideoEditsRepository.getEdit(orgId, id);
    }
    if (!edit) {
      throw new AiVideoEditsException(404, 'EDIT_NOT_FOUND', 'Edit not found');
    }
    const status = edit.status as EditStatus;
    const ready = status === 'READY' && !!edit.plan;
    if (!ready) {
      return this.viewOf(edit, status);
    }
    const stored = edit.delivered as unknown as AiVideoEditView | null;
    const body =
      stored && typeof stored === 'object' && stored.id === edit.id && stored.status === 'READY'
        ? stored
        : this.viewOf(edit, status);
    this.logServe(edit, body, appVersion);
    return body;
  }

  // The phone's receipt of one render attempt (`render-report`): stored as a `render_report` trace row with the ids that tie
  // it to the edit, the request and the app, and whether the body the phone parsed is the one stored as `delivered`
  // (`hash_match`). 404 EDIT_NOT_FOUND for another workspace's edit. Idempotent per `(editId, attemptId)`: a repeat is
  // answered `duplicate` and writes nothing. Never fails for the trace: a row that cannot be written is only logged.
  async renderReport(
    orgId: string,
    id: string,
    body: AiVideoEditRenderReportDto,
    requestId?: string
  ): Promise<{ ok: true; duplicate: boolean }> {
    const edit = await this._aiVideoEditsRepository.getEdit(orgId, id);
    if (!edit) {
      throw new AiVideoEditsException(404, 'EDIT_NOT_FOUND', 'Edit not found');
    }
    const key = `${edit.id}:${body.attemptId}`;
    if (this._receipts.has(key)) {
      return { ok: true, duplicate: true };
    }
    // claimed before any await, so a repeat that races this one finds it taken
    this._receipts.add(key);
    if (this._receipts.size > MAX_REMEMBERED_RECEIPTS) {
      this._receipts.delete(this._receipts.values().next().value as string);
    }
    if (await this.receiptKnown(edit, body.attemptId)) {
      return { ok: true, duplicate: true };
    }
    const deliveredSha = this.deliveredSha(edit);
    const outputs = Array.isArray(body.outputs) ? body.outputs : [];
    const warnings = Array.isArray(body.warnings) ? body.warnings : [];
    await this.trace(
      edit,
      {
        step: 'render_report',
        kind: 'metric',
        ok: body.parse_ok && outputs.every((o) => o.ok),
        payload: {
          attempt_id: body.attemptId,
          served_sha256: body.served_sha256.toLowerCase(),
          delivered_sha256: deliveredSha,
          hash_match: deliveredSha !== null && deliveredSha === body.served_sha256.toLowerCase(),
          parse_ok: body.parse_ok,
          app_version: body.app_version,
          device_model: body.device,
          outputs_ok: outputs.filter((o) => o.ok).length,
          outputs_failed: outputs.filter((o) => !o.ok).length,
          // keyed objects, so the `meta` form of the row keeps their codes
          outputs_by_ratio: Object.fromEntries(
            outputs.map((o) => [
              o.ratio,
              {
                ok: o.ok,
                ...(o.error_code ? { error_code: o.error_code } : {}),
                ...(o.duration_ms === undefined ? {} : { duration_ms: o.duration_ms }),
                ...(o.bytes === undefined ? {} : { bytes: o.bytes }),
              },
            ])
          ),
          warning_count: warnings.length,
          warnings: Object.fromEntries(
            warnings.map((w, i) => [`w${i + 1}`, { code: w.code, ...(w.item_id ? { item_id: w.item_id } : {}) }])
          ),
        },
      },
      requestId
    );
    return { ok: true, duplicate: false };
  }

  // Whether the edit already has a receipt of this attempt, or its receipts are at the limit (then a new one is not kept).
  // A trace that cannot be read says no.
  private async receiptKnown(edit: StoredEdit, attemptId: string) {
    try {
      const rows = await this._trace.list(edit.organizationId, edit.id, { step: 'render_report' });
      return (
        rows.length >= MAX_RECEIPTS ||
        rows.some((r) => (r.payload as { attempt_id?: unknown } | null)?.attempt_id === attemptId)
      );
    } catch (err) {
      this._logger.warn(`The receipts of an edit could not be read: ${(err as Error)?.name}`);
      return false;
    }
  }

  // The sha256 of the body a READY edit is served (the stored `delivered`, else the body built from its plan); null when it
  // is not READY with a plan.
  private deliveredSha(edit: StoredEdit): string | null {
    const ready = edit.status === 'READY' && !!edit.plan;
    if (!ready) {
      return null;
    }
    const body = edit.delivered ?? this.viewOf(edit, 'READY');
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  // The whole story of an edit for the super admin: the edit, its request, the trace rows in order (narrowed by step and
  // kind), the body served and the phone's receipts. Reads the edit across workspaces, so only an admin route may call it;
  // 404 EDIT_NOT_FOUND when there is no such edit. The served body and the plan's texts leave only in `full` trace mode.
  async traceBundle(id: string, filter: { step?: string; kind?: string } = {}): Promise<TraceBundle> {
    const edit = await this._aiVideoEditsRepository.getEditById(id);
    if (!edit) {
      throw new AiVideoEditsException(404, 'EDIT_NOT_FOUND', 'Edit not found');
    }
    const rows = await this._trace.list(edit.organizationId, edit.id);
    return bundleOf(edit, rows, {
      step: filter.step || undefined,
      kind: filter.kind || undefined,
      full: traceMode(process.env.AI_EDIT_TRACE) === 'full',
    });
  }

  // What an edit of a recording this many seconds long costs this workspace now, at every level.
  async quote(orgId: string, seconds: number): Promise<AiVideoEditQuote> {
    const charged = chargedSeconds(seconds);
    const costs = await Promise.all(
      EDIT_LEVELS.map((level) => this.costOf(orgId, level, charged))
    );
    return Object.fromEntries(
      EDIT_LEVELS.map((level, index) => [level, costs[index]])
    ) as AiVideoEditQuote;
  }

  // The first activity: gets the words of the recording, from its caption or by transcribing its audio, and keeps
  // them; the audio is deleted once they are kept. Fewer than MIN_SPOKEN_WORDS words end the job as NO_SPEECH and
  // give the credits back (`noSpeech`: the workflow stops). Repeating it after the words are kept only deletes the
  // audio again. A job that already ended is not reopened, and an edit deleted meanwhile never gets its words back.
  async transcribeEdit(editId: string): Promise<{ noSpeech: boolean }> {
    const edit = await this.job(editId);
    return this.instrument(edit, 'transcribe', () => this.transcribeStep(edit));
  }

  // The body of `transcribeEdit`, on the job it found.
  private async transcribeStep(edit: StoredEdit): Promise<{ noSpeech: boolean }> {
    if (FINAL_STATUSES.includes(edit.status as EditStatus)) {
      await this.trace(edit, {
        step: 'transcribe',
        kind: 'decision',
        payload: { decision: 'skipped', reason_code: 'job_ended', status: edit.status },
      });
      return { noSpeech: edit.status === 'NO_SPEECH' };
    }
    if (edit.words === null) {
      if (edit.deletedAt) {
        throw new AiVideoEditsStop(FAILED_TEXT);
      }
      await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
        status: 'TRANSCRIBING',
      });
      const started = Date.now();
      // what the speech-to-text call used is ledgered whether it answered or failed
      const usage: LlmUsage[] = [];
      let sourced: SourcedWords;
      try {
        sourced = await this.sourceWords(edit, usage);
      } finally {
        await this.ledger(edit, 'transcribe', usage);
      }
      const { words, language, source, rawWordCount } = sourced;
      const kept = await this._aiVideoEditsRepository.saveWords(
        edit.organizationId,
        edit.id,
        {
          words: words as unknown as Prisma.InputJsonValue,
          language: language ?? this.request(edit).language ?? null,
        }
      );
      if (!kept) {
        throw new AiVideoEditsStop(FAILED_TEXT);
      }
      edit.words = words as unknown as Prisma.JsonValue;
      await this.trace(edit, {
        step: 'transcribe',
        kind: 'output',
        durationMs: Date.now() - started,
        ok: true,
        payload: {
          source_kind: source,
          provider: source === 'audio' ? TRANSCRIBER : 'caption',
          language: language ?? this.request(edit).language ?? null,
          retries: Math.max(0, (activityTrace().attempt ?? 1) - 1),
          rawWordCount,
          wordCount: words.length,
          noSpeech: words.length < MIN_SPOKEN_WORDS,
          words,
        },
      });
    } else {
      await this.trace(edit, {
        step: 'transcribe',
        kind: 'decision',
        payload: { decision: 'words_already_kept', wordCount: this.words(edit).length },
      });
    }
    await this.removeAudio(edit);

    if (this.words(edit).length < MIN_SPOKEN_WORDS) {
      await this.trace(edit, {
        step: 'transcribe',
        kind: 'decision',
        payload: { decision: 'no_speech', reason_code: 'too_few_words', wordCount: this.words(edit).length, minWords: MIN_SPOKEN_WORDS },
      });
      // the credits first: a repeat of this step must find the job unfinished
      await this.settle(edit, false, 'no_speech');
      await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
        status: 'NO_SPEECH',
        error: NO_SPEECH_TEXT,
      });
      await this.traceUsage(edit);
      await this.removeUploads(edit);
      return { noSpeech: true };
    }
    return { noSpeech: false };
  }

  // The second activity: scores the proxy pieces with Clef-omni for Standard and Heavy (mood, energy, stressed
  // words, a phrase and an effect family per slot) and keeps the scores, then deletes the proxies. Every failure
  // only means fewer scores: a piece that cannot be read or asked is left out, and the plan is made from the words
  // and the event log alone (the planner core works without scores). Repeating it after the scores are kept
  // only deletes the proxies again.
  async perceiveEdit(editId: string) {
    const edit = await this.job(editId);
    return this.instrument(edit, 'perceive', () => this.perceiveStep(edit));
  }

  // The body of `perceiveEdit`, on the job it found.
  private async perceiveStep(edit: StoredEdit) {
    if (FINAL_STATUSES.includes(edit.status as EditStatus)) {
      return;
    }
    const skipped =
      edit.scores !== null
        ? 'scores_already_kept'
        : !LEVEL_RULES[edit.level as EditLevel]?.perception
          ? 'level_without_perception'
          : !edit.proxyUploadIds.length
            ? 'no_proxies'
            : !this._clef.isConfigured()
              ? 'clef_not_configured'
              : undefined;
    if (skipped) {
      await this.trace(edit, {
        step: 'perceive',
        kind: 'decision',
        payload: { decision: 'skipped', reason_code: skipped, level: edit.level },
      });
      // the director's moments still get their effects, from the rotation, when Clef-omni cannot be asked
      if (skipped === 'no_proxies' || skipped === 'clef_not_configured') {
        const picked = await this.fillPicks(edit, undefined, skipped);
        if (picked) {
          await this._aiVideoEditsRepository.updateEdit(
            edit.organizationId,
            edit.id,
            { scores: picked as unknown as Prisma.InputJsonValue }
          );
        }
      }
    } else {
      const started = Date.now();
      let scores: SlotScores | undefined;
      let failed = false;
      const usage: LlmUsage[] = [];
      try {
        scores = await this.perceive(edit, usage);
      } catch (err) {
        failed = true;
        // only the kind of failure is logged, never what was asked or answered
        this._logger.warn(
          `Perception of edit ${edit.id} failed: ${(err as Error).name}`
        );
        await this.traceError(edit, 'perceive', err, Date.now() - started);
      }
      await this.ledger(edit, 'perceive', usage);
      const answered = !!scores;
      // a moment Clef-omni did not answer gets the candidate its rotation names
      scores = await this.fillPicks(
        edit,
        scores,
        failed ? 'perception_failed' : 'pick_not_answered'
      );
      if (scores) {
        await this._aiVideoEditsRepository.updateEdit(
          edit.organizationId,
          edit.id,
          { scores: scores as unknown as Prisma.InputJsonValue }
        );
      }
      await this.trace(edit, {
        step: 'perceive',
        kind: 'output',
        durationMs: Date.now() - started,
        ok: !failed && answered,
        payload: { model: CLEF_MODEL, scores: scores ?? null },
      });
      if (!answered) {
        await this.trace(edit, {
          step: 'perceive',
          kind: 'decision',
          payload: {
            decision: 'fallback_no_scores',
            reason_code: failed ? 'perception_failed' : 'no_piece_answered',
            effect_code: 'plan_from_words_and_event_log',
          },
        });
      }
    }
    for (const id of edit.proxyUploadIds) {
      await this.removeUpload(edit, id);
    }
  }

  // The second activity of the trust-first edit: the director labels the sentences of the kept words (hook, claim,
  // reason, ...) and picks the style of the video (calm or lively); the labelled moments are kept in `moments` for
  // perception and the planner to read. Standard and Heavy only. A failure, a refusal or a server without the
  // director's key only means no direction: `{ source: 'none' }` is kept (or nothing, when it never asked) and the
  // plan is made as it is without one. Repeating it after the moments are kept changes nothing.
  async directEdit(editId: string) {
    const edit = await this.job(editId);
    return this.instrument(edit, 'direct', () => this.directStep(edit));
  }

  // The body of `directEdit`, on the job it found.
  private async directStep(edit: StoredEdit) {
    const llm = directorEditLlm();
    const skipped = FINAL_STATUSES.includes(edit.status as EditStatus)
      ? 'job_ended'
      : edit.moments !== null
        ? 'moments_already_kept'
        : !LEVEL_RULES[edit.level as EditLevel]?.director
          ? 'level_without_director'
          : !this._editLlm.isConfigured(llm)
            ? 'director_not_configured'
            : !this.words(edit).length
              ? 'no_words'
              : undefined;
    if (skipped) {
      await this.trace(edit, {
        step: 'direct',
        kind: 'decision',
        payload: { decision: 'skipped', reason_code: skipped, level: edit.level },
      });
      return;
    }
    const started = Date.now();
    let direction: Direction = { style: 'calm', moments: [], source: 'none' };
    let reason = 'director_failed';
    const usage: LlmUsage[] = [];
    try {
      const directed = await this.direct(edit, llm, usage);
      if (directed) {
        direction = directed;
      } else {
        reason = 'no_usable_answer';
      }
    } catch (err) {
      // only the kind of failure is logged, never what was asked or answered
      this._logger.warn(`The director of edit ${edit.id} failed: ${(err as Error).name}`);
      // the cause only (class and code), not the message: a provider's message may echo what it was asked
      await this.trace(edit, {
        step: 'direct',
        kind: 'error',
        durationMs: Date.now() - started,
        ok: false,
        payload: failureCause(err, 'direct', activityTrace().attempt),
      });
    }
    await this.ledger(edit, 'direct', usage);
    // the edit never fails here: without a direction `{ source: 'none' }` is kept and the plan is made without one
    await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
      moments: (direction.source === 'director'
        ? this.storedDirection(direction)
        : { source: 'none' }) as unknown as Prisma.InputJsonValue,
    });
    const counts: Record<string, number> = {};
    for (const m of direction.moments) {
      counts[m.label] = (counts[m.label] ?? 0) + 1;
    }
    await this.trace(edit, {
      step: 'direct',
      kind: 'decision',
      durationMs: Date.now() - started,
      payload: {
        decision: 'direct',
        style: direction.source === 'director' ? direction.style : null,
        source: direction.source,
        counts,
        ...(direction.source === 'none' ? { reason_code: reason, effect_code: 'plan_without_direction' } : {}),
      },
    });
  }

  // The director's direction for the job: the moments built on the SOURCE timeline (source words, the request's
  // activity map and chapters as they are, an identity map: `silenceCuts` shortens the gaps of the output, which would
  // hide the pauses that end a sentence), the model's labels laid on them. No direction when the model gave no answer.
  private async direct(
    edit: StoredEdit,
    llm: ReturnType<typeof directorEditLlm>,
    usage: LlmUsage[]
  ): Promise<Direction | undefined> {
    const request = this.request(edit);
    const words = this.words(edit);
    const moments = buildMoments(
      words,
      Array.isArray(request.activity_map) ? request.activity_map : [],
      request.chapters,
      buildMap(request.video.duration_ms, [])
    );
    const sentences = moments.filter((m) => m.kind === 'sentence');
    const drawings = moments.filter((m) => m.kind === 'drawing');
    const language = edit.language ?? request.language;
    const promptVersion = createHash('sha256').update(EDIT_DIRECTOR_PROMPT).digest('hex').slice(0, 12);
    await this.trace(edit, {
      step: 'direct',
      kind: 'input',
      payload: {
        model: llm.model,
        promptVersion,
        language: language ?? null,
        sentences: sentences.length,
        drawings: drawings.length,
        chapters: moments.length - sentences.length - drawings.length,
      },
    });
    const started = Date.now();
    const used: LlmUsage[] = [];
    let answer: EditDirection | null;
    try {
      answer = await this._editLlm.directEdit(
        llm,
        directorMessages({ sentences, words, chapters: request.chapters, drawings, language }),
        used
      );
    } finally {
      usage.push(...used.map((u) => ({ ...u, work: `director labels for ${sentences.length} sentences` })));
    }
    const direction: Direction | undefined = answer
      ? { style: answer.style, moments: applyLabels(moments, answer), source: 'director' }
      : undefined;
    // the answer holds the style and the labels of the ids only, no text
    await this.trace(edit, {
      step: 'direct',
      kind: 'output',
      durationMs: Date.now() - started,
      ok: !!direction,
      payload: { model: llm.model, promptVersion, answer: answer ?? null },
    });
    return direction;
  }

  // What is kept of a direction: times, word indexes, regions and labels, never a word, a title or a note.
  private storedDirection(direction: Direction) {
    return {
      style: direction.style,
      source: direction.source,
      moments: direction.moments.map((m: Moment) => ({
        id: m.id,
        kind: m.kind,
        start_ms: m.start_ms,
        end_ms: m.end_ms,
        word_from: m.word_from,
        word_to: m.word_to,
        region: m.region,
        label: m.label,
      })),
    };
  }

  // The third activity: writes the Heavy texts (a hook and a complementary phrase per slot, with icon queries) in the
  // brand voice, one model call, and keeps them. A failure (no key, a refusal, a timeout, nothing usable) only means
  // no texts: the plan is then made from Standard's phrases and keyword echoes. Repeating it after the texts are
  // kept changes nothing.
  async writeEdit(editId: string) {
    const edit = await this.job(editId);
    return this.instrument(edit, 'write', () => this.writeStep(edit));
  }

  // The body of `writeEdit`, on the job it found.
  private async writeStep(edit: StoredEdit) {
    const skipped = FINAL_STATUSES.includes(edit.status as EditStatus)
      ? 'job_ended'
      : !LEVEL_RULES[edit.level as EditLevel]?.writer
        ? 'level_without_writer'
        : edit.texts !== null
          ? 'texts_already_kept'
          : edit.words === null
            ? 'no_words'
            : undefined;
    if (skipped) {
      await this.trace(edit, {
        step: 'write',
        kind: 'decision',
        payload: { decision: 'skipped', reason_code: skipped, level: edit.level },
      });
      return;
    }
    const started = Date.now();
    let texts: WrittenTexts | undefined;
    let failed = false;
    const usage: LlmUsage[] = [];
    try {
      texts = await this.write(edit, usage);
    } catch (err) {
      failed = true;
      // only the kind of failure is logged, never what was asked or answered
      this._logger.warn(`The writer of edit ${edit.id} failed: ${(err as Error).name}`);
      await this.traceError(edit, 'write', err, Date.now() - started);
      await this.trace(edit, {
        step: 'write',
        kind: 'decision',
        payload: { decision: 'fallback_no_texts', reason_code: 'writer_failed', effect_code: 'plan_from_phrases_and_echoes' },
      });
    }
    await this.ledger(edit, 'write', usage);
    if (texts) {
      await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
        texts: texts as unknown as Prisma.InputJsonValue,
      });
    }
    if (!failed && !texts) {
      await this.trace(edit, {
        step: 'write',
        kind: 'decision',
        payload: { decision: 'fallback_no_texts', reason_code: 'no_usable_text', effect_code: 'plan_from_phrases_and_echoes' },
      });
    }
  }

  // The fourth activity: plans the edit from the kept words, the request and any scores with the planner core,
  // validates it and keeps the plan with the validator's log (rule numbers and codes, never texts). Repeating it
  // plans the same edit again in one write.
  async planEdit(editId: string) {
    const edit = await this.job(editId);
    return this.instrument(edit, 'assemble', () => this.planStep(edit));
  }

  // The body of `planEdit`, on the job it found.
  private async planStep(edit: StoredEdit) {
    if (FINAL_STATUSES.includes(edit.status as EditStatus)) {
      return;
    }
    if (edit.words === null) {
      throw new AiVideoEditsStop(FAILED_TEXT);
    }
    await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
      status: 'PLANNING',
    });
    const request = this.request(edit);
    const brand = await this.brand(edit.organizationId);
    const scores = (edit.scores as unknown as SlotScores | null) ?? undefined;
    const texts = (edit.texts as unknown as WrittenTexts | null) ?? undefined;
    const resolved = await this.resolveAssets(edit, request, scores, texts);
    const planInput: PlanEditInput = {
      sessionId: edit.sessionId,
      level: edit.level as EditLevel,
      request,
      words: this.words(edit),
      palette: paletteFor(request.text_colors, brand?.color),
      scores,
      texts,
      direction: this.direction(edit),
      assets: { sounds: resolved.sounds, icons: resolved.icons },
      planAssets: resolved.planAssets,
      bannedWords: brand?.bannedWords.length ? brand.bannedWords : undefined,
    };
    const result = planAndValidate(planInput);
    await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
      plan: result.plan as unknown as Prisma.InputJsonValue,
      assets: usedAssets(result.plan, resolved.planAssets) as unknown as Prisma.InputJsonValue,
      log: {
        warnings: result.warnings,
        rejections: result.rejections,
        // the ledger of the earlier steps (and of this one's asset call) stays; a job with no LLM call adds nothing
        ...(usageOfLog(edit.log) ? { usage: usageOfLog(edit.log) } : {}),
      } as unknown as Prisma.InputJsonValue,
    });
    // what the planner decided and why (structure, every slot, every repair); the plan is already kept
    let rows: TraceEntry[] = [];
    try {
      // the inputs first, so a `full` trace can replay the plan (`structure/input`)
      rows = [
        plannerInputTrace(planInput),
        ...plannerTrace(result),
        iconsTrace(result, texts, resolved.searched, Object.keys(resolved.icons).length),
      ];
    } catch (err) {
      // a trace is never worth a failed step, and the plan is kept
      this._logger.warn(`The planner trace rows could not be built: ${(err as Error)?.name}`);
    }
    await this.traceMany(edit, rows);
  }

  // The last activity: checks the plan for what the phone may draw badly (`client_check`), commits the credits (the plan
  // was made, so the customer got what they were held for), marks the job READY with the exact body the phone will be
  // served (`delivered`, traced as `deliver`), gives back the credits of the caption it reused and deletes the uploads
  // it read. With `AI_EDIT_CLIENT_CHECK_BLOCK=1` a plan the phone cannot draw at all (an unknown effect, look, zone or
  // asset, an item with no time range) is not delivered: the credits are given back and the job is FAILED; by default the
  // findings are only kept. Nothing happens to a job that ended without a plan.
  async finishEdit(editId: string) {
    const edit = await this.job(editId);
    return this.instrument(edit, 'settle', () => this.finishStep(edit));
  }

  // The body of `finishEdit`, on the job it found.
  private async finishStep(edit: StoredEdit) {
    if (edit.status === 'NO_SPEECH' || edit.status === 'FAILED') {
      return;
    }
    const foundReady = edit.status === 'READY';
    const checked = await this.checkClient(edit);
    const log = this.logWithCheck(edit.log, checked.results);
    if (checked.unusable && blocksUnusable()) {
      await this.rejectPlan(edit, checked.results, log);
      return;
    }
    // the credits first: a repeat of this step must find the job unfinished
    await this.settle(edit, true, 'plan_made');
    // the body the phone is served from now on; a job without a plan has none
    const delivered = edit.plan ? this.viewOf({ ...edit, error: null }, 'READY') : undefined;
    await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
      status: 'READY',
      error: null,
      ...(delivered ? { delivered: delivered as unknown as Prisma.InputJsonValue } : {}),
      ...(log ? { log } : {}),
    });
    if (delivered) {
      await this.traceDelivered(edit, delivered);
    }
    // a repeat of this step (the job was found READY: an earlier attempt got this far) sums the ledger up no second time
    if (!foundReady) {
      await this.traceUsage(edit);
    }
    await this.includeCaption(edit);
    await this.removeUploads(edit);
  }

  // Ends a job whose plan the phone cannot draw: the credits are given back, the job is FAILED with a text of ours and the
  // findings are kept in `log.client_check` beside the failure; the plan stays kept for whoever looks into it.
  private async rejectPlan(edit: StoredEdit, results: CheckResult[], log: Prisma.InputJsonValue | undefined) {
    const blocking = results.find((r) => r.severity === 'error');
    await this.settle(edit, false, 'plan_unusable');
    const failure = {
      step: 'client_check',
      error_class: 'UnusablePlan',
      error_code: blocking?.code ?? null,
      retryable: false,
      client_error: FAILED_TEXT,
      outcome_code: 'failed',
      at: new Date().toISOString(),
    };
    const written = { ...((log ?? this.splitLog(edit.log).rest) as object), failure } as unknown as Prisma.InputJsonValue;
    await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
      status: 'FAILED',
      error: FAILED_TEXT,
      log: written,
    });
    await this.trace(edit, { step: 'fail', kind: 'error', ok: false, payload: failure });
    await this.traceUsage(edit, written);
    await this.removeUploads(edit);
  }

  // The failure path of the workflow: ends a job that has not ended. The credits are given back unless the plan
  // was already kept, which the customer got what they were held for. `error` is a text written for the customer
  // (an AiVideoEditsStop's); without one the stored error is a generic one. The uploads are deleted on every ending.
  // The internal cause (the step, the error class and code, whether it was retryable) the failing step kept in `log`
  // is written beside that text, in `log.failure` and in a `fail` trace row; a failure no step caught (a timeout, a
  // cancellation) has none.
  async failEdit(editId: string, error?: string) {
    const edit = await this._aiVideoEditsRepository.getEditById(editId);
    if (!edit) {
      return;
    }
    if (!FINAL_STATUSES.includes(edit.status as EditStatus)) {
      const planned = edit.plan !== null;
      // the credits first: a repeat of this step must find the job unfinished
      await this.settle(
        edit,
        planned,
        planned ? 'plan_kept_despite_failure' : 'no_plan'
      );
      const { cause, rest } = this.splitLog(edit.log);
      const failure = {
        ...(cause ?? NO_CAUSE),
        client_error: planned ? null : error || FAILED_TEXT,
        outcome_code: planned ? 'ready_kept' : 'failed',
      };
      const log = { ...rest, failure } as unknown as Prisma.InputJsonValue;
      await this._aiVideoEditsRepository.updateEdit(
        edit.organizationId,
        edit.id,
        planned
          ? { status: 'READY', error: null, log }
          : { status: 'FAILED', error: error || FAILED_TEXT, log }
      );
      await this.trace(edit, { step: 'fail', kind: 'error', ok: false, payload: failure });
      await this.traceUsage(edit, log);
      if (planned) {
        await this.includeCaption(edit);
      }
    }
    await this.removeUploads(edit);
  }

  // The seconds of the recording the words come from: the READY caption's audio length, or the uploaded audio's
  // from its WAV header. Refuses a caption or audio that is not the workspace's or not usable.
  private async wordsSeconds(orgId: string, body: AiVideoEditCreateDto) {
    if (body.aiCaptionId) {
      const caption = await this._aiVideoEditsRepository.caption(
        orgId,
        body.aiCaptionId
      );
      if (!caption || caption.status !== 'READY') {
        throw new AiVideoEditsException(
          404,
          'CAPTION_NOT_FOUND',
          'Caption not found'
        );
      }
      return caption.audioSeconds ?? 0;
    }

    if (!this._transcription.isConfigured()) {
      throw this.notConfigured();
    }
    const audio = await this._aiVideoEditsRepository.upload(
      orgId,
      body.audioUploadId!
    );
    if (!audio || audio.purpose !== MOBILE_UPLOAD_PURPOSE_AUDIO) {
      throw new AiVideoEditsException(
        404,
        'AUDIO_NOT_FOUND',
        'Audio upload not found'
      );
    }
    if (audio.status !== 'completed') {
      throw this.notComplete();
    }
    try {
      return await this._transcription.audioSeconds(audio.objectKey);
    } catch (err) {
      if (err instanceof MuseTranscribeError) {
        this._logger.warn(`Audio refused: ${err.message}`);
        throw new AiVideoEditsException(
          400,
          'AUDIO_NOT_SUPPORTED',
          'The audio must be a mono 16-bit WAV at 16 or 24 kHz'
        );
      }
      throw err;
    }
  }

  // Every proxy piece is a completed `edit_proxy` upload of the workspace: 404 UPLOAD_NOT_FOUND, else 409
  // UPLOAD_NOT_COMPLETE.
  private async requireProxies(orgId: string, ids: string[]) {
    const uploads = await Promise.all(
      ids.map((id) => this._aiVideoEditsRepository.upload(orgId, id))
    );
    for (const upload of uploads) {
      if (!upload || upload.purpose !== MOBILE_UPLOAD_PURPOSE_EDIT_PROXY) {
        throw new AiVideoEditsException(
          404,
          'UPLOAD_NOT_FOUND',
          'Proxy upload not found'
        );
      }
      if (upload.status !== 'completed') {
        throw this.notComplete();
      }
    }
  }

  // The words of the recording and their language: the caption's when the edit names one, else a transcription of
  // its audio. What can't be had by trying again stops the job with a text of ours.
  private async sourceWords(edit: StoredEdit, usage: LlmUsage[]): Promise<SourcedWords> {
    if (edit.aiCaptionId) {
      const caption = await this._aiVideoEditsRepository.caption(
        edit.organizationId,
        edit.aiCaptionId
      );
      if (!caption || caption.status !== 'READY') {
        throw new AiVideoEditsStop(FAILED_TEXT);
      }
      const segments = caption.segments as unknown as TranscriptSegment[] | null;
      const raw = (Array.isArray(segments) ? segments : []).flatMap((s) => s.words || []);
      await this.trace(edit, {
        step: 'transcribe',
        kind: 'input',
        payload: { source_kind: 'caption', aiCaptionId: edit.aiCaptionId, rawWordCount: raw.length },
      });
      await this.trace(edit, {
        step: 'transcribe',
        kind: 'decision',
        payload: { decision: 'caption_reused', reason_code: 'edit_names_caption' },
      });
      return {
        words: toEditWords(raw),
        language: caption.language ?? undefined,
        source: 'caption',
        rawWordCount: raw.length,
      };
    }

    const audio = edit.audioUploadId
      ? await this._aiVideoEditsRepository.upload(
          edit.organizationId,
          edit.audioUploadId
        )
      : null;
    if (!audio) {
      throw new AiVideoEditsStop(AUDIO_FAILED_TEXT);
    }
    await this.trace(edit, {
      step: 'transcribe',
      kind: 'input',
      payload: { source_kind: 'audio', provider: TRANSCRIBER, audioUploadId: edit.audioUploadId, audio_key: audio.objectKey },
    });
    await this.trace(edit, {
      step: 'transcribe',
      kind: 'decision',
      payload: { decision: 'fresh_transcription', reason_code: 'no_caption_named' },
    });
    const spoken = Date.now();
    let transcription: Transcription;
    try {
      transcription = await this.transcribeAudio(audio.objectKey);
    } catch (err) {
      this.noteSpeech(usage, undefined, spoken);
      throw err;
    }
    this.noteSpeech(usage, transcription.seconds, spoken);
    const raw: TranscriptWord[] =
      transcription.words ??
      transcription.segments.flatMap((s) => s.words || []);
    return {
      words: toEditWords(raw),
      language: transcription.language,
      source: 'audio',
      rawWordCount: raw.length,
    };
  }

  // Adds the speech-to-text call to `usage`: the provider's model and the audio seconds (unknown for a call that failed).
  // A provider that names no model is not ledgered.
  private noteSpeech(usage: LlmUsage[], seconds: number | undefined, startedAt: number) {
    const model = this._transcription.model;
    if (!model) {
      return;
    }
    const known = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0;
    const audio = known ? (seconds as number) : 0;
    usage.push({
      model,
      input_tokens: 0,
      output_tokens: 0,
      audio_seconds: Math.round(audio * 1000) / 1000,
      estimated: false,
      latency_ms: Date.now() - startedAt,
      ok: known,
      work: known ? `speech to text ${Math.round(audio)} s` : 'speech to text attempt',
    });
  }

  // Transcribes the stored audio. What the transcriber refuses for good, or a missing key, stops the job with a
  // text of ours; anything else is thrown as it came so the activity is retried.
  private async transcribeAudio(key: string) {
    try {
      return await this._transcription.transcribe(key);
    } catch (err) {
      if (err instanceof AiCaptionsNotConfigured) {
        throw new AiVideoEditsStop(FAILED_TEXT);
      }
      if (err instanceof MuseTranscribeError && !err.retryable) {
        this._logger.warn(`Transcription refused: ${err.message}`);
        throw new AiVideoEditsStop(AUDIO_FAILED_TEXT);
      }
      throw err;
    }
  }

  // The workspace's colour, voice and banned words; undefined when they can't be read (the plan then has the multi
  // colour palette and no banned words, and the writer no voice).
  private async brand(orgId: string): Promise<EditBrand | undefined> {
    try {
      const brand = await this._brands.get(orgId);
      return {
        color: brand.color,
        voice: brand.profile.voice,
        bannedWords: brand.profile.bannedWords ?? [],
      };
    } catch (err) {
      this._logger.warn(`The brand of a workspace could not be read: ${(err as Error).name}`);
      return undefined;
    }
  }

  // The sounds and icon files the plan may use: the sounds the server serves and an icon or mp4 clip per slot the
  // planner may give one (the writer's query, else the slot's English keyword). A failure only means none: the plan
  // is then made without them.
  private async resolveAssets(
    edit: StoredEdit,
    request: EditRequest,
    scores?: SlotScores,
    texts?: WrittenTexts
  ): Promise<ResolvedAssets & { searched: number }> {
    const level = edit.level as EditLevel;
    const started = Date.now();
    const usage: LlmUsage[] = [];
    let searched = 0;
    try {
      const { slots, durationMs, direction } = perceptionTargets(request, this.words(edit), this.direction(edit));
      const input = {
        level,
        soundEffects: request.options?.sound_effects,
        queries: iconQueries(slots, level, durationMs, scores, texts, direction),
        texts: slotTexts(texts),
      };
      await this.trace(edit, {
        step: 'assets',
        kind: 'input',
        payload: {
          level,
          sound_effects: input.soundEffects ?? null,
          sounds_served: !!process.env.AI_EDIT_SOUNDS_BASE_URL,
          queries: input.queries,
          texts: input.texts ?? {},
        },
      });
      const report: AssetReport[] = [];
      const resolved = await this._assets.resolve(input, report, usage);
      await this.trace(edit, {
        step: 'assets',
        kind: 'output',
        durationMs: Date.now() - started,
        ok: true,
        payload: {
          icons: resolved.icons,
          sounds: resolved.sounds,
          planAssets: resolved.planAssets.map((a) => ({ id: a.id, kind: a.kind })),
        },
      });
      searched = Object.keys(input.queries).length;
      for (const item of report) {
        const chosen = ['remembered', 'cache_hit', 'stored'].includes(item.outcome_code);
        await this.trace(edit, {
          step: 'assets',
          kind: 'decision',
          payload: {
            decision: chosen ? 'asset_chosen' : 'asset_dropped',
            ...item,
            ...(chosen ? {} : { effect_code: 'no_icon_for_slot' }),
          },
        });
      }
      return { ...resolved, searched };
    } catch (err) {
      this._logger.warn(`The assets of edit ${edit.id} failed: ${(err as Error).name}`);
      await this.traceError(edit, 'assets', err, Date.now() - started);
      await this.trace(edit, {
        step: 'assets',
        kind: 'decision',
        payload: { decision: 'fallback_no_assets', reason_code: 'resolver_failed', effect_code: 'plan_without_icons_and_sounds' },
      });
      return { icons: {}, sounds: [], planAssets: [], searched: 0 };
    } finally {
      await this.ledger(edit, 'assets', usage);
    }
  }

  // The writer's one call: asks for a text per slot (the hook and the best scored) with the brand voice and banned
  // words, and reads the answer. Undefined when the writer wrote nothing usable.
  private async write(edit: StoredEdit, usage: LlmUsage[]): Promise<WrittenTexts | undefined> {
    const { words, slots, durationMs, direction } = perceptionTargets(this.request(edit), this.words(edit), this.direction(edit));
    const asked = writerSlots(
      slots,
      edit.level as EditLevel,
      durationMs,
      (edit.scores as unknown as SlotScores | null) ?? undefined
    );
    if (!asked.length) {
      await this.trace(edit, {
        step: 'write',
        kind: 'decision',
        payload: { decision: 'skipped', reason_code: 'no_slots_asked', level: edit.level },
      });
      return undefined;
    }
    const brand = await this.brand(edit.organizationId);
    const bannedWords = brand?.bannedWords ?? [];
    const llm = writerEditLlm();
    const promptVersion = createHash('sha256').update(EDIT_WRITER_PROMPT).digest('hex').slice(0, 12);
    await this.trace(edit, {
      step: 'write',
      kind: 'input',
      payload: {
        model: llm.model,
        promptVersion,
        language: edit.language ?? null,
        voice: brand?.voice ?? null,
        bannedWords,
        slots: asked.map((s) => ({ slot_id: s.id, word_index: s.word_index, start_ms: s.start_ms, score: s.score })),
      },
    });
    const started = Date.now();
    const used: LlmUsage[] = [];
    let answer: EditTextsDraft | null;
    try {
      answer = await this._editLlm.writeEditTexts(
        llm,
        writerMessages({
          words,
          slots: asked,
          level: edit.level as EditLevel,
          durationMs,
          direction,
          language: edit.language ?? undefined,
          voice: brand?.voice,
          bannedWords,
        }),
        used
      );
    } finally {
      usage.push(...used.map((u) => ({ ...u, work: `writer texts for ${asked.length} slots` })));
    }
    const texts = readTexts(
      answer as WriterAnswer | null,
      asked,
      bannedWords,
      edit.language ?? this.request(edit).language
    );
    await this.trace(edit, {
      step: 'write',
      kind: 'output',
      durationMs: Date.now() - started,
      ok: !!texts,
      payload: { model: llm.model, promptVersion, answer: answer ?? null, texts: texts ?? null },
    });
    for (const decision of writerDecisions(
      asked.map((s) => s.id),
      answer as WriterAnswer | null,
      texts,
      bannedWords
    )) {
      await this.trace(edit, { step: 'write', kind: 'decision', payload: decision });
    }
    return texts;
  }

  // The director's direction kept for the job; none when it was never asked or gave nothing (`{ source: 'none' }`).
  private direction(edit: StoredEdit): Direction | undefined {
    const kept = edit.moments as unknown as Direction | null;
    return kept && kept.source === 'director' && Array.isArray(kept.moments) ? kept : undefined;
  }

  // The pick questions of each of `count` proxy pieces (at least one, empty without a direction): the moments of the
  // direction on the source timeline, the effects the level, the phone and the style allow, a facecam move only when
  // the recording has a facecam track.
  private pickAsks(edit: StoredEdit, count: number): PickAsk[][] {
    const request = this.request(edit);
    return pickQuestions(
      this.direction(edit),
      {
        level: edit.level as EditLevel,
        capabilities: request.capabilities,
        facecam: Array.isArray(request.facecam_track) && request.facecam_track.length > 0,
      },
      request.video.duration_ms,
      count
    );
  }

  // The scores with a fallback pick for every pick question that got no valid answer, and the decision traced (ids and
  // counts only). Without a direction the scores come back as they were.
  private async fillPicks(
    edit: StoredEdit,
    scores: SlotScores | undefined,
    reason: string
  ): Promise<SlotScores | undefined> {
    const asks = this.pickAsks(edit, edit.proxyUploadIds.length).flat();
    const { scores: filled, filled: picks } = withFallbackPicks(scores, asks);
    if (Object.keys(picks).length) {
      await this.trace(edit, {
        step: 'perceive',
        kind: 'decision',
        payload: {
          decision: 'pick_fallback',
          reason_code: reason,
          effect_code: 'rotation_over_candidates',
          asked: asks.length,
          filled: Object.keys(picks).length,
          picks,
        },
      });
    }
    return filled;
  }

  // The scores of the whole video: the questions of each proxy piece asked in turn (a few pieces at a time), the
  // answers read into scores and merged. A piece whose questions all fail adds nothing; undefined when no piece
  // gave anything.
  private async perceive(edit: StoredEdit, usage: LlmUsage[]): Promise<SlotScores | undefined> {
    const request = this.request(edit);
    const { words, slots, sourceMs } = perceptionTargets(
      request,
      this.words(edit),
      this.direction(edit)
    );
    const count = edit.proxyUploadIds.length;
    const pieces = targetsByPiece(
      slots,
      words,
      sourceMs,
      request.video.duration_ms,
      count
    );
    const picks = this.pickAsks(edit, count);
    await this.trace(edit, {
      step: 'perceive',
      kind: 'input',
      payload: {
        model: CLEF_MODEL,
        pieces: count,
        perPiece: pieces.map((targets, index) => ({
          piece: index,
          uploadId: edit.proxyUploadIds[index],
          slots: targets.length,
          picks: picks[index].length,
        })),
      },
    });
    const results: SlotScores[] = [];
    const started = Date.now();
    for (let k = 0; k < count; k += PERCEPTION_PARALLEL) {
      // a job that has run long enough stops asking and plans with what it has
      if (Date.now() - started > PERCEPTION_BUDGET_MS) {
        await this.trace(edit, {
          step: 'perceive',
          kind: 'decision',
          payload: {
            decision: 'budget_stop',
            reason_code: 'perception_budget',
            piecesAsked: k,
            pieces: count,
            budgetMs: PERCEPTION_BUDGET_MS,
          },
        });
        break;
      }
      const group = await Promise.all(
        pieces
          .slice(k, k + PERCEPTION_PARALLEL)
          .map((targets, j) =>
            this.perceivePiece(edit, edit.proxyUploadIds[k + j], targets, picks[k + j], k + j, usage)
          )
      );
      results.push(...group.filter((r): r is SlotScores => !!r));
    }
    return mergePieces(results);
  }

  // The scores of one piece, or undefined when the piece cannot be read or none of its questions was answered.
  // The first calls carry the mood and the per-slot choices; the commentary is asked after, over the phrases of the
  // mood answered. A call that fails drops its own questions only.
  private async perceivePiece(
    edit: StoredEdit,
    uploadId: string,
    targets: PieceTarget[],
    picks: PickAsk[],
    index: number,
    usage: LlmUsage[]
  ): Promise<SlotScores | undefined> {
    const started = Date.now();
    // a piece left out says why, and the plan then has no scores from it
    const dropped = (reason: string) =>
      this.trace(edit, {
        step: 'perceive',
        kind: 'decision',
        payload: { decision: 'piece_dropped', piece: index, reason_code: reason, effect_code: 'plan_without_piece_scores' },
      });
    let video: Buffer;
    try {
      const upload = await this._aiVideoEditsRepository.upload(
        edit.organizationId,
        uploadId
      );
      if (!upload) {
        await dropped('upload_missing');
        return undefined;
      }
      video = await readObject(upload.objectKey);
    } catch (err) {
      this._logger.warn(
        `A proxy piece of edit ${edit.id} could not be read: ${(err as Error).name}`
      );
      await this.traceError(edit, 'perceive', err, Date.now() - started);
      await dropped('read_failed');
      return undefined;
    }
    // the pick questions come after the piece's own, so a call over the limit only moves the picks to the next call
    const first = [...pieceQuestions(targets), ...picks.map((a) => a.question)];
    await this.trace(edit, {
      step: 'perceive',
      kind: 'input',
      payload: {
        piece: index,
        uploadId,
        bytes: video.length,
        model: CLEF_MODEL,
        targets: targets.length,
        picks: picks.length,
        questions: first.length,
        questionsHash: questionsHash(first),
      },
    });
    const answers: ClefAnswers = {};
    const failures: Record<string, unknown>[] = [];
    let calls = 0;
    const ask = async (questions: ClefQuestion[], work: string) => {
      for (const batch of batches(questions)) {
        calls++;
        const used: LlmUsage[] = [];
        try {
          Object.assign(answers, await this._clef.ask(video, batch, used));
        } catch (err) {
          this._logger.warn(
            `Clef-omni call for edit ${edit.id} failed: ${(err as Error).message}`
          );
          const cause = failureCause(err, 'perceive');
          failures.push({ error_class: cause.error_class, error_code: cause.error_code, retryable: cause.retryable });
        }
        usage.push(...used.map((u) => ({ ...u, work })));
      }
    };
    await ask(first, `perception of slot piece ${index}`);
    await ask(
      commentaryQuestions(
        targets,
        typeof answers.mood === 'string' ? answers.mood : undefined
      ),
      `perception commentary of slot piece ${index}`
    );
    const scores = readPiece(answers, picks);
    const kept = Object.keys(scores).length ? scores : undefined;
    await this.trace(edit, {
      step: 'perceive',
      kind: 'output',
      durationMs: Date.now() - started,
      ok: !!kept,
      payload: {
        piece: index,
        model: CLEF_MODEL,
        calls,
        failedCalls: failures.length,
        failures,
        answered: Object.keys(answers).length,
        answers,
        scores,
      },
    });
    if (!kept) {
      await dropped(failures.length ? 'all_calls_failed' : 'no_usable_answers');
    }
    return kept;
  }

  // The answer for an edit that exists already: where it stands now and what it holds. A deleted edit is gone for
  // good. A job that stopped moving is ended first (`expire`), so the phone reads where it really stands.
  private async repeated(edit: StoredEdit): Promise<AiVideoEditCreated> {
    if (edit.deletedAt) {
      throw new AiVideoEditsException(404, 'EDIT_NOT_FOUND', 'Edit not found');
    }
    const status = (
      this.isStale(edit) ? (await this.expire(edit.id)) ?? edit.status : edit.status
    ) as EditStatus;
    return {
      id: edit.id,
      status,
      cost: this.isReleased(status) ? 0 : edit.cost,
    };
  }

  // Whether a job ended without a plan, so its credits were given back.
  private isReleased(status: EditStatus) {
    return status === 'FAILED' || status === 'NO_SPEECH';
  }

  // The moment before which a job in progress that has not changed is dead.
  private staleBefore() {
    return dayjs().subtract(STALE_HOURS, 'hour');
  }

  // Whether the job is in progress and has not changed for STALE_HOURS (`updatedAt` moves with every change).
  private isStale(edit: { status: string; updatedAt: Date }) {
    return (
      !FINAL_STATUSES.includes(edit.status as EditStatus) &&
      dayjs(edit.updatedAt).isBefore(this.staleBefore())
    );
  }

  // Ends a job that stopped moving, on the read that finds it (as captions do; no scheduled job): FAILED with a
  // text of ours, the credits given back, the uploads deleted. When the plan was already kept the customer got
  // what the credits were held for, so it is READY and they are committed (the rule of `failEdit`). Only the call
  // whose guarded write took the job settles, so reads racing each other settle once. A hold that cannot be
  // released here is released by the nightly credits reconciliation. Answers the status the edit has afterwards
  // (undefined when it is gone).
  private async expire(id: string) {
    const edit = await this._aiVideoEditsRepository.getEditById(id);
    // it moved on since the caller read it
    if (!edit || !this.isStale(edit)) {
      return edit?.status;
    }
    const planned = edit.plan !== null;
    const next = planned
      ? { status: 'READY', error: null }
      : { status: 'FAILED', error: FAILED_TEXT };
    const taken = await this._aiVideoEditsRepository.closeStale(
      edit.organizationId,
      id,
      this.staleBefore().toDate(),
      next
    );
    if (!taken) {
      return (await this._aiVideoEditsRepository.getEditById(id))?.status;
    }
    this._logger.warn(
      `Edit ${id} stopped moving in ${edit.status}: ended as ${next.status}`
    );
    await this.trace(edit, {
      step: 'fail',
      kind: 'decision',
      payload: {
        decision: 'expired_stale',
        status: next.status,
        last_status: edit.status,
        stale_hours: STALE_HOURS,
      },
    });
    try {
      await this.settle(edit, planned, planned ? 'stale_plan_kept' : 'stale_no_plan');
    } catch (err) {
      this._logger.error(
        `Could not settle the credits of edit ${id}: ${(err as Error).message}`
      );
    }
    if (planned) {
      await this.includeCaption(edit);
    }
    await this.removeUploads(edit);
    return next.status;
  }

  // The edit that reused a caption has the transcript's held credits given back (the caption is INCLUDED); never fails.
  private includeCaption(edit: { organizationId: string; aiCaptionId: string | null }) {
    return edit.aiCaptionId
      ? this._aiCaptions.includeInEdit(edit.organizationId, edit.aiCaptionId)
      : undefined;
  }

  // What an edit at this level of a recording this many whole seconds long costs this workspace now.
  private async costOf(orgId: string, level: EditLevel, seconds: number) {
    return (
      await this._aiChargingService.estimate(orgId, {
        kind: 'edit',
        editLevel: level,
        quantity: seconds,
      })
    ).amount;
  }

  // An edit as the phone reads it at a status: its error and cost, and its plan and assets once it is READY. The one
  // builder of the body, so the stored `delivered` and a body built from a row of before it was stored are the same.
  private viewOf(
    edit: { id: string; error: string | null; cost: number; plan: Prisma.JsonValue | null; assets: Prisma.JsonValue | null },
    status: EditStatus
  ): AiVideoEditView {
    const ready = status === 'READY' && !!edit.plan;
    return {
      id: edit.id,
      status,
      ...(edit.error ? { error: edit.error } : {}),
      cost: this.isReleased(status) ? 0 : edit.cost,
      ...(ready
        ? {
            plan: edit.plan as unknown as Plan,
            assets: (edit.assets as unknown as PlanAsset[] | null) ?? [],
          }
        : {}),
    };
  }

  // Logs that a READY edit was served: a `deliver` metric row the first time (in this process) and then at most one a
  // minute per edit, with when, the app's version, the hash and size of the body served (what the phone's receipt
  // names as `served_sha256`). Never throws and never delays the read: the row is written in the background.
  private logServe(edit: TraceEdit, body: AiVideoEditView, appVersion?: string) {
    try {
      const now = Date.now();
      const last = this._served.get(edit.id);
      if (last !== undefined && now - last < SERVE_LOG_MS) {
        return;
      }
      this._served.delete(edit.id);
      this._served.set(edit.id, now);
      if (this._served.size > MAX_SERVED) {
        this._served.delete(this._served.keys().next().value as string);
      }
      const json = JSON.stringify(body);
      void this.trace(edit, {
        step: 'deliver',
        kind: 'metric',
        ok: true,
        payload: {
          first_serve: last === undefined,
          served_at_ms: now,
          app_version: appVersion ?? null,
          served_sha256: createHash('sha256').update(json).digest('hex'),
          bytes: Buffer.byteLength(json),
        },
      });
    } catch (err) {
      this._logger.warn(`A serve could not be logged: ${(err as Error)?.name}`);
    }
  }

  // Traces the body that was stored as `delivered`: its hash and size as the database gives it back (what the phone is
  // served; a JSON column may reorder keys), the contract and plan versions, and the body itself (kept in `full` mode
  // only). Never throws.
  private async traceDelivered(edit: StoredEdit, body: AiVideoEditView) {
    let json = JSON.stringify(body);
    try {
      const stored = await this._aiVideoEditsRepository.getEditById(edit.id);
      if (stored?.delivered) {
        json = JSON.stringify(stored.delivered);
      }
    } catch (err) {
      this._logger.warn(`The stored body of an edit could not be read back: ${(err as Error)?.name}`);
    }
    await this.trace(edit, {
      step: 'deliver',
      kind: 'output',
      ok: true,
      payload: {
        sha256: createHash('sha256').update(json).digest('hex'),
        bytes: Buffer.byteLength(json),
        contract_version: body.plan?.contract_version ?? null,
        plan_version: body.plan?.plan_version ?? null,
        plan_items: body.plan?.items.length ?? 0,
        assets_count: body.assets?.length ?? 0,
        delivered: body,
      },
    });
  }

  // Checks the kept plan for what the phone may draw badly (the pure `clientCheck`, then a HEAD check of every asset URL)
  // and traces the findings in `client_check` rows. Never throws: a check that fails finds nothing and the plan goes on.
  private async checkClient(edit: StoredEdit): Promise<{ results: CheckResult[]; unusable: boolean }> {
    try {
      const plan = edit.plan as unknown as Plan | null;
      if (!plan) {
        return { results: [], unusable: false };
      }
      const assets = (edit.assets as unknown as PlanAsset[] | null) ?? [];
      const request = this.request(edit);
      const results = clientCheck({
        plan,
        assets,
        video: request.video,
        outputs: request.outputs,
        source_duration_ms: request.video.duration_ms,
        word_count: perceptionTargets(request, this.words(edit), this.direction(edit)).words.length,
        language: edit.language ?? request.language,
        capabilities: request.capabilities,
      });
      try {
        results.push(...unreachableAssets(await this._assets.probe(assets)));
      } catch (err) {
        this._logger.warn(`The assets of edit ${edit.id} could not be probed: ${(err as Error)?.name}`);
      }
      const unusable = isUnusable(results);
      await this.traceMany(edit, clientCheckTrace(results, unusable, blocksUnusable()));
      return { results, unusable };
    } catch (err) {
      this._logger.warn(`The client check of edit ${edit.id} failed: ${(err as Error)?.name}`);
      return { results: [], unusable: false };
    }
  }

  // The edit's `log` with the client check's findings under `client_check` (replacing the last attempt's); undefined when
  // the log needs no write (no findings, and none were kept before).
  private logWithCheck(log: Prisma.JsonValue | null | undefined, results: CheckResult[]) {
    const { client_check: before, ...rest } = (log && typeof log === 'object' && !Array.isArray(log) ? log : {}) as Record<string, unknown>;
    if (!results.length && before === undefined) {
      return undefined;
    }
    return (results.length ? { ...rest, client_check: results } : rest) as unknown as Prisma.InputJsonValue;
  }

  // The edit a job step works on; a missing one is a reason retrying can't change.
  private async job(editId: string) {
    const edit = await this._aiVideoEditsRepository.getEditById(editId);
    if (!edit) {
      throw new AiVideoEditsStop('Edit not found');
    }
    return edit;
  }

  // The engine request the job was made with.
  private request(edit: StoredEdit) {
    return edit.request as unknown as EditRequest;
  }

  // The kept words of the job; none before they are kept.
  private words(edit: StoredEdit) {
    const words = edit.words as unknown as EditWord[] | null;
    return Array.isArray(words) ? words : [];
  }

  // 503 AI_EDIT_NOT_CONFIGURED: the transcriber's key or the workflow engine is missing.
  private notConfigured() {
    return new AiVideoEditsException(
      503,
      'AI_EDIT_NOT_CONFIGURED',
      'AI editing is not available on this server.'
    );
  }

  // 409 UPLOAD_NOT_COMPLETE.
  private notComplete() {
    return new AiVideoEditsException(
      409,
      'UPLOAD_NOT_COMPLETE',
      'An upload of this edit is not complete'
    );
  }

  // Commits (`ok`) or gives back the credits held for an edit, the whole blocks it was held for. The workspace id
  // always goes with the key. `reason` is the code of why this way (`plan_made`, `no_speech`, `no_plan`, ...), written
  // to the trace with what was settled; a settle that fails is traced as an error and rethrown, as before.
  private async settle(
    edit: { id: string; sessionId: string; organizationId: string },
    ok: boolean,
    reason: string,
    requestId?: string
  ) {
    const started = Date.now();
    try {
      await this._aiChargingService.finish(
        creditsKey(edit.id),
        ok ? { ok: true } : { ok: false },
        edit.organizationId
      );
    } catch (err) {
      await this.traceError(edit, 'settle', err, Date.now() - started, requestId);
      throw err;
    }
    await this.trace(
      edit,
      {
        step: 'settle',
        kind: 'output',
        durationMs: Date.now() - started,
        ok: true,
        payload: { action_kind: ok ? 'commit' : 'release', credit_key_id: creditsKey(edit.id) },
      },
      requestId
    );
    await this.trace(
      edit,
      { step: 'settle', kind: 'decision', payload: { decision: ok ? 'commit' : 'release', reason_code: reason } },
      requestId
    );
  }

  // Deletes the edit's speech audio from storage (its words are kept). A failure is only logged: the sweep of old
  // uploads is the backstop.
  private async removeAudio(edit: {
    id: string;
    organizationId: string;
    audioUploadId: string | null;
  }) {
    if (edit.audioUploadId) {
      await this.removeUpload(edit, edit.audioUploadId);
    }
  }

  // Deletes every upload the edit read (its audio and its proxy pieces) from storage, once the job has ended, and
  // traces how many went.
  private async removeUploads(
    edit: {
      id: string;
      sessionId: string;
      organizationId: string;
      audioUploadId: string | null;
      proxyUploadIds: string[];
    },
    requestId?: string
  ) {
    const ids = [...(edit.audioUploadId ? [edit.audioUploadId] : []), ...edit.proxyUploadIds];
    const outcomes: string[] = [];
    for (const id of ids) {
      outcomes.push(await this.removeUpload(edit, id));
    }
    if (ids.length) {
      const count = (what: string) => outcomes.filter((o) => o === what).length;
      await this.trace(
        edit,
        {
          step: 'settle',
          kind: 'output',
          payload: { uploads: ids.length, uploads_deleted: count('deleted'), uploads_missing: count('missing'), uploads_failed: count('failed') },
        },
        requestId
      );
    }
  }

  // Deletes one upload's object from storage; says whether it went, was not there or could not. A failure is only
  // logged: the sweep of old uploads is the backstop.
  private async removeUpload(
    edit: { id: string; organizationId: string },
    uploadId: string
  ): Promise<'deleted' | 'missing' | 'failed'> {
    try {
      const upload = await this._aiVideoEditsRepository.upload(
        edit.organizationId,
        uploadId
      );
      if (upload) {
        await deleteObject(upload.objectKey);
        return 'deleted';
      }
      return 'missing';
    } catch (err) {
      this._logger.warn(
        `Could not delete an upload of edit ${edit.id}: ${
          (err as Error).message
        }`
      );
      return 'failed';
    }
  }

  // Appends one row to the trace of an edit, with the ids that tie it to the edit, its session, the workflow run and
  // the request, and the activity's attempt. Never throws and never waits longer than TRACE_TIMEOUT_MS: a trace row is
  // never worth a failed or a delayed step (a write that is still running then ends on its own).
  private async trace(edit: TraceEdit, entry: TraceEntry, requestId?: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const activity = activityTrace();
      const write = Promise.resolve(
        this._trace.record(edit.id, {
          ...entry,
          attempt: entry.attempt ?? activity.attempt,
          payload: { ...correlation(edit, requestId, activity), ...(entry.payload as object | undefined) },
        })
      );
      // a write that loses the race must not become an unhandled rejection later
      write.catch(() => undefined);
      await Promise.race([
        write,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this._logger.warn('A trace row took too long and was left running');
            resolve();
          }, TRACE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this._logger.warn(`A trace row could not be recorded: ${(err as Error)?.name}`);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  // Appends a list of rows in order, each one as `trace` does; rows left when TRACE_BATCH_MS has passed are given up on.
  private async traceMany(edit: TraceEdit, entries: TraceEntry[]) {
    const until = Date.now() + TRACE_BATCH_MS;
    for (const entry of entries) {
      if (Date.now() >= until) {
        this._logger.warn('The trace rows of a step took too long and the rest were left out');
        return;
      }
      await this.trace(edit, entry);
    }
  }

  // An `error` row of a step: the class and code of what was thrown, and its message (kept in `full` only).
  private traceError(edit: TraceEdit, step: TraceStep, err: unknown, durationMs: number, requestId?: string) {
    const message = (err as Error)?.message;
    return this.trace(
      edit,
      {
        step,
        kind: 'error',
        durationMs,
        ok: false,
        payload: { ...failureCause(err, step, activityTrace().attempt), message: typeof message === 'string' ? message : '' },
      },
      requestId
    );
  }

  // Runs the body of an activity step: a `metric` row with its duration when it ends, an `error` row and the cause
  // kept in the edit's `log` when it throws; the error is rethrown as it came, so Temporal retries as before.
  private async instrument<T>(edit: StoredEdit, step: TraceStep, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      // an earlier attempt's cause is stale now: this step went through
      await this.clearCause(edit);
      await this.trace(edit, { step, kind: 'metric', durationMs: Date.now() - started, ok: true });
      return result;
    } catch (err) {
      await this.traceError(edit, step, err, Date.now() - started);
      await this.keepCause(edit, failureCause(err, step, activityTrace().attempt));
      throw err;
    }
  }

  // Keeps the cause of a failed step in the edit's `log` (codes only: no API reads `log`), for `failEdit` to write
  // beside the text the customer reads. Never throws. A later step that fails replaces it, and a step that succeeds
  // removes it (`clearCause`), so what is kept is only ever the cause of the failure `failEdit` is told about.
  private async keepCause(edit: StoredEdit, cause: FailureCause) {
    try {
      const current = await this._aiVideoEditsRepository.getEditById(edit.id);
      const { rest } = this.splitLog(current?.log);
      await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
        log: { ...rest, cause } as unknown as Prisma.InputJsonValue,
      });
    } catch (err) {
      this._logger.warn(`The cause of a failure could not be kept: ${(err as Error)?.name}`);
    }
  }

  // Removes the kept cause when a step succeeds: an earlier attempt's failure was retried through, so `failEdit` must not
  // report it for a later failure no step caught (a timeout). Only looks at the database when the job, as the step read
  // it, carried a cause. Never throws.
  private async clearCause(edit: StoredEdit) {
    if (!this.splitLog(edit.log).cause) {
      return;
    }
    try {
      const current = await this._aiVideoEditsRepository.getEditById(edit.id);
      const { cause, rest } = this.splitLog(current?.log);
      if (cause) {
        await this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
          log: rest as unknown as Prisma.InputJsonValue,
        });
      }
    } catch (err) {
      this._logger.warn(`A stale failure cause could not be cleared: ${(err as Error)?.name}`);
    }
  }

  // Records the LLM calls a step made: one `usage/metric` row each (the step, what it did, the model, the tokens or the
  // audio seconds, whether they are estimated, the latency, the attempt, whether it succeeded) and the calls added to the
  // ledger in `log.usage` (kept in the job as it is read, too, so a later write of `log` in the same step keeps it).
  // Nothing is written when there was no call. Never throws and waits no longer than the trace rows do, so the ledger is
  // never worth a failed or a delayed step.
  private async ledger(edit: StoredEdit, step: UsageStep, calls: LlmUsage[]) {
    if (!calls.length) {
      return;
    }
    try {
      const attempt = activityTrace().attempt;
      const payloads = calls.map((call) => usagePayload(step, call, attempt));
      const log = { ...this.logObject(edit.log), usage: addUsage(usageOfLog(edit.log), payloads) };
      edit.log = log as unknown as Prisma.JsonValue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const write = Promise.resolve(
          this._aiVideoEditsRepository.updateEdit(edit.organizationId, edit.id, {
            log: log as unknown as Prisma.InputJsonValue,
          })
        );
        write.catch(() => undefined);
        await Promise.race([
          write,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, TRACE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      await this.traceMany(
        edit,
        calls.map(
          (call, index): TraceEntry => ({
            step: 'usage',
            kind: 'metric',
            durationMs: call.latency_ms,
            ok: call.ok,
            payload: payloads[index],
          })
        )
      );
    } catch (err) {
      this._logger.warn(`The LLM usage of a step could not be recorded: ${(err as Error)?.name}`);
    }
  }

  // When a job ends: one `usage/output` row with the ledger (calls, tokens, totals by step and by model) and one structured
  // application-log line with the ids and the same totals (no text, no word). `log` is the log the job ends with (the job's
  // own when not given). Nothing when the job made no LLM call. Never throws.
  private async traceUsage(edit: StoredEdit, log?: unknown) {
    try {
      const ledger = usageOfLog(log ?? edit.log);
      if (!ledger) {
        return;
      }
      await this.trace(edit, { step: 'usage', kind: 'output', ok: true, payload: { ...ledger } });
      this._logger.log(`ai_edit_usage ${JSON.stringify({ ...correlation(edit), ...ledger })}`);
    } catch (err) {
      this._logger.warn(`The LLM usage of a job could not be summed up: ${(err as Error)?.name}`);
    }
  }

  // An edit's `log` as an object (empty when it holds none).
  private logObject(log: Prisma.JsonValue | null | undefined) {
    return (log && typeof log === 'object' && !Array.isArray(log) ? log : {}) as Record<string, unknown>;
  }

  // The kept cause of a failed step and the rest of an edit's `log`.
  private splitLog(log: Prisma.JsonValue | null | undefined) {
    const { cause, ...rest } = (log && typeof log === 'object' && !Array.isArray(log) ? log : {}) as Record<string, unknown>;
    return { cause: cause as FailureCause | undefined, rest };
  }
}
