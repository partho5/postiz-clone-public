// Content plan service: the setup's own routes (start, answer, proposal, revise, confirm, reset), which run the plan's
// session of the planning engine, the proposal job and the plan as the page draws it. Needs no network, database or
// Temporal: the storage is an in-memory stand-in, and the generator, the credits and the workflow engine are stubs.
// Covers stale rounds, the append-only chat of the rounds, the owner's direction saved before the next round, the
// start of the proposal job, confirm (stale version, 12 weeks on the right clusters, the first week job), reset and
// the controller's role check.
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { Role } from '@prisma/client';
import {
  ContentPlanService,
  PlanOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import {
  PlanAiFailed,
  PlanNotConfigured,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import { ContentPlanSessionService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.service';
import { PlanSessionKinds } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.kind';
import { PlanSetupSessionKind } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.setup.kind';
import { ContentPlanSetupService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.setup.service';
import { stableJson } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import {
  PlanFacts,
  PlanProposal,
  ROADMAP_WEEKS,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';
import { ContentPlanController } from '@gitroom/backend/api/routes/content.plan.controller';

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

const facts: PlanFacts = {
  whatWeDo: 'Bakes bread',
  audience: 'Neighbours',
  problems: ['p1'],
  solution: 'Fresh daily',
  objections: ['o1'],
  tone: 'Warm',
  videoSeconds: 60,
};

const org = (role: Role = Role.ADMIN, extra = {}): PlanOrganization =>
  ({
    id: ORG,
    name: 'Bakery',
    locale: 'en',
    timezone: 'UTC',
    profile: { schemaVersion: 1 },
    users: [{ role }],
    ...extra,
  }) as unknown as PlanOrganization;

// The storage of the plan, in memory, with the behaviour the service relies on.
class FakeRepository {
  plan: any = null;
  themes: any[] = [];
  clusters: any[] = [];
  weeks: any[] = [];
  calls: string[] = [];

  findByOrganization = async () => this.plan;
  findWithOrganization = async () =>
    this.plan && {
      ...this.plan,
      organization: { id: ORG, name: 'Bakery', locale: 'en', timezone: 'UTC' },
    };
  ensure = async () => {
    this.plan ??= {
      id: 'plan-1',
      organizationId: ORG,
      status: 'SETUP',
      sourceText: null,
      direction: null,
      videosPerWeek: 3,
      facts: null,
      proposal: null,
      proposalVersion: 0,
      proposalTurns: null,
      busy: null,
      notice: null,
    };
    return this.plan;
  };
  update = async (_id: string, data: any) => {
    Object.assign(this.plan, data);
    return this.plan;
  };
  claimBusy = async (_id: string, busy: string) => {
    if (this.plan.busy) {
      return false;
    }
    this.plan.busy = busy;
    return true;
  };
  release = async (_id: string, data: any = {}) => {
    Object.assign(this.plan, data, { busy: null });
  };
  activeThemes = async () => this.themes.filter((theme) => !theme.archivedAt);
  openDraft = async () => null;
  currentWrittenWeek = async () => null;
  activate = async (data: any) => {
    this.calls.push('activate');
    this.themes = data.themes;
    this.clusters = data.clusters;
    this.weeks = data.weeks;
    Object.assign(this.plan, {
      status: 'ACTIVE',
      direction: data.direction,
      sourceText: data.sourceText,
      videosPerWeek: data.videosPerWeek,
      facts: data.facts,
      busy: null,
    });
  };
}

// The storage of the sessions, in memory, with the behaviour the engine relies on.
class FakeSessionRepository {
  sessions: any[] = [];
  roundRows: any[] = [];
  calls: string[] = [];

  private find = (id: string) => this.sessions.find((row) => row.id === id);
  private isOpen = (row: any) => ['ASKING', 'PROPOSING', 'PROPOSED'].includes(row.status);

  findByOrganization = async (organizationId: string, id: string) =>
    this.sessions.find((row) => row.id === id && row.organizationId === organizationId) ?? null;
  findOpen = async (organizationId: string, kind: string) =>
    [...this.sessions]
      .reverse()
      .find((row) => row.organizationId === organizationId && row.kind === kind && this.isOpen(row)) ?? null;
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
      .filter((row) => row.organizationId === session.organizationId && row.kind === session.kind && this.isOpen(row))
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
  discardOpen = async (organizationId: string, kind: string) => {
    this.calls.push('discardOpen');
    this.sessions
      .filter((row) => row.organizationId === organizationId && row.kind === kind && this.isOpen(row))
      .forEach((row) => Object.assign(row, { status: 'DISCARDED', busy: null }));
  };
  update = async (id: string, data: any) => Object.assign(this.find(id), data);
  claimBusy = async (id: string, busy: string) => {
    if (this.find(id).busy) {
      return false;
    }
    this.find(id).busy = busy;
    return true;
  };
  release = async (id: string, data: any = {}) => Object.assign(this.find(id), data, { busy: null });
  rounds = async (sessionId: string) =>
    this.roundRows.filter((row) => row.sessionId === sessionId).sort((a, b) => a.index - b.index);
  latestRound = async (sessionId: string) => (await this.rounds(sessionId)).slice(-1)[0] ?? null;
  rewindTo = async (sessionId: string, index: number) => {
    this.calls.push('rewindTo');
    this.roundRows = this.roundRows.filter((row) => row.sessionId !== sessionId || row.index <= index);
    Object.assign(this.find(sessionId), { status: 'ASKING', proposal: null, proposalTurns: null, notice: null });
  };
  saveRound = async (round: any) => {
    this.roundRows.push({ ...round, id: `round-${round.index}`, answers: null });
    this.find(round.sessionId).summary = round.summary;
  };
  saveAnswers = async (sessionId: string, roundId: string, answers: any) => {
    this.roundRows.find((row) => row.id === roundId && row.sessionId === sessionId).answers = answers;
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
  text: 'Who buys?',
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

const build = (generatorOverrides: Record<string, any> = {}) => {
  const repository = new FakeRepository();
  const sessions = new FakeSessionRepository();
  const generator: Record<string, jest.Mock> = {
    chatRound: jest.fn().mockResolvedValue(roundAnswer()),
    proposeStructure: jest.fn(),
    writeIdeas: jest.fn(),
    writeOutline: jest.fn(),
    ...generatorOverrides,
  };
  const spend = jest.fn((request: any, run: () => Promise<unknown>) => run());
  const start = jest.fn().mockResolvedValue(undefined);
  const temporal = { client: { getRawClient: () => ({ workflow: { start } }) } };
  const service = new ContentPlanService(
    repository as any,
    generator as any,
    { spend } as any,
    temporal as any,
    sessions as any
  );
  const kinds = new PlanSessionKinds();
  new PlanSetupSessionKind(kinds, service, repository as any, generator as any);
  const sessionService = new ContentPlanSessionService(sessions as any, generator as any, service, kinds);
  const setup = new ContentPlanSetupService(service, repository as any, sessions as any, sessionService);
  return { service, setup, sessionService, repository, sessions, generator, spend, start };
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

// A plan with a setup of one round, ready to answer.
const withRound = async (ctx: ReturnType<typeof build>) => {
  await ctx.setup.startSetup(org(), { sourceText: 'We bake bread' });
  return ctx;
};

describe('ContentPlanService setup', () => {
  it('answers NONE for a workspace without a plan', async () => {
    const { service } = build();
    const view = await service.view(org());
    expect(view.status).toBe('NONE');
    expect(view.round).toBeNull();
    expect(view.videosPerWeek).toBe(3);
  });

  it('builds the prefill from the brand profile and leaves it empty without one', async () => {
    const { service } = build();
    expect((await service.view(org())).prefill).toBe('');
    const view = await service.view(
      org(Role.ADMIN, {
        profile: {
          schemaVersion: 1,
          tagline: 'Fresh daily',
          audience: ['Neighbours', 'Cafes'],
          pillars: ['Bread'],
        },
      })
    );
    expect(view.prefill).toBe('Bakery\nFresh daily\nNeighbours, Cafes\nBread');
  });

  it('tells a USER member they cannot edit', async () => {
    const { service } = build();
    expect((await service.view(org(Role.USER))).canEdit).toBe(false);
    expect((await service.view(org(Role.SUPERADMIN))).canEdit).toBe(true);
  });

  it('writes round 0 from the source text on the setup frame, spends on plan.setup_round and frees the session', async () => {
    const { setup, generator, spend, sessions } = build();
    const view = await setup.startSetup(org(), { sourceText: ' We bake bread ' });
    // the setup frame and its own field hints (none given: the generator's default)
    expect(generator.chatRound).toHaveBeenCalledWith(
      'planner.frame.setup',
      expect.objectContaining({
        orgId: ORG,
        turns: [],
        newUserTurn: stableJson({ sourceText: 'We bake bread' }),
      }),
      undefined
    );
    expect(spend.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        actionKey: 'plan.setup_round',
        metadata: { planId: 'plan-1' },
      })
    );
    expect(spend.mock.calls[0][0].idempotencyKey).toMatch(/^plan:plan-1:plan\.setup_round:/);
    expect(view.round).toEqual({
      id: 'round-0',
      index: 0,
      direction: 'We bake for locals',
      questions: [question],
      readyForPlan: false,
    });
    expect(view.direction).toBe('We bake for locals');
    expect(view.sourceText).toBe('We bake bread');
    expect(view.videosPerWeek).toBe(3);
    expect(view.status).toBe('SETUP');
    expect(view.busy).toBeNull();
    expect(sessions.sessions[0]).toMatchObject({ kind: 'plan', status: 'ASKING', options: { videosPerWeek: 3 } });
    expect(sessions.roundRows[0].userTurn).toBe(stableJson({ sourceText: 'We bake bread' }));
  });

  it('refuses to start a setup over an ACTIVE plan', async () => {
    const ctx = build();
    await ctx.repository.ensure();
    ctx.repository.plan.status = 'ACTIVE';
    expect(await codeOf(ctx.setup.startSetup(org(), { sourceText: 'x' }))).toBe('PLAN_EXISTS');
    expect(ctx.sessions.sessions).toHaveLength(0);
  });

  it('refuses a second job while one holds the session', async () => {
    const ctx = await withRound(build());
    ctx.sessions.sessions[0].busy = 'round';
    expect(
      await codeOf(
        ctx.setup.answer(org(), {
          roundId: 'round-0',
          direction: 'd',
          answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
        })
      )
    ).toBe('PLAN_BUSY');
  });

  it('starting again ends the open setup and starts a new one', async () => {
    const ctx = await withRound(build());
    await ctx.setup.startSetup(org(), { sourceText: 'We sell shoes' });
    expect(ctx.sessions.sessions.map((row) => row.status)).toEqual(['DISCARDED', 'ASKING']);
    expect((await ctx.service.view(org())).sourceText).toBe('We sell shoes');
  });

  it('answers 400 INVALID_PLAN for a bad body', async () => {
    const { setup } = build();
    expect(await codeOf(setup.startSetup(org(), { sourceText: '' }))).toBe('INVALID_PLAN');
    expect(await codeOf(setup.startSetup(org(), { sourceText: 'x', extra: 1 }))).toBe('INVALID_PLAN');
  });

  it('turns a refused planner into 503 and a failed call into 502, and frees the session', async () => {
    const refused = build({ chatRound: jest.fn().mockRejectedValue(new PlanNotConfigured()) });
    expect(await codeOf(refused.setup.startSetup(org(), { sourceText: 'x' }))).toBe(
      'PLAN_NOT_AVAILABLE'
    );
    expect(refused.sessions.sessions[0]).toMatchObject({ busy: null, status: 'DISCARDED' });
    const failed = build({ chatRound: jest.fn().mockRejectedValue(new PlanAiFailed()) });
    expect(await codeOf(failed.setup.startSetup(org(), { sourceText: 'x' }))).toBe('PLAN_AI_FAILED');
    expect(failed.sessions.sessions[0]).toMatchObject({ busy: null, status: 'DISCARDED' });
    // no setup is left to resume, so the page is back at the first step
    expect((await failed.service.view(org())).round).toBeNull();
  });
});

describe('ContentPlanService answer', () => {
  it('refuses a round that is not the latest', async () => {
    const ctx = await withRound(build());
    expect(
      await codeOf(
        ctx.setup.answer(org(), {
          roundId: 'round-old',
          direction: 'd',
          answers: [],
        })
      )
    ).toBe('ROUND_STALE');
    expect(ctx.generator.chatRound).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer to a question or option that is not in the round', async () => {
    const ctx = await withRound(build());
    expect(
      await codeOf(
        ctx.setup.answer(org(), {
          roundId: 'round-0',
          direction: 'd',
          answers: [{ questionId: 'q9', optionId: 'o1' }],
        })
      )
    ).toBe('INVALID_PLAN');
    expect(
      await codeOf(
        ctx.setup.answer(org(), {
          roundId: 'round-0',
          direction: 'd',
          answers: [{ questionId: 'q1', optionId: 'o9' }],
        })
      )
    ).toBe('INVALID_PLAN');
  });

  it('saves the owner direction before the next round and sends the chat append-only without ids', async () => {
    const ctx = await withRound(build());
    let directionWhenAsked: string | null = null;
    ctx.generator.chatRound.mockImplementationOnce(async () => {
      directionWhenAsked = ctx.sessions.sessions[0].summary;
      return roundAnswer({ direction: 'Next direction', assistantTurn: '{"raw":"second"}' });
    });
    const view = await ctx.setup.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake sourdough for locals',
      answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
    });
    expect(directionWhenAsked).toBe('We bake sourdough for locals');
    const call = ctx.generator.chatRound.mock.calls[1][1];
    expect(call.turns).toEqual([
      { role: 'user', content: stableJson({ sourceText: 'We bake bread' }) },
      { role: 'assistant', content: '{"raw":"assistant text"}' },
    ]);
    // the setup keeps its own key for the owner's edit, so its prompts are the bytes they always were
    expect(call.newUserTurn).toBe(
      stableJson({
        answers: [{ question: 'Who buys?', answer: 'Tourists' }],
        editedDirection: 'We bake sourdough for locals',
      })
    );
    expect(call.newUserTurn).not.toContain('o2');
    expect(view.round?.index).toBe(1);
    expect(view.direction).toBe('Next direction');
    expect(ctx.sessions.roundRows[0].answers).toEqual([
      { questionId: 'q1', optionId: 'o2', optionIds: [], other: null },
    ]);
    expect(ctx.sessions.roundRows[1].userTurn).toBe(call.newUserTurn);
    expect(ctx.sessions.roundRows[1].assistantTurn).toBe('{"raw":"second"}');
  });

  it('sends every ticked option of a question that takes several, then the owner own words', async () => {
    const ctx = await withRound(build());
    await ctx.setup.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake for locals',
      answers: [{ questionId: 'q1', optionId: null, optionIds: ['o1', 'o2'], other: 'Hotels' }],
    });
    expect(ctx.generator.chatRound.mock.calls[1][1].newUserTurn).toBe(
      stableJson({
        answers: [{ question: 'Who buys?', answer: 'Locals, Tourists, Hotels' }],
        editedDirection: null,
      })
    );
    const fresh = await withRound(build());
    expect(
      await codeOf(
        fresh.setup.answer(org(), {
          roundId: 'round-0',
          direction: 'd',
          answers: [{ questionId: 'q1', optionId: null, optionIds: ['o1', 'o9'], other: null }],
        })
      )
    ).toBe('INVALID_PLAN');
  });

  it('shows every round with its answers and the direction as the owner left it', async () => {
    const ctx = await withRound(build());
    await ctx.setup.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake sourdough for locals',
      answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
    });
    const view = await ctx.service.view(org());
    expect(view.rounds.map((round) => round.index)).toEqual([0, 1]);
    expect(view.rounds[0].direction).toBe('We bake sourdough for locals');
    expect(view.rounds[0].answers).toEqual([
      { questionId: 'q1', optionId: 'o2', optionIds: [], other: null },
    ]);
    expect(view.rounds[1].answers).toBeNull();
    expect(view.rounds[1].direction).toBe(view.direction);
    expect(view.round?.id).toBe(view.rounds[1].id);
  });

  it('answering an earlier round drops the rounds after it and writes the next one from the changed answers', async () => {
    const ctx = await withRound(build());
    await ctx.setup.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake bread',
      answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
    });
    ctx.sessions.calls.length = 0;
    const view = await ctx.setup.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake bread',
      answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
    });
    expect(ctx.sessions.calls).toContain('rewindTo');
    expect(view.rounds.map((round) => round.index)).toEqual([0, 1]);
    const call = ctx.generator.chatRound.mock.calls[2][1];
    expect(call.turns).toHaveLength(2);
    expect(call.newUserTurn).toContain('Tourists');
    expect(ctx.sessions.roundRows[0].answers[0].optionId).toBe('o2');
  });

  it('keeps the later rounds and the old answers when the AI fails while going back to an earlier round', async () => {
    const ctx = await withRound(build());
    await ctx.setup.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake bread',
      answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
    });
    ctx.generator.chatRound.mockRejectedValueOnce(new Error('model down'));
    await expect(
      ctx.setup.answer(org(), {
        roundId: 'round-0',
        direction: 'We bake bread',
        answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
      })
    ).rejects.toBeDefined();
    expect(ctx.sessions.calls).not.toContain('rewindTo');
    expect(ctx.sessions.roundRows).toHaveLength(2);
    expect(ctx.sessions.roundRows[0].answers[0].optionId).toBe('o1');
  });

  it('refuses a round that is not in the plan', async () => {
    const ctx = await withRound(build());
    expect(
      await codeOf(
        ctx.setup.answer(org(), {
          roundId: 'nope',
          direction: 'd',
          answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
        })
      )
    ).toBe('ROUND_STALE');
  });

  it('refuses an answer when the workspace has no setup: 404 without a plan, 409 with one', async () => {
    const ctx = build();
    const body = { roundId: 'round-0', direction: 'd', answers: [] };
    expect(await codeOf(ctx.setup.answer(org(), body))).toBe('PLAN_NOT_FOUND');
    await ctx.repository.ensure();
    expect(await codeOf(ctx.setup.answer(org(), body))).toBe('ROUND_STALE');
  });

  it('sends the owner own words when given, and null when the direction was not edited', async () => {
    const ctx = await withRound(build());
    await ctx.setup.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake for locals',
      answers: [{ questionId: 'q1', optionId: 'o1', other: 'Mostly cafes' }],
    });
    expect(ctx.generator.chatRound.mock.calls[1][1].newUserTurn).toBe(
      stableJson({
        answers: [{ question: 'Who buys?', answer: 'Mostly cafes' }],
        editedDirection: null,
      })
    );
  });
});

// A proposal as the job writes it: 2 themes with 2 and 1 clusters, 12 weeks.
const proposal = (version = 1): PlanProposal => ({
  version,
  facts,
  themes: [
    { ref: 't1', name: 'Bread', description: 'd' },
    { ref: 't2', name: 'Shop', description: 'd' },
  ],
  clusters: [
    { ref: 'c1', themeRef: 't1', title: 'Crust', problem: 'p' },
    { ref: 'c2', themeRef: 't1', title: 'Crumb', problem: 'p' },
    { ref: 'c3', themeRef: 't2', title: 'Hours', problem: 'p' },
  ],
  weeks: Array.from({ length: ROADMAP_WEEKS }, (_, index) => ({
    weekStart: `2026-01-${String(index + 1).padStart(2, '0')}`,
    clusterRef: ['c1', 'c3', 'c2'][index % 3],
    idea: `Idea ${index}`,
    outline: index < 4 ? [{ title: `Title ${index}`, angle: 'problem' as const }] : null,
  })),
});

// A setup whose proposal has been written (version `version`), the owner at the preview.
const proposed = async (ctx: ReturnType<typeof build>, version = 1) => {
  await withRound(ctx);
  Object.assign(ctx.sessions.sessions[0], {
    status: 'PROPOSED',
    summary: 'We bake for locals',
    proposal: proposal(version),
    proposalVersion: version,
    options: { videosPerWeek: 1 },
    busy: null,
  });
  return ctx;
};

describe('ContentPlanService propose and revise', () => {
  it('stores the direction and videos per week and starts the proposal job', async () => {
    const ctx = await withRound(build());
    const view = await ctx.setup.propose(org(), {
      direction: 'We bake for locals',
      videosPerWeek: 5,
      answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
    });
    expect(ctx.sessions.sessions[0].options).toEqual({ videosPerWeek: 5 });
    expect(ctx.sessions.sessions[0].summary).toBe('We bake for locals');
    expect(ctx.sessions.roundRows[0].answers).toHaveLength(1);
    expect(ctx.start).toHaveBeenCalledWith(
      'contentPlanJobWorkflow',
      expect.objectContaining({
        workflowId: 'content_plan_session_proposal_session-1',
        taskQueue: 'main',
        args: [{ kind: 'session_proposal', id: 'session-1' }],
      })
    );
    expect(view.busy).toBe('proposal');
    expect(view.videosPerWeek).toBe(5);
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
    expect(
      await codeOf(ctx.setup.propose(org(), { direction: 'd', videosPerWeek: 3 }))
    ).toBe('PLAN_BUSY');
    expect(ctx.sessions.sessions[0].busy).toBe('proposal');
  });

  it('answers 503 and frees the session when the job cannot be started', async () => {
    const ctx = await withRound(build());
    ctx.start.mockRejectedValueOnce(new Error('down'));
    expect(
      await codeOf(ctx.setup.propose(org(), { direction: 'd', videosPerWeek: 3 }))
    ).toBe('PLAN_NOT_AVAILABLE');
    expect(ctx.sessions.sessions[0]).toMatchObject({ busy: null, status: 'ASKING' });
  });

  it('refuses a revise of a stale proposal and starts the revise job otherwise', async () => {
    const ctx = await proposed(build(), 2);
    ctx.start.mockClear();
    expect(
      await codeOf(ctx.setup.revise(org(), { proposalVersion: 1, feedback: 'More' }))
    ).toBe('PROPOSAL_STALE');
    expect(ctx.start).not.toHaveBeenCalled();
    const view = await ctx.setup.revise(org(), { proposalVersion: 2, feedback: 'More' });
    expect(ctx.start).toHaveBeenCalledWith(
      'contentPlanJobWorkflow',
      expect.objectContaining({
        workflowId: 'content_plan_session_revise_session-1',
        args: [{ kind: 'session_revise', id: 'session-1', feedback: 'More' }],
      })
    );
    expect(view.busy).toBe('proposal');
    // the plan page keeps showing the proposal that is being written again
    expect(view.status).toBe('PROPOSED');
    expect(view.proposal?.version).toBe(2);
  });
});

describe('ContentPlanService buildProposal', () => {
  const structure = {
    facts,
    themes: proposal().themes,
    clusters: proposal().clusters,
    assistantTurn: '{"raw":"structure"}',
    usage: { prompt: 1, cached: 0, completion: 1 },
  };
  const wire = (ctx: ReturnType<typeof build>) => {
    ctx.generator.proposeStructure.mockResolvedValue(structure);
    ctx.generator.writeIdeas.mockImplementation(async (input: any) => ({
      ideas: input.weeks.map((_: unknown, index: number) => `Idea ${index}`),
      usage: structure.usage,
    }));
    ctx.generator.writeOutline.mockImplementation(async (input: any) => ({
      titles: input.angles.map((_: unknown, index: number) => `T${index}`),
      usage: structure.usage,
    }));
  };

  // A setup whose proposal job is running (the session is held by it).
  const startPlan = async (ctx: ReturnType<typeof build>) => {
    await withRound(ctx);
    Object.assign(ctx.sessions.sessions[0], {
      summary: 'We bake for locals',
      options: { videosPerWeek: 3 },
      status: 'PROPOSING',
      busy: 'proposal',
    });
    ctx.spend.mockClear();
  };

  it('writes the structure, 12 ideas and 4 outlines, and saves a PROPOSED session', async () => {
    const ctx = build();
    wire(ctx);
    await startPlan(ctx);
    await ctx.sessionService.buildProposal('session-1', null);
    expect(ctx.generator.proposeStructure).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [],
        newUserTurn: stableJson({ direction: 'We bake for locals' }),
      })
    );
    expect(ctx.generator.writeIdeas.mock.calls[0][0].weeks).toHaveLength(ROADMAP_WEEKS);
    expect(ctx.generator.writeOutline).toHaveBeenCalledTimes(4);
    const saved = ctx.sessions.sessions[0];
    expect(saved.status).toBe('PROPOSED');
    expect(saved.busy).toBeNull();
    expect(saved.proposalVersion).toBe(1);
    expect(saved.proposal.version).toBe(1);
    expect(saved.proposal.weeks).toHaveLength(ROADMAP_WEEKS);
    expect(saved.proposal.weeks.filter((week: any) => week.outline).length).toBe(4);
    expect(saved.proposal.weeks[0].outline).toHaveLength(3);
    // theme-interleaved rotation: Crust (t1), Hours (t2), Crumb (t1), then round again
    expect(saved.proposal.weeks.slice(0, 4).map((week: any) => week.clusterRef)).toEqual([
      'c1',
      'c3',
      'c2',
      'c1',
    ]);
    expect(saved.proposalTurns).toEqual([
      { role: 'user', content: stableJson({ direction: 'We bake for locals' }) },
      { role: 'assistant', content: '{"raw":"structure"}' },
    ]);
    // each AI call is booked on its own action, as before the setup moved onto sessions
    expect(ctx.spend.mock.calls.map((call) => call[0].actionKey)).toEqual([
      'plan.proposal',
      'plan.roadmap',
      'plan.proposal',
      'plan.proposal',
      'plan.proposal',
      'plan.proposal',
    ]);
  });

  it('writes the outlines for the videos per week the owner chose', async () => {
    const ctx = build();
    wire(ctx);
    await startPlan(ctx);
    ctx.sessions.sessions[0].options = { videosPerWeek: 5 };
    await ctx.sessionService.buildProposal('session-1', null);
    expect(ctx.generator.writeOutline.mock.calls[0][0].videosPerWeek).toBe(5);
    expect(ctx.generator.writeOutline.mock.calls[0][0].angles).toHaveLength(5);
  });

  it('appends the feedback to the stored chat on a revise', async () => {
    const ctx = build();
    wire(ctx);
    await startPlan(ctx);
    const earlier = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
    ];
    Object.assign(ctx.sessions.sessions[0], { proposalTurns: earlier, proposalVersion: 1 });
    await ctx.sessionService.buildProposal('session-1', 'Fewer themes');
    expect(ctx.generator.proposeStructure.mock.calls[0][0].turns).toEqual(earlier);
    expect(ctx.generator.proposeStructure.mock.calls[0][0].newUserTurn).toBe(
      stableJson({ feedback: 'Fewer themes' })
    );
    expect(ctx.sessions.sessions[0].proposalVersion).toBe(2);
    expect(ctx.sessions.sessions[0].proposal.version).toBe(2);
    expect(ctx.sessions.sessions[0].proposalTurns).toEqual([
      ...earlier,
      { role: 'user', content: stableJson({ feedback: 'Fewer themes' }) },
      { role: 'assistant', content: '{"raw":"structure"}' },
    ]);
  });

  it('drops the answer when the setup was reset while it was written', async () => {
    const ctx = build();
    wire(ctx);
    await startPlan(ctx);
    ctx.generator.writeIdeas.mockImplementationOnce(async (input: any) => {
      await ctx.setup.reset(org());
      return { ideas: input.weeks.map(() => 'i'), usage: structure.usage };
    });
    await ctx.sessionService.buildProposal('session-1', null);
    expect(ctx.sessions.sessions[0].status).toBe('DISCARDED');
    expect(ctx.sessions.sessions[0].proposal).toBeNull();
    expect(ctx.repository.plan.status).toBe('SETUP');
  });

  it('throws the generator failure and the failure path sets the notice', async () => {
    const ctx = build();
    ctx.generator.proposeStructure.mockRejectedValue(new PlanAiFailed());
    await startPlan(ctx);
    await expect(ctx.sessionService.buildProposal('session-1', null)).rejects.toBeInstanceOf(
      PlanAiFailed
    );
    await ctx.sessionService.sessionFailed('session-1');
    expect(ctx.sessions.sessions[0]).toMatchObject({
      busy: null,
      notice: 'proposal_failed',
      status: 'ASKING',
    });
  });
});

describe('ContentPlanService confirm', () => {
  it('refuses a stale proposal version', async () => {
    const ctx = await proposed(build(), 2);
    expect(await codeOf(ctx.setup.confirm(org(), { proposalVersion: 1 }))).toBe('PROPOSAL_STALE');
    expect(ctx.repository.calls).not.toContain('activate');
  });

  it('refuses when the setup is not PROPOSED', async () => {
    const ctx = build();
    await ctx.repository.ensure();
    expect(await codeOf(ctx.setup.confirm(org(), { proposalVersion: 0 }))).toBe('PROPOSAL_STALE');
    const asking = await withRound(build());
    expect(await codeOf(asking.setup.confirm(org(), { proposalVersion: 0 }))).toBe('PROPOSAL_STALE');
  });

  it('creates 12 weeks on the right clusters from today and starts the first week job', async () => {
    const ctx = await proposed(build());
    const today = new Date().toISOString().slice(0, 10);
    const view = await ctx.setup.confirm(org(), { proposalVersion: 1 });
    const { themes, clusters, weeks } = ctx.repository;
    expect(view.status).toBe('ACTIVE');
    expect(view.facts).toEqual(facts);
    expect(view.proposal).toBeNull();
    // the session summary is the plan's direction, with the videos a week and the first text
    expect(view.direction).toBe('We bake for locals');
    expect(view.videosPerWeek).toBe(1);
    expect(ctx.repository.plan).toMatchObject({
      direction: 'We bake for locals',
      videosPerWeek: 1,
      sourceText: 'We bake bread',
    });
    expect(ctx.sessions.sessions[0].status).toBe('DONE');
    expect(themes.map((theme: any) => theme.position)).toEqual([0, 1]);
    // interleaved rotation: c1 (t1), c3 (t2), c2 (t1)
    const byTitle = (title: string) => clusters.find((c: any) => c.title === title);
    expect(byTitle('Crust').rotationIndex).toBe(0);
    expect(byTitle('Hours').rotationIndex).toBe(1);
    expect(byTitle('Crumb').rotationIndex).toBe(2);
    expect(byTitle('Crust').themeId).toBe(themes[0].id);
    expect(byTitle('Hours').themeId).toBe(themes[1].id);
    expect(weeks).toHaveLength(ROADMAP_WEEKS);
    expect(weeks.map((week: any) => week.clusterId).slice(0, 3)).toEqual([
      byTitle('Crust').id,
      byTitle('Hours').id,
      byTitle('Crumb').id,
    ]);
    // the weeks start on the confirm date, seven days apart, not on the date the proposal was written
    expect(weeks[0].weekStart).toBe(today);
    expect(weeks[1].weekStart).not.toBe(weeks[0].weekStart);
    expect(weeks[3].outline).toEqual([{ title: 'Title 3', angle: 'problem' }]);
    expect(weeks[4].outline).toBeNull();
    expect(ctx.start).toHaveBeenCalledWith(
      'contentPlanJobWorkflow',
      expect.objectContaining({
        workflowId: `content_plan_week_${weeks[0].id}`,
        args: [{ kind: 'week', id: weeks[0].id }],
      })
    );
  });

  it('is still confirmed when the first week job cannot be started', async () => {
    const ctx = await proposed(build());
    ctx.start.mockRejectedValueOnce(new Error('down'));
    const view = await ctx.setup.confirm(org(), { proposalVersion: 1 });
    expect(view.status).toBe('ACTIVE');
  });
});

describe('ContentPlanService reset and facts', () => {
  it('goes back to SETUP, clears the rounds and the proposal, and touches no week', async () => {
    const ctx = await proposed(build());
    await ctx.setup.confirm(org(), { proposalVersion: 1 });
    const weeks = [...ctx.repository.weeks];
    const view = await ctx.setup.reset(org());
    expect(view.status).toBe('SETUP');
    expect(view.round).toBeNull();
    expect(view.proposal).toBeNull();
    expect(ctx.repository.weeks).toEqual(weeks);
  });

  it('ends the open setup, and a new setup starts after it', async () => {
    const ctx = await proposed(build());
    const view = await ctx.setup.reset(org());
    expect(ctx.sessions.sessions[0].status).toBe('DISCARDED');
    expect(view).toMatchObject({ status: 'SETUP', round: null, proposal: null, busy: null });
    await ctx.setup.startSetup(org(), { sourceText: 'We sell shoes' });
    expect(ctx.sessions.sessions[1]).toMatchObject({ kind: 'plan', status: 'ASKING' });
  });

  it('saves the facts into an ACTIVE plan and into a PROPOSED proposal', async () => {
    const edited = { ...facts, tone: 'Playful' };
    const active = await proposed(build());
    await active.setup.confirm(org(), { proposalVersion: 1 });
    expect((await active.service.saveFacts(org(), { facts: edited })).facts?.tone).toBe(
      'Playful'
    );
    const preview = await proposed(build());
    const view = await preview.service.saveFacts(org(), { facts: edited });
    expect(view.proposal?.facts.tone).toBe('Playful');
    expect(view.proposal?.version).toBe(1);
    expect(preview.sessions.sessions[0].proposal.facts.tone).toBe('Playful');
  });

  it('refuses facts before there is a proposal', async () => {
    const ctx = build();
    await ctx.repository.ensure();
    expect(await codeOf(ctx.service.saveFacts(org(), { facts }))).toBe('PLAN_NOT_ACTIVE');
    const asking = await withRound(build());
    expect(await codeOf(asking.service.saveFacts(org(), { facts }))).toBe('PLAN_NOT_ACTIVE');
  });

  it('refuses facts while the proposal is being written again', async () => {
    const ctx = await proposed(build());
    ctx.sessions.sessions[0].busy = 'proposal';
    expect(await codeOf(ctx.service.saveFacts(org(), { facts }))).toBe('PLAN_BUSY');
  });
});

describe('ContentPlanController', () => {
  it('refuses a USER member on every mutation and lets the read through', async () => {
    const { service, setup } = build();
    const sessions = {
      view: jest.fn(async () => ({ id: 'session-1' })),
      open: jest.fn(async () => null),
    };
    const controller = new ContentPlanController(service, sessions as any, setup);
    const user = org(Role.USER);
    const calls = [
      () => controller.startSetup(user, {}),
      () => controller.answer(user, {}),
      () => controller.propose(user, {}),
      () => controller.revise(user, {}),
      () => controller.confirm(user, {}),
      () => controller.reset(user),
      () => controller.saveFacts(user, {}),
      () => controller.startSession(user, {}),
      () => controller.answerSession(user, 'session-1', {}),
      () => controller.proposeSession(user, 'session-1', {}),
      () => controller.reviseSession(user, 'session-1', {}),
      () => controller.confirmSession(user, 'session-1', {}),
      () => controller.discardSession(user, 'session-1'),
    ];
    for (const call of calls) {
      let code: string | undefined;
      try {
        await call();
      } catch (err) {
        code = (err as any).getResponse().code;
      }
      expect(code).toBe('ADMIN_REQUIRED');
    }
    expect((await controller.view(user)).canEdit).toBe(false);
    // any member may read a session and resume the open one
    expect(await controller.session(user, 'session-1')).toEqual({ id: 'session-1' });
    expect(await controller.openSession(user, 'video_set')).toBeNull();
    expect(sessions.open).toHaveBeenCalledWith(user, { kind: 'video_set' });
  });
});
