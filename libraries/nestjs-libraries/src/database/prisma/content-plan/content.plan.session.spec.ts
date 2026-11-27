// Content plan sessions: the planning engine's interview -> proposal -> confirm procedure, run against a test kind. Needs
// no network, database or Temporal: the storage is an in-memory stand-in, and the generator, the credits and the workflow
// engine are stubs. Covers start (the first round, the kind's options, a second start replacing the open session, a
// failed first round leaving no session), answer (the append-only chat, the owner's summary saved first, a stale round, a
// rewind that waits for the AI), propose and revise (the job started, the proposal and its chat saved, a stale version),
// confirm (the kind's confirmation, a second confirm refused, a failing kind releasing the session), discard, the busy
// claim, the charges on the setup's action names and the failure path of the jobs (busy released, notice set).
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { Role } from '@prisma/client';
import {
  ContentPlanService,
  InvalidPlanException,
  PlanOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import {
  PlanAiFailed,
  PlanNotConfigured,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import { ContentPlanSessionService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.service';
import { PlanSessionKinds } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.kind';
import { stableJson } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.repository',
  () => ({ ContentPlanRepository: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.repository',
  () => ({ ContentPlanSessionRepository: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/credits/credits.service',
  () => ({ CreditsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service',
  () => ({ AccountsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/brands/brands.repository',
  () => ({ BrandsRepository: class {} })
);
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

const ORG = 'org-1';

const org = (id = ORG, role: Role = Role.ADMIN): PlanOrganization =>
  ({
    id,
    name: 'Bakery',
    locale: 'en',
    timezone: 'UTC',
    profile: { schemaVersion: 1 },
    users: [{ role }],
  }) as unknown as PlanOrganization;

// The storage of the sessions, in memory, with the behaviour the service relies on.
class FakeSessionRepository {
  sessions: any[] = [];
  roundRows: any[] = [];
  calls: string[] = [];

  private find = (id: string) => this.sessions.find((row) => row.id === id);

  findByOrganization = async (organizationId: string, id: string) =>
    this.sessions.find((row) => row.id === id && row.organizationId === organizationId) ??
    null;
  findWithOrganization = async (id: string) => {
    const row = this.find(id);
    return (
      row && {
        ...row,
        organization: { id: row.organizationId, name: 'Bakery', locale: 'en', timezone: 'UTC' },
      }
    );
  };
  create = async (session: any) => {
    this.sessions
      .filter(
        (row) =>
          row.organizationId === session.organizationId &&
          row.kind === session.kind &&
          ['ASKING', 'PROPOSING', 'PROPOSED'].includes(row.status)
      )
      .forEach((row) => Object.assign(row, { status: 'DISCARDED', busy: null }));
    const row = {
      ...session,
      id: `session-${this.sessions.length + 1}`,
      status: 'ASKING',
      summary: null,
      proposal: null,
      proposalVersion: 0,
      proposalTurns: null,
      busy: 'round',
      notice: null,
      confirmedAt: null,
    };
    this.sessions.push(row);
    return row;
  };
  update = async (id: string, data: any) => Object.assign(this.find(id), data);
  claimBusy = async (id: string, busy: string) => {
    if (this.find(id).busy) {
      return false;
    }
    this.find(id).busy = busy;
    return true;
  };
  release = async (id: string, data: any = {}) =>
    Object.assign(this.find(id), data, { busy: null });
  rounds = async (sessionId: string) =>
    this.roundRows
      .filter((row) => row.sessionId === sessionId)
      .sort((a, b) => a.index - b.index);
  latestRound = async (sessionId: string) => (await this.rounds(sessionId)).slice(-1)[0] ?? null;
  rewindTo = async (sessionId: string, index: number) => {
    this.calls.push('rewindTo');
    this.roundRows = this.roundRows.filter(
      (row) => row.sessionId !== sessionId || row.index <= index
    );
    Object.assign(this.find(sessionId), {
      status: 'ASKING',
      proposal: null,
      proposalTurns: null,
      notice: null,
    });
  };
  saveRound = async (round: any) => {
    this.roundRows.push({ ...round, id: `round-${round.index}`, answers: null });
    this.find(round.sessionId).summary = round.summary;
  };
  saveAnswers = async (sessionId: string, roundId: string, answers: any) => {
    this.roundRows.find((row) => row.id === roundId && row.sessionId === sessionId).answers =
      answers;
  };
  saveProposal = async (id: string, saved: any) => {
    const row = this.find(id);
    if (row.busy !== 'proposal' || row.status !== 'PROPOSING') {
      return false;
    }
    Object.assign(row, {
      status: 'PROPOSED',
      proposal: saved.proposal,
      proposalVersion: saved.proposalVersion,
      proposalTurns: saved.proposalTurns,
      busy: null,
      notice: null,
    });
    return true;
  };
}

const question = {
  id: 'q1',
  text: 'Who watches?',
  options: [
    { id: 'o1', label: 'Locals' },
    { id: 'o2', label: 'Tourists' },
  ],
  recommendedOptionId: 'o1',
};

const roundAnswer = (extra = {}) => ({
  direction: 'We bake for locals',
  questions: [question],
  readyForPlan: false,
  assistantTurn: '{"raw":"assistant text"}',
  usage: { prompt: 1, cached: 0, completion: 1 },
  ...extra,
});

// The one kind the specs run: its proposal is the summary and the feedback, so a test can see what it was written from.
const buildKind = () => {
  let written = 0;
  const kind = {
    kind: 'test',
    roundFrame: 'planner.frame.setup' as const,
    proposalAction: 'plan.proposal',
    planOf: jest.fn(async (_org: unknown) => ({ id: 'plan-1', organizationId: ORG }) as any),
    parseOptions: jest.fn((options: any) => {
      if (options.count !== undefined && typeof options.count !== 'number') {
        throw new InvalidPlanException([{ path: 'options.count', message: 'must be a number' }]);
      }
      return { count: options.count ?? 1 };
    }),
    buildProposal: jest.fn(async (session: any, _turns: any[], feedback: string | null) => {
      written += 1;
      return {
        proposal: { items: [session.summary, feedback], written },
        userTurn: stableJson(feedback ? { feedback } : { summary: session.summary }),
        assistantTurn: `{"raw":"proposal ${written}"}`,
      };
    }),
    confirm: jest.fn(async (_session: any, _edits: unknown): Promise<void> => undefined),
    viewOf: jest.fn((proposal: any) => ({ shown: proposal.items })),
  };
  return kind;
};

const build = (generatorOverrides: Record<string, any> = {}) => {
  const repository = new FakeSessionRepository();
  const planRepository = { ensure: jest.fn(async () => ({ id: 'plan-1', organizationId: ORG })) };
  const generator: Record<string, jest.Mock> = {
    chatRound: jest.fn().mockResolvedValue(roundAnswer()),
    ...generatorOverrides,
  };
  const spend = jest.fn((request: any, run: () => Promise<unknown>) => run());
  const start = jest.fn().mockResolvedValue(undefined);
  const temporal = { client: { getRawClient: () => ({ workflow: { start } }) } };
  const plans = new ContentPlanService(
    planRepository as any,
    generator as any,
    { spend } as any,
    temporal as any,
    repository as any
  );
  const kind = buildKind();
  kind.planOf.mockImplementation(async () => planRepository.ensure() as any);
  const kinds = new PlanSessionKinds();
  kinds.register(kind);
  const service = new ContentPlanSessionService(
    repository as any,
    generator as any,
    plans,
    kinds
  );
  return { service, repository, generator, spend, start, kind };
};

// The code of an HttpException a call rejects with, or undefined when it resolves.
const codeOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return (err as any).getResponse?.().code ?? (err as Error).name;
  }
  return undefined;
};

// A session of one round, ready to answer.
const withRound = async (ctx: ReturnType<typeof build>) => {
  await ctx.service.start(org(), { kind: 'test', sourceText: 'We bake bread' });
  return ctx;
};

// A session whose proposal is written (version 1) by the job.
const withProposal = async (ctx: ReturnType<typeof build>) => {
  await withRound(ctx);
  await ctx.service.propose(org(), 'session-1', { summary: 'We bake for locals' });
  await ctx.service.buildProposal('session-1', null);
  return ctx;
};

describe('ContentPlanSessionService start', () => {
  it('writes round 0 from the source text on the kind frame, spends on plan.setup_round and frees the session', async () => {
    const { service, generator, spend, repository } = build();
    const view = await service.start(org(), {
      kind: 'test',
      sourceText: ' We bake bread ',
      options: { count: 3 },
    });
    expect(generator.chatRound).toHaveBeenCalledTimes(1);
    const [frame, input] = generator.chatRound.mock.calls[0];
    expect(frame).toBe('planner.frame.setup');
    expect(input).toMatchObject({ orgId: ORG, turns: [] });
    expect(input.newUserTurn).toBe(stableJson({ sourceText: 'We bake bread' }));
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      actionKey: 'plan.setup_round',
      metadata: { planId: 'plan-1' },
    });
    expect(view.status).toBe('ASKING');
    expect(view.kind).toBe('test');
    expect(view.options).toEqual({ count: 3 });
    expect(view.summary).toBe('We bake for locals');
    expect(view.round?.index).toBe(0);
    expect(view.round?.questions).toHaveLength(1);
    expect(view.busy).toBeNull();
    expect(repository.roundRows[0].userTurn).toBe(stableJson({ sourceText: 'We bake bread' }));
    expect(repository.roundRows[0].assistantTurn).toBe('{"raw":"assistant text"}');
  });

  it('refuses an unknown kind, bad options and a bad body with 400 INVALID_PLAN and writes nothing', async () => {
    const { service, generator, repository } = build();
    expect(await codeOf(service.start(org(), { kind: 'nope', sourceText: 'x' }))).toBe(
      'INVALID_PLAN'
    );
    expect(
      await codeOf(service.start(org(), { kind: 'test', sourceText: 'x', options: { count: 'a' } }))
    ).toBe('INVALID_PLAN');
    expect(await codeOf(service.start(org(), { kind: 'test', sourceText: '' }))).toBe(
      'INVALID_PLAN'
    );
    expect(await codeOf(service.start(org(), { kind: 'test', sourceText: 'x', extra: 1 }))).toBe(
      'INVALID_PLAN'
    );
    expect(generator.chatRound).not.toHaveBeenCalled();
    expect(repository.sessions).toHaveLength(0);
  });

  it('discards the open session of the kind when the owner starts another', async () => {
    const ctx = await withRound(build());
    await ctx.service.start(org(), { kind: 'test', sourceText: 'Another idea' });
    expect(ctx.repository.sessions.map((row) => row.status)).toEqual(['DISCARDED', 'ASKING']);
  });

  it('turns a refused planner into 503, a failed call into 502, and leaves no open session', async () => {
    const refused = build({ chatRound: jest.fn().mockRejectedValue(new PlanNotConfigured()) });
    expect(
      await codeOf(refused.service.start(org(), { kind: 'test', sourceText: 'x' }))
    ).toBe('PLAN_NOT_AVAILABLE');
    expect(refused.repository.sessions[0]).toMatchObject({ status: 'DISCARDED', busy: null });
    const failed = build({ chatRound: jest.fn().mockRejectedValue(new PlanAiFailed()) });
    expect(await codeOf(failed.service.start(org(), { kind: 'test', sourceText: 'x' }))).toBe(
      'PLAN_AI_FAILED'
    );
    expect(failed.repository.sessions[0]).toMatchObject({ status: 'DISCARDED', busy: null });
    expect(failed.repository.roundRows).toHaveLength(0);
  });
});

describe('ContentPlanSessionService answer', () => {
  it('refuses a round that is not in the session with 409 ROUND_STALE', async () => {
    const ctx = await withRound(build());
    expect(
      await codeOf(
        ctx.service.answer(org(), 'session-1', { roundId: 'nope', summary: 's', answers: [] })
      )
    ).toBe('ROUND_STALE');
    expect(ctx.generator.chatRound).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer to a session that has ended with 409 ROUND_STALE', async () => {
    const ctx = await withRound(build());
    await ctx.service.discard(org(), 'session-1');
    expect(
      await codeOf(
        ctx.service.answer(org(), 'session-1', { roundId: 'round-0', summary: 's', answers: [] })
      )
    ).toBe('ROUND_STALE');
  });

  it('refuses an answer to a question or option that is not in the round', async () => {
    const ctx = await withRound(build());
    expect(
      await codeOf(
        ctx.service.answer(org(), 'session-1', {
          roundId: 'round-0',
          summary: 's',
          answers: [{ questionId: 'q9', optionId: 'o1' }],
        })
      )
    ).toBe('INVALID_PLAN');
    expect(
      await codeOf(
        ctx.service.answer(org(), 'session-1', {
          roundId: 'round-0',
          summary: 's',
          answers: [{ questionId: 'q1', optionId: 'o9' }],
        })
      )
    ).toBe('INVALID_PLAN');
  });

  it('saves the owner summary before the next round and sends the chat append-only without ids', async () => {
    const ctx = await withRound(build());
    let summaryWhenAsked: string | null = null;
    ctx.generator.chatRound.mockImplementationOnce(async () => {
      summaryWhenAsked = ctx.repository.sessions[0].summary;
      return roundAnswer({ direction: 'Next summary', assistantTurn: '{"raw":"second"}' });
    });
    const view = await ctx.service.answer(org(), 'session-1', {
      roundId: 'round-0',
      summary: 'We bake sourdough for locals',
      answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
    });
    expect(summaryWhenAsked).toBe('We bake sourdough for locals');
    const [frame, call] = ctx.generator.chatRound.mock.calls[1];
    expect(frame).toBe('planner.frame.setup');
    expect(call.turns).toEqual([
      { role: 'user', content: stableJson({ sourceText: 'We bake bread' }) },
      { role: 'assistant', content: '{"raw":"assistant text"}' },
    ]);
    expect(call.newUserTurn).toBe(
      stableJson({
        answers: [{ question: 'Who watches?', answer: 'Tourists' }],
        editedSummary: 'We bake sourdough for locals',
      })
    );
    expect(call.newUserTurn).not.toContain('o2');
    expect(view.round?.index).toBe(1);
    expect(view.summary).toBe('Next summary');
    expect(view.busy).toBeNull();
    expect(ctx.repository.roundRows[0].answers).toEqual([
      { questionId: 'q1', optionId: 'o2', optionIds: [], other: null },
    ]);
    expect(ctx.repository.roundRows[1].userTurn).toBe(call.newUserTurn);
    expect(ctx.repository.roundRows[1].assistantTurn).toBe('{"raw":"second"}');
  });

  it('sends null for an unedited summary, and the owner own words when given', async () => {
    const ctx = await withRound(build());
    await ctx.service.answer(org(), 'session-1', {
      roundId: 'round-0',
      summary: 'We bake for locals',
      answers: [{ questionId: 'q1', optionId: 'o1', other: 'Mostly cafes' }],
    });
    expect(ctx.generator.chatRound.mock.calls[1][1].newUserTurn).toBe(
      stableJson({
        answers: [{ question: 'Who watches?', answer: 'Mostly cafes' }],
        editedSummary: null,
      })
    );
  });

  it('shows every round with its answers and the summary as the owner left it', async () => {
    const ctx = await withRound(build());
    await ctx.service.answer(org(), 'session-1', {
      roundId: 'round-0',
      summary: 'We bake sourdough for locals',
      answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
    });
    const view = await ctx.service.view(org(), 'session-1');
    expect(view.rounds.map((round) => round.index)).toEqual([0, 1]);
    expect(view.rounds[0].summary).toBe('We bake sourdough for locals');
    expect(view.rounds[0].answers).toEqual([
      { questionId: 'q1', optionId: 'o2', optionIds: [], other: null },
    ]);
    expect(view.rounds[1].answers).toBeNull();
    expect(view.rounds[1].summary).toBe(view.summary);
    expect(view.round?.id).toBe(view.rounds[1].id);
  });

  it('answering an earlier round drops the rounds after it and writes the next one from the changed answers', async () => {
    const ctx = await withRound(build());
    await ctx.service.answer(org(), 'session-1', {
      roundId: 'round-0',
      summary: 'We bake bread',
      answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
    });
    ctx.repository.calls.length = 0;
    const view = await ctx.service.answer(org(), 'session-1', {
      roundId: 'round-0',
      summary: 'We bake bread',
      answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
    });
    expect(ctx.repository.calls).toContain('rewindTo');
    expect(view.rounds.map((round) => round.index)).toEqual([0, 1]);
    const call = ctx.generator.chatRound.mock.calls[2][1];
    expect(call.turns).toHaveLength(2);
    expect(call.newUserTurn).toContain('Tourists');
    expect(ctx.repository.roundRows[0].answers[0].optionId).toBe('o2');
  });

  it('keeps the later rounds and the old answers when the AI fails while going back to an earlier round', async () => {
    const ctx = await withRound(build());
    await ctx.service.answer(org(), 'session-1', {
      roundId: 'round-0',
      summary: 'We bake bread',
      answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
    });
    ctx.generator.chatRound.mockRejectedValueOnce(new Error('model down'));
    await expect(
      ctx.service.answer(org(), 'session-1', {
        roundId: 'round-0',
        summary: 'We bake bread',
        answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
      })
    ).rejects.toBeDefined();
    expect(ctx.repository.calls).not.toContain('rewindTo');
    expect(ctx.repository.roundRows).toHaveLength(2);
    expect(ctx.repository.roundRows[0].answers[0].optionId).toBe('o1');
    expect(ctx.repository.sessions[0].busy).toBeNull();
  });

  it('answering the last round after the proposal drops the proposal and goes back to ASKING', async () => {
    const ctx = await withProposal(build());
    expect(ctx.repository.sessions[0].status).toBe('PROPOSED');
    const view = await ctx.service.answer(org(), 'session-1', {
      roundId: 'round-0',
      summary: 'We bake for tourists',
      answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
    });
    expect(ctx.repository.calls).toContain('rewindTo');
    expect(view.status).toBe('ASKING');
    expect(view.proposal).toBeNull();
    expect(ctx.repository.sessions[0].proposal).toBeNull();
    expect(ctx.repository.sessions[0].proposalTurns).toBeNull();
  });
});

describe('ContentPlanSessionService propose', () => {
  it('holds the session, starts the proposal job and stores the summary and the answers', async () => {
    const ctx = await withRound(build());
    const view = await ctx.service.propose(org(), 'session-1', {
      summary: 'We bake sourdough',
      answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
    });
    expect(ctx.start).toHaveBeenCalledTimes(1);
    const [workflow, options] = ctx.start.mock.calls[0];
    expect(workflow).toBe('contentPlanJobWorkflow');
    expect(options.workflowId).toBe('content_plan_session_proposal_session-1');
    expect(options.args).toEqual([{ kind: 'session_proposal', id: 'session-1' }]);
    expect(view.status).toBe('PROPOSING');
    expect(view.busy).toBe('proposal');
    expect(view.summary).toBe('We bake sourdough');
    expect(view.proposal).toBeNull();
    expect(ctx.repository.roundRows[0].answers[0].optionId).toBe('o1');
  });

  it('refuses an answer that is not in the round, and a session that has ended', async () => {
    const ctx = await withRound(build());
    expect(
      await codeOf(
        ctx.service.propose(org(), 'session-1', {
          summary: 's',
          answers: [{ questionId: 'q9', optionId: 'o1' }],
        })
      )
    ).toBe('INVALID_PLAN');
    expect(ctx.repository.sessions[0].busy).toBeNull();
    await ctx.service.discard(org(), 'session-1');
    expect(await codeOf(ctx.service.propose(org(), 'session-1', { summary: 's' }))).toBe(
      'SESSION_CLOSED'
    );
    expect(ctx.start).not.toHaveBeenCalled();
  });

  it('writes the proposal in the job on the plan.proposal action and saves it with its chat', async () => {
    const ctx = await withRound(build());
    await ctx.service.propose(org(), 'session-1', { summary: 'We bake sourdough' });
    ctx.spend.mockClear();
    await ctx.service.buildProposal('session-1', null);
    expect(ctx.kind.buildProposal).toHaveBeenCalledTimes(1);
    const [session, turns, feedback] = ctx.kind.buildProposal.mock.calls[0];
    expect(session.summary).toBe('We bake sourdough');
    expect(session.organization.id).toBe(ORG);
    expect(turns).toEqual([]);
    expect(feedback).toBeNull();
    expect(ctx.spend).toHaveBeenCalledTimes(1);
    expect(ctx.spend.mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      actionKey: 'plan.proposal',
      metadata: { planId: 'plan-1' },
    });
    const row = ctx.repository.sessions[0];
    expect(row).toMatchObject({ status: 'PROPOSED', proposalVersion: 1, busy: null });
    expect(row.proposalTurns).toEqual([
      { role: 'user', content: stableJson({ summary: 'We bake sourdough' }) },
      { role: 'assistant', content: '{"raw":"proposal 1"}' },
    ]);
    const view = await ctx.service.view(org(), 'session-1');
    expect(view.status).toBe('PROPOSED');
    expect(view.proposalVersion).toBe(1);
    expect(view.proposal).toEqual({ shown: ['We bake sourdough', null] });
  });

  it('charges nothing outside a kind that books each of its AI calls itself', async () => {
    const ctx = await withRound(build());
    (ctx.kind as any).proposalAction = undefined;
    await ctx.service.propose(org(), 'session-1', { summary: 'We bake sourdough' });
    ctx.spend.mockClear();
    await ctx.service.buildProposal('session-1', null);
    expect(ctx.kind.buildProposal).toHaveBeenCalledTimes(1);
    expect(ctx.spend).not.toHaveBeenCalled();
    expect(ctx.repository.sessions[0]).toMatchObject({ status: 'PROPOSED', proposalVersion: 1 });
  });

  it('keeps the owner edit of the summary under the key the kind names, in the turn and in the rounds', async () => {
    const ctx = await withRound(build());
    (ctx.kind as any).editedKey = 'editedDirection';
    await ctx.service.answer(org(), 'session-1', {
      roundId: 'round-0',
      summary: 'We bake sourdough for locals',
      answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
    });
    const turn = ctx.generator.chatRound.mock.calls[1][1].newUserTurn;
    expect(JSON.parse(turn)).toEqual({
      answers: [{ question: 'Who watches?', answer: 'Locals' }],
      editedDirection: 'We bake sourdough for locals',
    });
    expect((await ctx.service.view(org(), 'session-1')).rounds[0].summary).toBe(
      'We bake sourdough for locals'
    );
  });

  it('merges the options sent with a proposal request through the kind, and refuses them for a kind that takes none', async () => {
    const none = await withRound(build());
    expect(
      await codeOf(none.service.propose(org(), 'session-1', { summary: 's', options: { count: 2 } }))
    ).toBe('INVALID_PLAN');
    expect(none.repository.sessions[0].busy).toBeNull();
    const ctx = await withRound(build());
    (ctx.kind as any).parseProposeOptions = jest.fn((options: any, session: any) => ({
      ...session.options,
      ...options,
    }));
    const view = await ctx.service.propose(org(), 'session-1', { summary: 's', options: { count: 2 } });
    expect(view.options).toEqual({ count: 2 });
    expect((ctx.kind as any).parseProposeOptions).toHaveBeenCalledTimes(1);
  });

  it('does not write for a session that is no longer PROPOSING', async () => {
    const ctx = await withRound(build());
    await ctx.service.propose(org(), 'session-1', { summary: 's' });
    await ctx.service.discard(org(), 'session-1');
    await ctx.service.buildProposal('session-1', null);
    expect(ctx.kind.buildProposal).not.toHaveBeenCalled();
    expect(ctx.repository.sessions[0].status).toBe('DISCARDED');
  });

  it('drops a proposal that was written after the session was discarded', async () => {
    const ctx = await withRound(build());
    await ctx.service.propose(org(), 'session-1', { summary: 's' });
    ctx.kind.buildProposal.mockImplementationOnce(async () => {
      await ctx.service.discard(org(), 'session-1');
      return { proposal: { items: [], written: 0 }, userTurn: '{}', assistantTurn: '{}' };
    });
    await ctx.service.buildProposal('session-1', null);
    expect(ctx.repository.sessions[0]).toMatchObject({ status: 'DISCARDED', proposal: null });
  });

  it('answers 404 SESSION_NOT_FOUND when the job has no such session', async () => {
    const { service } = build();
    expect(await codeOf(service.buildProposal('nope', null))).toBe('SESSION_NOT_FOUND');
  });
});

describe('ContentPlanSessionService revise', () => {
  it('refuses a proposal that is not the latest and a session that is not PROPOSED with 409 PROPOSAL_STALE', async () => {
    const ctx = await withProposal(build());
    expect(
      await codeOf(
        ctx.service.revise(org(), 'session-1', { proposalVersion: 0, feedback: 'shorter' })
      )
    ).toBe('PROPOSAL_STALE');
    expect(ctx.start).toHaveBeenCalledTimes(1);
    const asking = await withRound(build());
    expect(
      await codeOf(
        asking.service.revise(org(), 'session-1', { proposalVersion: 0, feedback: 'shorter' })
      )
    ).toBe('PROPOSAL_STALE');
  });

  it('starts the revise job and writes version 2 as the next turn of the stored chat', async () => {
    const ctx = await withProposal(build());
    const view = await ctx.service.revise(org(), 'session-1', {
      proposalVersion: 1,
      feedback: 'Make it shorter',
    });
    expect(view.status).toBe('PROPOSING');
    expect(view.busy).toBe('proposal');
    expect(view.proposalVersion).toBe(1);
    expect(view.proposal).toEqual({ shown: ['We bake sourdough', null] });
    const [, options] = ctx.start.mock.calls[1];
    expect(options.workflowId).toBe('content_plan_session_revise_session-1');
    expect(options.args).toEqual([
      { kind: 'session_revise', id: 'session-1', feedback: 'Make it shorter' },
    ]);
    await ctx.service.buildProposal('session-1', 'Make it shorter');
    const [, turns, feedback] = ctx.kind.buildProposal.mock.calls[1];
    expect(turns).toHaveLength(2);
    expect(turns[1].content).toBe('{"raw":"proposal 1"}');
    expect(feedback).toBe('Make it shorter');
    const row = ctx.repository.sessions[0];
    expect(row).toMatchObject({ status: 'PROPOSED', proposalVersion: 2, busy: null });
    expect(row.proposalTurns).toHaveLength(4);
    expect(row.proposalTurns[2]).toEqual({
      role: 'user',
      content: stableJson({ feedback: 'Make it shorter' }),
    });
    expect(row.proposalTurns[3].content).toBe('{"raw":"proposal 2"}');
  });

  it('shows the last proposal while a revision is written, none for a first proposal, and none once discarded', async () => {
    const ctx = await withProposal(build());
    await ctx.service.revise(org(), 'session-1', { proposalVersion: 1, feedback: 'Make it shorter' });
    const revising = await ctx.service.view(org(), 'session-1');
    expect(revising).toMatchObject({ status: 'PROPOSING', proposalVersion: 1 });
    expect(revising.proposal).toEqual({ shown: ['We bake for locals', null] });
    const first = await withRound(build());
    await first.service.propose(org(), 'session-1', { summary: 'We bake for locals' });
    expect((await first.service.view(org(), 'session-1')).proposal).toBeNull();
    await ctx.service.discard(org(), 'session-1');
    expect((await ctx.service.view(org(), 'session-1')).proposal).toBeNull();
  });
});

describe('ContentPlanSessionService confirm', () => {
  it('refuses a stale version, an unproposed session and a held one', async () => {
    const ctx = await withProposal(build());
    expect(await codeOf(ctx.service.confirm(org(), 'session-1', { proposalVersion: 0 }))).toBe(
      'PROPOSAL_STALE'
    );
    ctx.repository.sessions[0].busy = 'proposal';
    expect(await codeOf(ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 }))).toBe(
      'PLAN_BUSY'
    );
    expect(ctx.kind.confirm).not.toHaveBeenCalled();
    const asking = await withRound(build());
    expect(
      await codeOf(asking.service.confirm(org(), 'session-1', { proposalVersion: 0 }))
    ).toBe('PROPOSAL_STALE');
  });

  it('hands the proposal session and the owner edits to the kind and ends the session', async () => {
    const ctx = await withProposal(build());
    const view = await ctx.service.confirm(org(), 'session-1', {
      proposalVersion: 1,
      edits: { dates: ['2026-12-01'] },
    });
    expect(ctx.kind.confirm).toHaveBeenCalledTimes(1);
    const [session, edits] = ctx.kind.confirm.mock.calls[0];
    expect(session.proposal).toEqual({ items: ['We bake for locals', null], written: 1 });
    expect(session.organization.id).toBe(ORG);
    expect(edits).toEqual({ dates: ['2026-12-01'] });
    expect(view.status).toBe('DONE');
    expect(view.busy).toBeNull();
    expect(view.proposal).toBeNull();
    expect(ctx.repository.sessions[0].confirmedAt).toBeInstanceOf(Date);
    expect(await codeOf(ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 }))).toBe(
      'PROPOSAL_STALE'
    );
    expect(ctx.kind.confirm).toHaveBeenCalledTimes(1);
  });

  it('passes empty edits when the owner sent none', async () => {
    const ctx = await withProposal(build());
    await ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 });
    expect(ctx.kind.confirm.mock.calls[0][1]).toEqual({});
  });

  it('releases the session and keeps the proposal when the kind refuses', async () => {
    const ctx = await withProposal(build());
    ctx.kind.confirm.mockRejectedValueOnce(
      new InvalidPlanException([{ path: 'edits.dates', message: 'is out of range' }])
    );
    expect(await codeOf(ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 }))).toBe(
      'INVALID_PLAN'
    );
    expect(ctx.repository.sessions[0]).toMatchObject({ status: 'PROPOSED', busy: null });
  });
});

describe('ContentPlanSessionService discard', () => {
  it('ends the session and frees it, also while a job holds it', async () => {
    const ctx = await withRound(build());
    await ctx.service.propose(org(), 'session-1', { summary: 's' });
    const view = await ctx.service.discard(org(), 'session-1');
    expect(view.status).toBe('DISCARDED');
    expect(view.busy).toBeNull();
  });

  it('refuses a session that is already confirmed with 409 SESSION_CLOSED', async () => {
    const ctx = await withProposal(build());
    await ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 });
    expect(await codeOf(ctx.service.discard(org(), 'session-1'))).toBe('SESSION_CLOSED');
    expect(ctx.repository.sessions[0].status).toBe('DONE');
  });

  it('answers 404 SESSION_NOT_FOUND for a session of another workspace, on every call', async () => {
    const ctx = await withProposal(build());
    const other = org('org-2');
    const calls = [
      () => ctx.service.view(other, 'session-1'),
      () =>
        ctx.service.answer(other, 'session-1', { roundId: 'round-0', summary: 's', answers: [] }),
      () => ctx.service.propose(other, 'session-1', { summary: 's' }),
      () => ctx.service.revise(other, 'session-1', { proposalVersion: 1, feedback: 'f' }),
      () => ctx.service.confirm(other, 'session-1', { proposalVersion: 1 }),
      () => ctx.service.discard(other, 'session-1'),
    ];
    for (const call of calls) {
      expect(await codeOf(call())).toBe('SESSION_NOT_FOUND');
    }
    expect(ctx.repository.sessions[0].status).toBe('PROPOSED');
  });

  it('tells a USER member they cannot edit', async () => {
    const ctx = await withRound(build());
    expect((await ctx.service.view(org(ORG, Role.USER), 'session-1')).canEdit).toBe(false);
    expect((await ctx.service.view(org(ORG, Role.ADMIN), 'session-1')).canEdit).toBe(true);
  });
});

describe('ContentPlanSessionService busy claim', () => {
  it('answers 409 PLAN_BUSY on answer, propose and revise while the session is held, and changes nothing', async () => {
    const ctx = await withProposal(build());
    ctx.repository.sessions[0].busy = 'round';
    expect(
      await codeOf(
        ctx.service.answer(org(), 'session-1', {
          roundId: 'round-0',
          summary: 's',
          answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
        })
      )
    ).toBe('PLAN_BUSY');
    expect(await codeOf(ctx.service.propose(org(), 'session-1', { summary: 's' }))).toBe(
      'PLAN_BUSY'
    );
    expect(
      await codeOf(
        ctx.service.revise(org(), 'session-1', { proposalVersion: 1, feedback: 'shorter' })
      )
    ).toBe('PLAN_BUSY');
    expect(ctx.repository.sessions[0]).toMatchObject({ status: 'PROPOSED', busy: 'round' });
    expect(ctx.start).toHaveBeenCalledTimes(1);
    expect(ctx.generator.chatRound).toHaveBeenCalledTimes(1);
  });

  it('holds the session while the job runs, so a second propose is refused', async () => {
    const ctx = await withRound(build());
    await ctx.service.propose(org(), 'session-1', { summary: 's' });
    expect(await codeOf(ctx.service.propose(org(), 'session-1', { summary: 's' }))).toBe(
      'PLAN_BUSY'
    );
    expect(ctx.start).toHaveBeenCalledTimes(1);
  });

  it('answers 409 PLAN_BUSY when the job is already running and keeps the session held', async () => {
    const ctx = await withRound(build());
    ctx.start.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError(
        'started',
        'content_plan_session_proposal_session-1',
        'contentPlanJobWorkflow'
      )
    );
    expect(await codeOf(ctx.service.propose(org(), 'session-1', { summary: 's' }))).toBe(
      'PLAN_BUSY'
    );
    expect(ctx.repository.sessions[0].busy).toBe('proposal');
  });

  it('answers 503 and frees the session where it was when the job cannot be started', async () => {
    const ctx = await withRound(build());
    ctx.start.mockRejectedValueOnce(new Error('temporal down'));
    expect(await codeOf(ctx.service.propose(org(), 'session-1', { summary: 's' }))).toBe(
      'PLAN_NOT_AVAILABLE'
    );
    expect(ctx.repository.sessions[0]).toMatchObject({ status: 'ASKING', busy: null });
    const proposed = await withProposal(build());
    proposed.start.mockRejectedValueOnce(new Error('temporal down'));
    expect(
      await codeOf(
        proposed.service.revise(org(), 'session-1', { proposalVersion: 1, feedback: 'shorter' })
      )
    ).toBe('PLAN_NOT_AVAILABLE');
    expect(proposed.repository.sessions[0]).toMatchObject({ status: 'PROPOSED', busy: null });
  });
});

describe('ContentPlanSessionService failure path', () => {
  it('frees a first proposal that failed, back to ASKING, with the notice set', async () => {
    const ctx = await withRound(build());
    await ctx.service.propose(org(), 'session-1', { summary: 's' });
    ctx.kind.buildProposal.mockRejectedValueOnce(new PlanAiFailed());
    await expect(ctx.service.buildProposal('session-1', null)).rejects.toBeInstanceOf(PlanAiFailed);
    await ctx.service.sessionFailed('session-1');
    const view = await ctx.service.view(org(), 'session-1');
    expect(view).toMatchObject({ status: 'ASKING', busy: null, notice: 'proposal_failed' });
    expect(view.round?.index).toBe(0);
  });

  it('frees a revise that failed, back to PROPOSED with the proposal it had', async () => {
    const ctx = await withProposal(build());
    await ctx.service.revise(org(), 'session-1', { proposalVersion: 1, feedback: 'shorter' });
    ctx.kind.buildProposal.mockRejectedValueOnce(new Error('model down'));
    await expect(ctx.service.buildProposal('session-1', 'shorter')).rejects.toBeDefined();
    await ctx.service.sessionFailed('session-1');
    const view = await ctx.service.view(org(), 'session-1');
    expect(view).toMatchObject({
      status: 'PROPOSED',
      busy: null,
      notice: 'proposal_failed',
      proposalVersion: 1,
    });
    expect(view.proposal).toEqual({ shown: ['We bake for locals', null] });
  });

  it('clears the notice when the owner asks again', async () => {
    const ctx = await withRound(build());
    await ctx.service.propose(org(), 'session-1', { summary: 's' });
    await ctx.service.sessionFailed('session-1');
    expect(ctx.repository.sessions[0].notice).toBe('proposal_failed');
    await ctx.service.propose(org(), 'session-1', { summary: 's' });
    expect(ctx.repository.sessions[0].notice).toBeNull();
  });

  it('does not bring a discarded session back, and ignores a session that is gone', async () => {
    const ctx = await withRound(build());
    await ctx.service.propose(org(), 'session-1', { summary: 's' });
    await ctx.service.discard(org(), 'session-1');
    await ctx.service.sessionFailed('session-1');
    expect(ctx.repository.sessions[0]).toMatchObject({ status: 'DISCARDED', busy: null });
    await expect(ctx.service.sessionFailed('nope')).resolves.toBeUndefined();
  });
});
