// Content plan session kinds: the one place that tells the generic session procedure (start, rounds, proposal, revise,
// confirm) what a kind of work (a set of videos, a future feature) is made of. One implementation of `PlanSessionKind`
// per kind, registered by its `kind` string; the generic service looks it up and never names a kind.
import { Injectable } from '@nestjs/common';
import { PlanSession, Prisma } from '@prisma/client';
import { ChatTurn } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import { PlannerPromptKey } from '@gitroom/nestjs-libraries/database/prisma/content-plan/prompts';

// A session with the brand columns the AI calls and the confirmation are made from.
export type PlanSessionForWrite = PlanSession & {
  organization: {
    id: string;
    name: string;
    locale: string | null;
    timezone: string | null;
  };
};

// What a kind writes for a proposal: the proposal as stored, the user turn it sent and the model's raw answer, which
// the service stores as the chat so the next revise re-sends it byte for byte.
export interface SessionProposalDraft {
  proposal: Prisma.InputJsonObject;
  userTurn: string;
  assistantTurn: string;
}

// One kind of session. The kind makes its own AI calls and the rows its confirmation creates; the service holds the
// session, charges the calls and keeps the chat.
export interface PlanSessionKind {
  // The name stored in `PlanSession.kind`.
  kind: string;
  // The prompt key of the frame the question rounds are written on.
  roundFrame: PlannerPromptKey;
  // The kind's start options as they are stored; throws InvalidPlanException when they are not valid.
  parseOptions(options: unknown): Prisma.InputJsonObject;
  // Writes the proposal from the session (its summary, options and answers). `turns` is the earlier proposal chat (empty
  // for the first proposal); `feedback` is the owner's words of a revise, else null. Failures are thrown.
  buildProposal(
    session: PlanSessionForWrite,
    turns: ChatTurn[],
    feedback: string | null
  ): Promise<SessionProposalDraft>;
  // Makes the proposal real, with the owner's `edits` (the kind checks them and throws InvalidPlanException).
  confirm(session: PlanSessionForWrite, edits: unknown): Promise<void>;
  // The proposal as the page draws it.
  viewOf(proposal: Prisma.JsonValue): unknown;
}

// The kinds the service can run, by name.
@Injectable()
export class PlanSessionKinds {
  private readonly _kinds = new Map<string, PlanSessionKind>();

  // Makes a kind known to the service; a kind registers itself when it is created.
  register(kind: PlanSessionKind) {
    this._kinds.set(kind.kind, kind);
  }

  // The kind with that name, or undefined when there is none.
  get(kind: string) {
    return this._kinds.get(kind);
  }
}
