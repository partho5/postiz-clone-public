// Content plan sessions: reads and writes a workspace's sessions of the planning engine and their rounds. Every query
// that takes an id of a session also filters by the workspace, except the jobs', which know only the session id.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ChatTurn } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import {
  PlanAnswer,
  PlanQuestion,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// A session that has just been asked for.
export interface NewPlanSession {
  organizationId: string;
  planId: string;
  kind: string;
  sourceText: string;
  options: Prisma.InputJsonObject;
}

// A round of a session as `saveRound` stores it.
export interface NewSessionRound {
  sessionId: string;
  index: number;
  summary: string;
  questions: PlanQuestion[];
  readyForPlan: boolean;
  userTurn: string;
  assistantTurn: string;
}

// What the proposal job saves once the proposal is written.
export interface SavedSessionProposal {
  proposal: Prisma.InputJsonObject;
  proposalVersion: number;
  proposalTurns: ChatTurn[];
}

// The statuses of a session that is still open.
const OPEN_STATUSES = ['ASKING', 'PROPOSING', 'PROPOSED'];

@Injectable()
export class ContentPlanSessionRepository {
  // Receives the Prisma repositories for the sessions and their rounds, and the transaction.
  constructor(
    private _session: PrismaRepository<'planSession'>,
    private _round: PrismaRepository<'planSessionRound'>,
    private _transaction: PrismaTransaction
  ) {}

  // A session of a workspace, or null (also for one of another workspace).
  findByOrganization(organizationId: string, id: string) {
    return this._session.model.planSession.findFirst({
      where: { id, organizationId },
    });
  }

  // A session with the brand columns the AI calls are made from (for the jobs, which know only the session id).
  findWithOrganization(id: string) {
    return this._session.model.planSession.findUnique({
      where: { id },
      include: {
        organization: {
          select: { id: true, name: true, locale: true, timezone: true },
        },
      },
    });
  }

  // Starts a session already held by its first round. The open sessions of the same kind of the workspace are
  // discarded: the owner starts over.
  async create(session: NewPlanSession) {
    const [, created] = await this._transaction.model.$transaction([
      this._session.model.planSession.updateMany({
        where: {
          organizationId: session.organizationId,
          kind: session.kind,
          status: { in: OPEN_STATUSES },
        },
        data: { status: 'DISCARDED', busy: null },
      }),
      this._session.model.planSession.create({
        data: { ...session, busy: 'round' },
      }),
    ]);
    return created;
  }

  // Writes the given fields of a session.
  update(id: string, data: Prisma.PlanSessionUncheckedUpdateInput) {
    return this._session.model.planSession.update({ where: { id }, data });
  }

  // Marks the session as busy with a job or a round; false when another one already holds it.
  async claimBusy(id: string, busy: string) {
    const { count } = await this._session.model.planSession.updateMany({
      where: { id, busy: null },
      data: { busy },
    });
    return count === 1;
  }

  // Marks the session as not busy, with any other fields the end of the job changes.
  release(id: string, data: Prisma.PlanSessionUncheckedUpdateInput = {}) {
    return this.update(id, { ...data, busy: null });
  }

  // The rounds of a session, first to last.
  rounds(sessionId: string) {
    return this._round.model.planSessionRound.findMany({
      where: { sessionId },
      orderBy: { index: 'asc' },
    });
  }

  // The latest round of a session, or null.
  latestRound(sessionId: string) {
    return this._round.model.planSessionRound.findFirst({
      where: { sessionId },
      orderBy: { index: 'desc' },
    });
  }

  // Takes the session back to the round at `index`: the rounds after it are removed and a proposal written from them is
  // dropped, so that round is the latest again.
  rewindTo(sessionId: string, index: number) {
    return this._transaction.model.$transaction([
      this._round.model.planSessionRound.deleteMany({
        where: { sessionId, index: { gt: index } },
      }),
      this._session.model.planSession.update({
        where: { id: sessionId },
        data: {
          status: 'ASKING',
          proposal: Prisma.DbNull,
          proposalTurns: Prisma.DbNull,
          notice: null,
        },
      }),
    ]);
  }

  // Saves a round and makes its summary the session's, in one write.
  saveRound(round: NewSessionRound) {
    return this._transaction.model.$transaction([
      this._round.model.planSessionRound.create({
        data: {
          sessionId: round.sessionId,
          index: round.index,
          summary: round.summary,
          questions: round.questions as unknown as Prisma.InputJsonValue,
          readyForPlan: round.readyForPlan,
          userTurn: round.userTurn,
          assistantTurn: round.assistantTurn,
        },
      }),
      this._session.model.planSession.update({
        where: { id: round.sessionId },
        data: { summary: round.summary },
      }),
    ]);
  }

  // Stores the owner's answers on a round of the session.
  saveAnswers(sessionId: string, roundId: string, answers: PlanAnswer[]) {
    return this._round.model.planSessionRound.updateMany({
      where: { id: roundId, sessionId },
      data: { answers: answers as unknown as Prisma.InputJsonValue },
    });
  }

  // Saves the written proposal and moves the session to PROPOSED, but only while the proposal job still holds it (a
  // discard in the meantime ends it, and the late answer is dropped). Returns whether it was saved.
  async saveProposal(id: string, saved: SavedSessionProposal) {
    const { count } = await this._session.model.planSession.updateMany({
      where: { id, busy: 'proposal', status: 'PROPOSING' },
      data: {
        status: 'PROPOSED',
        proposal: saved.proposal,
        proposalVersion: saved.proposalVersion,
        proposalTurns: saved.proposalTurns as unknown as Prisma.InputJsonValue,
        busy: null,
        notice: null,
      },
    });
    return count === 1;
  }
}
