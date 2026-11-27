// Content plan setup: the session kind `plan` that turns the owner's text about the business into the brand's plan. The
// rounds ask about the business on the setup frame; the proposal is the structure of the plan (facts, themes, clusters),
// the ideas of the 12 weeks and an outline for the first of them; the confirmation makes the plan ACTIVE (themes and
// clusters in rotation order, the 12 weeks from today) and starts the first week. It registers itself with the kinds the
// generic session service runs.
import { Injectable, Logger } from '@nestjs/common';
import { ContentPlan, PlanSession, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ChatTurn } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import { displayName } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import {
  ContentPlanGenerator,
  PlanAiFailed,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import { ContentPlanRepository } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.repository';
import {
  ContentPlanService,
  PlanConflictException,
  PlanOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import {
  PlanSessionForWrite,
  PlanSessionKind,
  PlanSessionKinds,
  SessionProposalDraft,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.kind';
import {
  addDays,
  nextClusterId,
  pickAngles,
  rotationOrder,
  stableJson,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import { PlannerPromptKey } from '@gitroom/nestjs-libraries/database/prisma/content-plan/prompts';
import {
  DEFAULT_VIDEOS_PER_WEEK,
  PLAN_SESSION_EDIT_KEY,
  PLAN_SESSION_KIND,
  PREVIEW_WEEKS,
  PlanOutlineItem,
  PlanProposal,
  PlanSetupOptions,
  PlanSetupOptionsSchema,
  ROADMAP_WEEKS,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';
import { BRAND_DEFAULT_LOCALE } from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';

// The session kind `plan`.
@Injectable()
export class PlanSetupSessionKind implements PlanSessionKind {
  readonly kind = PLAN_SESSION_KIND;
  readonly roundFrame: PlannerPromptKey = 'planner.frame.setup';
  readonly editedKey = PLAN_SESSION_EDIT_KEY;
  private readonly _logger = new Logger(PlanSetupSessionKind.name);

  // Receives the kinds to register with, the plan service (the brand context, dates and charges), the storage of the plan
  // and the writer of the AI calls.
  constructor(
    kinds: PlanSessionKinds,
    private _contentPlanService: ContentPlanService,
    private _contentPlanRepository: ContentPlanRepository,
    private _contentPlanGenerator: ContentPlanGenerator
  ) {
    kinds.register(this);
  }

  // The plan of the workspace (made when it has none); 409 PLAN_EXISTS when it is ACTIVE: starting over goes through reset.
  async planOf(org: PlanOrganization): Promise<ContentPlan> {
    if ((await this._contentPlanRepository.findByOrganization(org.id))?.status === 'ACTIVE') {
      throw new PlanConflictException('PLAN_EXISTS');
    }
    return this._contentPlanRepository.ensure(org.id);
  }

  // The videos a week the owner starts from: the plan's own number unless one is given.
  parseOptions(options: unknown, _org: PlanOrganization, plan: ContentPlan): Prisma.InputJsonObject {
    const body = this._contentPlanService.parse(PlanSetupOptionsSchema, options);
    const stored: PlanSetupOptions = { videosPerWeek: body.videosPerWeek ?? plan.videosPerWeek };
    return { ...stored };
  }

  // The videos a week the owner chose when asking for the proposal, over the stored ones.
  parseProposeOptions(options: unknown, session: PlanSession): Prisma.InputJsonObject {
    const body = this._contentPlanService.parse(PlanSetupOptionsSchema, options);
    return { ...(session.options as Prisma.InputJsonObject), ...body };
  }

  // The proposal job: the structure of the plan from the proposal chat, the ideas of the 12 weeks, and an outline for each
  // of the first weeks. `feedback` is the owner's words of a revise, sent as the next turn of the stored chat; without it the
  // chat starts from the direction (the session's summary). Each AI call is booked on its own action. A failure is thrown.
  async buildProposal(
    session: PlanSessionForWrite,
    earlier: ChatTurn[],
    feedback: string | null
  ): Promise<SessionProposalDraft> {
    const { organization: org } = session;
    const direction = session.summary;
    if (!direction) {
      throw new PlanAiFailed('The plan has no direction');
    }
    const { videosPerWeek } = this.optionsOf(session);
    const locale = org.locale ?? BRAND_DEFAULT_LOCALE;
    const name = displayName(org.name);
    const newUserTurn = stableJson(feedback ? { feedback } : { direction });
    const structure = await this._contentPlanService.charge(org.id, session.planId, 'plan.proposal', () =>
      this._contentPlanGenerator.proposeStructure({
        orgId: org.id,
        brandContext: this._contentPlanService.setupContext(org),
        turns: earlier,
        newUserTurn,
      })
    );
    const rotation = this.rotationOf(structure);
    const today = this._contentPlanService.today(org);
    const firstStart = await this.firstWeekStart(session.planId, today);
    const rows: { weekStart: string; clusterRef: string }[] = [];
    let previous: string | null = null;
    for (let index = 0; index < ROADMAP_WEEKS; index += 1) {
      previous = nextClusterId(rotation, previous);
      rows.push({ weekStart: addDays(firstStart, index * 7), clusterRef: previous });
    }
    const clusterOf = (ref: string) =>
      structure.clusters.find((cluster) => cluster.ref === ref) ?? structure.clusters[0];
    const context = {
      orgId: org.id,
      name,
      locale,
      direction,
      facts: structure.facts,
    };
    const { ideas } = await this._contentPlanService.charge(org.id, session.planId, 'plan.roadmap', () =>
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
      const angles = pickAngles(videosPerWeek, new Map(), [], false, index);
      const { titles } = await this._contentPlanService.charge(org.id, session.planId, 'plan.proposal', () =>
        this._contentPlanGenerator.writeOutline({
          ...context,
          idea: ideas[index],
          clusterTitle: cluster.title,
          problem: cluster.problem,
          angles,
          videosPerWeek,
        })
      );
      outlines[index] = titles.map((title, position) => ({
        title,
        angle: angles[position],
      }));
    }
    const proposal: PlanProposal = {
      version: session.proposalVersion + 1,
      facts: structure.facts,
      themes: structure.themes,
      clusters: structure.clusters,
      weeks: rows.map((row, index) => ({
        weekStart: row.weekStart,
        clusterRef: row.clusterRef,
        idea: ideas[index],
        outline: outlines[index],
      })),
    };
    return {
      proposal: proposal as unknown as Prisma.InputJsonObject,
      userTurn: newUserTurn,
      assistantTurn: structure.assistantTurn,
    };
  }

  // Makes the proposal the plan: themes, clusters in rotation order and the 12 weeks, the first of them starting today (or
  // the day after the week still running), with the session's summary as the plan's direction and its videos a week. The
  // first week is written right away by a job; when that cannot be started the hourly tick writes it. 409 PROPOSAL_STALE
  // when the plan is ACTIVE already or is no longer the session's.
  async confirm(session: PlanSessionForWrite, _edits: unknown): Promise<void> {
    const proposal = session.proposal as unknown as PlanProposal;
    const plan = await this._contentPlanRepository.findByOrganization(session.organizationId);
    if (!plan || plan.id !== session.planId || plan.status === 'ACTIVE') {
      throw new PlanConflictException('PROPOSAL_STALE');
    }
    const { videosPerWeek } = this.optionsOf(session);
    const today = this._contentPlanService.today(session.organization);
    const firstStart = await this.firstWeekStart(plan.id, today);
    const themeIds = new Map(proposal.themes.map((theme) => [theme.ref, randomUUID()]));
    const clusterIds = new Map(proposal.clusters.map((cluster) => [cluster.ref, randomUUID()]));
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
      direction: session.summary as string,
      sourceText: session.sourceText,
      videosPerWeek,
    });
    if (weeks[0] && weeks[0].weekStart === today) {
      try {
        await this._contentPlanService.launchJob(
          { kind: 'week', id: weeks[0].id },
          session.organizationId,
          null
        );
      } catch (err) {
        // the plan is already confirmed; the hourly tick writes the week
        this._logger.warn(
          `content plan: first week job not started plan=${plan.id} error=${(err as Error)?.name ?? 'unknown'}`
        );
      }
    }
  }

  // The proposal as the page draws it: as it is stored.
  viewOf(proposal: Prisma.JsonValue): PlanProposal {
    return proposal as unknown as PlanProposal;
  }

  // The options of the session as stored; the default videos a week when a row has none.
  private optionsOf(session: PlanSession): PlanSetupOptions {
    return { videosPerWeek: DEFAULT_VIDEOS_PER_WEEK, ...(session.options as Partial<PlanSetupOptions> | null) };
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

  // The first day of the plan's first week: today, or the day after the week that is running now, so the weeks of a plan
  // that is started over never overlap the one the phone still shows.
  private async firstWeekStart(planId: string, today: string) {
    const current = await this._contentPlanRepository.currentWrittenWeek(
      planId,
      today,
      addDays(today, -6)
    );
    return current ? addDays(current.weekStart, 7) : today;
  }
}
