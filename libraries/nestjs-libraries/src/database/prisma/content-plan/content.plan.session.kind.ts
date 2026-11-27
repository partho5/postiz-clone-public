// Content plan session kinds: the one place that tells the generic session procedure (start, rounds, proposal, revise,
// confirm) what a kind of work (a set of videos, a future feature) is made of. One implementation of `PlanSessionKind`
// per kind, registered by its `kind` string; the generic service looks it up and never names a kind.
import { Injectable } from '@nestjs/common';
import { ContentPlan, PlanSession, Prisma } from '@prisma/client';
import { ChatTurn } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import { PlannerPromptKey } from '@gitroom/nestjs-libraries/database/prisma/content-plan/prompts';
import { RoundFieldHints } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import { PlanOrganization } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';

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
  // The field hints of the rounds' answer schema, when the kind words them itself; the setup's when it has none.
  roundHints?: RoundFieldHints;
  // The key under which the first turn of a round after the owner's answers carries the owner's edit of the summary;
  // 'editedSummary' when the kind has none of its own (the setup's stored chats call the summary its direction).
  editedKey?: string;
  // The action the proposal and the revise are charged on as one call; absent when the kind books each of its AI calls
  // itself (the setup's proposal is several calls on several actions).
  proposalAction?: string;
  // The plan the session belongs to: the one the setup makes, or the running plan a kind works inside (the kind refuses
  // when the workspace has none, so no plan row is made for it).
  planOf(org: PlanOrganization): Promise<ContentPlan>;
  // The kind's start options as they are stored, checked against the workspace and its plan; throws
  // InvalidPlanException when they are not valid.
  parseOptions(
    options: unknown,
    org: PlanOrganization,
    plan: ContentPlan
  ): Prisma.InputJsonObject | Promise<Prisma.InputJsonObject>;
  // The options the owner sends with the proposal request, checked and merged over the stored ones; absent when the kind
  // takes none there. Throws InvalidPlanException when they are not valid.
  parseProposeOptions?(
    options: unknown,
    session: PlanSession
  ): Prisma.InputJsonObject;
  // What the kind adds to the first turn of the rounds, next to the owner's first text, from the stored options.
  openingOf?(options: Prisma.InputJsonObject): Record<string, unknown>;
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
