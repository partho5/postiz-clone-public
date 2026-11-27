// Content plan sessions: the planning engine's interview -> proposal -> confirm procedure, generic over the kind of work.
// The owner writes a first text, answers the AI's rounds of questions (and may go back to an earlier round), reads the
// proposal, asks for a revision and confirms it. The rounds are an append-only chat so Meta's prompt cache can match
// their start; the proposal and the revise are written by a job (a workflow). The session row holds the busy claim, and
// every AI call is booked through the plan service's `charge` on the same price-0 actions as the setup's. What differs
// per kind (the round frame, the proposal, the confirmation) is in a `PlanSessionKind`; this file never names a kind.
import { Injectable, Logger } from '@nestjs/common';
import { PlanSession } from '@prisma/client';
import { ChatTurn } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import { canEditRole } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import { ContentPlanGenerator } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import {
  ContentPlanService,
  InvalidPlanException,
  PlanConflictException,
  PlanNotFoundException,
  PlanOrganization,
  storedTurns,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { ContentPlanSessionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.repository';
import {
  PlanSessionKind,
  PlanSessionKinds,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.kind';
import {
  roundSummary,
  stableJson,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import {
  AnswerSessionSchema,
  ConfirmSessionSchema,
  OpenSessionSchema,
  PlanAnswer,
  PlanQuestion,
  PlanSessionRoundView,
  PlanSessionStatus,
  PlanSessionView,
  ProposeSessionSchema,
  ReviseSessionSchema,
  StartSessionSchema,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The statuses in which the owner may still answer a round.
const ANSWERABLE: string[] = ['ASKING', 'PROPOSED'];
// The statuses of a session that has ended.
const CLOSED: string[] = ['DONE', 'DISCARDED'];
// The key of the owner's edit of the summary in a round's first turn, for a kind that has no key of its own.
const EDITED_KEY = 'editedSummary';

// The sessions of the planning engine: start, answer, propose, revise, confirm, discard and view.
@Injectable()
export class ContentPlanSessionService {
  private readonly _logger = new Logger(ContentPlanSessionService.name);

  // Receives the storage of the sessions, the writer of the AI calls, the plan service (credits, workflow engine and the
  // parts of the setup the sessions share) and the kinds.
  constructor(
    private _sessionRepository: ContentPlanSessionRepository,
    private _contentPlanGenerator: ContentPlanGenerator,
    private _contentPlanService: ContentPlanService,
    private _kinds: PlanSessionKinds
  ) {}

  // The session the page draws: its status, the current round or proposal and what the caller may do.
  async view(org: PlanOrganization, sessionId: string): Promise<PlanSessionView> {
    return this.viewOf(org, await this.owned(org, sessionId));
  }

  // The open session of a kind in the workspace, so the page can resume it; null when there is none.
  async open(org: PlanOrganization, query: unknown): Promise<PlanSessionView | null> {
    const body = this._contentPlanService.parse(OpenSessionSchema, query);
    const session = await this._sessionRepository.findOpen(org.id, body.kind);
    return session ? this.viewOf(org, session) : null;
  }

  // Starts a session from the owner's first text and answers the first round. The open sessions of the same kind are
  // discarded. A first round that fails leaves no session behind.
  async start(org: PlanOrganization, input: unknown): Promise<PlanSessionView> {
    const body = this._contentPlanService.parse(StartSessionSchema, input);
    const kind = this._kinds.get(body.kind);
    if (!kind) {
      throw new InvalidPlanException([
        { path: 'kind', message: 'is not a kind of session' },
      ]);
    }
    const plan = await kind.planOf(org);
    const options = await kind.parseOptions(body.options ?? {}, org, plan);
    const session = await this._sessionRepository.create({
      organizationId: org.id,
      planId: plan.id,
      kind: kind.kind,
      sourceText: body.sourceText,
      options,
    });
    try {
      await this.writeRound(
        org,
        session,
        kind,
        0,
        [],
        stableJson({
          sourceText: body.sourceText,
          ...kind.openingOf?.(options),
        })
      );
    } catch (err) {
      await this._sessionRepository.release(session.id, { status: 'DISCARDED' });
      throw this._contentPlanService.aiError(err);
    }
    await this._sessionRepository.release(session.id);
    return this.view(org, session.id);
  }

  // Saves the answers and the owner's edit of the summary, then writes the next round from the whole chat so far. The
  // round may be an earlier one (the owner went back and changed it): the rounds after it, and a proposal written from
  // them, are dropped first, because they were written from the old answers.
  async answer(
    org: PlanOrganization,
    sessionId: string,
    input: unknown
  ): Promise<PlanSessionView> {
    const body = this._contentPlanService.parse(AnswerSessionSchema, input);
    const session = await this.owned(org, sessionId);
    const kind = this.kindOf(session);
    const all = await this._sessionRepository.rounds(session.id);
    const position = all.findIndex((round) => round.id === body.roundId);
    if (!ANSWERABLE.includes(session.status) || position < 0) {
      throw new PlanConflictException('ROUND_STALE');
    }
    const rounds = all.slice(0, position + 1);
    const latest = rounds[position];
    const answers = this._contentPlanService.resolveAnswers(
      latest.questions,
      body.answers
    );
    await this.claim(session.id, 'round');
    try {
      // read again now the session is held: a session closed since the first read is not taken back
      const held = await this._sessionRepository.findByOrganization(org.id, session.id);
      if (!held || !ANSWERABLE.includes(held.status)) {
        throw new PlanConflictException('ROUND_STALE');
      }
      // Going back to an earlier round (or to the last one after the proposal) changes what the later rounds and the
      // proposal were written from, so they are dropped, but only once the AI has written the new round: a failed
      // call leaves the session as it was.
      const rewinding = held.status === 'PROPOSED' || position < all.length - 1;
      const save = async () => {
        if (rewinding) {
          await this._sessionRepository.rewindTo(session.id, latest.index);
        }
        await this._sessionRepository.saveAnswers(session.id, latest.id, body.answers);
        // the owner's edit wins, and is saved before the AI is asked again
        await this._sessionRepository.update(session.id, { summary: body.summary });
      };
      if (!rewinding) {
        await save();
      }
      const turns = rounds.flatMap((round): ChatTurn[] => [
        { role: 'user', content: round.userTurn },
        { role: 'assistant', content: round.assistantTurn },
      ]);
      const editedSummary =
        body.summary.trim() === latest.summary.trim() ? null : body.summary;
      await this.writeRound(
        org,
        session,
        kind,
        latest.index + 1,
        turns,
        stableJson({ answers, [kind.editedKey ?? EDITED_KEY]: editedSummary }),
        rewinding ? save : undefined
      );
    } catch (err) {
      throw this._contentPlanService.aiError(err);
    } finally {
      await this._sessionRepository.release(session.id);
    }
    return this.view(org, session.id);
  }

  // Stores the summary and the answers of the last round, and starts the job that writes the proposal. The page polls
  // until the session is PROPOSED.
  async propose(
    org: PlanOrganization,
    sessionId: string,
    input: unknown
  ): Promise<PlanSessionView> {
    const body = this._contentPlanService.parse(ProposeSessionSchema, input);
    const session = await this.owned(org, sessionId);
    const kind = this.kindOf(session);
    if (CLOSED.includes(session.status)) {
      throw new PlanConflictException('SESSION_CLOSED');
    }
    const latest = await this._sessionRepository.latestRound(session.id);
    if (body.answers && !latest) {
      throw new PlanConflictException('ROUND_STALE');
    }
    if (body.answers && latest) {
      this._contentPlanService.resolveAnswers(latest.questions, body.answers);
    }
    if (body.options !== undefined && !kind.parseProposeOptions) {
      throw new InvalidPlanException([
        { path: 'options', message: 'this kind takes no options here' },
      ]);
    }
    const options =
      body.options !== undefined ? kind.parseProposeOptions?.(body.options, session) : undefined;
    await this.claim(session.id, 'proposal');
    try {
      if (body.answers && latest) {
        await this._sessionRepository.saveAnswers(session.id, latest.id, body.answers);
      }
      await this._sessionRepository.update(session.id, {
        summary: body.summary,
        ...(options ? { options } : {}),
        status: 'PROPOSING',
        notice: null,
      });
    } catch (err) {
      await this._sessionRepository.release(session.id, {
        status: session.status,
      });
      throw err;
    }
    await this._contentPlanService.launchJob(
      { kind: 'session_proposal', id: session.id },
      org.id,
      () => this._sessionRepository.release(session.id, { status: session.status })
    );
    return this.view(org, session.id);
  }

  // Asks for a new proposal after the owner's feedback, as the next turn of the proposal chat. 409 when the owner
  // answers a proposal that is no longer the latest.
  async revise(
    org: PlanOrganization,
    sessionId: string,
    input: unknown
  ): Promise<PlanSessionView> {
    const body = this._contentPlanService.parse(ReviseSessionSchema, input);
    const session = await this.owned(org, sessionId);
    if (
      session.status !== 'PROPOSED' ||
      session.proposalVersion !== body.proposalVersion
    ) {
      throw new PlanConflictException('PROPOSAL_STALE');
    }
    await this.claim(session.id, 'proposal');
    try {
      await this._sessionRepository.update(session.id, {
        status: 'PROPOSING',
        notice: null,
      });
    } catch (err) {
      await this._sessionRepository.release(session.id);
      throw err;
    }
    await this._contentPlanService.launchJob(
      { kind: 'session_revise', id: session.id, feedback: body.feedback },
      org.id,
      () => this._sessionRepository.release(session.id, { status: 'PROPOSED' })
    );
    return this.view(org, session.id);
  }

  // Makes the proposal real through the kind, with the owner's edits, and ends the session. The session is held while the
  // kind works, so the same proposal cannot be confirmed twice.
  async confirm(
    org: PlanOrganization,
    sessionId: string,
    input: unknown
  ): Promise<PlanSessionView> {
    const body = this._contentPlanService.parse(ConfirmSessionSchema, input);
    const session = await this.owned(org, sessionId);
    const kind = this.kindOf(session);
    if (
      session.status !== 'PROPOSED' ||
      !session.proposal ||
      session.proposalVersion !== body.proposalVersion
    ) {
      throw new PlanConflictException('PROPOSAL_STALE');
    }
    await this.claim(session.id, 'confirm');
    try {
      const held = await this._sessionRepository.findWithOrganization(session.id);
      await kind.confirm(held, body.edits ?? {});
      await this._sessionRepository.release(session.id, {
        status: 'DONE',
        confirmedAt: new Date(),
      });
    } catch (err) {
      await this._sessionRepository.release(session.id);
      throw err;
    }
    return this.view(org, session.id);
  }

  // Ends the session without using its proposal. A job that is still writing is let go: its answer is dropped.
  async discard(org: PlanOrganization, sessionId: string): Promise<PlanSessionView> {
    const session = await this.owned(org, sessionId);
    if (session.status === 'DONE') {
      throw new PlanConflictException('SESSION_CLOSED');
    }
    await this._sessionRepository.release(session.id, { status: 'DISCARDED' });
    return this.view(org, session.id);
  }

  // The proposal job (called by the activity): the kind writes the proposal from the session, as the next turn of the
  // stored chat on a revise (`feedback` is the owner's words); the service stores it and the chat. A session that is no
  // longer PROPOSING (discarded, or already answered) is left alone. A failure is thrown, and the job's failure path
  // calls `sessionFailed`.
  async buildProposal(sessionId: string, feedback: string | null) {
    const session = await this._sessionRepository.findWithOrganization(sessionId);
    if (!session) {
      throw new PlanNotFoundException('SESSION_NOT_FOUND');
    }
    if (session.status !== 'PROPOSING') {
      return;
    }
    const kind = this.kindOf(session);
    const earlier = feedback ? storedTurns(session.proposalTurns) : [];
    const draft = kind.proposalAction
      ? await this._contentPlanService.charge(
          session.organizationId,
          session.planId,
          kind.proposalAction,
          () => kind.buildProposal(session, earlier, feedback)
        )
      : await kind.buildProposal(session, earlier, feedback);
    const saved = await this._sessionRepository.saveProposal(session.id, {
      proposal: draft.proposal,
      proposalVersion: session.proposalVersion + 1,
      proposalTurns: [
        ...earlier,
        { role: 'user', content: draft.userTurn },
        { role: 'assistant', content: draft.assistantTurn },
      ],
    });
    if (!saved) {
      // the session was discarded while the proposal was written: the answer is dropped
      this._logger.log(`content plan: session proposal dropped session=${session.id}`);
    }
  }

  // The failure path of a proposal or revise job: the session is free again, back where it was (asking, or proposed
  // with the proposal it had), and the owner is told it did not work.
  async sessionFailed(sessionId: string) {
    const session = await this._sessionRepository.findWithOrganization(sessionId);
    if (!session) {
      return;
    }
    await this._sessionRepository.release(session.id, {
      notice: 'proposal_failed',
      ...(session.status === 'PROPOSING'
        ? { status: session.proposal ? 'PROPOSED' : 'ASKING' }
        : {}),
    });
  }

  // The session of the workspace; 404 SESSION_NOT_FOUND when it has none (also for one of another workspace).
  private async owned(org: PlanOrganization, sessionId: string) {
    const session = await this._sessionRepository.findByOrganization(org.id, sessionId);
    if (!session) {
      throw new PlanNotFoundException('SESSION_NOT_FOUND');
    }
    return session;
  }

  // The kind of a stored session; 404 SESSION_KIND_NOT_FOUND when this deployment no longer has it.
  private kindOf(session: PlanSession): PlanSessionKind {
    const kind = this._kinds.get(session.kind);
    if (!kind) {
      throw new PlanNotFoundException('SESSION_KIND_NOT_FOUND');
    }
    return kind;
  }

  // Takes the session for a job or a round; 409 PLAN_BUSY when another one holds it.
  private async claim(sessionId: string, busy: string) {
    if (!(await this._sessionRepository.claimBusy(sessionId, busy))) {
      throw new PlanConflictException('PLAN_BUSY');
    }
  }

  // The round written from the chat so far on the kind's frame, saved with the exact texts of its turns.
  private writeRound(
    org: PlanOrganization,
    session: PlanSession,
    kind: PlanSessionKind,
    index: number,
    turns: ChatTurn[],
    newUserTurn: string,
    beforeSave?: () => Promise<void>
  ) {
    return this._contentPlanService.writeChatRound(
      org,
      session.planId,
      (input) =>
        this._contentPlanGenerator.chatRound(kind.roundFrame, input, kind.roundHints),
      turns,
      newUserTurn,
      (round) =>
        this._sessionRepository.saveRound({
          sessionId: session.id,
          index,
          summary: round.direction,
          questions: round.questions,
          readyForPlan: round.readyForPlan,
          userTurn: newUserTurn,
          assistantTurn: round.assistantTurn,
        }),
      beforeSave
    );
  }

  // The session as the page draws it.
  private async viewOf(
    org: PlanOrganization,
    session: PlanSession
  ): Promise<PlanSessionView> {
    const kind = this.kindOf(session);
    const rounds = await this._sessionRepository.rounds(session.id);
    const views = rounds.map(
      (item, index): PlanSessionRoundView => ({
        id: item.id,
        index: item.index,
        summary: this.summaryOf(item, rounds[index + 1], session, kind),
        questions: item.questions as unknown as PlanQuestion[],
        answers: (item.answers as unknown as PlanAnswer[] | null) ?? null,
        readyForPlan: item.readyForPlan,
      })
    );
    return {
      id: session.id,
      kind: session.kind,
      status: session.status as PlanSessionStatus,
      canEdit: canEditRole(org.users?.[0]?.role),
      sourceText: session.sourceText,
      summary: session.summary,
      options: (session.options as Record<string, unknown> | null) ?? null,
      busy: session.busy,
      notice: session.notice,
      round: views[views.length - 1] ?? null,
      rounds: views,
      proposalVersion: session.proposalVersion,
      proposal:
        session.status === 'PROPOSED' && session.proposal
          ? kind.viewOf(session.proposal)
          : null,
    };
  }

  // The summary of a round as the owner left it (see `roundSummary`); the latest round's is the session's own.
  private summaryOf(
    round: { summary: string },
    next: { userTurn: string } | undefined,
    session: PlanSession,
    kind: PlanSessionKind
  ) {
    return roundSummary(round, next, session.summary, kind.editedKey ?? EDITED_KEY);
  }
}
