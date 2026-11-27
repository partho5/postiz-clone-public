// Content plan video set: the session kind that turns the owner's raw idea into one video or a few inside the running plan.
// Needs no network, database or Temporal: the storage is an in-memory stand-in, and the generator, the credits and the
// workflow engine are stubs. Covers the start (a date outside today..plan end and a bad count refused, the defaults, the
// count the owner chose told to the first round, no active plan refused without making a plan row), a clear idea (zero
// questions, then the proposal with N videos whose dates the code sets, one per day and capped at the plan end), the
// answers of the last round and the charge on plan.instant, a revise from the owner's feedback, the confirmation with date
// edits (PLANNED instant ideas linked to the session, refusals leaving the session proposed) and the confirmed videos in
// the web and the phone week.
import { ContentPlanService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { ContentPlanSessionService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.service';
import { PlanSessionKinds } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.kind';
import { VideoSetSessionKind } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.video.set.kind';
import { addDays, stableJson } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import { VIDEO_SET_ROUND_FIELD_HINTS } from '@gitroom/nestjs-libraries/database/prisma/content-plan/prompts';
import { PlanFacts, SLOT_DAYS } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

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
const NOW = new Date('2026-03-10T12:00:00Z');
const TODAY = '2026-03-10';
// the plan's last week starts 2 days ago, so the plan ends 4 days from today
const PLAN_END = addDays(TODAY, 4);
const org = { id: ORG, name: 'Bakery', locale: 'en', timezone: 'UTC', users: [{ role: 'ADMIN' }] } as any;

const facts: PlanFacts = {
  whatWeDo: 'Bakes bread',
  audience: 'Neighbours',
  problems: ['p1'],
  solution: 'Fresh daily',
  objections: ['o1'],
  tone: 'Warm',
  videoSeconds: 60,
};

// One video as the stubbed generator writes it.
const written = (index: number) => ({
  ref: `v${index + 1}`,
  title: `Video ${index + 1}`,
  why: 'It helps',
  beats: [
    { hook: 'one', say: 'say one' },
    { hook: 'two', say: 'say two' },
    { hook: 'three', say: 'say three' },
  ],
  closingLine: 'bye',
});

// The storage of the plan, in memory, with the behaviour the video set and the weeks rely on.
class FakeRepository {
  plan: any = {
    id: 'plan-1',
    organizationId: ORG,
    status: 'ACTIVE',
    direction: 'We bake for locals',
    videosPerWeek: 3,
    facts,
    busy: null,
    notice: null,
    organization: { id: ORG, name: 'Bakery', locale: 'en', timezone: 'UTC' },
  };
  weeks: any[] = [];
  days: any[] = [];
  instants: any[] = [];
  ensure = jest.fn(async () => this.plan);

  // A READY current week (it started 2 days ago) with 3 planned days, and nothing after it: the plan ends in 4 days.
  addCurrentWeek() {
    const week = { id: 'week-1', planId: 'plan-1', clusterId: 'c1', idea: 'An idea', weekStart: addDays(TODAY, -2), status: 'READY' };
    this.weeks.push(week);
    SLOT_DAYS[3].forEach((dayIndex) =>
      this.days.push({
        id: `day-${dayIndex}`,
        weekId: week.id,
        organizationId: ORG,
        dayIndex,
        date: addDays(week.weekStart, dayIndex),
        title: `Title ${dayIndex}`,
        angle: 'problem',
        why: 'why',
        beats: [{ hook: 'h', say: 's' }],
        closingLine: 'bye',
        status: 'PLANNED',
        busy: false,
        version: 1,
      })
    );
  }

  findByOrganization = async (id: string) => (id === ORG ? this.plan : null);
  findWithOrganization = async () => this.plan;
  lastWeek = async () => [...this.weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart)).slice(-1)[0] ?? null;
  currentWeekWithDays = async (_id: string, from: string, to: string) => {
    const week = this.weeks.find((known) => known.weekStart >= from && known.weekStart <= to);
    return week && { ...week, days: this.days.filter((day) => day.weekId === week.id) };
  };
  createSessionVideos = async (planId: string, organizationId: string, sessionId: string, idea: string, videos: any[]) => {
    videos.forEach((video, index) =>
      this.instants.push({
        id: `instant-${this.instants.length + 1}`,
        planId,
        organizationId,
        sessionId,
        idea,
        status: 'PLANNED',
        recordedAt: null,
        createdAt: new Date(NOW.getTime() + index),
        ...video,
      })
    );
    return { count: videos.length };
  };
  instantIdeasBetween = async (orgId: string, from: string, to: string) =>
    this.instants
      .filter((row) => row.organizationId === orgId && row.status !== 'DRAFT' && row.date >= from && row.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
}

// The storage of the sessions, in memory.
class FakeSessionRepository {
  sessions: any[] = [];
  roundRows: any[] = [];

  private find = (id: string) => this.sessions.find((row) => row.id === id);

  findByOrganization = async (organizationId: string, id: string) =>
    this.sessions.find((row) => row.id === id && row.organizationId === organizationId) ?? null;
  findOpen = async (organizationId: string, kind: string) =>
    [...this.sessions]
      .reverse()
      .find(
        (row) =>
          row.organizationId === organizationId &&
          row.kind === kind &&
          ['ASKING', 'PROPOSING', 'PROPOSED'].includes(row.status)
      ) ?? null;
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
      .filter((row) => row.organizationId === session.organizationId && row.kind === session.kind)
      .filter((row) => ['ASKING', 'PROPOSING', 'PROPOSED'].includes(row.status))
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
  release = async (id: string, data: any = {}) => Object.assign(this.find(id), data, { busy: null });
  rounds = async (sessionId: string) =>
    this.roundRows.filter((row) => row.sessionId === sessionId).sort((a, b) => a.index - b.index);
  latestRound = async (sessionId: string) => (await this.rounds(sessionId)).slice(-1)[0] ?? null;
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

// A round of a clear idea: what was understood, no question, nothing open.
const clearRound = {
  direction: 'A video about our new sourdough loaf',
  questions: [] as any[],
  readyForPlan: true,
  assistantTurn: '{"raw":"round"}',
  usage: { prompt: 1, cached: 0, completion: 1 },
};

const build = () => {
  const repository = new FakeRepository();
  const sessions = new FakeSessionRepository();
  const generator = {
    chatRound: jest.fn().mockResolvedValue(clearRound),
    writeVideoSet: jest.fn(async (input: any) => ({
      videos: Array.from({ length: input.count }, (_, index) => written(index)),
      userTurn: stableJson(input.feedback ? { feedback: input.feedback } : { idea: input.idea }),
      assistantTurn: '{"raw":"videos"}',
      usage: { prompt: 1, cached: 0, completion: 1 },
    })),
  };
  const spend = jest.fn(async (_request: any, run: () => Promise<unknown>) => run());
  const workflowStart = jest.fn(async () => undefined);
  const temporal = { client: { getRawClient: () => ({ workflow: { start: workflowStart } }) } };
  const plans = new ContentPlanService(repository as any, generator as any, { spend } as any, temporal as any, sessions as any);
  const kinds = new PlanSessionKinds();
  new VideoSetSessionKind(kinds, plans, repository as any, sessions as any, generator as any);
  const service = new ContentPlanSessionService(sessions as any, generator as any, plans, kinds);
  return { service, plans, repository, sessions, generator, spend, workflowStart };
};

// An active plan with a current week, a session started on `options`.
const started = async (options: Record<string, unknown> = {}) => {
  const ctx = build();
  ctx.repository.addCurrentWeek();
  const view = await ctx.service.start(org, { kind: 'video_set', sourceText: ' Show our new loaf ', options });
  return { ...ctx, view };
};

// A session whose proposal the job has written (version 1).
const proposed = async (options: Record<string, unknown> = {}) => {
  const ctx = await started(options);
  await ctx.service.propose(org, 'session-1', { summary: 'A video about our new sourdough loaf' });
  await ctx.service.buildProposal('session-1', null);
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

describe('video set session kind', () => {
  beforeAll(() => {
    // only Date is faked
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('start', () => {
    it('defaults to today and one video, asks the first round on the video-set frame and its own wording, and stores the options', async () => {
      const { view, generator, sessions } = await started();
      expect(view).toMatchObject({
        kind: 'video_set',
        status: 'ASKING',
        options: { date: TODAY, count: 1, countSet: false },
        summary: 'A video about our new sourdough loaf',
        busy: null,
      });
      expect(view.round?.questions).toEqual([]);
      expect(view.round?.readyForPlan).toBe(true);
      const [frame, input, hints] = generator.chatRound.mock.calls[0];
      expect(frame).toBe('planner.frame.video_set_round');
      expect(hints).toBe(VIDEO_SET_ROUND_FIELD_HINTS);
      // a count the owner did not choose is not told to the AI, so it may ask about it
      expect(input.newUserTurn).toBe(stableJson({ sourceText: 'Show our new loaf' }));
      expect(sessions.sessions[0]).toMatchObject({ planId: 'plan-1', organizationId: ORG });
    });

    it('tells the first round the count the owner chose, so it never asks about it', async () => {
      const { view, generator } = await started({ count: 3, date: addDays(TODAY, 2) });
      expect(view.options).toEqual({ date: addDays(TODAY, 2), count: 3, countSet: true });
      expect(generator.chatRound.mock.calls[0][1].newUserTurn).toBe(
        stableJson({ sourceText: 'Show our new loaf', videoCount: 3 })
      );
    });

    it('refuses a date before today or after the end of the plan, and a count outside 1 to 7, with INVALID_PLAN', async () => {
      const { service, generator, sessions, repository } = build();
      repository.addCurrentWeek();
      for (const options of [
        { date: addDays(TODAY, -1) },
        { date: addDays(PLAN_END, 1) },
        { date: '2026-02-30' },
        { count: 0 },
        { count: 8 },
        { count: 1.5 },
        { other: 1 },
      ]) {
        await expect(service.start(org, { kind: 'video_set', sourceText: 'x', options })).rejects.toMatchObject({
          response: { code: 'INVALID_PLAN' },
          status: 400,
        });
      }
      expect(generator.chatRound).not.toHaveBeenCalled();
      expect(sessions.sessions).toHaveLength(0);
      await expect(
        service.start(org, { kind: 'video_set', sourceText: 'x', options: { date: PLAN_END, count: 7 } })
      ).resolves.toBeDefined();
    });

    it('is refused without an active plan and makes no plan row', async () => {
      const { service, repository, sessions, generator } = build();
      repository.plan = null;
      expect(await codeOf(service.start(org, { kind: 'video_set', sourceText: 'x' }))).toBe('PLAN_NOT_FOUND');
      repository.plan = { id: 'plan-1', organizationId: ORG, status: 'SETUP' };
      expect(await codeOf(service.start(org, { kind: 'video_set', sourceText: 'x' }))).toBe('PLAN_NOT_ACTIVE');
      expect(repository.ensure).not.toHaveBeenCalled();
      expect(sessions.sessions).toHaveLength(0);
      expect(generator.chatRound).not.toHaveBeenCalled();
    });

    it('resumes the open session of the kind, and answers null when there is none', async () => {
      const { service, view } = await started();
      expect((await service.open(org, { kind: 'video_set' }))?.id).toBe(view.id);
      expect(await service.open({ ...org, id: 'org-2' }, { kind: 'video_set' })).toBeNull();
      await service.discard(org, view.id);
      expect(await service.open(org, { kind: 'video_set' })).toBeNull();
      expect(await codeOf(service.open(org, {}))).toBe('INVALID_PLAN');
    });
  });

  describe('propose', () => {
    it('writes the videos of a clear idea after zero questions, charged on plan.instant, with dates set by the code', async () => {
      const { service, generator, spend, workflowStart } = await started({ count: 3 });
      const view = await service.propose(org, 'session-1', { summary: ' A video about our new sourdough loaf ' });
      expect(view.status).toBe('PROPOSING');
      expect(workflowStart).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({ args: [{ kind: 'session_proposal', id: 'session-1' }] })
      );
      await service.buildProposal('session-1', null);
      expect(generator.writeVideoSet).toHaveBeenCalledTimes(1);
      expect(generator.writeVideoSet.mock.calls[0][0]).toMatchObject({
        orgId: ORG,
        direction: 'We bake for locals',
        idea: 'A video about our new sourdough loaf',
        answers: [],
        count: 3,
        countFixed: true,
        turns: [],
        feedback: null,
      });
      expect(spend).toHaveBeenLastCalledWith(
        expect.objectContaining({ actionKey: 'plan.instant' }),
        expect.any(Function)
      );
      const done = await service.view(org, 'session-1');
      expect(done.status).toBe('PROPOSED');
      expect(done.proposalVersion).toBe(1);
      expect(done.proposal).toEqual({
        videos: [0, 1, 2].map((index) => ({ ...written(index), date: addDays(TODAY, index) })),
      });
    });

    it('starts the dates on the chosen date and holds the last ones on the end of the plan', async () => {
      const { service } = await proposed({ count: 4, date: addDays(TODAY, 3) });
      const { proposal } = await service.view(org, 'session-1');
      expect((proposal as any).videos.map((video: any) => video.date)).toEqual([
        addDays(TODAY, 3),
        PLAN_END,
        PLAN_END,
        PLAN_END,
      ]);
    });

    it('writes one video by default, and hands the answers of the last round to the writer', async () => {
      const { service, sessions, generator } = await started();
      sessions.roundRows[0].questions = [
        {
          id: 'q1',
          text: 'How many?',
          options: [
            { id: 'o1', label: 'One' },
            { id: 'o2', label: 'Three' },
          ],
          recommendedOptionId: 'o1',
        },
      ];
      await service.propose(org, 'session-1', {
        summary: 'A video about our new sourdough loaf',
        answers: [{ questionId: 'q1', optionId: 'o2' }],
      });
      await service.buildProposal('session-1', null);
      expect(generator.writeVideoSet.mock.calls[0][0]).toMatchObject({
        count: 1,
        countFixed: false,
        answers: [{ question: 'How many?', answer: 'Three' }],
      });
      expect(((await service.view(org, 'session-1')).proposal as any).videos).toHaveLength(1);
    });

    it('frees the session and sets the notice when the writer fails', async () => {
      const { service, generator } = await started();
      generator.writeVideoSet.mockRejectedValueOnce(new Error('boom'));
      await service.propose(org, 'session-1', { summary: 'A video about our new sourdough loaf' });
      await expect(service.buildProposal('session-1', null)).rejects.toThrow('boom');
      await service.sessionFailed('session-1');
      expect(await service.view(org, 'session-1')).toMatchObject({ status: 'ASKING', busy: null, notice: 'proposal_failed' });
    });
  });

  describe('revise', () => {
    it("sends the owner's feedback as the next turn of the proposal chat and sets the dates again", async () => {
      const { service, generator, workflowStart } = await proposed({ count: 2 });
      const view = await service.revise(org, 'session-1', { proposalVersion: 1, feedback: 'Make it shorter' });
      expect(view.status).toBe('PROPOSING');
      expect(workflowStart).toHaveBeenLastCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({ args: [{ kind: 'session_revise', id: 'session-1', feedback: 'Make it shorter' }] })
      );
      generator.writeVideoSet.mockResolvedValueOnce({
        videos: [written(0), written(1), written(2)],
        userTurn: stableJson({ feedback: 'Make it shorter' }),
        assistantTurn: '{"raw":"again"}',
        usage: { prompt: 1, cached: 0, completion: 1 },
      });
      await service.buildProposal('session-1', 'Make it shorter');
      const input = generator.writeVideoSet.mock.calls[1][0];
      expect(input.feedback).toBe('Make it shorter');
      expect(input.turns.map((turn: any) => turn.role)).toEqual(['user', 'assistant']);
      const done = await service.view(org, 'session-1');
      expect(done.proposalVersion).toBe(2);
      // a revise may change how many videos there are; the dates start again from the chosen date
      expect((done.proposal as any).videos.map((video: any) => video.date)).toEqual([
        TODAY,
        addDays(TODAY, 1),
        addDays(TODAY, 2),
      ]);
    });

    it('refuses a revise of a proposal that is no longer the latest with 409 PROPOSAL_STALE', async () => {
      const { service } = await proposed();
      expect(await codeOf(service.revise(org, 'session-1', { proposalVersion: 0, feedback: 'x' }))).toBe('PROPOSAL_STALE');
    });
  });

  describe('confirm', () => {
    it('adds each video as a planned instant idea linked to the session, with the owner\'s date edits, and ends the session', async () => {
      const { service, repository } = await proposed({ count: 3 });
      const view = await service.confirm(org, 'session-1', {
        proposalVersion: 1,
        edits: { dates: [{ ref: 'v2', date: addDays(TODAY, 4) }] },
      });
      expect(view.status).toBe('DONE');
      expect(repository.instants.map((row) => [row.title, row.date, row.status, row.sessionId])).toEqual([
        ['Video 1', TODAY, 'PLANNED', 'session-1'],
        ['Video 2', addDays(TODAY, 4), 'PLANNED', 'session-1'],
        ['Video 3', addDays(TODAY, 2), 'PLANNED', 'session-1'],
      ]);
      expect(repository.instants[0]).toMatchObject({
        planId: 'plan-1',
        organizationId: ORG,
        idea: 'Show our new loaf',
        why: 'It helps',
        closingLine: 'bye',
        beats: written(0).beats,
      });
      expect(await codeOf(service.confirm(org, 'session-1', { proposalVersion: 1 }))).toBe('PROPOSAL_STALE');
      expect(repository.instants).toHaveLength(3);
    });

    it('confirms without edits on the proposed dates', async () => {
      const { service, repository } = await proposed({ count: 2 });
      await service.confirm(org, 'session-1', { proposalVersion: 1 });
      expect(repository.instants.map((row) => row.date)).toEqual([TODAY, addDays(TODAY, 1)]);
    });

    it('refuses a date outside today to the plan end, an unknown or repeated ref, and leaves the session proposed and free', async () => {
      const { service, repository, sessions } = await proposed({ count: 2 });
      for (const dates of [
        [{ ref: 'v1', date: addDays(TODAY, -1) }],
        [{ ref: 'v1', date: addDays(PLAN_END, 1) }],
        [{ ref: 'v9', date: TODAY }],
        [
          { ref: 'v1', date: TODAY },
          { ref: 'v1', date: TODAY },
        ],
      ]) {
        expect(await codeOf(service.confirm(org, 'session-1', { proposalVersion: 1, edits: { dates } }))).toBe(
          'INVALID_PLAN'
        );
        expect(sessions.sessions[0]).toMatchObject({ status: 'PROPOSED', busy: null });
      }
      expect(await codeOf(service.confirm(org, 'session-1', { proposalVersion: 1, edits: { dates: 'x' } }))).toBe(
        'INVALID_PLAN'
      );
      expect(repository.instants).toHaveLength(0);
    });

    it('refuses a proposal whose dates have passed since it was written, and one whose plan was reset', async () => {
      const { service, repository, sessions } = await proposed({ count: 1 });
      sessions.sessions[0].proposal = { videos: [{ ...written(0), date: addDays(TODAY, -1) }] };
      expect(await codeOf(service.confirm(org, 'session-1', { proposalVersion: 1 }))).toBe('INVALID_PLAN');
      // the owner moves it to a valid date
      await service.confirm(org, 'session-1', { proposalVersion: 1, edits: { dates: [{ ref: 'v1', date: TODAY }] } });
      expect(repository.instants).toHaveLength(1);
      const reset = await proposed({ count: 1 });
      reset.repository.plan.status = 'SETUP';
      expect(await codeOf(reset.service.confirm(org, 'session-1', { proposalVersion: 1 }))).toBe('PLAN_NOT_ACTIVE');
      expect(reset.repository.instants).toHaveLength(0);
      expect(reset.sessions.sessions[0]).toMatchObject({ status: 'PROPOSED', busy: null });
    });
  });

  describe('the week', () => {
    it('shows the confirmed videos in the web week and the phone week on their dates, as instant ideas', async () => {
      const { service, plans, repository } = await proposed({ count: 2, date: addDays(TODAY, 1) });
      await service.confirm(org, 'session-1', { proposalVersion: 1 });
      const [first, second] = repository.instants;
      const phone = await plans.phoneWeek(org);
      const instant = phone.week?.days.filter((day) => day.kind === 'INSTANT_IDEA');
      expect(instant?.map((day) => [day.id, day.date, day.title, day.status])).toEqual([
        [first.id, addDays(TODAY, 1), 'Video 1', 'PLANNED'],
        [second.id, addDays(TODAY, 2), 'Video 2', 'PLANNED'],
      ]);
      expect(instant?.[0]).toMatchObject({ dayIndex: null, angle: null, beats: written(0).beats, closingLine: 'bye' });
      const web = await plans.currentWeek(org);
      expect(web?.days.filter((day) => day.kind === 'INSTANT_IDEA').map((day) => day.id)).toEqual([first.id, second.id]);
      expect(web?.days.every((day, index, all) => index === 0 || all[index - 1].date <= day.date)).toBe(true);
    });
  });
});
