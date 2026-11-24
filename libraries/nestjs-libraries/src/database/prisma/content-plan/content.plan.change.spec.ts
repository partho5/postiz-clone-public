// Content plan change routes and phone routes: the owner's edits of a running plan (direction, brief, idea, urgent note,
// videos per week, regenerate, recorded) and the week the phone reads. Needs no network, database or Temporal: the
// storage is an in-memory stand-in, and the generator, the credits and the workflow engine are stubs. Covers the phone
// week shape, `days` empty unless READY, recorded idempotent and 404 for another workspace, a brief edit that rewrites
// only planned videos from today, an urgent note that carries at most 3, an idea edit refused for the current week, a
// recorded video that cannot be regenerated, and a new `videosPerWeek` that keeps written weeks.
import { ContentPlanService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { addDays } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import { SLOT_DAYS } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

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

// The storage of the plan, in memory, with the behaviour the change routes rely on.
class FakeRepository {
  plan: any = {
    id: 'plan-1',
    organizationId: ORG,
    status: 'ACTIVE',
    direction: 'We bake for locals',
    directionVersion: 0,
    videosPerWeek: 3,
    facts: null,
    busy: null,
    notice: null,
    sourceText: null,
    proposal: null,
  };
  weeks: any[] = [];
  days: any[] = [];
  private _id = 0;

  // A week row with the defaults of the table.
  addWeek(data: any) {
    const week = {
      id: `week-${(this._id += 1)}`,
      planId: 'plan-1',
      clusterId: 'c1',
      idea: 'An idea',
      ideaEdited: false,
      outline: [{ title: 'T', angle: 'story' }],
      brief: null,
      briefEdited: true,
      urgentNote: null,
      carryIn: null,
      status: 'IDEA',
      ...data,
    };
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

  private sorted = () => [...this.weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  private daysOf = (weekId: string) =>
    this.days.filter((day) => day.weekId === weekId).sort((a, b) => a.dayIndex - b.dayIndex);
  private withDays = (week: any) => week && { ...week, days: this.daysOf(week.id), cluster: { theme: { name: 'Theme' } } };

  findByOrganization = async (id: string) => (id === ORG ? this.plan : null);
  latestRound = async () => null;
  activeThemes = async () => [];
  openDraft = async () => null;
  instantIdeasBetween = async () => [];
  getInstantIdea = async () => null;
  update = async (_id: string, data: any) => {
    const { directionVersion, ...rest } = data;
    Object.assign(this.plan, rest);
    if (directionVersion) {
      this.plan.directionVersion += directionVersion.increment;
    }
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
  currentWeek = async (_id: string, from: string, to: string) =>
    this.sorted().filter((week) => week.weekStart >= from && week.weekStart <= to).slice(-1)[0] ?? null;
  currentWeekWithDays = async (id: string, from: string, to: string) =>
    this.withDays(await this.currentWeek(id, from, to));
  upcomingWeeks = async (_id: string, from: string, take: number) =>
    this.sorted().filter((week) => week.weekStart >= from).slice(0, take).map(this.withDays);
  weekOfOrganization = async (orgId: string, weekId: string) =>
    orgId === ORG ? this.withDays(this.weeks.find((week) => week.id === weekId)) ?? null : null;
  dayOfOrganization = async (orgId: string, dayId: string) =>
    this.days.find((day) => day.id === dayId && day.organizationId === orgId) ?? null;
  firstIdeaWeekFrom = async (_id: string, start: string) =>
    this.sorted().find((week) => week.status === 'IDEA' && week.weekStart >= start) ?? null;
  saveBrief = async (id: string, brief: string) => {
    Object.assign(this.weeks.find((week) => week.id === id), { brief, briefEdited: true });
  };
  saveIdea = async (id: string, idea: string) => {
    const week = this.weeks.find((known) => known.id === id);
    Object.assign(week, { idea, ideaEdited: true, outline: null });
    return this.withDays(week);
  };
  saveUrgent = async (id: string, note: string, carry: any) => {
    Object.assign(this.weeks.find((week) => week.id === id), { urgentNote: note, briefEdited: false });
    if (carry) {
      this.weeks.find((week) => week.id === carry.weekId).carryIn = carry.items;
    }
  };
  markRecorded = async (orgId: string, dayId: string, at: Date) => {
    const day = this.days.find((known) => known.id === dayId && known.organizationId === orgId);
    if (day && day.status !== 'RECORDED') {
      Object.assign(day, { status: 'RECORDED', busy: false, recordedAt: at, version: day.version + 1 });
    }
  };
  saveVideosPerWeek = async (_id: string, videosPerWeek: number) => {
    this.plan.videosPerWeek = videosPerWeek;
    this.weeks.filter((week) => week.status === 'IDEA').forEach((week) => (week.outline = null));
  };
  holdDays = async (ids: string[]) => {
    this.days.forEach((day) => {
      if (ids.includes(day.id) && day.status === 'PLANNED') {
        day.busy = true;
      }
    });
  };
  releaseDays = async (ids: string[]) => {
    this.days.forEach((day) => {
      if (ids.includes(day.id)) {
        day.busy = false;
      }
    });
  };
  updateWeek = async (id: string, data: any) => {
    Object.assign(this.weeks.find((week) => week.id === id), data);
  };
  failWeek = async (id: string) => {
    const week = this.weeks.find((known) => known.id === id);
    if (week.status === 'GENERATING') {
      week.status = 'FAILED';
    }
  };
}

const build = () => {
  const repository = new FakeRepository();
  const start = jest.fn(async () => undefined);
  const temporal = { client: { getRawClient: () => ({ workflow: { start } }) } };
  const service = new ContentPlanService(repository as any, {} as any, {} as any, temporal as any);
  return { service, repository, start };
};

// The current week (it started 2 days ago), READY, with `count` planned days on the SLOT_DAYS offsets.
const readyWeek = (repository: FakeRepository, count: number, extra = {}) => {
  const week = repository.addWeek({ weekStart: addDays(TODAY, -2), status: 'READY', ...extra });
  SLOT_DAYS[count].forEach((dayIndex) => repository.addDay(week, { dayIndex }));
  return week;
};

describe('ContentPlanService change routes and phone routes', () => {
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

  describe('phoneWeek', () => {
    it('answers the contract shape for a written week', async () => {
      const { service, repository } = build();
      const week = readyWeek(repository, 3);
      const day = repository.days[0];
      const view = await service.phoneWeek(org);
      expect(Object.keys(view).sort()).toEqual(['status', 'timezone', 'today', 'week']);
      expect(view).toMatchObject({ status: 'ACTIVE', today: TODAY, timezone: 'UTC' });
      expect(Object.keys(view.week as object).sort()).toEqual(
        ['days', 'id', 'idea', 'status', 'weekEnd', 'weekStart']
      );
      expect(view.week).toMatchObject({
        id: week.id,
        weekStart: addDays(TODAY, -2),
        weekEnd: addDays(TODAY, 4),
        status: 'READY',
      });
      expect(view.week?.days).toHaveLength(3);
      expect(view.week?.days[0]).toEqual({
        id: day.id,
        kind: 'PLANNED',
        date: day.date,
        dayIndex: 0,
        title: 'Title 0',
        angle: 'problem',
        why: 'why',
        beats: [{ hook: 'h', say: 's' }],
        closingLine: 'bye',
        status: 'PLANNED',
        version: 1,
      });
    });

    it('has days [] unless the week is READY, and week null when no week holds today', async () => {
      const { service, repository } = build();
      const week = readyWeek(repository, 3);
      for (const status of ['IDEA', 'GENERATING', 'FAILED']) {
        week.status = status;
        expect((await service.phoneWeek(org)).week?.days).toEqual([]);
      }
      repository.weeks = [];
      expect((await service.phoneWeek(org)).week).toBeNull();
      expect(await service.phoneWeek({ ...org, id: 'org-none' })).toMatchObject({ status: 'NONE', week: null });
    });
  });

  describe('recorded', () => {
    it('is idempotent: a second call answers the same and does not bump the version', async () => {
      const { service, repository } = build();
      readyWeek(repository, 3);
      const id = repository.days[0].id;
      const first = await service.recorded(org, id);
      const second = await service.recorded(org, id);
      expect(first.status).toBe('RECORDED');
      expect(second).toEqual(first);
      expect(repository.days[0].version).toBe(2);
    });

    it("answers 404 DAY_NOT_FOUND for another workspace's day", async () => {
      const { service, repository } = build();
      readyWeek(repository, 3);
      await expect(service.recorded(otherOrg, repository.days[0].id)).rejects.toMatchObject({
        response: { code: 'DAY_NOT_FOUND' },
        status: 404,
      });
    });
  });

  describe('brief', () => {
    it('saves the brief and rewrites only the planned days from today on', async () => {
      const { service, repository, start } = build();
      const week = readyWeek(repository, 5);
      // the week started 2 days ago: day 0 and 1 are past, day 2 is today, 4 and 5 are ahead
      const [past, , today, recorded, ahead] = repository.days;
      repository.days.find((day) => day.id === recorded.id).status = 'RECORDED';
      const view = await service.brief(org, week.id, { brief: 'Focus on lunch' });
      expect(week.brief).toBe('Focus on lunch');
      expect(week.briefEdited).toBe(true);
      expect(past.busy).toBe(false);
      expect(recorded.busy).toBe(false);
      expect(today.busy).toBe(true);
      expect(ahead.busy).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({
          workflowId: `content_plan_days_${week.id}`,
          args: [{ kind: 'days', id: week.id, fromDate: TODAY }],
        })
      );
      expect(view.days.filter((day) => day.busy).map((day) => day.id)).toEqual([today.id, ahead.id]);
    });

    it('writes a failed week again instead of its days', async () => {
      const { service, repository, start } = build();
      const week = repository.addWeek({ weekStart: addDays(TODAY, -2), status: 'FAILED' });
      const view = await service.brief(org, week.id, { brief: 'Same' });
      expect(view.status).toBe('GENERATING');
      expect(start).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({ args: [{ kind: 'week', id: week.id }] })
      );
    });

    it('refuses a week that is not the current one, and a week being written', async () => {
      const { service, repository } = build();
      const ahead = repository.addWeek({ weekStart: addDays(TODAY, 7) });
      await expect(service.brief(org, ahead.id, { brief: 'x' })).rejects.toMatchObject({
        response: { code: 'WEEK_LOCKED' },
      });
      const week = readyWeek(repository, 3);
      repository.days[0].busy = true;
      await expect(service.brief(org, week.id, { brief: 'x' })).rejects.toMatchObject({
        response: { code: 'PLAN_BUSY' },
      });
    });
  });

  describe('urgent', () => {
    it('sets the note, frees the brief and carries at most 3 displaced videos to the next idea week', async () => {
      const { service, repository, start } = build();
      const week = repository.addWeek({ weekStart: TODAY, status: 'READY' });
      SLOT_DAYS[5].forEach((dayIndex) => repository.addDay(week, { dayIndex }));
      const next = repository.addWeek({ weekStart: addDays(TODAY, 7) });
      await service.urgent(org, week.id, { note: 'New law today' });
      expect(week.urgentNote).toBe('New law today');
      expect(week.briefEdited).toBe(false);
      expect(next.carryIn).toHaveLength(3);
      expect(next.carryIn.map((item: any) => item.title)).toEqual(['Title 0', 'Title 1', 'Title 2']);
      expect(start).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({ args: [{ kind: 'days', id: week.id, fromDate: TODAY }] })
      );
    });

    it('keeps what the next week already carries first, within 3 in all', async () => {
      const { service, repository } = build();
      const week = repository.addWeek({ weekStart: TODAY, status: 'READY' });
      SLOT_DAYS[4].forEach((dayIndex) => repository.addDay(week, { dayIndex }));
      const next = repository.addWeek({
        weekStart: addDays(TODAY, 7),
        carryIn: [{ title: 'Already', angle: 'steps', clusterId: 'c1' }],
      });
      await service.urgent(org, week.id, { note: 'News' });
      expect(next.carryIn.map((item: any) => item.title)).toEqual(['Already', 'Title 0', 'Title 1']);
    });
  });

  describe('idea', () => {
    it('refuses the current week and a written week, and edits a coming one', async () => {
      const { service, repository } = build();
      const current = readyWeek(repository, 3);
      await expect(service.idea(org, current.id, { idea: 'x' })).rejects.toMatchObject({
        response: { code: 'WEEK_LOCKED' },
      });
      const written = repository.addWeek({ weekStart: addDays(TODAY, 7), status: 'READY' });
      await expect(service.idea(org, written.id, { idea: 'x' })).rejects.toMatchObject({
        response: { code: 'WEEK_LOCKED' },
      });
      const coming = repository.addWeek({ weekStart: addDays(TODAY, 14) });
      const view = await service.idea(org, coming.id, { idea: 'My own idea' });
      expect(view).toEqual({
        id: coming.id,
        weekStart: addDays(TODAY, 14),
        idea: 'My own idea',
        ideaEdited: true,
        theme: 'Theme',
      });
      expect(coming.outline).toBeNull();
    });

    it("answers 404 WEEK_NOT_FOUND for another workspace's week", async () => {
      const { service, repository } = build();
      const coming = repository.addWeek({ weekStart: addDays(TODAY, 14) });
      await expect(service.idea(otherOrg, coming.id, { idea: 'x' })).rejects.toMatchObject({
        response: { code: 'WEEK_NOT_FOUND' },
      });
    });
  });

  describe('regenerate', () => {
    it('answers 409 DAY_LOCKED for a recorded video and for a past one', async () => {
      const { service, repository, start } = build();
      readyWeek(repository, 5);
      repository.days[2].status = 'RECORDED';
      await expect(service.regenerate(org, repository.days[2].id)).rejects.toMatchObject({
        response: { code: 'DAY_LOCKED' },
        status: 409,
      });
      await expect(service.regenerate(org, repository.days[0].id)).rejects.toMatchObject({
        response: { code: 'DAY_LOCKED' },
      });
      expect(start).not.toHaveBeenCalled();
    });

    it('marks a planned video busy and starts the day job', async () => {
      const { service, repository, start } = build();
      readyWeek(repository, 5);
      const day = repository.days[4];
      const view = await service.regenerate(org, day.id);
      expect(view.busy).toBe(true);
      expect(start).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({ args: [{ kind: 'day', id: day.id }] })
      );
    });

    it('frees the video again when the job cannot be started', async () => {
      const { service, repository, start } = build();
      readyWeek(repository, 5);
      start.mockRejectedValueOnce(new Error('down'));
      await expect(service.regenerate(org, repository.days[4].id)).rejects.toMatchObject({
        response: { code: 'PLAN_NOT_AVAILABLE' },
      });
      expect(repository.days[4].busy).toBe(false);
    });
  });

  describe('videosPerWeek', () => {
    it('keeps the written weeks and clears the outline of the weeks not written', async () => {
      const { service, repository, start } = build();
      const written = readyWeek(repository, 3);
      const coming = repository.addWeek({ weekStart: addDays(TODAY, 5) });
      const view = await service.videosPerWeek(org, { videosPerWeek: 5 });
      expect(view.videosPerWeek).toBe(5);
      expect(coming.outline).toBeNull();
      expect(written.outline).not.toBeNull();
      expect(repository.days.filter((day) => day.weekId === written.id)).toHaveLength(3);
      expect(start).not.toHaveBeenCalled();
    });

    it('refuses a number outside 1-7 with INVALID_PLAN', async () => {
      const { service } = build();
      await expect(service.videosPerWeek(org, { videosPerWeek: 8 })).rejects.toMatchObject({
        response: { code: 'INVALID_PLAN' },
      });
    });
  });

  describe('direction', () => {
    it('saves the direction, bumps its version, marks the plan busy and starts the replan job', async () => {
      const { service, repository, start } = build();
      const view = await service.direction(org, { direction: 'Talk about family recipes' });
      expect(repository.plan.direction).toBe('Talk about family recipes');
      expect(repository.plan.directionVersion).toBe(1);
      expect(view.busy).toBe('replan');
      expect(start).toHaveBeenCalledWith(
        'contentPlanJobWorkflow',
        expect.objectContaining({ args: [{ kind: 'replan', id: 'plan-1' }] })
      );
    });

    it('answers 409 PLAN_BUSY while another job holds the plan', async () => {
      const { service, repository } = build();
      repository.plan.busy = 'proposal';
      await expect(service.direction(org, { direction: 'x' })).rejects.toMatchObject({
        response: { code: 'PLAN_BUSY' },
      });
    });
  });

  describe('currentWeek and upcoming', () => {
    it('answers the current week with its days, null when none, and the weeks after it', async () => {
      const { service, repository } = build();
      expect(await service.currentWeek(org)).toBeNull();
      const week = readyWeek(repository, 3);
      const next = repository.addWeek({ weekStart: addDays(TODAY, 5) });
      expect((await service.currentWeek(org))?.id).toBe(week.id);
      expect((await service.currentWeek(org))?.days).toHaveLength(3);
      expect((await service.upcoming(org)).map((item) => item.id)).toEqual([next.id]);
    });
  });
});
