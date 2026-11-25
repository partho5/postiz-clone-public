// Content plan instant ideas: the owner's own video, refined by the AI and added to the plan on a date of the owner's
// choice. Needs no network, database or Temporal: the storage is an in-memory stand-in, and the generator, the credits
// and the workflow engine are stubs. Covers a date out of range (INVALID_PLAN), a second start replacing the first draft,
// DRAFT_NOT_READY before the refine, a failed refine (notice set, plan free, credits released, draft kept), one charge
// per refine, a confirmed idea in the phone week after the AI day (kind INSTANT_IDEA, dayIndex and angle null), hidden
// while the week is not READY, a past planned one shown as MISSED, recorded idempotent and 404 for another workspace,
// and the AI days, videosPerWeek and roadmap untouched by it.
import { ContentPlanService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { addDays } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import { PlanFacts, SLOT_DAYS } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

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
const NOW = new Date('2026-03-10T12:00:00Z');
const TODAY = '2026-03-10';
const org = { id: ORG, name: 'Bakery', locale: 'en', timezone: 'UTC', users: [{ role: 'ADMIN' }] } as any;
const otherOrg = { ...org, id: 'org-2' };

const facts: PlanFacts = {
  whatWeDo: 'Bakes bread',
  audience: 'Neighbours',
  problems: ['p1'],
  solution: 'Fresh daily',
  objections: ['o1'],
  tone: 'Warm',
  videoSeconds: 60,
};

// The script the stubbed generator writes.
const script = {
  title: 'My own idea',
  why: 'It helps',
  beats: [
    { hook: 'one', say: 'say one' },
    { hook: 'two', say: 'say two' },
    { hook: 'three', say: 'say three' },
  ],
  closingLine: 'bye',
};

// The storage of the plan, in memory, with the behaviour the instant idea routes rely on.
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
  private _id = 0;

  // A week row with the defaults of the table.
  addWeek(data: any) {
    const week = { id: `week-${(this._id += 1)}`, planId: 'plan-1', clusterId: 'c1', idea: 'An idea', ...data };
    this.weeks.push(week);
    return week;
  }

  // A day row with the defaults of the table.
  addDay(week: any, data: any) {
    const day = {
      id: `day-${(this._id += 1)}`,
      weekId: week.id,
      organizationId: ORG,
      date: addDays(week.weekStart, data.dayIndex),
      title: `Title ${data.dayIndex}`,
      angle: 'problem',
      why: 'why',
      beats: [{ hook: 'h', say: 's' }],
      closingLine: 'bye',
      status: 'PLANNED',
      busy: false,
      version: 1,
      ...data,
    };
    this.days.push(day);
    return day;
  }

  // An instant idea row with the defaults of the table.
  addInstant(data: any) {
    const row = {
      id: `instant-${(this._id += 1)}`,
      planId: 'plan-1',
      organizationId: ORG,
      idea: 'My idea',
      date: TODAY,
      ...script,
      status: 'PLANNED',
      recordedAt: null,
      createdAt: new Date(),
      ...data,
    };
    this.instants.push(row);
    return row;
  }

  private sorted = () => [...this.weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  private withDays = (week: any) =>
    week && {
      ...week,
      days: this.days.filter((day) => day.weekId === week.id).sort((a, b) => a.dayIndex - b.dayIndex),
    };

  findByOrganization = async (id: string) => (id === ORG ? this.plan : null);
  rounds = async () => [];
  latestRound = async () => null;
  activeThemes = async () => [];
  lastWeek = async () => this.sorted().slice(-1)[0] ?? null;
  update = async (_id: string, data: any) => {
    Object.assign(this.plan, data);
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
  currentWeekWithDays = async (_id: string, from: string, to: string) =>
    this.withDays(
      this.sorted()
        .filter((week) => week.weekStart >= from && week.weekStart <= to)
        .slice(-1)[0] ?? null
    );
  dayOfOrganization = async (orgId: string, dayId: string) =>
    this.days.find((day) => day.id === dayId && day.organizationId === orgId) ?? null;
  markRecorded = async (orgId: string, dayId: string, at: Date) => {
    const day = this.days.find((known) => known.id === dayId && known.organizationId === orgId);
    if (day && day.status !== 'RECORDED') {
      Object.assign(day, { status: 'RECORDED', busy: false, recordedAt: at, version: day.version + 1 });
    }
  };
  openDraft = async (orgId: string) =>
    this.instants.find((row) => row.organizationId === orgId && row.status === 'DRAFT') ?? null;
  createDraft = async (planId: string, organizationId: string, idea: string, date: string) => {
    this.instants = this.instants.filter((row) => !(row.organizationId === organizationId && row.status === 'DRAFT'));
    return this.addInstant({
      planId,
      organizationId,
      idea,
      date,
      title: '',
      why: '',
      beats: [],
      closingLine: '',
      status: 'DRAFT',
    });
  };
  instantForWrite = async (id: string) => {
    const row = this.instants.find((known) => known.id === id);
    return row ? { ...row, plan: this.plan } : null;
  };
  getInstantIdea = async (orgId: string, id: string) =>
    this.instants.find((row) => row.id === id && row.organizationId === orgId) ?? null;
  saveRefined = async (orgId: string, id: string, refined: any) => {
    const row = this.instants.find((known) => known.id === id && known.organizationId === orgId);
    if (!row || row.status !== 'DRAFT') {
      return false;
    }
    Object.assign(row, refined);
    return true;
  };
  confirm = async (orgId: string, id: string) => {
    const row = this.instants.find((known) => known.id === id && known.organizationId === orgId);
    if (!row || row.status !== 'DRAFT' || !row.title) {
      return false;
    }
    row.status = 'PLANNED';
    return true;
  };
  markInstantRecorded = async (orgId: string, id: string, at: Date) => {
    const row = this.instants.find((known) => known.id === id && known.organizationId === orgId);
    if (row && ['PLANNED', 'MISSED'].includes(row.status)) {
      Object.assign(row, { status: 'RECORDED', recordedAt: at });
    }
  };
  instantIdeasBetween = async (orgId: string, from: string, to: string) =>
    this.instants
      .filter((row) => row.organizationId === orgId && row.status !== 'DRAFT' && row.date >= from && row.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
  purgeStaleDrafts = jest.fn(async () => ({ count: 0 }));
  activePlans = async () => [];
}

const build = () => {
  const repository = new FakeRepository();
  const start = jest.fn(async () => undefined);
  const temporal = { client: { getRawClient: () => ({ workflow: { start } }) } };
  const generator = {
    writeInstantIdea: jest.fn(async (_input: any) => ({
      day: script,
      usage: { prompt: 1, cached: 0, completion: 1 },
    })),
    writeWeek: jest.fn(),
    writeDay: jest.fn(),
    writeIdeas: jest.fn(),
  };
  // the credit engine: one reservation per call, committed when the call ends, released when it throws
  const ledger = { reserved: 0, committed: 0, released: 0, keys: [] as string[] };
  const spend = jest.fn(async (request: any, run: () => Promise<unknown>) => {
    ledger.reserved += 1;
    ledger.keys.push(request.actionKey);
    try {
      const result = await run();
      ledger.committed += 1;
      return result;
    } catch (err) {
      ledger.released += 1;
      throw err;
    }
  });
  const service = new ContentPlanService(
    repository as any,
    generator as any,
    { spend } as any,
    temporal as any
  );
  return { service, repository, generator, ledger, start };
};

// The current week (it started 2 days ago), READY, with 3 planned days (today - 2, today, today + 2), and the last week of
// the roadmap 11 weeks ahead.
const readyWeek = (repository: FakeRepository, extra = {}) => {
  const week = repository.addWeek({ weekStart: addDays(TODAY, -2), status: 'READY', ...extra });
  SLOT_DAYS[3].forEach((dayIndex) => repository.addDay(week, { dayIndex }));
  repository.addWeek({ weekStart: addDays(TODAY, -2 + 77), status: 'IDEA' });
  return week;
};

describe('ContentPlanService instant ideas', () => {
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

  describe('startInstantIdea', () => {
    it('starts the job, holds the plan as instant and answers the plan view with the open draft', async () => {
      const { service, repository, start } = build();
      readyWeek(repository);
      const view = await service.startInstantIdea(org, { idea: 'Show our new loaf', date: addDays(TODAY, 3) });
      expect(view.busy).toBe('instant');
      expect(view.instantDraft).toMatchObject({
        idea: 'Show our new loaf',
        date: addDays(TODAY, 3),
        title: '',
        status: 'DRAFT',
      });
      expect(start).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({
          workflowId: `content_plan_instant_${view.instantDraft?.id}`,
          args: [{ kind: 'instant', id: view.instantDraft?.id }],
        })
      );
    });

    it('refuses a date before today or after the end of the last roadmap week with INVALID_PLAN', async () => {
      const { service, repository, start } = build();
      readyWeek(repository);
      const last = addDays(TODAY, -2 + 77 + 6);
      for (const date of [addDays(TODAY, -1), addDays(last, 1)]) {
        await expect(service.startInstantIdea(org, { idea: 'x', date })).rejects.toMatchObject({
          response: { code: 'INVALID_PLAN' },
          status: 400,
        });
      }
      await expect(service.startInstantIdea(org, { idea: 'x', date: last })).resolves.toBeDefined();
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('answers 409 PLAN_NOT_ACTIVE for a plan that is not confirmed, and 409 PLAN_BUSY while one is being refined', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      repository.plan.status = 'SETUP';
      await expect(service.startInstantIdea(org, { idea: 'x', date: TODAY })).rejects.toMatchObject({
        response: { code: 'PLAN_NOT_ACTIVE' },
      });
      repository.plan.status = 'ACTIVE';
      await service.startInstantIdea(org, { idea: 'x', date: TODAY });
      await expect(service.startInstantIdea(org, { idea: 'y', date: TODAY })).rejects.toMatchObject({
        response: { code: 'PLAN_BUSY' },
      });
    });

    it('replaces the open draft when it is started again', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const first = await service.startInstantIdea(org, { idea: 'First', date: TODAY });
      await service.refineInstantIdea(first.instantDraft?.id as string);
      const second = await service.startInstantIdea(org, { idea: 'Second', date: addDays(TODAY, 1) });
      expect(repository.instants).toHaveLength(1);
      expect(second.instantDraft).toMatchObject({ idea: 'Second', title: '' });
      expect(second.instantDraft?.id).not.toBe(first.instantDraft?.id);
    });
  });

  describe('refineInstantIdea', () => {
    it('writes the script from the idea only, saves it, frees the plan and charges once', async () => {
      const { service, repository, generator, ledger } = build();
      readyWeek(repository);
      const started = await service.startInstantIdea(org, { idea: 'Show our new loaf', date: TODAY });
      await service.refineInstantIdea(started.instantDraft?.id as string);
      expect(generator.writeInstantIdea).toHaveBeenCalledTimes(1);
      const input = generator.writeInstantIdea.mock.calls[0][0];
      expect(input).toMatchObject({ orgId: ORG, idea: 'Show our new loaf', direction: 'We bake for locals' });
      expect(Object.keys(input)).not.toContain('angle');
      expect(repository.plan.busy).toBeNull();
      expect((await service.view(org)).instantDraft).toMatchObject({ title: 'My own idea', status: 'DRAFT' });
      expect(ledger).toMatchObject({ reserved: 1, committed: 1, released: 0, keys: ['plan.instant'] });
    });

    it('only frees the plan when it runs again after it saved its answer', async () => {
      const { service, repository, generator, ledger } = build();
      readyWeek(repository);
      const started = await service.startInstantIdea(org, { idea: 'x', date: TODAY });
      const id = started.instantDraft?.id as string;
      await service.refineInstantIdea(id);
      repository.plan.busy = 'instant';
      await service.refineInstantIdea(id);
      expect(generator.writeInstantIdea).toHaveBeenCalledTimes(1);
      expect(ledger.reserved).toBe(1);
      expect(repository.plan.busy).toBeNull();
    });

    it('releases the credits and throws when the model fails; the failure path frees the plan, sets the notice and keeps the draft', async () => {
      const { service, repository, generator, ledger } = build();
      readyWeek(repository);
      generator.writeInstantIdea.mockRejectedValueOnce(new Error('boom'));
      const started = await service.startInstantIdea(org, { idea: 'Keep me', date: addDays(TODAY, 2) });
      const id = started.instantDraft?.id as string;
      await expect(service.refineInstantIdea(id)).rejects.toThrow('boom');
      expect(ledger).toMatchObject({ reserved: 1, committed: 0, released: 1 });
      expect(repository.plan.busy).toBe('instant');
      await service.instantFailed(id);
      const view = await service.view(org);
      expect(view.busy).toBeNull();
      expect(view.notice).toBe('instant_failed');
      expect(view.instantDraft).toMatchObject({ id, idea: 'Keep me', date: addDays(TODAY, 2), title: '' });
      // Try again re-POSTs the same idea and clears the notice
      const again = await service.startInstantIdea(org, { idea: 'Keep me', date: addDays(TODAY, 2) });
      expect(again.notice).toBeNull();
    });
  });

  describe('confirmInstantIdea', () => {
    it('answers 409 DRAFT_NOT_READY before the refine and while the plan is still refining', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const started = await service.startInstantIdea(org, { idea: 'x', date: TODAY });
      await expect(service.confirmInstantIdea(org, started.instantDraft?.id as string)).rejects.toMatchObject({
        response: { code: 'DRAFT_NOT_READY' },
        status: 409,
      });
    });

    it('adds the refined draft to the plan and answers the same view when it is confirmed again', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const started = await service.startInstantIdea(org, { idea: 'x', date: addDays(TODAY, 1) });
      const id = started.instantDraft?.id as string;
      await service.refineInstantIdea(id);
      const first = await service.confirmInstantIdea(org, id);
      expect(first).toMatchObject({ id, status: 'PLANNED', title: 'My own idea', date: addDays(TODAY, 1) });
      expect(await service.confirmInstantIdea(org, id)).toEqual(first);
      expect((await service.view(org)).instantDraft).toBeNull();
    });

    it("answers 404 DAY_NOT_FOUND for another workspace's draft", async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const row = repository.addInstant({ status: 'DRAFT' });
      repository.findByOrganization = async () => repository.plan;
      await expect(service.confirmInstantIdea(otherOrg, row.id)).rejects.toMatchObject({
        response: { code: 'DAY_NOT_FOUND' },
        status: 404,
      });
    });
  });

  describe('the week', () => {
    it('shows a confirmed idea in the phone week after the AI day of the same date, as an instant idea', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const started = await service.startInstantIdea(org, { idea: 'x', date: TODAY });
      const id = started.instantDraft?.id as string;
      await service.refineInstantIdea(id);
      await service.confirmInstantIdea(org, id);
      const { week } = await service.phoneWeek(org);
      expect(week?.days.map((day) => day.kind)).toEqual(['PLANNED', 'PLANNED', 'INSTANT_IDEA', 'PLANNED']);
      expect(week?.days[2]).toEqual({
        id,
        kind: 'INSTANT_IDEA',
        date: TODAY,
        dayIndex: null,
        title: 'My own idea',
        angle: null,
        why: 'It helps',
        beats: script.beats,
        closingLine: 'bye',
        status: 'PLANNED',
        version: 0,
      });
      expect(week?.days[1].date).toBe(TODAY);
    });

    it('puts an instant idea of an earlier date before the later AI day, and shows it in the web week too', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      repository.addInstant({ date: addDays(TODAY, 1) });
      const phone = await service.phoneWeek(org);
      expect(phone.week?.days.map((day) => day.date)).toEqual([
        addDays(TODAY, -2),
        TODAY,
        addDays(TODAY, 1),
        addDays(TODAY, 2),
      ]);
      const web = await service.currentWeek(org);
      expect(web?.days.map((day) => day.kind)).toEqual(['PLANNED', 'PLANNED', 'INSTANT_IDEA', 'PLANNED']);
      expect(web?.days[2]).toMatchObject({ dayIndex: null, angle: null, busy: false, version: 0 });
    });

    it('does not show a draft, an idea of another week, or any idea in the phone week while the week is not READY', async () => {
      const { service, repository } = build();
      const week = readyWeek(repository);
      repository.addInstant({ status: 'DRAFT', date: TODAY });
      repository.addInstant({ date: addDays(TODAY, 20) });
      expect((await service.phoneWeek(org)).week?.days.every((day) => day.kind === 'PLANNED')).toBe(true);
      repository.addInstant({ date: TODAY });
      for (const status of ['IDEA', 'GENERATING', 'FAILED']) {
        week.status = status;
        expect((await service.phoneWeek(org)).week?.days).toEqual([]);
      }
    });

    it('shows a planned idea whose date has passed as MISSED without writing it', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const row = repository.addInstant({ date: addDays(TODAY, -1) });
      const instant = (await service.phoneWeek(org)).week?.days.find((day) => day.kind === 'INSTANT_IDEA');
      expect(instant?.status).toBe('MISSED');
      expect(row.status).toBe('PLANNED');
    });
  });

  describe('recorded', () => {
    it('marks an instant idea recorded, answers the same 200 twice, and leaves the AI days alone', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const row = repository.addInstant({ date: TODAY });
      const first = await service.recorded(org, row.id);
      const second = await service.recorded(org, row.id);
      expect(first).toMatchObject({ id: row.id, kind: 'INSTANT_IDEA', status: 'RECORDED' });
      expect(second).toEqual(first);
      expect(row.recordedAt).toBeInstanceOf(Date);
      expect(repository.days.every((day) => day.status === 'PLANNED' && day.version === 1)).toBe(true);
    });

    it("answers 404 DAY_NOT_FOUND for another workspace's idea and for a draft", async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const row = repository.addInstant({});
      const draft = repository.addInstant({ status: 'DRAFT' });
      await expect(service.recorded(otherOrg, row.id)).rejects.toMatchObject({
        response: { code: 'DAY_NOT_FOUND' },
        status: 404,
      });
      await expect(service.recorded(org, draft.id)).rejects.toMatchObject({ response: { code: 'DAY_NOT_FOUND' } });
    });

    it('still marks an AI day', async () => {
      const { service, repository } = build();
      readyWeek(repository);
      const day = repository.days[0];
      expect((await service.recorded(org, day.id)).status).toBe('RECORDED');
    });
  });

  describe('what it never touches', () => {
    it('leaves the AI days, videosPerWeek and the roadmap as they were, and calls no week or day writer', async () => {
      const { service, repository, generator } = build();
      readyWeek(repository);
      const before = JSON.stringify({ days: repository.days, weeks: repository.weeks, videos: repository.plan.videosPerWeek });
      const started = await service.startInstantIdea(org, { idea: 'x', date: TODAY });
      const id = started.instantDraft?.id as string;
      await service.refineInstantIdea(id);
      await service.confirmInstantIdea(org, id);
      await service.recorded(org, id);
      expect(JSON.stringify({ days: repository.days, weeks: repository.weeks, videos: repository.plan.videosPerWeek })).toBe(
        before
      );
      expect(generator.writeWeek).not.toHaveBeenCalled();
      expect(generator.writeDay).not.toHaveBeenCalled();
      expect(generator.writeIdeas).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('removes the drafts older than 24 hours and carries on when that fails', async () => {
      const { service, repository } = build();
      await service.tick(NOW);
      expect(repository.purgeStaleDrafts).toHaveBeenCalledWith(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
      repository.purgeStaleDrafts.mockRejectedValueOnce(new Error('db down'));
      await expect(service.tick(NOW)).resolves.toBeUndefined();
    });
  });
});
