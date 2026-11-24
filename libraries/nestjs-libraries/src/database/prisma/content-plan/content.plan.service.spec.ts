// Content plan service: the setup rounds, the proposal job and the confirmation. Needs no network, database or
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
  roundRows: any[] = [];
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
  resetSetup = async (_id: string, extra: any = {}) => {
    this.calls.push('resetSetup');
    this.roundRows = [];
    Object.assign(this.plan, extra, {
      status: 'SETUP',
      proposal: null,
      proposalTurns: null,
      notice: null,
    });
  };
  rounds = async () => [...this.roundRows].sort((a, b) => a.index - b.index);
  latestRound = async () => (await this.rounds()).slice(-1)[0] ?? null;
  saveRound = async (round: any) => {
    this.roundRows.push({ ...round, id: `round-${round.index}`, answers: null });
    this.plan.direction = round.direction;
  };
  saveAnswers = async (_planId: string, roundId: string, answers: any) => {
    this.roundRows.find((row) => row.id === roundId).answers = answers;
  };
  activeThemes = async () => this.themes.filter((theme) => !theme.archivedAt);
  openDraft = async () => null;
  currentWrittenWeek = async () => null;
  saveProposal = async (_id: string, saved: any) => {
    if (this.plan.busy !== 'proposal') {
      return false;
    }
    Object.assign(this.plan, {
      status: 'PROPOSED',
      proposal: saved.proposal,
      proposalVersion: saved.proposalVersion,
      proposalTurns: saved.proposalTurns,
      busy: null,
    });
    return true;
  };
  activate = async (data: any) => {
    this.calls.push('activate');
    this.themes = data.themes;
    this.clusters = data.clusters;
    this.weeks = data.weeks;
    Object.assign(this.plan, {
      status: 'ACTIVE',
      proposal: null,
      proposalTurns: null,
      facts: data.facts,
      busy: null,
    });
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
  const generator: Record<string, jest.Mock> = {
    setupRound: jest.fn().mockResolvedValue(roundAnswer()),
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
    temporal as any
  );
  return { service, repository, generator, spend, start };
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
  await ctx.service.startSetup(org(), { sourceText: 'We bake bread' });
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

  it('writes round 0 from the source text, spends on plan.setup_round and frees the plan', async () => {
    const { service, generator, spend, repository } = build();
    const view = await service.startSetup(org(), { sourceText: ' We bake bread ' });
    expect(generator.setupRound).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        turns: [],
        newUserTurn: stableJson({ sourceText: 'We bake bread' }),
      })
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
    expect(view.busy).toBeNull();
    expect(repository.roundRows[0].userTurn).toBe(
      stableJson({ sourceText: 'We bake bread' })
    );
  });

  it('refuses to start a setup over an ACTIVE plan', async () => {
    const ctx = build();
    await ctx.repository.ensure();
    ctx.repository.plan.status = 'ACTIVE';
    expect(await codeOf(ctx.service.startSetup(org(), { sourceText: 'x' }))).toBe(
      'PLAN_EXISTS'
    );
  });

  it('refuses a second job while one holds the plan', async () => {
    const ctx = build();
    await ctx.repository.ensure();
    ctx.repository.plan.busy = 'round';
    expect(await codeOf(ctx.service.startSetup(org(), { sourceText: 'x' }))).toBe(
      'PLAN_BUSY'
    );
  });

  it('answers 400 INVALID_PLAN for a bad body', async () => {
    const { service } = build();
    expect(await codeOf(service.startSetup(org(), { sourceText: '' }))).toBe(
      'INVALID_PLAN'
    );
    expect(await codeOf(service.startSetup(org(), { sourceText: 'x', extra: 1 }))).toBe(
      'INVALID_PLAN'
    );
  });

  it('turns a refused planner into 503 and a failed call into 502, and frees the plan', async () => {
    const refused = build({ setupRound: jest.fn().mockRejectedValue(new PlanNotConfigured()) });
    expect(await codeOf(refused.service.startSetup(org(), { sourceText: 'x' }))).toBe(
      'PLAN_NOT_AVAILABLE'
    );
    expect(refused.repository.plan.busy).toBeNull();
    const failed = build({ setupRound: jest.fn().mockRejectedValue(new PlanAiFailed()) });
    expect(await codeOf(failed.service.startSetup(org(), { sourceText: 'x' }))).toBe(
      'PLAN_AI_FAILED'
    );
    expect(failed.repository.plan.busy).toBeNull();
  });
});

describe('ContentPlanService answer', () => {
  it('refuses a round that is not the latest', async () => {
    const ctx = await withRound(build());
    expect(
      await codeOf(
        ctx.service.answer(org(), {
          roundId: 'round-old',
          direction: 'd',
          answers: [],
        })
      )
    ).toBe('ROUND_STALE');
    expect(ctx.generator.setupRound).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer to a question or option that is not in the round', async () => {
    const ctx = await withRound(build());
    expect(
      await codeOf(
        ctx.service.answer(org(), {
          roundId: 'round-0',
          direction: 'd',
          answers: [{ questionId: 'q9', optionId: 'o1' }],
        })
      )
    ).toBe('INVALID_PLAN');
    expect(
      await codeOf(
        ctx.service.answer(org(), {
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
    ctx.generator.setupRound.mockImplementationOnce(async () => {
      directionWhenAsked = ctx.repository.plan.direction;
      return roundAnswer({ direction: 'Next direction', assistantTurn: '{"raw":"second"}' });
    });
    const view = await ctx.service.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake sourdough for locals',
      answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
    });
    expect(directionWhenAsked).toBe('We bake sourdough for locals');
    const call = ctx.generator.setupRound.mock.calls[1][0];
    expect(call.turns).toEqual([
      { role: 'user', content: stableJson({ sourceText: 'We bake bread' }) },
      { role: 'assistant', content: '{"raw":"assistant text"}' },
    ]);
    expect(call.newUserTurn).toBe(
      stableJson({
        answers: [{ question: 'Who buys?', answer: 'Tourists' }],
        editedDirection: 'We bake sourdough for locals',
      })
    );
    expect(call.newUserTurn).not.toContain('o2');
    expect(view.round?.index).toBe(1);
    expect(view.direction).toBe('Next direction');
    expect(ctx.repository.roundRows[0].answers).toEqual([
      { questionId: 'q1', optionId: 'o2', other: null },
    ]);
    expect(ctx.repository.roundRows[1].userTurn).toBe(call.newUserTurn);
    expect(ctx.repository.roundRows[1].assistantTurn).toBe('{"raw":"second"}');
  });

  it('sends the owner own words when given, and null when the direction was not edited', async () => {
    const ctx = await withRound(build());
    await ctx.service.answer(org(), {
      roundId: 'round-0',
      direction: 'We bake for locals',
      answers: [{ questionId: 'q1', optionId: 'o1', other: 'Mostly cafes' }],
    });
    expect(ctx.generator.setupRound.mock.calls[1][0].newUserTurn).toBe(
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

const proposed = async (ctx: ReturnType<typeof build>, version = 1) => {
  await ctx.repository.ensure();
  Object.assign(ctx.repository.plan, {
    status: 'PROPOSED',
    direction: 'We bake for locals',
    proposal: proposal(version),
    proposalVersion: version,
    videosPerWeek: 1,
  });
  return ctx;
};

describe('ContentPlanService propose and revise', () => {
  it('stores the direction and videos per week and starts the proposal job', async () => {
    const ctx = await withRound(build());
    const view = await ctx.service.propose(org(), {
      direction: 'We bake for locals',
      videosPerWeek: 5,
      answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
    });
    expect(ctx.repository.plan.videosPerWeek).toBe(5);
    expect(ctx.repository.plan.direction).toBe('We bake for locals');
    expect(ctx.repository.roundRows[0].answers).toHaveLength(1);
    expect(ctx.start).toHaveBeenCalledWith(
      'contentPlanJobWorkflow',
      expect.objectContaining({
        workflowId: 'content_plan_proposal_plan-1',
        taskQueue: 'main',
        args: [{ kind: 'proposal', id: 'plan-1' }],
      })
    );
    expect(view.busy).toBe('proposal');
  });

  it('answers 409 PLAN_BUSY when the job is already running and keeps the plan held', async () => {
    const ctx = await withRound(build());
    ctx.start.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError('started', 'content_plan_proposal_plan-1', 'contentPlanJobWorkflow')
    );
    expect(
      await codeOf(ctx.service.propose(org(), { direction: 'd', videosPerWeek: 3 }))
    ).toBe('PLAN_BUSY');
    expect(ctx.repository.plan.busy).toBe('proposal');
  });

  it('answers 503 and frees the plan when the job cannot be started', async () => {
    const ctx = await withRound(build());
    ctx.start.mockRejectedValueOnce(new Error('down'));
    expect(
      await codeOf(ctx.service.propose(org(), { direction: 'd', videosPerWeek: 3 }))
    ).toBe('PLAN_NOT_AVAILABLE');
    expect(ctx.repository.plan.busy).toBeNull();
  });

  it('refuses a revise of a stale proposal and starts the revise job otherwise', async () => {
    const ctx = await proposed(build(), 2);
    expect(
      await codeOf(ctx.service.revise(org(), { proposalVersion: 1, feedback: 'More' }))
    ).toBe('PROPOSAL_STALE');
    expect(ctx.start).not.toHaveBeenCalled();
    const view = await ctx.service.revise(org(), { proposalVersion: 2, feedback: 'More' });
    expect(ctx.start).toHaveBeenCalledWith(
      'contentPlanJobWorkflow',
      expect.objectContaining({
        workflowId: 'content_plan_revise_plan-1',
        args: [{ kind: 'revise', id: 'plan-1', feedback: 'More' }],
      })
    );
    expect(view.busy).toBe('proposal');
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

  const startPlan = async (ctx: ReturnType<typeof build>) => {
    await ctx.repository.ensure();
    Object.assign(ctx.repository.plan, {
      direction: 'We bake for locals',
      videosPerWeek: 3,
      busy: 'proposal',
    });
  };

  it('writes the structure, 12 ideas and 4 outlines, and saves a PROPOSED plan', async () => {
    const ctx = build();
    wire(ctx);
    await startPlan(ctx);
    await ctx.service.buildProposal('plan-1', null);
    expect(ctx.generator.proposeStructure).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [],
        newUserTurn: stableJson({ direction: 'We bake for locals' }),
      })
    );
    expect(ctx.generator.writeIdeas.mock.calls[0][0].weeks).toHaveLength(ROADMAP_WEEKS);
    expect(ctx.generator.writeOutline).toHaveBeenCalledTimes(4);
    const saved = ctx.repository.plan;
    expect(saved.status).toBe('PROPOSED');
    expect(saved.busy).toBeNull();
    expect(saved.proposalVersion).toBe(1);
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
    expect(ctx.spend.mock.calls.map((call) => call[0].actionKey)).toEqual([
      'plan.proposal',
      'plan.roadmap',
      'plan.proposal',
      'plan.proposal',
      'plan.proposal',
      'plan.proposal',
    ]);
  });

  it('appends the feedback to the stored chat on a revise', async () => {
    const ctx = build();
    wire(ctx);
    await startPlan(ctx);
    const earlier = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
    ];
    Object.assign(ctx.repository.plan, { proposalTurns: earlier, proposalVersion: 1 });
    await ctx.service.buildProposal('plan-1', 'Fewer themes');
    expect(ctx.generator.proposeStructure.mock.calls[0][0].turns).toEqual(earlier);
    expect(ctx.generator.proposeStructure.mock.calls[0][0].newUserTurn).toBe(
      stableJson({ feedback: 'Fewer themes' })
    );
    expect(ctx.repository.plan.proposalVersion).toBe(2);
    expect(ctx.repository.plan.proposalTurns).toEqual([
      ...earlier,
      { role: 'user', content: stableJson({ feedback: 'Fewer themes' }) },
      { role: 'assistant', content: '{"raw":"structure"}' },
    ]);
  });

  it('drops the answer when the plan was reset while it was written', async () => {
    const ctx = build();
    wire(ctx);
    await startPlan(ctx);
    ctx.generator.writeIdeas.mockImplementationOnce(async (input: any) => {
      ctx.repository.plan.busy = null;
      return { ideas: input.weeks.map(() => 'i'), usage: structure.usage };
    });
    await ctx.service.buildProposal('plan-1', null);
    expect(ctx.repository.plan.status).toBe('SETUP');
    expect(ctx.repository.plan.proposal).toBeNull();
  });

  it('throws the generator failure and the failure path sets the notice', async () => {
    const ctx = build();
    ctx.generator.proposeStructure.mockRejectedValue(new PlanAiFailed());
    await startPlan(ctx);
    await expect(ctx.service.buildProposal('plan-1', null)).rejects.toBeInstanceOf(
      PlanAiFailed
    );
    await ctx.service.proposalFailed('plan-1');
    expect(ctx.repository.plan.busy).toBeNull();
    expect(ctx.repository.plan.notice).toBe('proposal_failed');
  });
});

describe('ContentPlanService confirm', () => {
  it('refuses a stale proposal version', async () => {
    const ctx = await proposed(build(), 2);
    expect(await codeOf(ctx.service.confirm(org(), { proposalVersion: 1 }))).toBe(
      'PROPOSAL_STALE'
    );
    expect(ctx.repository.calls).not.toContain('activate');
  });

  it('refuses when the plan is not PROPOSED', async () => {
    const ctx = build();
    await ctx.repository.ensure();
    expect(await codeOf(ctx.service.confirm(org(), { proposalVersion: 0 }))).toBe(
      'PROPOSAL_STALE'
    );
  });

  it('creates 12 weeks on the right clusters from today and starts the first week job', async () => {
    const ctx = await proposed(build());
    const today = new Date().toISOString().slice(0, 10);
    const view = await ctx.service.confirm(org(), { proposalVersion: 1 });
    const { themes, clusters, weeks } = ctx.repository;
    expect(view.status).toBe('ACTIVE');
    expect(view.facts).toEqual(facts);
    expect(view.proposal).toBeNull();
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
    const view = await ctx.service.confirm(org(), { proposalVersion: 1 });
    expect(view.status).toBe('ACTIVE');
  });
});

describe('ContentPlanService reset and facts', () => {
  it('goes back to SETUP, clears the rounds and the proposal, and touches no week', async () => {
    const ctx = await proposed(build());
    await ctx.service.confirm(org(), { proposalVersion: 1 });
    const weeks = [...ctx.repository.weeks];
    const view = await ctx.service.reset(org());
    expect(view.status).toBe('SETUP');
    expect(view.round).toBeNull();
    expect(view.proposal).toBeNull();
    expect(ctx.repository.weeks).toEqual(weeks);
  });

  it('saves the facts into an ACTIVE plan and into a PROPOSED proposal', async () => {
    const edited = { ...facts, tone: 'Playful' };
    const active = await proposed(build());
    await active.service.confirm(org(), { proposalVersion: 1 });
    expect((await active.service.saveFacts(org(), { facts: edited })).facts?.tone).toBe(
      'Playful'
    );
    const preview = await proposed(build());
    const view = await preview.service.saveFacts(org(), { facts: edited });
    expect(view.proposal?.facts.tone).toBe('Playful');
    expect(view.proposal?.version).toBe(1);
  });

  it('refuses facts before there is a proposal', async () => {
    const ctx = build();
    await ctx.repository.ensure();
    expect(await codeOf(ctx.service.saveFacts(org(), { facts }))).toBe('PLAN_NOT_ACTIVE');
  });
});

describe('ContentPlanController', () => {
  it('refuses a USER member on every mutation and lets the read through', async () => {
    const { service } = build();
    const controller = new ContentPlanController(service);
    const user = org(Role.USER);
    const calls = [
      () => controller.startSetup(user, {}),
      () => controller.answer(user, {}),
      () => controller.propose(user, {}),
      () => controller.revise(user, {}),
      () => controller.confirm(user, {}),
      () => controller.reset(user),
      () => controller.saveFacts(user, {}),
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
  });
});
