// Content plan video set: the session kind that turns the owner's raw idea into one video or a few, each dated inside the
// running plan. The rounds ask only when the idea is unclear; the proposal writes the videos (their dates are set here,
// from the chosen date, one per day up to the end of the plan); the confirmation adds each video to the plan as an
// instant idea linked to the session, after the owner's date edits. It registers itself with the kinds the generic
// session service runs.
import { Injectable } from '@nestjs/common';
import { ContentPlan, Prisma } from '@prisma/client';
import { ChatTurn } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import { ContentPlanGenerator, PlanAiFailed } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import { ContentPlanRepository } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.repository';
import {
  ContentPlanService,
  InvalidPlanException,
  PlanConflictException,
  PlanNotFoundException,
  PlanOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { ContentPlanSessionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.repository';
import {
  PlanSessionForWrite,
  PlanSessionKind,
  PlanSessionKinds,
  SessionProposalDraft,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.kind';
import { addDays } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import { PlannerPromptKey, VIDEO_SET_ROUND_FIELD_HINTS } from '@gitroom/nestjs-libraries/database/prisma/content-plan/prompts';
import {
  PlanAnswer,
  PlanVideoSetOptions,
  PlanVideoSetVideo,
  PlanVideoSetView,
  VideoSetEditsSchema,
  VideoSetOptionsSchema,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The stored proposal of a video set.
interface StoredVideoSet {
  videos: PlanVideoSetVideo[];
}

// The session kind `video_set`.
@Injectable()
export class VideoSetSessionKind implements PlanSessionKind {
  readonly kind = 'video_set';
  readonly roundFrame: PlannerPromptKey = 'planner.frame.video_set_round';
  readonly roundHints = VIDEO_SET_ROUND_FIELD_HINTS;
  // The videos are the owner's own idea written out, so they are charged as an instant idea is.
  readonly proposalAction = 'plan.instant';

  // Receives the kinds to register with, the plan service (the plan, dates and brand context), the storage of the plan
  // and of the sessions, and the writer of the AI calls.
  constructor(
    kinds: PlanSessionKinds,
    private _contentPlanService: ContentPlanService,
    private _contentPlanRepository: ContentPlanRepository,
    private _sessionRepository: ContentPlanSessionRepository,
    private _contentPlanGenerator: ContentPlanGenerator
  ) {
    kinds.register(this);
  }

  // The running plan of the workspace; 404 PLAN_NOT_FOUND without a plan and 409 PLAN_NOT_ACTIVE with one that is not
  // confirmed, as the instant ideas answer. No plan row is made.
  planOf(org: PlanOrganization) {
    return this._contentPlanService.activePlan(org);
  }

  // The date of the first video (today by default, and from today to the end of the plan) and the number of videos
  // (1 by default, at most 7). `countSet` remembers that the owner chose the number.
  async parseOptions(
    options: unknown,
    org: PlanOrganization,
    plan: ContentPlan
  ): Promise<Prisma.InputJsonObject> {
    const body = this._contentPlanService.parse(VideoSetOptionsSchema, options);
    const today = this._contentPlanService.today(org);
    const date = body.date ?? today;
    await this.assertDate(plan.id, today, date, 'date');
    const stored: PlanVideoSetOptions = {
      date,
      count: body.count ?? 1,
      countSet: body.count !== undefined,
    };
    return { ...stored };
  }

  // Tells the rounds how many videos the owner asked for, so the AI never asks about it.
  openingOf(options: Prisma.InputJsonObject) {
    const stored = options as unknown as PlanVideoSetOptions;
    return stored.countSet ? { videoCount: stored.count } : {};
  }

  // Writes the videos from what was understood and the answers of the last round (a revise from the owner's feedback),
  // and sets their dates: the first on the chosen date (today when that has passed), one more per day, none after the end
  // of the plan.
  async buildProposal(
    session: PlanSessionForWrite,
    turns: ChatTurn[],
    feedback: string | null
  ): Promise<SessionProposalDraft> {
    const plan = await this._contentPlanRepository.findWithOrganization(session.planId);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    if (!session.summary) {
      throw new PlanAiFailed('The session has no summary');
    }
    const options = session.options as unknown as PlanVideoSetOptions;
    const latest = feedback ? null : await this._sessionRepository.latestRound(session.id);
    const answers =
      latest?.answers
        ? this._contentPlanService.resolveAnswers(latest.questions, latest.answers as unknown as PlanAnswer[])
        : [];
    const written = await this._contentPlanGenerator.writeVideoSet({
      ...this._contentPlanService.writeContext(plan),
      idea: session.summary,
      answers,
      count: options.count,
      countFixed: options.countSet,
      turns,
      feedback,
    });
    const today = this._contentPlanService.today(session.organization);
    const first = options.date < today ? today : options.date;
    const end = await this._contentPlanService.planEnd(session.planId, today);
    const videos: PlanVideoSetVideo[] = written.videos.map((video, index) => {
      const date = addDays(first, index);
      return { ...video, date: date > end ? end : date };
    });
    return {
      proposal: { videos } as unknown as Prisma.InputJsonObject,
      userTurn: written.userTurn,
      assistantTurn: written.assistantTurn,
    };
  }

  // Adds each video to the plan on its date (the owner's edits change dates by ref), linked to the session. 400
  // INVALID_PLAN for an edit of an unknown or repeated video and for a date outside today to the end of the plan; 409
  // PLAN_NOT_ACTIVE when the plan was reset since the session started.
  async confirm(session: PlanSessionForWrite, edits: unknown): Promise<void> {
    const body = this._contentPlanService.parse(VideoSetEditsSchema, edits);
    const stored = session.proposal as unknown as StoredVideoSet;
    const plan = await this._contentPlanRepository.findByOrganization(session.organizationId);
    if (!plan || plan.id !== session.planId || plan.status !== 'ACTIVE') {
      throw new PlanConflictException('PLAN_NOT_ACTIVE');
    }
    const fields: { path: string; message: string }[] = [];
    const dates = new Map<string, string>();
    (body.dates ?? []).forEach((edit, index) => {
      if (!stored.videos.some((video) => video.ref === edit.ref) || dates.has(edit.ref)) {
        fields.push({ path: `dates.${index}.ref`, message: 'is not a video of this proposal, or is repeated' });
      }
      dates.set(edit.ref, edit.date);
    });
    if (fields.length) {
      throw new InvalidPlanException(fields);
    }
    const videos = stored.videos.map((video) => ({ ...video, date: dates.get(video.ref) ?? video.date }));
    const today = this._contentPlanService.today(session.organization);
    const end = await this._contentPlanService.planEnd(plan.id, today);
    videos.forEach((video, index) => {
      if (video.date < today || video.date > end) {
        fields.push({ path: `videos.${index}.date`, message: 'must be from today to the end of the plan' });
      }
    });
    if (fields.length) {
      throw new InvalidPlanException(fields);
    }
    await this._contentPlanRepository.createSessionVideos(
      plan.id,
      session.organizationId,
      session.id,
      session.sourceText ?? '',
      videos.map((video) => ({
        date: video.date,
        title: video.title,
        why: video.why,
        beats: video.beats as unknown as Prisma.InputJsonValue,
        closingLine: video.closingLine,
      }))
    );
  }

  // The videos with their dates, each ready for a phone-shaped preview.
  viewOf(proposal: Prisma.JsonValue): PlanVideoSetView {
    return { videos: (proposal as unknown as StoredVideoSet).videos };
  }

  // 400 INVALID_PLAN unless the date is from today to the end of the plan.
  private async assertDate(planId: string, today: string, date: string, path: string) {
    if (date < today || date > (await this._contentPlanService.planEnd(planId, today))) {
      throw new InvalidPlanException([{ path, message: 'must be from today to the end of the plan' }]);
    }
  }
}
