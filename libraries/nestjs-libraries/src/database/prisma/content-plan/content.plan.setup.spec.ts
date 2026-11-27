// Content plan setup kind: the session kind `plan` that is the brand's plan setup on the planning engine. Needs no network,
// database or Temporal: the storage is an in-memory stand-in, and the generator, the credits and the workflow engine are
// stubs. Covers the start (an ACTIVE plan refused and no session made, the plan made when there is none, the videos a week
// from the plan or the options), the rounds on the setup frame with the setup's own turn key, a rewind to an earlier round,
// the proposal with the videos a week sent with it, a revise, the confirmation that makes the plan ACTIVE with the session
// summary as its direction, a reset followed by a new session, and the jobs queued before the setup moved onto sessions
// (a legacy `proposal` or `revise` job id still finishing, on a session moved by the migration).
import { Role } from '@prisma/client';
import {
  ContentPlanService,
  PlanOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { PlanAiFailed } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
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
const org = (role: Role = Role.ADMIN): PlanOrganization =>
  ({
    id: ORG,
    name: 'Bakery',
    locale: 'en',
    timezone: 'UTC',
    profile: { schemaVersion: 1 },
    users: [{ role }],
  }) as unknown as PlanOrganization;

const facts: PlanFacts = {
  whatWeDo: 'Bakes bread',
  audience: 'Neighbours',
  problems: ['p1'],
  solution: 'Fresh daily',
  objections: ['o1'],
  tone: 'Warm',
  videoSeconds: 60,
};

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

// The storage of the plan, in memory, with the behaviour the setup relies on.
class FakeRepository {
  plan: any = null;
  themes: any[] = [];
  clusters: any[] = [];
  weeks: any[] = [];
  ensure = jest.fn(async () => {
    this.plan ??= {
      id: 'plan-1',
      organizationId: ORG,
      status: 'SETUP',
      sourceText: null,
      direction: null,
      videosPerWeek: 3,
      facts: null,
      busy: null,
      notice: null,
    };
    return this.plan;
  });

  findByOrganization = async () => this.plan;
  findWithOrganization = async () =>
    this.plan && {
      ...this.plan,
      organization: { id: ORG, name: 'Bakery', locale: 'en', timezone: 'UTC' },
    };
  update = async (_id: string, data: any) => Object.assign(this.plan, data);
  release = async (_id: string, data: any = {}) => Object.assign(this.plan, data, { busy: null });
  activeThemes = async () => this.themes;
  openDraft = async () => null;
  currentWrittenWeek = async () => null;
  activate = async (data: any) => {
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

const structure = {
  facts,
  themes: proposal().themes,
  clusters: proposal().clusters,
  assistantTurn: '{"raw":"structure"}',
  usage: { prompt: 1, cached: 0, completion: 1 },
};

const build = () => {
  const repository = new FakeRepository();
  const sessions = new FakeSessionRepository();
  const generator = {
    chatRound: jest.fn().mockResolvedValue(roundAnswer()),
    proposeStructure: jest.fn().mockResolvedValue(structure),
    writeIdeas: jest.fn(async (input: any) => ({
      ideas: input.weeks.map((_: unknown, index: number) => `Idea ${index}`),
      usage: structure.usage,
    })),
    writeOutline: jest.fn(async (input: any) => ({
      titles: input.angles.map((_: unknown, index: number) => `T${index}`),
      usage: structure.usage,
    })),
  };
  const spend = jest.fn((_request: any, run: () => Promise<unknown>) => run());
  const workflowStart = jest.fn().mockResolvedValue(undefined);
  const temporal = { client: { getRawClient: () => ({ workflow: { start: workflowStart } }) } };
  const plans = new ContentPlanService(
    repository as any,
    generator as any,
    { spend } as any,
    temporal as any,
    sessions as any
  );
  const kinds = new PlanSessionKinds();
  new PlanSetupSessionKind(kinds, plans, repository as any, generator as any);
  const service = new ContentPlanSessionService(sessions as any, generator as any, plans, kinds);
  const setup = new ContentPlanSetupService(plans, repository as any, sessions as any, service);
  return { service, setup, plans, repository, sessions, generator, spend, workflowStart };
};

// A setup started through the session routes, asking its first round.
const started = async (options?: Record<string, unknown>) => {
  const ctx = build();
  const view = await ctx.service.start(org(), {
    kind: 'plan',
    sourceText: ' We bake bread ',
    ...(options ? { options } : {}),
  });
  return { ...ctx, view };
};

// A setup whose proposal the job has written (version 1), the videos a week chosen at propose.
const proposed = async () => {
  const ctx = await started();
  await ctx.service.propose(org(), 'session-1', {
    summary: 'We bake for locals',
    options: { videosPerWeek: 4 },
  });
  await ctx.service.buildProposal('session-1', null);
  ctx.spend.mockClear();
  ctx.workflowStart.mockClear();
  return ctx;
};

const codeOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return (err as any).getResponse?.().code ?? (err as Error).name;
  }
  return undefined;
};

describe('plan setup session kind', () => {
  describe('start', () => {
    it('is refused over an ACTIVE plan and makes no session', async () => {
      const ctx = build();
      await ctx.repository.ensure();
      ctx.repository.plan.status = 'ACTIVE';
      expect(await codeOf(ctx.service.start(org(), { kind: 'plan', sourceText: 'x' }))).toBe('PLAN_EXISTS');
      expect(ctx.sessions.sessions).toHaveLength(0);
      expect(ctx.generator.chatRound).not.toHaveBeenCalled();
    });

    it('makes the plan when the workspace has none, and asks the first round on the setup frame', async () => {
      const { view, repository, generator, sessions } = await started();
      expect(repository.ensure).toHaveBeenCalledWith(ORG);
      expect(view).toMatchObject({
        kind: 'plan',
        status: 'ASKING',
        sourceText: 'We bake bread',
        summary: 'We bake for locals',
        options: { videosPerWeek: 3 },
        busy: null,
      });
      const [frame, input, hints] = generator.chatRound.mock.calls[0];
      expect(frame).toBe('planner.frame.setup');
      expect(hints).toBeUndefined();
      expect(input.newUserTurn).toBe(stableJson({ sourceText: 'We bake bread' }));
      expect(sessions.sessions[0]).toMatchObject({ planId: 'plan-1', organizationId: ORG });
    });

    it('takes the videos a week from the options, and refuses a number outside 1 to 7', async () => {
      const { view } = await started({ videosPerWeek: 5 });
      expect(view.options).toEqual({ videosPerWeek: 5 });
      const ctx = build();
      expect(
        await codeOf(ctx.service.start(org(), { kind: 'plan', sourceText: 'x', options: { videosPerWeek: 9 } }))
      ).toBe('INVALID_PLAN');
      expect(
        await codeOf(ctx.service.start(org(), { kind: 'plan', sourceText: 'x', options: { other: 1 } }))
      ).toBe('INVALID_PLAN');
    });
  });

  describe('rounds', () => {
    it('sends the chat append-only with the setup key for the owner edit, and shows the rounds like the plan page', async () => {
      const ctx = await started();
      ctx.generator.chatRound.mockResolvedValueOnce(
        roundAnswer({ direction: 'Next direction', assistantTurn: '{"raw":"second"}' })
      );
      const view = await ctx.service.answer(org(), 'session-1', {
        roundId: 'round-0',
        summary: 'We bake sourdough for locals',
        answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
      });
      const input = ctx.generator.chatRound.mock.calls[1][1];
      expect(input.turns).toEqual([
        { role: 'user', content: stableJson({ sourceText: 'We bake bread' }) },
        { role: 'assistant', content: '{"raw":"assistant text"}' },
      ]);
      expect(input.newUserTurn).toBe(
        stableJson({
          answers: [{ question: 'Who buys?', answer: 'Tourists' }],
          editedDirection: 'We bake sourdough for locals',
        })
      );
      expect(view.rounds.map((round) => round.summary)).toEqual([
        'We bake sourdough for locals',
        'Next direction',
      ]);
      // the plan page draws the same rounds
      const plan = await ctx.plans.view(org());
      expect(plan.rounds.map((round) => round.direction)).toEqual([
        'We bake sourdough for locals',
        'Next direction',
      ]);
      expect(plan.round?.id).toBe('round-1');
    });

    it('going back to an earlier round drops the later ones and a proposal, and writes the next round again', async () => {
      const ctx = await started();
      await ctx.service.answer(org(), 'session-1', {
        roundId: 'round-0',
        summary: 'We bake bread',
        answers: [{ questionId: 'q1', optionId: 'o1', other: null }],
      });
      ctx.generator.chatRound.mockResolvedValue(roundAnswer());
      await ctx.service.propose(org(), 'session-1', { summary: 'We bake bread', options: { videosPerWeek: 2 } });
      await ctx.service.buildProposal('session-1', null);
      expect(ctx.sessions.sessions[0].status).toBe('PROPOSED');
      ctx.sessions.calls.length = 0;
      const view = await ctx.service.answer(org(), 'session-1', {
        roundId: 'round-0',
        summary: 'We bake bread',
        answers: [{ questionId: 'q1', optionId: 'o2', other: null }],
      });
      expect(ctx.sessions.calls).toContain('rewindTo');
      expect(view.status).toBe('ASKING');
      expect(view.proposal).toBeNull();
      expect(view.rounds.map((round) => round.index)).toEqual([0, 1]);
      expect(ctx.generator.chatRound.mock.calls.slice(-1)[0][1].newUserTurn).toContain('Tourists');
    });
  });

  describe('propose and revise', () => {
    it('stores the videos a week sent with the proposal request and starts the proposal job', async () => {
      const ctx = await started();
      const view = await ctx.service.propose(org(), 'session-1', {
        summary: 'We bake for locals',
        options: { videosPerWeek: 5 },
      });
      expect(view).toMatchObject({ status: 'PROPOSING', busy: 'proposal', options: { videosPerWeek: 5 } });
      expect(ctx.workflowStart).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({
          workflowId: 'content_plan_session_proposal_session-1',
          args: [{ kind: 'session_proposal', id: 'session-1' }],
        })
      );
    });

    it('keeps the stored videos a week when none are sent, and refuses a bad number before holding the session', async () => {
      const ctx = await started({ videosPerWeek: 2 });
      expect(
        await codeOf(ctx.service.propose(org(), 'session-1', { summary: 's', options: { videosPerWeek: 8 } }))
      ).toBe('INVALID_PLAN');
      expect(ctx.sessions.sessions[0].busy).toBeNull();
      const view = await ctx.service.propose(org(), 'session-1', { summary: 's' });
      expect(view.options).toEqual({ videosPerWeek: 2 });
    });

    it('writes the proposal from the session summary and the chosen videos a week, each call on its own action', async () => {
      const ctx = await started();
      await ctx.service.propose(org(), 'session-1', { summary: 'We bake for locals', options: { videosPerWeek: 5 } });
      ctx.spend.mockClear();
      await ctx.service.buildProposal('session-1', null);
      expect(ctx.generator.proposeStructure).toHaveBeenCalledWith(
        expect.objectContaining({ turns: [], newUserTurn: stableJson({ direction: 'We bake for locals' }) })
      );
      expect(ctx.generator.writeOutline.mock.calls[0][0]).toMatchObject({ videosPerWeek: 5 });
      expect(ctx.generator.writeOutline.mock.calls[0][0].angles).toHaveLength(5);
      const row = ctx.sessions.sessions[0];
      expect(row).toMatchObject({ status: 'PROPOSED', proposalVersion: 1, busy: null });
      expect(row.proposal.version).toBe(1);
      expect(row.proposal.weeks).toHaveLength(ROADMAP_WEEKS);
      expect(ctx.spend.mock.calls.map((call) => call[0].actionKey)).toEqual([
        'plan.proposal',
        'plan.roadmap',
        'plan.proposal',
        'plan.proposal',
        'plan.proposal',
        'plan.proposal',
      ]);
      const plan = await ctx.plans.view(org());
      expect(plan).toMatchObject({ status: 'PROPOSED', direction: 'We bake for locals', videosPerWeek: 5 });
      expect(plan.proposal?.version).toBe(1);
    });

    it('a revise is the next turn of the stored chat and writes version 2', async () => {
      const ctx = await proposed();
      const view = await ctx.service.revise(org(), 'session-1', { proposalVersion: 1, feedback: 'Fewer themes' });
      expect(view.status).toBe('PROPOSING');
      expect(ctx.workflowStart.mock.calls[0][1].args).toEqual([
        { kind: 'session_revise', id: 'session-1', feedback: 'Fewer themes' },
      ]);
      await ctx.service.buildProposal('session-1', 'Fewer themes');
      const row = ctx.sessions.sessions[0];
      expect(ctx.generator.proposeStructure.mock.calls[1][0].turns).toHaveLength(2);
      expect(ctx.generator.proposeStructure.mock.calls[1][0].newUserTurn).toBe(
        stableJson({ feedback: 'Fewer themes' })
      );
      expect(row.proposalVersion).toBe(2);
      expect(row.proposal.version).toBe(2);
      expect(row.proposalTurns).toHaveLength(4);
      expect(row.status).toBe('PROPOSED');
    });

    it('a failed proposal job frees the session, tells the owner, and goes back to asking', async () => {
      const ctx = await started();
      await ctx.service.propose(org(), 'session-1', { summary: 'We bake for locals' });
      ctx.generator.proposeStructure.mockRejectedValueOnce(new PlanAiFailed());
      await expect(ctx.service.buildProposal('session-1', null)).rejects.toBeInstanceOf(PlanAiFailed);
      await ctx.service.sessionFailed('session-1');
      expect(ctx.sessions.sessions[0]).toMatchObject({ status: 'ASKING', busy: null, notice: 'proposal_failed' });
      expect((await ctx.plans.view(org())).notice).toBe('proposal_failed');
    });
  });

  describe('confirm', () => {
    it('makes the plan ACTIVE with the session summary as its direction and the chosen videos a week', async () => {
      const ctx = await proposed();
      const today = new Date().toISOString().slice(0, 10);
      const view = await ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 });
      expect(view.status).toBe('DONE');
      expect(ctx.repository.plan).toMatchObject({
        status: 'ACTIVE',
        direction: 'We bake for locals',
        videosPerWeek: 4,
        sourceText: 'We bake bread',
        facts,
      });
      expect(ctx.repository.weeks).toHaveLength(ROADMAP_WEEKS);
      expect(ctx.repository.weeks[0].weekStart).toBe(today);
      expect(ctx.repository.themes.map((theme: any) => theme.position)).toEqual([0, 1]);
      // the first week is written right away
      expect(ctx.workflowStart).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({
          workflowId: `content_plan_week_${ctx.repository.weeks[0].id}`,
          args: [{ kind: 'week', id: ctx.repository.weeks[0].id }],
        })
      );
      expect(await codeOf(ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 }))).toBe(
        'PROPOSAL_STALE'
      );
      expect((await ctx.plans.view(org())).status).toBe('ACTIVE');
    });

    it('refuses a stale version and a plan that is already ACTIVE, and activates nothing', async () => {
      const ctx = await proposed();
      expect(await codeOf(ctx.service.confirm(org(), 'session-1', { proposalVersion: 0 }))).toBe(
        'PROPOSAL_STALE'
      );
      ctx.repository.plan.status = 'ACTIVE';
      expect(await codeOf(ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 }))).toBe(
        'PROPOSAL_STALE'
      );
      expect(ctx.repository.weeks).toHaveLength(0);
      expect(ctx.sessions.sessions[0]).toMatchObject({ status: 'PROPOSED', busy: null });
    });
  });

  describe('reset', () => {
    it('ends the open session, keeps the weeks, and a new plan session starts after it', async () => {
      const ctx = await proposed();
      await ctx.service.confirm(org(), 'session-1', { proposalVersion: 1 });
      const weeks = [...ctx.repository.weeks];
      const view = await ctx.setup.reset(org());
      expect(view).toMatchObject({ status: 'SETUP', round: null, proposal: null });
      expect(ctx.repository.weeks).toEqual(weeks);
      // the plan is not ACTIVE any more, so a new setup may start
      const next = await ctx.service.start(org(), { kind: 'plan', sourceText: 'We sell shoes' });
      expect(next).toMatchObject({ kind: 'plan', status: 'ASKING', sourceText: 'We sell shoes' });
      expect(ctx.sessions.sessions.map((row) => row.status)).toEqual(['DONE', 'ASKING']);
      expect((await ctx.service.open(org(), { kind: 'plan' }))?.id).toBe('session-2');
    });
  });

  describe('setups and jobs from before the move onto sessions', () => {
    // A session as the migration makes it from a plan in SETUP: the plan id is the session id, the rounds keep their ids
    // and their stored turns (the owner's edit is under editedDirection).
    const migrated = (extra: Record<string, unknown> = {}) => {
      const ctx = build();
      ctx.repository.plan = {
        id: 'plan-1',
        organizationId: ORG,
        status: 'SETUP',
        sourceText: 'We bake bread',
        direction: 'We bake sourdough for locals',
        videosPerWeek: 3,
        facts: null,
        busy: null,
        notice: null,
      };
      ctx.sessions.sessions.push({
        id: 'plan-1',
        organizationId: ORG,
        planId: 'plan-1',
        kind: 'plan',
        status: 'PROPOSING',
        sourceText: 'We bake bread',
        summary: 'We bake sourdough for locals',
        options: { videosPerWeek: 3 },
        proposal: null,
        proposalVersion: 0,
        proposalTurns: null,
        busy: 'proposal',
        notice: null,
        confirmedAt: null,
        ...extra,
      });
      ctx.sessions.roundRows.push(
        {
          id: 'legacy-round-0',
          sessionId: 'plan-1',
          index: 0,
          summary: 'We bake for locals',
          questions: [question],
          answers: [{ questionId: 'q1', optionId: 'o2', optionIds: [], other: null }],
          readyForPlan: false,
          userTurn: stableJson({ sourceText: 'We bake bread' }),
          assistantTurn: '{"raw":"old 0"}',
        },
        {
          id: 'legacy-round-1',
          sessionId: 'plan-1',
          index: 1,
          summary: 'We bake sourdough for locals',
          questions: [],
          answers: null,
          readyForPlan: true,
          userTurn: stableJson({
            answers: [{ question: 'Who buys?', answer: 'Tourists' }],
            editedDirection: 'We bake sourdough for locals',
          }),
          assistantTurn: '{"raw":"old 1"}',
        }
      );
      return ctx;
    };

    it('shows a moved setup on the plan page with its round ids and the owner edits', async () => {
      const ctx = migrated({ status: 'ASKING', busy: null });
      const plan = await ctx.plans.view(org());
      expect(plan.status).toBe('SETUP');
      expect(plan.rounds.map((round) => round.id)).toEqual(['legacy-round-0', 'legacy-round-1']);
      expect(plan.rounds[0].direction).toBe('We bake sourdough for locals');
      expect(plan.round?.id).toBe('legacy-round-1');
      // a tab that still holds the old round id keeps working
      const view = await ctx.setup.answer(org(), {
        roundId: 'legacy-round-1',
        direction: 'We bake sourdough for locals',
        answers: [],
      });
      expect(view.rounds.map((round) => round.index)).toEqual([0, 1, 2]);
    });

    it('a queued `proposal` job id finishes on the plan session', async () => {
      const ctx = migrated();
      await ctx.setup.buildProposal('plan-1', null);
      expect(ctx.generator.proposeStructure).toHaveBeenCalledWith(
        expect.objectContaining({ newUserTurn: stableJson({ direction: 'We bake sourdough for locals' }) })
      );
      expect(ctx.sessions.sessions[0]).toMatchObject({ status: 'PROPOSED', proposalVersion: 1, busy: null });
      const plan = await ctx.plans.view(org());
      expect(plan.status).toBe('PROPOSED');
      expect(plan.proposal?.version).toBe(1);
      // the job ran again after it saved its answer: nothing is written twice
      await ctx.setup.buildProposal('plan-1', null);
      expect(ctx.generator.proposeStructure).toHaveBeenCalledTimes(1);
    });

    it('a queued `revise` job id finishes on the proposal chat of the moved session', async () => {
      const turns = [
        { role: 'user', content: stableJson({ direction: 'We bake sourdough for locals' }) },
        { role: 'assistant', content: '{"raw":"old structure"}' },
      ];
      const ctx = migrated({ proposal: proposal(1), proposalVersion: 1, proposalTurns: turns });
      await ctx.setup.buildProposal('plan-1', 'Fewer themes');
      expect(ctx.generator.proposeStructure.mock.calls[0][0].turns).toEqual(turns);
      expect(ctx.sessions.sessions[0]).toMatchObject({ status: 'PROPOSED', proposalVersion: 2, busy: null });
      expect(ctx.sessions.sessions[0].proposalTurns).toHaveLength(4);
    });

    it('a queued job that fails frees the plan session, back where it was, with the notice', async () => {
      const proposing = migrated();
      await proposing.setup.proposalFailed('plan-1');
      expect(proposing.sessions.sessions[0]).toMatchObject({
        status: 'ASKING',
        busy: null,
        notice: 'proposal_failed',
      });
      const revising = migrated({ proposal: proposal(1), proposalVersion: 1 });
      await revising.setup.proposalFailed('plan-1');
      expect(revising.sessions.sessions[0]).toMatchObject({
        status: 'PROPOSED',
        busy: null,
        notice: 'proposal_failed',
      });
    });

    it('a queued job of a plan with no open session, or no plan, does nothing', async () => {
      const discarded = migrated({ status: 'DISCARDED', busy: null });
      await discarded.setup.buildProposal('plan-1', null);
      await discarded.setup.proposalFailed('plan-1');
      expect(discarded.generator.proposeStructure).not.toHaveBeenCalled();
      expect(discarded.sessions.sessions[0].notice).toBeNull();
      const none = build();
      await none.setup.buildProposal('plan-9', null);
      await none.setup.proposalFailed('plan-9');
      expect(none.generator.proposeStructure).not.toHaveBeenCalled();
    });
  });
});
