// Content plan setup routes: the setup's own routes (start, answer, proposal, revise, confirm, reset) that tabs opened before
// the setup moved onto the planning engine still call. Each one runs the workspace's `plan` session through the session
// service and answers the plan as the page draws it, so an old tab keeps working across the deploy. The proposal jobs
// queued before the move (`proposal` and `revise`, which carry a plan id) are routed to the plan's session here too.
import { Injectable } from '@nestjs/common';
import {
  ContentPlanService,
  PlanConflictException,
  PlanNotFoundException,
  PlanOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { ContentPlanRepository } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.repository';
import { ContentPlanSessionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.repository';
import { ContentPlanSessionService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.service';
import {
  AnswerSetupSchema,
  ConfirmSchema,
  PLAN_SESSION_KIND,
  PlanView,
  ProposeSchema,
  ReviseSchema,
  StartSetupSchema,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The setup of the plan, as the routes of the plan's setup call it.
@Injectable()
export class ContentPlanSetupService {
  // Receives the plan service (the plan as the page draws it, the validation), the storage of the plan and of the sessions,
  // and the session service that runs the setup.
  constructor(
    private _contentPlanService: ContentPlanService,
    private _contentPlanRepository: ContentPlanRepository,
    private _sessionRepository: ContentPlanSessionRepository,
    private _contentPlanSessionService: ContentPlanSessionService
  ) {}

  // Starts the setup from the owner's first text and answers round 0. A plan that is already ACTIVE is refused: starting
  // over goes through `reset`.
  async startSetup(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this._contentPlanService.parse(StartSetupSchema, input);
    await this._contentPlanSessionService.start(org, {
      kind: PLAN_SESSION_KIND,
      sourceText: body.sourceText,
    });
    return this._contentPlanService.view(org);
  }

  // Saves the answers and the owner's edit of the direction, then writes the next round (an earlier round rewinds).
  async answer(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this._contentPlanService.parse(AnswerSetupSchema, input);
    const session = await this.sessionOf(org, 'ROUND_STALE');
    await this._contentPlanSessionService.answer(org, session.id, {
      roundId: body.roundId,
      summary: body.direction,
      answers: body.answers,
    });
    return this._contentPlanService.view(org);
  }

  // Stores the direction, the videos per week and the answers of the last round, and starts the proposal job.
  async propose(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this._contentPlanService.parse(ProposeSchema, input);
    const session = await this.sessionOf(org, 'ROUND_STALE');
    await this._contentPlanSessionService.propose(org, session.id, {
      summary: body.direction,
      ...(body.answers ? { answers: body.answers } : {}),
      options: { videosPerWeek: body.videosPerWeek },
    });
    return this._contentPlanService.view(org);
  }

  // Asks for a new proposal after the owner's feedback.
  async revise(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this._contentPlanService.parse(ReviseSchema, input);
    const session = await this.sessionOf(org, 'PROPOSAL_STALE');
    await this._contentPlanSessionService.revise(org, session.id, body);
    return this._contentPlanService.view(org);
  }

  // Makes the proposal the plan.
  async confirm(org: PlanOrganization, input: unknown): Promise<PlanView> {
    const body = this._contentPlanService.parse(ConfirmSchema, input);
    const session = await this.sessionOf(org, 'PROPOSAL_STALE');
    await this._contentPlanSessionService.confirm(org, session.id, body);
    return this._contentPlanService.view(org);
  }

  // Back to a fresh setup: the open session ends and the plan is SETUP again. The weeks are kept, so the phone keeps the
  // current one until a new plan is confirmed.
  async reset(org: PlanOrganization): Promise<PlanView> {
    const plan = await this._contentPlanRepository.ensure(org.id);
    await this._sessionRepository.discardOpen(org.id, PLAN_SESSION_KIND);
    await this._contentPlanRepository.release(plan.id, { status: 'SETUP', notice: null });
    return this._contentPlanService.view(org);
  }

  // The proposal job queued before the setup moved onto sessions (kind `proposal`, or `revise` with the owner's `feedback`),
  // which carries the plan id: the plan's session writes it. A plan whose session is no longer open has nothing to write.
  async buildProposal(planId: string, feedback: string | null) {
    const session = await this.openSessionOfPlan(planId);
    if (session) {
      await this._contentPlanSessionService.buildProposal(session.id, feedback);
    }
  }

  // The failure path of such a job: the plan's session is free again and the owner is told it did not work.
  async proposalFailed(planId: string) {
    const session = await this.openSessionOfPlan(planId);
    if (session) {
      await this._contentPlanSessionService.sessionFailed(session.id);
    }
  }

  // The open `plan` session of the workspace; when it has none, 404 PLAN_NOT_FOUND for a workspace without a plan and
  // 409 with `code` (the route's own "this is not what the page showed") for one with a plan.
  private async sessionOf(org: PlanOrganization, code: string) {
    const session = await this._sessionRepository.findOpen(org.id, PLAN_SESSION_KIND);
    if (session) {
      return session;
    }
    if (!(await this._contentPlanRepository.findByOrganization(org.id))) {
      throw new PlanNotFoundException();
    }
    throw new PlanConflictException(code);
  }

  // The open `plan` session of the plan with this id, or null.
  private async openSessionOfPlan(planId: string) {
    const plan = await this._contentPlanRepository.findWithOrganization(planId);
    return plan ? this._sessionRepository.findOpen(plan.organizationId, PLAN_SESSION_KIND) : null;
  }
}
