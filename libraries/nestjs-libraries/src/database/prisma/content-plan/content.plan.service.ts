// Content plan: a brand's setup and proposal. The owner explains the business, answers the AI's rounds of questions,
// reads the proposed plan (facts, themes, 12 weeks, an outline for the first 4) and confirms it, which makes the plan
// ACTIVE. The rounds are an append-only chat so Meta's prompt cache can match their start; the proposal is written by a
// job (a workflow) because it takes several AI calls. Every AI call goes through `CreditsService.spend` on a price-0
// action. The weekly engine (the hourly tick, the week and day writers, the roadmap) is here too, and the change
// routes build on it.
import { HttpException, Injectable, Logger } from '@nestjs/common';
import {
  ContentPlan,
  Organization,
  PlanDay,
  PlanInstantIdea,
  PlanWeek,
  Prisma,
  Role,
} from '@prisma/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { TypedSearchAttributes } from '@temporalio/common';
import { randomUUID } from 'crypto';
import { TemporalService } from 'nestjs-temporal-core';
import { z } from 'zod';
import { ChatTurn } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import {
  canEditRole,
  displayName,
} from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import {
  ContentPlanGenerator,
  PlanAiFailed,
  PlanChatInput,
  PlanChatRound,
  PlanNotConfigured,
  PlanVideoContext,
  PlanWriteContext,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import {
  ContentPlanRepository,
  PlanWithOrganization,
  WeekForWrite,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.repository';
import {
  addDays,
  brandContextMessage,
  carryPositions,
  daysBetween,
  localToday,
  mergeCarry,
  nextClusterId,
  pickAngles,
  rotationOrder,
  slotsForWeek,
  stableJson,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import {
  BRAND_DEFAULT_LOCALE,
  BRAND_DEFAULT_TIMEZONE,
  BrandProfile,
} from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';
import {
  Angle,
  ANGLES,
  AnswerSetupSchema,
  BriefSchema,
  CARRY_MAX,
  ConfirmSchema,
  DEFAULT_VIDEOS_PER_WEEK,
  DirectionSchema,
  FactsSchema,
  IdeaSchema,
  InstantIdeaSchema,
  LIMITS,
  PhoneDayView,
  PhoneWeekView,
  PlanAnswer,
  PlanBeat,
  PlanCarryItem,
  PlanDayView,
  PlanFacts,
  PlanInstantIdeaView,
  PlanOutlineItem,
  PlanProposal,
  PlanQuestion,
  PlanUpcomingView,
  PlanView,
  PlanWeekView,
  PREVIEW_WEEKS,
  ProposeSchema,
  ReviseSchema,
  ROADMAP_WEEKS,
  StartSetupSchema,
  UrgentSchema,
  VideosPerWeekSchema,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';
import { organizationId as organizationKey } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';

// The workspace the caller is in, with the caller's membership as the request middleware loads it.
export type PlanOrganization = Organization & { users?: { role: Role }[] };

// What a plan job is asked to do: `id` is the plan (proposal, revise, replan), the week (week, days), the day (day), the
// instant idea (instant) or the session (session_proposal, session_revise).
// `feedback` is the owner's words of a revise; `fromDate` is the first date `days` writes again.
export interface PlanJob {
  kind:
    | 'proposal'
    | 'revise'
    | 'week'
    | 'days'
    | 'day'
    | 'replan'
    | 'instant'
    | 'session_proposal'
    | 'session_revise';
  id: string;
  feedback?: string;
  fromDate?: string;
}

// A body failed validation: { statusCode, code, message, fields }.
export class InvalidPlanException extends HttpException {
  // Answers 400 INVALID_PLAN with each failing path and why.
  constructor(fields: { path: string; message: string }[]) {
    super(
      {
        statusCode: 400,
        code: 'INVALID_PLAN',
        message: 'The content plan request is invalid',
        fields,
      },
      400
    );
  }
}

// The workspace has no plan (or no such row in it).
export class PlanNotFoundException extends HttpException {
  // Answers 404 with the code of the thing that was not found.
  constructor(code = 'PLAN_NOT_FOUND') {
    super({ statusCode: 404, code }, 404);
  }
}

// The plan is not in the state the call needs: PLAN_EXISTS, PLAN_BUSY, ROUND_STALE, PROPOSAL_STALE, ...
export class PlanConflictException extends HttpException {
  // Answers 409 with the code of the conflict.
  constructor(code: string) {
    super({ statusCode: 409, code }, 409);
  }
}

// The planner is not usable on this deployment (no key, no client, or Meta refused the key or the billing).
export class PlanUnavailableException extends HttpException {
  // Answers 503 PLAN_NOT_AVAILABLE.
  constructor() {
    super({ statusCode: 503, code: 'PLAN_NOT_AVAILABLE' }, 503);
  }
}

// One AI call failed or answered something unusable.
export class PlanAiFailedException extends HttpException {
  // Answers 502 PLAN_AI_FAILED.
  constructor() {
    super({ statusCode: 502, code: 'PLAN_AI_FAILED' }, 502);
  }
}

// The brand columns the AI calls are made from.
export interface PlanBrand {
  name: string;
  locale: string | null;
  timezone: string | null;
}

// The stored turns of a chat as the generator re-sends them; [] when nothing valid is stored.
export const storedTurns = (value: Prisma.JsonValue | null): ChatTurn[] =>
  Array.isArray(value) ? (value as unknown as ChatTurn[]) : [];

// A week with its days.
type WeekWithDays = PlanWeek & { days: PlanDay[] };

// The leftovers a week carries in; [] when it has none.
const storedCarry = (value: Prisma.JsonValue | null): PlanCarryItem[] =>
  Array.isArray(value) ? (value as unknown as PlanCarryItem[]) : [];

// The outline confirmed in the preview; null when the week has none.
const storedOutline = (value: Prisma.JsonValue | null): PlanOutlineItem[] | null =>
  Array.isArray(value) ? (value as unknown as PlanOutlineItem[]) : null;

// How many plans the hourly tick reads at a time, and how many it works on at once (Meta allows 150 calls a minute).
const TICK_PAGE = 50;
const TICK_PARALLEL = 4;
// A week that failed this many times is left alone until the owner asks again.
const WEEK_ATTEMPTS_MAX = 3;
// A week that has been GENERATING this long lost its job.
const GENERATING_STALE_MS = 60 * 60 * 1000;
// An instant idea that was never added to the plan is removed after this long.
const DRAFT_STALE_MS = 24 * 60 * 60 * 1000;
// Weeks of ideas one call writes.
const IDEAS_PER_CALL = ROADMAP_WEEKS;
// Earlier ideas of a cluster given to the model so a new one does not repeat them.
const PREVIOUS_IDEAS = 3;

// The setup, the proposal and the weekly engine of a brand's content plan.
@Injectable()
export class ContentPlanService {
  private readonly _logger = new Logger(ContentPlanService.name);

  // Receives the storage, the writer of the AI calls, the credit engine and the workflow engine.
  constructor(
    private _contentPlanRepository: ContentPlanRepository,
    private _contentPlanGenerator: ContentPlanGenerator,
    private _creditsService: CreditsService,
    private _temporalService: TemporalService
  ) {}

  // The plan the page draws: its status (NONE when the workspace has none), the current round or proposal and what the
  // caller may do.
  async view(org: PlanOrganization): Promise<PlanView> {
    return this.viewOf(
      org,
      await this._contentPlanRepository.findByOrganization(org.id)
    );
  }

  // Starts a setup from the owner's first text and answers the first round. A plan that is already ACTIVE is refused:
  // starting over goes through `reset`.
  async startSetup(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this.parse(StartSetupSchema, input);
    if ((await this._contentPlanRepository.findByOrganization(org.id))?.status === 'ACTIVE') {
      throw new PlanConflictException('PLAN_EXISTS');
    }
    const plan = await this._contentPlanRepository.ensure(org.id);
    await this.claim(plan.id, 'round');
    try {
      await this._contentPlanRepository.resetSetup(plan.id, {
        sourceText: body.sourceText,
      });
      await this.writeRound(org, plan.id, 0, [], stableJson({ sourceText: body.sourceText }));
    } catch (err) {
      throw this.aiError(err);
    } finally {
      await this._contentPlanRepository.release(plan.id);
    }
    return this.view(org);
  }

  // Saves the answers and the owner's edit of the direction, then writes the next round from the whole chat so far.
  // The round may be an earlier one (the owner went back and changed it): the rounds after it, and a proposal written
  // from them, are dropped first, because they were written from the old answers.
  async answer(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this.parse(AnswerSetupSchema, input);
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    const all = await this._contentPlanRepository.rounds(plan.id);
    const position = all.findIndex((round) => round.id === body.roundId);
    if (!['SETUP', 'PROPOSED'].includes(plan.status) || position < 0) {
      throw new PlanConflictException('ROUND_STALE');
    }
    const rounds = all.slice(0, position + 1);
    const latest = rounds[position];
    const answers = this.resolveAnswers(latest.questions, body.answers);
    await this.claim(plan.id, 'round');
    try {
      // read again now the plan is held: a plan confirmed since the first read is not taken back
      const held = await this._contentPlanRepository.findByOrganization(org.id);
      if (!held || !['SETUP', 'PROPOSED'].includes(held.status)) {
        throw new PlanConflictException('ROUND_STALE');
      }
      // Going back to an earlier round (or to the last one after the proposal) changes what the later rounds and the
      // proposal were written from, so they are dropped, but only once the AI has written the new round: a failed
      // call leaves the plan as it was.
      const rewinding = held.status === 'PROPOSED' || position < all.length - 1;
      const save = async () => {
        if (rewinding) {
          await this._contentPlanRepository.rewindTo(plan.id, latest.index);
        }
        await this._contentPlanRepository.saveAnswers(plan.id, latest.id, body.answers);
        // the owner's edit wins, and is saved before the AI is asked again
        await this._contentPlanRepository.update(plan.id, { direction: body.direction });
      };
      if (!rewinding) {
        await save();
      }
      const turns = rounds.flatMap((round): ChatTurn[] => [
        { role: 'user', content: round.userTurn },
        { role: 'assistant', content: round.assistantTurn },
      ]);
      const editedDirection =
        body.direction.trim() === latest.direction.trim() ? null : body.direction;
      await this.writeRound(
        org,
        plan.id,
        latest.index + 1,
        turns,
        stableJson({ answers, editedDirection }),
        rewinding ? save : undefined
      );
    } catch (err) {
      throw this.aiError(err);
    } finally {
      await this._contentPlanRepository.release(plan.id);
    }
    return this.view(org);
  }

  // Stores the direction, the videos per week and the answers of the last round, and starts the job that writes the
  // proposal. The page polls until the plan is PROPOSED.
  async propose(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this.parse(ProposeSchema, input);
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    if (plan.status === 'ACTIVE') {
      throw new PlanConflictException('PLAN_EXISTS');
    }
    const latest = await this._contentPlanRepository.latestRound(plan.id);
    if (body.answers && !latest) {
      throw new PlanConflictException('ROUND_STALE');
    }
    if (body.answers && latest) {
      this.resolveAnswers(latest.questions, body.answers);
    }
    await this.claim(plan.id, 'proposal');
    try {
      if (body.answers && latest) {
        await this._contentPlanRepository.saveAnswers(plan.id, latest.id, body.answers);
      }
      await this._contentPlanRepository.update(plan.id, {
        direction: body.direction,
        videosPerWeek: body.videosPerWeek,
        notice: null,
      });
    } catch (err) {
      await this._contentPlanRepository.release(plan.id);
      throw err;
    }
    await this.startJob({ kind: 'proposal', id: plan.id }, org.id, plan.id);
    return this.view(org);
  }

  // Asks for a new proposal after the owner's feedback, as the next turn of the proposal chat. 409 when the owner
  // answers a proposal that is no longer the latest.
  async revise(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this.parse(ReviseSchema, input);
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    if (plan.status !== 'PROPOSED' || plan.proposalVersion !== body.proposalVersion) {
      throw new PlanConflictException('PROPOSAL_STALE');
    }
    await this.claim(plan.id, 'proposal');
    try {
      await this._contentPlanRepository.update(plan.id, { notice: null });
    } catch (err) {
      await this._contentPlanRepository.release(plan.id);
      throw err;
    }
    await this.startJob(
      { kind: 'revise', id: plan.id, feedback: body.feedback },
      org.id,
      plan.id
    );
    return this.view(org);
  }

  // Makes the proposal the plan: themes, clusters in rotation order and the 12 weeks, the first of them starting
  // today (or the day after the week still running). The first week is written right away by a job; when that cannot
  // be started the hourly tick writes it.
  async confirm(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this.parse(ConfirmSchema, input);
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    const proposal = plan.proposal as unknown as PlanProposal | null;
    if (
      plan.status !== 'PROPOSED' ||
      !proposal ||
      plan.proposalVersion !== body.proposalVersion
    ) {
      throw new PlanConflictException('PROPOSAL_STALE');
    }
    if (plan.busy) {
      throw new PlanConflictException('PLAN_BUSY');
    }
    const today = this.today(org);
    const firstStart = await this.firstWeekStart(plan.id, today);
    const themeIds = new Map(proposal.themes.map((theme) => [theme.ref, randomUUID()]));
    const clusterIds = new Map(
      proposal.clusters.map((cluster) => [cluster.ref, randomUUID()])
    );
    const rotation = this.rotationOf(proposal);
    const weeks = proposal.weeks.map((week, index) => {
      const clusterId = clusterIds.get(week.clusterRef);
      if (!clusterId) {
        throw new Error(`The proposal week ${index} has an unknown cluster`);
      }
      return {
        id: randomUUID(),
        clusterId,
        weekStart: addDays(firstStart, index * 7),
        idea: week.idea,
        outline: week.outline,
      };
    });
    await this._contentPlanRepository.activate({
      planId: plan.id,
      // a week of the old plan that was never written and has started or is still to come
      removeIdleFrom: addDays(today, -6),
      themes: proposal.themes.map((theme, index) => ({
        id: themeIds.get(theme.ref) as string,
        name: theme.name,
        description: theme.description,
        position: index,
      })),
      clusters: proposal.clusters.map((cluster) => ({
        id: clusterIds.get(cluster.ref) as string,
        themeId: themeIds.get(cluster.themeRef) as string,
        title: cluster.title,
        problem: cluster.problem,
        rotationIndex: rotation.indexOf(cluster.ref),
      })),
      weeks,
      facts: proposal.facts as unknown as Prisma.InputJsonValue,
    });
    if (weeks[0] && weeks[0].weekStart === today) {
      try {
        await this.startJob({ kind: 'week', id: weeks[0].id }, org.id, null);
      } catch (err) {
        // the plan is already confirmed; the hourly tick writes the week
        this._logger.warn(
          `content plan: first week job not started plan=${plan.id} error=${
            (err as Error)?.name ?? 'unknown'
          }`
        );
      }
    }
    return this.view(org);
  }

  // Back to a fresh setup. The weeks are kept, so the phone keeps the current one until a new plan is confirmed.
  async reset(org: PlanOrganization): Promise<PlanView> {
    const plan = await this._contentPlanRepository.ensure(org.id);
    await this._contentPlanRepository.resetSetup(plan.id, { busy: null });
    return this.view(org);
  }

  // Saves the facts about the business the owner edited: into the plan, or into the proposal being read.
  async saveFacts(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const { facts } = this.parse(FactsSchema, input);
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    if (plan.busy) {
      throw new PlanConflictException('PLAN_BUSY');
    }
    const proposal = plan.proposal as unknown as PlanProposal | null;
    if (plan.status === 'ACTIVE') {
      await this._contentPlanRepository.update(plan.id, {
        facts: facts as unknown as Prisma.InputJsonValue,
      });
    } else if (plan.status === 'PROPOSED' && proposal) {
      await this._contentPlanRepository.update(plan.id, {
        proposal: { ...proposal, facts } as unknown as Prisma.InputJsonValue,
      });
    } else {
      throw new PlanConflictException('PLAN_NOT_ACTIVE');
    }
    return this.view(org);
  }

  // Saves the owner's new Content Direction and starts the job that writes the ideas of the coming weeks again. The page
  // polls until the plan is no longer busy.
  async direction(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this.parse(DirectionSchema, input);
    const plan = await this.activePlan(org);
    await this.claim(plan.id, 'replan');
    try {
      await this._contentPlanRepository.update(plan.id, {
        direction: body.direction,
        directionVersion: { increment: 1 },
        notice: null,
      });
    } catch (err) {
      await this._contentPlanRepository.release(plan.id);
      throw err;
    }
    await this.startJob({ kind: 'replan', id: plan.id }, org.id, plan.id);
    return this.view(org);
  }

  // The week that contains today, with its videos; null when the plan has none (no plan, or one that sat idle).
  async currentWeek(org: PlanOrganization): Promise<PlanWeekView | null> {
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      return null;
    }
    const today = this.today(org);
    const week = await this._contentPlanRepository.currentWeekWithDays(
      plan.id,
      addDays(today, -6),
      today
    );
    if (!week) {
      return null;
    }
    const instant = await this._contentPlanRepository.instantIdeasBetween(
      org.id,
      week.weekStart,
      addDays(week.weekStart, 6)
    );
    const view = this.weekView(week);
    return {
      ...view,
      days: this.withInstantIdeas(view.days, instant, (idea) =>
        this.instantDayView(idea, today)
      ),
    };
  }

  // The weeks after the current one, each with its idea (the owner may edit it until the week starts).
  async upcoming(org: PlanOrganization): Promise<PlanUpcomingView[]> {
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      return [];
    }
    const today = this.today(org);
    const current = await this.currentWeekOf(plan.id, today);
    const weeks = await this._contentPlanRepository.upcomingWeeks(
      plan.id,
      current ? addDays(current.weekStart, 7) : addDays(today, 1),
      ROADMAP_WEEKS
    );
    return weeks.map((week) => this.upcomingView(week));
  }

  // Saves the owner's brief of the current week. The planned videos from today on are written again from it (a week
  // that is not written yet is written, which is also how a failed week is tried again).
  async brief(org: PlanOrganization, weekId: string, input: unknown): Promise<PlanWeekView> {
    const body = this.parse(BriefSchema, input);
    const today = this.today(org);
    const week = await this.currentWeekOfOrganization(org, weekId, today);
    await this._contentPlanRepository.saveBrief(week.id, body.brief);
    return this.writeAgain(org, week, today);
  }

  // Saves the owner's idea of a week that is still to come and not written. Its outline is cleared, as it was written for
  // the old idea.
  async idea(org: PlanOrganization, weekId: string, input: unknown): Promise<PlanUpcomingView> {
    const body = this.parse(IdeaSchema, input);
    const week = await this._contentPlanRepository.weekOfOrganization(org.id, weekId);
    if (!week) {
      throw new PlanNotFoundException('WEEK_NOT_FOUND');
    }
    if (week.status !== 'IDEA' || week.weekStart <= this.today(org)) {
      throw new PlanConflictException('WEEK_LOCKED');
    }
    return this.upcomingView(await this._contentPlanRepository.saveIdea(week.id, body.idea));
  }

  // Something happened in the owner's industry: the current week now focuses on it. The planned videos from today on are
  // written again with the note (the `trend` angle is allowed), and up to 3 of the stories they replace go on to the next
  // week that is not written.
  async urgent(org: PlanOrganization, weekId: string, input: unknown): Promise<PlanWeekView> {
    const body = this.parse(UrgentSchema, input);
    const today = this.today(org);
    const week = await this.currentWeekOfOrganization(org, weekId, today);
    const displaced = week.days
      .filter((day) => day.status === 'PLANNED' && day.date >= today)
      .slice(0, CARRY_MAX)
      .map((day) => ({
        title: day.title,
        angle: day.angle as Angle,
        clusterId: week.clusterId,
      }));
    const target = displaced.length
      ? await this._contentPlanRepository.firstIdeaWeekFrom(week.planId, addDays(week.weekStart, 7))
      : null;
    await this._contentPlanRepository.saveUrgent(
      week.id,
      body.note,
      target
        ? {
            weekId: target.id,
            items: mergeCarry(storedCarry(target.carryIn), displaced).kept,
          }
        : null
    );
    return this.writeAgain(org, week, today);
  }

  // Writes one planned video again on another angle. 409 DAY_LOCKED for a video that is recorded or whose date has passed.
  async regenerate(org: PlanOrganization, dayId: string): Promise<PlanDayView> {
    const day = await this.dayOfOrganization(org, dayId);
    if (day.status !== 'PLANNED' || day.date < this.today(org)) {
      throw new PlanConflictException('DAY_LOCKED');
    }
    if (day.busy) {
      throw new PlanConflictException('PLAN_BUSY');
    }
    await this._contentPlanRepository.holdDays([day.id]);
    await this.startDaysJob({ kind: 'day', id: day.id }, org.id, [day.id]);
    return this.dayView(await this.dayOfOrganization(org, dayId));
  }

  // Marks a video as recorded (an AI day, or else an instant idea); one that is recorded already is answered as it is.
  async recorded(org: PlanOrganization, dayId: string): Promise<PlanDayView> {
    const day = await this._contentPlanRepository.dayOfOrganization(org.id, dayId);
    if (!day) {
      return this.instantRecorded(org, dayId);
    }
    if (day.status !== 'RECORDED') {
      await this._contentPlanRepository.markRecorded(org.id, day.id, new Date());
    }
    return this.dayView(await this.dayOfOrganization(org, dayId));
  }

  // Saves how many videos a week gets from now on. The weeks that are written keep their videos; no AI call.
  async videosPerWeek(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this.parse(VideosPerWeekSchema, input);
    const plan = await this.activePlan(org);
    await this._contentPlanRepository.saveVideosPerWeek(plan.id, body.videosPerWeek);
    return this.view(org);
  }

  // Starts refining the owner's own idea into a video for a date from today to the end of the plan. The old open draft is
  // replaced. The page polls the plan until it is no longer busy, then shows the script (`instantDraft`).
  async startInstantIdea(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this.parse(InstantIdeaSchema, input);
    const plan = await this.activePlan(org);
    const today = this.today(org);
    const last = await this._contentPlanRepository.lastWeek(plan.id);
    if (body.date < today || body.date > (last ? addDays(last.weekStart, 6) : today)) {
      throw new InvalidPlanException([
        { path: 'date', message: 'must be from today to the end of the plan' },
      ]);
    }
    await this.claim(plan.id, 'instant');
    let draft: PlanInstantIdea;
    try {
      draft = await this._contentPlanRepository.createDraft(
        plan.id,
        org.id,
        body.idea,
        body.date
      );
      await this._contentPlanRepository.update(plan.id, { notice: null });
    } catch (err) {
      await this._contentPlanRepository.release(plan.id);
      throw err;
    }
    await this.startJob({ kind: 'instant', id: draft.id }, org.id, plan.id);
    return this.view(org);
  }

  // Adds a refined instant idea to the plan on its date. 409 DRAFT_NOT_READY while it is still being refined; one that was
  // added already is answered as it is.
  async confirmInstantIdea(org: PlanOrganization, id: string): Promise<PlanInstantIdeaView> {
    const plan = await this.activePlan(org);
    const idea = await this._contentPlanRepository.getInstantIdea(org.id, id);
    if (!idea) {
      throw new PlanNotFoundException('DAY_NOT_FOUND');
    }
    if (idea.status === 'DRAFT') {
      if (!idea.title || plan.busy === 'instant') {
        throw new PlanConflictException('DRAFT_NOT_READY');
      }
      await this._contentPlanRepository.confirm(org.id, id);
    }
    return this.instantView(
      (await this._contentPlanRepository.getInstantIdea(org.id, id)) as PlanInstantIdea,
      this.today(org)
    );
  }

  // The week the phone shows: the one that contains today, and its videos once the week is written.
  async phoneWeek(org: PlanOrganization): Promise<PhoneWeekView> {
    const today = this.today(org);
    const timezone = org.timezone ?? BRAND_DEFAULT_TIMEZONE;
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      return { status: 'NONE', today, timezone, week: null };
    }
    const week = await this._contentPlanRepository.currentWeekWithDays(
      plan.id,
      addDays(today, -6),
      today
    );
    const instant =
      week?.status === 'READY'
        ? await this._contentPlanRepository.instantIdeasBetween(
            org.id,
            week.weekStart,
            addDays(week.weekStart, 6)
          )
        : [];
    return {
      status: plan.status as PhoneWeekView['status'],
      today,
      timezone,
      week: week && {
        id: week.id,
        weekStart: week.weekStart,
        weekEnd: addDays(week.weekStart, 6),
        idea: week.idea,
        status: week.status as PlanWeekView['status'],
        days:
          week.status === 'READY'
            ? this.withInstantIdeas(
                week.days.map(
                  (day): PhoneDayView => ({
                    id: day.id,
                    kind: 'PLANNED',
                    date: day.date,
                    dayIndex: day.dayIndex,
                    title: day.title,
                    angle: day.angle,
                    why: day.why,
                    beats: this.beatsOf(day),
                    closingLine: day.closingLine,
                    status: day.status as PlanDayView['status'],
                    version: day.version,
                  })
                ),
                instant,
                (idea): PhoneDayView => {
                  const day = this.instantDayView(idea, today);
                  return {
                    id: day.id,
                    kind: 'INSTANT_IDEA',
                    date: day.date,
                    dayIndex: null,
                    title: day.title,
                    angle: null,
                    why: day.why,
                    beats: day.beats,
                    closingLine: day.closingLine,
                    status: day.status,
                    version: 0,
                  };
                }
              )
            : [],
      },
    };
  }

  // The proposal job (called by the activity): the structure of the plan from the proposal chat, the ideas of the 12
  // weeks, and an outline for each of the first weeks. `feedback` is the owner's words of a revise, sent as the next
  // turn of the stored chat; without it the chat starts from the direction. A failure is thrown, and the job's failure
  // path calls `proposalFailed`.
  async buildProposal(planId: string, feedback: string | null) {
    const plan = await this._contentPlanRepository.findWithOrganization(planId);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    const { organization: org } = plan;
    const direction = plan.direction;
    if (!direction) {
      throw new PlanAiFailed('The plan has no direction');
    }
    const locale = org.locale ?? BRAND_DEFAULT_LOCALE;
    const name = displayName(org.name);
    const earlier = feedback ? storedTurns(plan.proposalTurns) : [];
    const newUserTurn = stableJson(feedback ? { feedback } : { direction });
    const structure = await this.charge(org.id, plan.id, 'plan.proposal', () =>
      this._contentPlanGenerator.proposeStructure({
        orgId: org.id,
        brandContext: this.setupContext(org),
        turns: earlier,
        newUserTurn,
      })
    );
    const rotation = this.rotationOf(structure);
    const today = this.today(org);
    const firstStart = await this.firstWeekStart(plan.id, today);
    const rows: { weekStart: string; clusterRef: string }[] = [];
    let previous: string | null = null;
    for (let index = 0; index < ROADMAP_WEEKS; index += 1) {
      previous = nextClusterId(rotation, previous);
      rows.push({ weekStart: addDays(firstStart, index * 7), clusterRef: previous });
    }
    const clusterOf = (ref: string) =>
      structure.clusters.find((cluster) => cluster.ref === ref) ??
      structure.clusters[0];
    const context = {
      orgId: org.id,
      name,
      locale,
      direction,
      facts: structure.facts,
    };
    const { ideas } = await this.charge(org.id, plan.id, 'plan.roadmap', () =>
      this._contentPlanGenerator.writeIdeas({
        ...context,
        weeks: rows.map((row) => ({
          weekStart: row.weekStart,
          weekEnd: addDays(row.weekStart, 6),
          clusterTitle: clusterOf(row.clusterRef).title,
          problem: clusterOf(row.clusterRef).problem,
          previousIdeas: [],
        })),
      })
    );
    const outlines: (PlanOutlineItem[] | null)[] = rows.map(() => null);
    // one after another, so the calls of one brand share the cached start of the request
    for (let index = 0; index < Math.min(PREVIEW_WEEKS, rows.length); index += 1) {
      const cluster = clusterOf(rows[index].clusterRef);
      const angles = pickAngles(plan.videosPerWeek, new Map(), [], false, index);
      const { titles } = await this.charge(org.id, plan.id, 'plan.proposal', () =>
        this._contentPlanGenerator.writeOutline({
          ...context,
          idea: ideas[index],
          clusterTitle: cluster.title,
          problem: cluster.problem,
          angles,
          videosPerWeek: plan.videosPerWeek,
        })
      );
      outlines[index] = titles.map((title, position) => ({
        title,
        angle: angles[position],
      }));
    }
    const version = plan.proposalVersion + 1;
    const saved = await this._contentPlanRepository.saveProposal(plan.id, {
      proposal: {
        version,
        facts: structure.facts,
        themes: structure.themes,
        clusters: structure.clusters,
        weeks: rows.map((row, index) => ({
          weekStart: row.weekStart,
          clusterRef: row.clusterRef,
          idea: ideas[index],
          outline: outlines[index],
        })),
      },
      proposalVersion: version,
      proposalTurns: [
        ...earlier,
        { role: 'user', content: newUserTurn },
        { role: 'assistant', content: structure.assistantTurn },
      ],
    });
    if (!saved) {
      // the plan was reset while the proposal was written: the answer is dropped
      this._logger.log(`content plan: proposal dropped plan=${plan.id}`);
    }
  }

  // The failure path of a proposal or revise job: the plan is free again and the owner is told it did not work.
  proposalFailed(planId: string) {
    return this._contentPlanRepository.release(planId, {
      notice: 'proposal_failed',
    });
  }

  // The instant idea job (called by the activity): the owner's idea refined into a script, saved on the draft, and the plan
  // is free again. A failure is thrown, and the job's failure path calls `instantFailed`.
  async refineInstantIdea(draftId: string) {
    const draft = await this._contentPlanRepository.instantForWrite(draftId);
    if (!draft) {
      throw new PlanNotFoundException('DAY_NOT_FOUND');
    }
    const { plan } = draft;
    // a job that ran again after it saved its answer only frees the plan
    if (!draft.title) {
      const { day } = await this.charge(plan.organizationId, plan.id, 'plan.instant', () =>
        this._contentPlanGenerator.writeInstantIdea({
          ...this.writeContext(plan),
          idea: draft.idea,
        })
      );
      if (!(await this._contentPlanRepository.saveRefined(plan.organizationId, draft.id, day))) {
        // the draft was replaced while it was refined: the answer is dropped
        this._logger.log(`content plan: instant idea dropped plan=${plan.id}`);
      }
    }
    await this._contentPlanRepository.release(plan.id);
  }

  // The failure path of an instant idea job: the plan is free again and the owner is told it did not work. The draft stays,
  // so the owner can try again with the same idea.
  async instantFailed(draftId: string) {
    const draft = await this._contentPlanRepository.instantForWrite(draftId);
    if (draft) {
      await this._contentPlanRepository.release(draft.planId, { notice: 'instant_failed' });
    }
  }

  // The hourly tick: every ACTIVE plan is advanced, a few at a time. One plan failing never stops the others.
  async tick(now: Date) {
    try {
      await this._contentPlanRepository.purgeStaleDrafts(new Date(now.getTime() - DRAFT_STALE_MS));
    } catch (err) {
      this._logger.warn(
        `content plan: stale drafts not removed error=${(err as Error)?.name ?? 'unknown'}`
      );
    }
    let after: string | null = null;
    while (true) {
      const page: PlanWithOrganization[] =
        await this._contentPlanRepository.activePlans(after, TICK_PAGE);
      for (let index = 0; index < page.length; index += TICK_PARALLEL) {
        await Promise.all(
          page.slice(index, index + TICK_PARALLEL).map((plan) =>
            this.advance(plan, now).catch((err) =>
              this._logger.warn(
                `content plan: tick failed plan=${plan.id} error=${
                  (err as Error)?.name ?? 'unknown'
                }`
              )
            )
          )
        );
      }
      if (page.length < TICK_PAGE) {
        return;
      }
      after = page[page.length - 1].id;
    }
  }

  // One plan's turn: a plan that sat idle starts its weeks again from today, the leftovers of the weeks that ended are
  // carried on, the current week is written when it is not, and the roadmap is topped up to 12 weeks.
  async advance(plan: PlanWithOrganization, now: Date) {
    const today = localToday(now, plan.organization.timezone ?? BRAND_DEFAULT_TIMEZONE);
    let current = await this.currentWeekOf(plan.id, today);
    if (!current) {
      await this.extendRoadmap(plan.id, today);
      current = await this.currentWeekOf(plan.id, today);
    }
    await this.rollOver(plan.id, today);
    if (!current) {
      return;
    }
    const stale =
      current.status === 'GENERATING' &&
      now.getTime() - current.updatedAt.getTime() > GENERATING_STALE_MS;
    const retry =
      (current.status === 'FAILED' || stale) && current.attempts < WEEK_ATTEMPTS_MAX;
    if (current.status === 'IDEA' || retry) {
      try {
        await this.generateWeek(current.id);
      } catch (err) {
        // the week is FAILED and shows it; the roadmap still grows
        this._logger.warn(
          `content plan: week not written plan=${plan.id} week=${current.id} error=${
            (err as Error)?.name ?? 'unknown'
          }`
        );
      }
    }
    if (
      (await this._contentPlanRepository.countWeeksFrom(plan.id, current.weekStart)) <
      ROADMAP_WEEKS
    ) {
      await this.extendRoadmap(plan.id);
    }
  }

  // Writes a week: `videosPerWeek` videos on the days of SLOT_DAYS, each with the angle the rotation gives it (the
  // week's outline when it has one, carried leftovers at the 2nd, 4th and 6th video), and the week's brief unless the
  // owner edited it. A week that is READY is left as it is.
  async generateWeek(weekId: string) {
    const week = await this._contentPlanRepository.weekForWrite(weekId);
    if (!week) {
      throw new PlanNotFoundException('WEEK_NOT_FOUND');
    }
    if (week.status === 'READY') {
      return;
    }
    const { plan } = week;
    const context = this.videoContext(week, []);
    const videos = plan.videosPerWeek;
    await this._contentPlanRepository.updateWeek(weekId, {
      status: 'GENERATING',
      attempts: { increment: 1 },
    });
    try {
      const today = this.today(plan.organization);
      const current = await this.currentWeekOf(plan.id, today);
      const lastUse = await this.lastUse(
        plan.id,
        week.clusterId,
        week.id,
        current?.weekStart ?? week.weekStart
      );
      // `trend` is only for a week with an urgent note, so a carried one is not used without it
      const carried = storedCarry(week.carryIn).filter(
        (item) => !!week.urgentNote || item.angle !== 'trend'
      );
      const positions = carryPositions(videos, carried.length);
      const used = carried.slice(0, positions.length);
      const picks = pickAngles(
        videos - used.length,
        lastUse,
        used.map((item) => item.angle),
        !!week.urgentNote,
        await this.weekNumber(plan.id, week.weekStart)
      );
      const pickedAngles = Array.from({ length: videos }, (_, index) => {
        const at = positions.indexOf(index);
        return at >= 0 ? used[at].angle : (picks.shift() as Angle);
      });
      const outline = storedOutline(week.outline);
      const slots = slotsForWeek({
        weekStart: week.weekStart,
        videosPerWeek: videos,
        outline: outline && outline.length === videos ? outline : null,
        carryIn: used,
        pickedAngles,
      });
      const written = await this.charge(plan.organizationId, plan.id, 'plan.week', () =>
        this._contentPlanGenerator.writeWeek({ ...context, slots })
      );
      const recorded = new Set(
        week.days.filter((day) => day.status === 'RECORDED').map((day) => day.dayIndex)
      );
      await this._contentPlanRepository.saveGeneratedWeek({
        weekId,
        organizationId: plan.organizationId,
        days: slots
          .map((slot, index) => ({
            dayIndex: slot.dayIndex,
            date: slot.date,
            angle: slot.angle,
            title: written.days[index].title,
            why: written.days[index].why,
            beats: written.days[index].beats,
            closingLine: written.days[index].closingLine,
          }))
          .filter((day) => !recorded.has(day.dayIndex)),
        brief: week.briefEdited ? null : written.brief,
      });
    } catch (err) {
      await this._contentPlanRepository.failWeek(weekId);
      throw err;
    }
  }

  // Writes the planned videos of a week from `fromDate` on again, in one call (never a recorded video, never a day
  // before today). A video keeps its angle unless the week has an urgent note, which may bring the `trend` angle.
  async regenerateDays(weekId: string, fromDate: string) {
    const week = await this._contentPlanRepository.weekForWrite(weekId);
    if (!week) {
      throw new PlanNotFoundException('WEEK_NOT_FOUND');
    }
    const { plan } = week;
    const today = this.today(plan.organization);
    const from = fromDate > today ? fromDate : today;
    const targets = week.days.filter((day) => day.status === 'PLANNED' && day.date >= from);
    if (!targets.length) {
      return;
    }
    const others = week.days.filter((day) => !targets.includes(day));
    const context = this.videoContext(
      week,
      others.map((day) => day.title)
    );
    const ids = targets.map((day) => day.id);
    await this._contentPlanRepository.holdDays(ids);
    try {
      const angles = week.urgentNote
        ? pickAngles(
            targets.length,
            await this.lastUse(plan.id, week.clusterId, week.id, week.weekStart),
            others.map((day) => day.angle as Angle),
            true,
            await this.weekNumber(plan.id, week.weekStart)
          )
        : targets.map((day) => day.angle as Angle);
      const written = await this.charge(plan.organizationId, plan.id, 'plan.week', () =>
        this._contentPlanGenerator.writeWeek({
          ...context,
          videosPerWeek: week.days.length,
          slots: targets.map((day, index) => ({
            dayIndex: day.dayIndex,
            date: day.date,
            angle: angles[index],
          })),
        })
      );
      await this._contentPlanRepository.saveRewrittenDays(
        targets.map((day, index) => ({
          id: day.id,
          angle: angles[index],
          title: written.days[index].title,
          why: written.days[index].why,
          beats: written.days[index].beats,
          closingLine: written.days[index].closingLine,
        })),
        week.briefEdited ? null : { weekId, text: written.brief }
      );
    } catch (err) {
      await this._contentPlanRepository.releaseDays(ids);
      throw err;
    }
  }

  // Writes one planned video again on another angle than the week's other videos (and its own). A video that was
  // recorded or whose date has passed is left as it is.
  async regenerateDay(dayId: string) {
    const day = await this._contentPlanRepository.dayForWrite(dayId);
    if (!day) {
      throw new PlanNotFoundException('DAY_NOT_FOUND');
    }
    const { week } = day;
    const { plan } = week;
    if (day.status !== 'PLANNED' || day.date < this.today(plan.organization)) {
      await this._contentPlanRepository.releaseDays([day.id]);
      return;
    }
    const others = week.days.filter((other) => other.id !== day.id);
    const context = this.videoContext(
      week,
      others.map((other) => other.title)
    );
    await this._contentPlanRepository.holdDays([day.id]);
    try {
      const [angle] = pickAngles(
        1,
        await this.lastUse(plan.id, week.clusterId, week.id, week.weekStart),
        [...others.map((other) => other.angle as Angle), day.angle as Angle],
        !!week.urgentNote,
        await this.weekNumber(plan.id, week.weekStart)
      );
      const written = await this.charge(plan.organizationId, plan.id, 'plan.day', () =>
        this._contentPlanGenerator.writeDay({
          ...context,
          videosPerWeek: week.days.length,
          slot: { dayIndex: day.dayIndex, date: day.date, angle },
        })
      );
      await this._contentPlanRepository.saveRewrittenDays(
        [
          {
            id: day.id,
            angle,
            title: written.day.title,
            why: written.day.why,
            beats: written.day.beats,
            closingLine: written.day.closingLine,
          },
        ],
        null
      );
    } catch (err) {
      await this._contentPlanRepository.releaseDays([day.id]);
      throw err;
    }
  }

  // Adds weeks after the last one until 12 start on or after the current week (or after `fromDate`, where a plan that
  // sat idle starts again). Each takes the next cluster of the rotation and an idea written with the cluster's latest
  // ideas in view.
  async extendRoadmap(planId: string, fromDate?: string) {
    const plan = await this._contentPlanRepository.findWithOrganization(planId);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    const context = this.writeContext(plan);
    const today = this.today(plan.organization);
    const base =
      fromDate ?? (await this.currentWeekOf(plan.id, today))?.weekStart ?? today;
    const missing = ROADMAP_WEEKS - (await this._contentPlanRepository.countWeeksFrom(plan.id, base));
    if (missing <= 0) {
      return;
    }
    const last = await this._contentPlanRepository.lastWeek(plan.id);
    const next = last ? addDays(last.weekStart, 7) : today;
    const first = fromDate && fromDate > next ? fromDate : next;
    const clusters = await this._contentPlanRepository.activeClusters(plan.id);
    if (!clusters.length) {
      throw new PlanAiFailed('The plan has no cluster');
    }
    const rotation = clusters.map((cluster) => cluster.id);
    const rows: { id: string; clusterId: string; weekStart: string }[] = [];
    let previous = last?.clusterId ?? null;
    for (let index = 0; index < missing; index += 1) {
      previous = nextClusterId(rotation, previous);
      rows.push({ id: randomUUID(), clusterId: previous, weekStart: addDays(first, index * 7) });
    }
    const ideas = await this.writeIdeas(plan, context, first, rows.map((row) => ({
      weekStart: row.weekStart,
      cluster: clusters.find((cluster) => cluster.id === row.clusterId) ?? clusters[0],
      clusterId: row.clusterId,
    })));
    await this._contentPlanRepository.createWeeks(
      plan.id,
      rows.map((row, index) => ({ ...row, idea: ideas[index] }))
    );
  }

  // The owner changed the direction: the ideas of the weeks after the current one that are not written and whose idea
  // the owner did not edit are written again (their outline is cleared). The plan is freed with the notice; a failure
  // is left to `replanFailed`, so the job's retries keep the plan busy.
  async replan(planId: string) {
    const plan = await this._contentPlanRepository.findWithOrganization(planId);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    const context = this.writeContext(plan);
    const today = this.today(plan.organization);
    const current = await this.currentWeekOf(plan.id, today);
    const weeks = await this._contentPlanRepository.replanWeeks(
      plan.id,
      current ? addDays(current.weekStart, 7) : today
    );
    if (weeks.length) {
      const ideas = await this.writeIdeas(
        plan,
        context,
        weeks[0].weekStart,
        weeks.map((week) => ({
          weekStart: week.weekStart,
          cluster: week.cluster,
          clusterId: week.clusterId,
        }))
      );
      await this._contentPlanRepository.saveIdeas(
        weeks.map((week, index) => ({ id: week.id, idea: ideas[index] }))
      );
    }
    await this._contentPlanRepository.release(plan.id, { notice: 'roadmap_updated' });
  }

  // The failure path of a replan job: the plan is free again and the owner is told the new direction was not applied.
  replanFailed(planId: string) {
    return this._contentPlanRepository.release(planId, { notice: 'replan_failed' });
  }

  // The failure path of a week job: the week shows as FAILED (the tick tries again while it has attempts left).
  weekFailed(weekId: string) {
    return this._contentPlanRepository.failWeek(weekId);
  }

  // The failure path of a days job: the videos are free again, as they were.
  daysFailed(weekId: string) {
    return this._contentPlanRepository.releaseWeekDays(weekId);
  }

  // The failure path of a day job: the video is free again, as it was.
  dayFailed(dayId: string) {
    return this._contentPlanRepository.releaseDays([dayId]);
  }

  // Carries the leftovers of the weeks that ended: up to 3 go on to the next week that is not written, the rest are
  // dropped. Every planned day of an ended week becomes MISSED either way, so it never counts as used.
  private async rollOver(planId: string, today: string) {
    const ended = await this._contentPlanRepository.endedWeeksWithPlannedDays(
      planId,
      addDays(today, -7)
    );
    if (!ended.length) {
      return;
    }
    const target = await this._contentPlanRepository.firstIdeaWeekFrom(planId, today);
    const incoming = ended.flatMap((week) =>
      week.days.map((day) => ({
        title: day.title,
        angle: day.angle as Angle,
        clusterId: week.clusterId,
      }))
    );
    await this._contentPlanRepository.closeWeek(
      ended.flatMap((week) => week.days.map((day) => day.id)),
      target
        ? {
            weekId: target.id,
            items: mergeCarry(storedCarry(target.carryIn), incoming).kept,
          }
        : null
    );
  }

  // The plan of the workspace when it is ACTIVE; the changes below need a confirmed plan.
  private async activePlan(org: PlanOrganization) {
    const plan = await this._contentPlanRepository.findByOrganization(org.id);
    if (!plan) {
      throw new PlanNotFoundException();
    }
    if (plan.status !== 'ACTIVE') {
      throw new PlanConflictException('PLAN_NOT_ACTIVE');
    }
    return plan;
  }

  // A week of the workspace that contains today. 404 for a week of another workspace, 409 WEEK_LOCKED for any other week,
  // 409 PLAN_BUSY while it or one of its videos is being written.
  private async currentWeekOfOrganization(org: PlanOrganization, weekId: string, today: string) {
    const week = await this._contentPlanRepository.weekOfOrganization(org.id, weekId);
    if (!week) {
      throw new PlanNotFoundException('WEEK_NOT_FOUND');
    }
    if (week.weekStart > today || addDays(week.weekStart, 6) < today) {
      throw new PlanConflictException('WEEK_LOCKED');
    }
    if (week.status === 'GENERATING' || week.days.some((day) => day.busy)) {
      throw new PlanConflictException('PLAN_BUSY');
    }
    return week;
  }

  // A day of the workspace; 404 DAY_NOT_FOUND for a day of another workspace.
  private async dayOfOrganization(org: PlanOrganization, dayId: string) {
    const day = await this._contentPlanRepository.dayOfOrganization(org.id, dayId);
    if (!day) {
      throw new PlanNotFoundException('DAY_NOT_FOUND');
    }
    return day;
  }

  // The owner changed what the current week is written from: a written week gets its planned videos from today on written
  // again; a week that is not written (or failed) is written. The videos are marked busy before the job starts, so the
  // answer already shows them as being written.
  private async writeAgain(org: PlanOrganization, week: WeekWithDays, today: string) {
    if (week.status === 'READY') {
      const ids = week.days
        .filter((day) => day.status === 'PLANNED' && day.date >= today)
        .map((day) => day.id);
      if (ids.length) {
        await this._contentPlanRepository.holdDays(ids);
        await this.startDaysJob({ kind: 'days', id: week.id, fromDate: today }, org.id, ids);
      }
    } else {
      await this._contentPlanRepository.updateWeek(week.id, { status: 'GENERATING' });
      try {
        await this.startJob({ kind: 'week', id: week.id }, org.id, null);
      } catch (err) {
        if (!(err instanceof PlanConflictException)) {
          await this._contentPlanRepository.failWeek(week.id);
        }
        throw err;
      }
    }
    const fresh = await this._contentPlanRepository.weekOfOrganization(org.id, week.id);
    return this.weekView(fresh as WeekWithDays);
  }

  // Starts a job that writes videos again; when it cannot be started the videos are free again, unless the same job is
  // already running and holds them.
  private async startDaysJob(job: PlanJob, orgId: string, dayIds: string[]) {
    try {
      await this.startJob(job, orgId, null);
    } catch (err) {
      if (!(err instanceof PlanConflictException)) {
        await this._contentPlanRepository.releaseDays(dayIds);
      }
      throw err;
    }
  }

  // The beats stored on a day or an instant idea.
  private beatsOf(row: { beats: Prisma.JsonValue }) {
    return (Array.isArray(row.beats) ? row.beats : []) as unknown as PlanBeat[];
  }

  // A day as the page draws it.
  private dayView(day: PlanDay): PlanDayView {
    return {
      id: day.id,
      kind: 'PLANNED',
      date: day.date,
      dayIndex: day.dayIndex,
      title: day.title,
      angle: day.angle as Angle,
      why: day.why,
      beats: this.beatsOf(day),
      closingLine: day.closingLine,
      status: day.status as PlanDayView['status'],
      busy: day.busy,
      version: day.version,
    };
  }

  // An instant idea as the page draws it.
  private instantView(idea: PlanInstantIdea, today: string): PlanInstantIdeaView {
    return {
      id: idea.id,
      date: idea.date,
      idea: idea.idea,
      title: idea.title,
      why: idea.why,
      beats: this.beatsOf(idea),
      closingLine: idea.closingLine,
      status: idea.status === 'PLANNED' && idea.date < today ? 'MISSED' : (idea.status as PlanInstantIdeaView['status']),
    };
  }

  // An instant idea that was added to the plan as a video of its week: no day slot, no angle, never busy. One planned for a
  // date that has passed shows as MISSED (derived here, nothing is written).
  private instantDayView(idea: PlanInstantIdea, today: string): PlanDayView {
    const view = this.instantView(idea, today);
    return {
      id: view.id,
      kind: 'INSTANT_IDEA',
      date: view.date,
      dayIndex: null,
      title: view.title,
      angle: null,
      why: view.why,
      beats: view.beats,
      closingLine: view.closingLine,
      status: view.status as PlanDayView['status'],
      busy: false,
      version: 0,
    };
  }

  // The videos of a week with its instant ideas (already in date order) put in: by date, an AI day before an instant idea of
  // the same date.
  private withInstantIdeas<T extends { date: string }>(
    days: T[],
    instant: PlanInstantIdea[],
    asDay: (idea: PlanInstantIdea) => T
  ): T[] {
    const merged = [...days];
    for (const idea of instant) {
      const at = merged.findIndex((day) => day.date > idea.date);
      merged.splice(at < 0 ? merged.length : at, 0, asDay(idea));
    }
    return merged;
  }

  // Marks an instant idea of the workspace as recorded, answering as a day; 404 DAY_NOT_FOUND when there is no such row (a
  // draft is not a video yet).
  private async instantRecorded(org: PlanOrganization, id: string): Promise<PlanDayView> {
    const idea = await this._contentPlanRepository.getInstantIdea(org.id, id);
    if (!idea || idea.status === 'DRAFT') {
      throw new PlanNotFoundException('DAY_NOT_FOUND');
    }
    if (idea.status !== 'RECORDED') {
      await this._contentPlanRepository.markInstantRecorded(org.id, id, new Date());
    }
    return this.instantDayView(
      (await this._contentPlanRepository.getInstantIdea(org.id, id)) as PlanInstantIdea,
      this.today(org)
    );
  }

  // A week as the page draws it, with its videos.
  private weekView(week: WeekWithDays): PlanWeekView {
    return {
      id: week.id,
      weekStart: week.weekStart,
      weekEnd: addDays(week.weekStart, 6),
      idea: week.idea,
      brief: week.brief,
      urgentNote: week.urgentNote,
      status: week.status as PlanWeekView['status'],
      days: week.days.map((day) => this.dayView(day)),
    };
  }

  // A week of the roadmap as the list of coming weeks draws it.
  private upcomingView(
    week: PlanWeek & { cluster: { theme: { name: string } } }
  ): PlanUpcomingView {
    return {
      id: week.id,
      weekStart: week.weekStart,
      idea: week.idea,
      ideaEdited: week.ideaEdited,
      theme: week.cluster.theme.name,
    };
  }

  // The week of the plan that contains a brand-local date, or null.
  private currentWeekOf(planId: string, today: string) {
    return this._contentPlanRepository.currentWeek(planId, addDays(today, -6), today);
  }

  // The number of the week since the plan was confirmed (0, 1, 2, ...), which turns the angle order from week to week.
  private async weekNumber(planId: string, weekStart: string) {
    const first = await this._contentPlanRepository.firstWeek(planId);
    return first
      ? Math.max(0, Math.floor(daysBetween(first.weekStart, weekStart) / 7))
      : 0;
  }

  // The date each angle of a cluster was last used: a recorded video, a video still planned from the current week on,
  // or a leftover waiting in a week from the current one on.
  private async lastUse(
    planId: string,
    clusterId: string,
    exceptWeekId: string,
    currentStart: string
  ) {
    const uses = await this._contentPlanRepository.angleUses(
      planId,
      clusterId,
      exceptWeekId,
      currentStart
    );
    const last = new Map<Angle, string>();
    const note = (angle: string, date: string) => {
      if (!(ANGLES as readonly string[]).includes(angle)) {
        return;
      }
      const known = last.get(angle as Angle);
      if (!known || date > known) {
        last.set(angle as Angle, date);
      }
    };
    uses.days.forEach((day) => note(day.angle, day.date));
    uses.weeks.forEach((week) =>
      storedCarry(week.carryIn)
        .filter((item) => item.clusterId === clusterId)
        .forEach((item) => note(item.angle, week.weekStart))
    );
    return last;
  }

  // What the weekly calls know about the brand; a plan that was never confirmed has no facts to write from.
  private writeContext(plan: PlanWithOrganization): PlanWriteContext {
    const facts = plan.facts as unknown as PlanFacts | null;
    if (!facts || !plan.direction) {
      throw new PlanAiFailed('The plan is not confirmed');
    }
    return {
      orgId: plan.organizationId,
      name: displayName(plan.organization.name),
      locale: plan.organization.locale ?? BRAND_DEFAULT_LOCALE,
      direction: plan.direction,
      facts,
    };
  }

  // What a week or a day is written from.
  private videoContext(week: WeekForWrite, otherTitles: string[]): PlanVideoContext {
    return {
      ...this.writeContext(week.plan),
      idea: week.idea,
      clusterTitle: week.cluster.title,
      problem: week.cluster.problem,
      brief: week.brief,
      briefEdited: week.briefEdited,
      urgentNote: week.urgentNote,
      otherTitles,
    };
  }

  // One idea per week, in the same order, written with the latest ideas of each cluster before `before` in view; at
  // most 12 weeks to a call.
  private async writeIdeas(
    plan: PlanWithOrganization,
    context: PlanWriteContext,
    before: string,
    weeks: { weekStart: string; clusterId: string; cluster: { title: string; problem: string } }[]
  ) {
    const earlier = new Map<string, string[]>();
    for (const week of weeks) {
      if (!earlier.has(week.clusterId)) {
        const rows = await this._contentPlanRepository.recentIdeas(
          plan.id,
          week.clusterId,
          before,
          PREVIOUS_IDEAS
        );
        earlier.set(week.clusterId, rows.map((row) => row.idea).reverse());
      }
    }
    const ideas: string[] = [];
    for (let index = 0; index < weeks.length; index += IDEAS_PER_CALL) {
      const written = await this.charge(plan.organizationId, plan.id, 'plan.roadmap', () =>
        this._contentPlanGenerator.writeIdeas({
          ...context,
          weeks: weeks.slice(index, index + IDEAS_PER_CALL).map((week) => ({
            weekStart: week.weekStart,
            weekEnd: addDays(week.weekStart, 6),
            clusterTitle: week.cluster.title,
            problem: week.cluster.problem,
            previousIdeas: earlier.get(week.clusterId) ?? [],
          })),
        })
      );
      ideas.push(...written.ideas);
    }
    return ideas;
  }

  // The plan as the page draws it.
  private async viewOf(
    org: PlanOrganization,
    plan: ContentPlan | null
  ): Promise<PlanView> {
    const [rounds, themes, draft] = plan
      ? await Promise.all([
          this._contentPlanRepository.rounds(plan.id),
          this._contentPlanRepository.activeThemes(plan.id),
          this._contentPlanRepository.openDraft(org.id),
        ])
      : [[], [], null];
    const round = rounds[rounds.length - 1] ?? null;
    return {
      status: plan ? (plan.status as PlanView['status']) : 'NONE',
      canEdit: canEditRole(org.users?.[0]?.role),
      videosPerWeek: plan?.videosPerWeek ?? DEFAULT_VIDEOS_PER_WEEK,
      prefill: this.prefill(org),
      sourceText: plan?.sourceText ?? null,
      direction: plan?.direction ?? null,
      facts: (plan?.facts as unknown as PlanFacts | null) ?? null,
      busy: plan?.busy ?? null,
      notice: plan?.notice ?? null,
      round: round
        ? {
            id: round.id,
            index: round.index,
            direction: round.direction,
            questions: round.questions as unknown as PlanQuestion[],
            readyForPlan: round.readyForPlan,
          }
        : null,
      rounds: rounds.map((item, index) => ({
        id: item.id,
        index: item.index,
        direction: this.directionOf(item, rounds[index + 1], plan),
        questions: item.questions as unknown as PlanQuestion[],
        answers: (item.answers as unknown as PlanAnswer[] | null) ?? null,
        readyForPlan: item.readyForPlan,
      })),
      proposal:
        plan?.status === 'PROPOSED'
          ? (plan.proposal as unknown as PlanProposal | null)
          : null,
      themes,
      instantDraft: draft ? this.instantView(draft, this.today(org)) : null,
      today: this.today(org),
    };
  }

  // The direction of a round as the owner left it: the edit the owner sent with the answers (kept in the next round's
  // first turn), or for the latest round the plan's direction, which holds the owner's last edit.
  private directionOf(
    round: { direction: string },
    next: { userTurn: string } | undefined,
    plan: ContentPlan
  ) {
    if (!next) {
      return plan.direction ?? round.direction;
    }
    try {
      const edited = JSON.parse(next.userTurn)?.editedDirection;
      return typeof edited === 'string' && edited ? edited : round.direction;
    } catch {
      return round.direction;
    }
  }

  // What the first textarea starts with: the brand profile as plain lines (the name first), or empty when the profile
  // has nothing about the business yet. No labels, so it reads in any language.
  private prefill(org: PlanOrganization) {
    const parsed = BrandProfile.safeParse(org.profile ?? { schemaVersion: 1 });
    if (!parsed.success) {
      return '';
    }
    const { tagline, audience, voice, pillars } = parsed.data;
    const lines = [
      tagline,
      audience?.join(', '),
      voice,
      pillars?.join(', '),
    ].filter((line): line is string => !!line?.trim());
    if (!lines.length) {
      return '';
    }
    return [displayName(org.name), ...lines]
      .join('\n')
      .slice(0, LIMITS.sourceText);
  }

  // The brand-local date today.
  private today(org: PlanBrand) {
    return localToday(new Date(), org.timezone ?? BRAND_DEFAULT_TIMEZONE);
  }

  // The brand context of the setup and the proposal chat: only the name and the language, so it stays the same for every
  // round (the direction lives in the chat turns).
  setupContext(org: PlanBrand) {
    return brandContextMessage({
      name: displayName(org.name),
      locale: org.locale ?? BRAND_DEFAULT_LOCALE,
      facts: null,
      direction: null,
    });
  }

  // The refs of a proposal's clusters in rotation order.
  private rotationOf(proposal: Pick<PlanProposal, 'themes' | 'clusters'>) {
    return rotationOrder(
      proposal.themes.map((theme, index) => ({ id: theme.ref, position: index })),
      proposal.clusters.map((cluster, index) => ({
        id: cluster.ref,
        themeId: cluster.themeRef,
        position: index,
      }))
    );
  }

  // The first day of the plan's first week: today, or the day after the week that is running now, so the weeks of a
  // plan that is started over never overlap the one the phone still shows.
  private async firstWeekStart(planId: string, today: string) {
    const current = await this._contentPlanRepository.currentWrittenWeek(
      planId,
      today,
      addDays(today, -6)
    );
    return current ? addDays(current.weekStart, 7) : today;
  }

  // The setup round written from the chat so far, saved with the exact texts of its turns (re-sent byte for byte next
  // time).
  private writeRound(
    org: PlanBrand & { id: string },
    planId: string,
    index: number,
    turns: ChatTurn[],
    newUserTurn: string,
    beforeSave?: () => Promise<void>
  ) {
    return this.writeChatRound(
      org,
      planId,
      (input) => this._contentPlanGenerator.setupRound(input),
      turns,
      newUserTurn,
      (round) =>
        this._contentPlanRepository.saveRound({
          planId,
          index,
          direction: round.direction,
          questions: round.questions,
          readyForPlan: round.readyForPlan,
          userTurn: newUserTurn,
          assistantTurn: round.assistantTurn,
        }),
      beforeSave
    );
  }

  // One round of an interview chat, the part the setup and a session share: the AI call (`ask`) booked on the price-0
  // action plan.setup_round, then `beforeSave` (a rewind that waits for the answer) and `save`, which stores the round
  // with the exact texts of its turns.
  async writeChatRound(
    org: PlanBrand & { id: string },
    planId: string,
    ask: (input: PlanChatInput) => Promise<PlanChatRound>,
    turns: ChatTurn[],
    newUserTurn: string,
    save: (round: PlanChatRound) => Promise<unknown>,
    beforeSave?: () => Promise<void>
  ) {
    const round = await this.charge(org.id, planId, 'plan.setup_round', () =>
      ask({
        orgId: org.id,
        brandContext: this.setupContext(org),
        turns,
        newUserTurn,
      })
    );
    await beforeSave?.();
    await save(round);
  }

  // The owner's answers as the model reads them: the question text and the answer text (the owner's own words when
  // given, else the chosen options' texts, or both for ticked options). The ids never reach the model. An answer to a question or option that is
  // not in the round is refused.
  resolveAnswers(stored: Prisma.JsonValue, answers: PlanAnswer[]) {
    const questions = stored as unknown as PlanQuestion[];
    const fields: { path: string; message: string }[] = [];
    const resolved = answers.map((answer, index) => {
      const question = questions.find((item) => item.id === answer.questionId);
      const chosen = [...new Set([answer.optionId, ...(answer.optionIds ?? [])])].filter(Boolean);
      const labels = chosen.flatMap((optionId) => {
        const option = question?.options.find((item) => item.id === optionId);
        return option ? [option.label] : [];
      });
      if (!question) {
        fields.push({
          path: `answers.${index}.questionId`,
          message: 'is not a question of this round',
        });
      } else if (labels.length !== chosen.length) {
        fields.push({
          path: `answers.${index}.optionIds`,
          message: 'is not an option of this question',
        });
      }
      const other = answer.other?.trim();
      return {
        question: question?.text ?? '',
        // one option with the owner's own words: the words win; ticked options: all of them, then the words
        answer: answer.optionId && other ? other : [...labels, other].filter(Boolean).join(', '),
      };
    });
    if (fields.length) {
      throw new InvalidPlanException(fields);
    }
    return resolved;
  }

  // Takes the plan for a job; 409 PLAN_BUSY when another one holds it.
  private async claim(planId: string, busy: string) {
    if (!(await this._contentPlanRepository.claimBusy(planId, busy))) {
      throw new PlanConflictException('PLAN_BUSY');
    }
  }

  // One AI call, booked on a price-0 action so charging can be switched on in the pricing table without code.
  charge<T>(
    organizationId: string,
    planId: string,
    actionKey: string,
    run: () => Promise<T>
  ) {
    return this._creditsService.spend(
      {
        organizationId,
        actionKey,
        idempotencyKey: `plan:${planId}:${actionKey}:${randomUUID()}`,
        metadata: { planId },
      },
      run
    );
  }

  // Starts a job as a workflow whose id names the job, so the same job cannot run twice (409 PLAN_BUSY). When the job
  // holds the plan (`busyPlanId`) and cannot be started, the plan is freed and the call answers 503.
  private startJob(job: PlanJob, orgId: string, busyPlanId: string | null) {
    return this.launchJob(
      job,
      orgId,
      busyPlanId ? () => this._contentPlanRepository.release(busyPlanId) : null
    );
  }

  // The workflow start of `startJob`. `free` gives back what the job holds (the plan, or a session) when the job cannot
  // be started; null when it holds nothing.
  async launchJob(
    job: PlanJob,
    orgId: string,
    free: (() => Promise<unknown>) | null
  ) {
    const client = this._temporalService.client.getRawClient();
    try {
      if (!client) {
        throw new PlanUnavailableException();
      }
      await client.workflow.start('contentPlanJobWorkflow', {
        workflowId: `content_plan_${job.kind}_${job.id}`,
        taskQueue: 'main',
        args: [job],
        typedSearchAttributes: new TypedSearchAttributes([
          { key: organizationKey, value: orgId },
        ]),
      });
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        // the running job holds the plan and frees it when it ends
        throw new PlanConflictException('PLAN_BUSY');
      }
      if (free) {
        await free();
      }
      if (err instanceof PlanUnavailableException) {
        throw err;
      }
      this._logger.error(
        `Could not start the content plan job ${job.kind} ${job.id}: ${
          (err as Error).message
        }`
      );
      throw new PlanUnavailableException();
    }
  }

  // The generator's two refusals as the HTTP answers of the synchronous setup routes; any other error passes on.
  aiError(err: unknown) {
    if (err instanceof PlanNotConfigured) {
      return new PlanUnavailableException();
    }
    if (err instanceof PlanAiFailed) {
      return new PlanAiFailedException();
    }
    return err;
  }

  // Validates an input against a schema; every failing path is answered as INVALID_PLAN.
  parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) {
      throw new InvalidPlanException(
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))
      );
    }
    return result.data;
  }
}
