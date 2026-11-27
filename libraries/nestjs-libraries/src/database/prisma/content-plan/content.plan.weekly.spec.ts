// Content plan weekly engine: the hourly advance of a plan, the writing of a week, the rewrite of days and the roadmap.
// Needs no network, database or Temporal: the storage is an in-memory stand-in, and the generator and the credits are
// stubs. Covers the leftovers of an ended week (3 carried, the rest MISSED), the current week written when it is IDEA,
// a FAILED week with 3 attempts left alone, the roadmap topped up to 12, an idle plan starting again from today, no
// `trend` angle without an urgent note, the days of 1, 3 and 7 videos on the SLOT_DAYS offsets, and a rewrite that never
// touches a recorded video or a past date.
import { ContentPlanService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { addDays } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import {
  ANGLES,
  PlanFacts,
  ROADMAP_WEEKS,
  SLOT_DAYS,
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
const NOW = new Date('2026-03-10T12:00:00Z');
const TODAY = '2026-03-10';

const facts: PlanFacts = {
  whatWeDo: 'Bakes bread',
  audience: 'Neighbours',
  problems: ['p1'],
  solution: 'Fresh daily',
  objections: ['o1'],
  tone: 'Warm',
  videoSeconds: 60,
};

// The storage of the plan, in memory, with the behaviour the weekly engine relies on.
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
  clusters = [
    { id: 'c1', title: 'Cluster 1', problem: 'Problem 1' },
    { id: 'c2', title: 'Cluster 2', problem: 'Problem 2' },
  ];
  weeks: any[] = [];
  days: any[] = [];
  closed: { missed: string[]; carry: any } | null = null;
  private _id = 0;

  // A week row with the defaults of the table.
  addWeek(data: any) {
    const week = {
      id: `week-${(this._id += 1)}`,
      planId: 'plan-1',
      clusterId: 'c1',
      idea: 'An idea',
      ideaEdited: false,
      outline: null,
      brief: null,
      briefEdited: false,
      urgentNote: null,
      carryIn: null,
      status: 'IDEA',
      attempts: 0,
      updatedAt: NOW,
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
      date: addDays(week.weekStart, data.dayIndex),
      title: `Title ${data.dayIndex}`,
      angle: 'problem',
      why: 'why',
      beats: [],
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

  activePlans = async () => [this.plan];
  purgeStaleDrafts = async () => ({ count: 0 });
  findWithOrganization = async () => this.plan;
  release = async (_id: string, data: any = {}) => {
    Object.assign(this.plan, data, { busy: null });
  };
  currentWeek = async (_id: string, from: string, to: string) =>
    this.sorted()
      .filter((week) => week.weekStart >= from && week.weekStart <= to)
      .slice(-1)[0] ?? null;
  firstWeek = async () => this.sorted()[0] ?? null;
  lastWeek = async () => this.sorted().slice(-1)[0] ?? null;
  countWeeksFrom = async (_id: string, start: string) =>
    this.weeks.filter((week) => week.weekStart >= start).length;
  endedWeeksWithPlannedDays = async (_id: string, lastStart: string) =>
    this.sorted()
      .filter(
        (week) =>
          week.status === 'READY' &&
          week.weekStart <= lastStart &&
          this.daysOf(week.id).some((day) => day.status === 'PLANNED')
      )
      .map((week) => ({
        ...week,
        days: this.daysOf(week.id).filter((day) => day.status === 'PLANNED'),
      }));
  firstIdeaWeekFrom = async (_id: string, start: string) =>
    this.sorted().find((week) => week.status === 'IDEA' && week.weekStart >= start) ?? null;
  closeWeek = async (missed: string[], carry: any) => {
    this.closed = { missed, carry };
    this.days.forEach((day) => {
      if (missed.includes(day.id) && day.status === 'PLANNED') {
        day.status = 'MISSED';
      }
    });
    if (carry) {
      this.weeks.find((week) => week.id === carry.weekId).carryIn = carry.items;
    }
  };
  activeClusters = async () => this.clusters;
  recentIdeas = async (_id: string, clusterId: string, before: string, take: number) =>
    this.sorted()
      .filter((week) => week.clusterId === clusterId && week.weekStart < before)
      .reverse()
      .slice(0, take)
      .map((week) => ({ idea: week.idea }));
  createWeeks = async (_id: string, weeks: any[]) => {
    weeks.forEach((week) => {
      if (!this.weeks.some((known) => known.weekStart === week.weekStart)) {
        this.addWeek({ ...week, id: week.id });
      }
    });
  };
  weekForWrite = async (id: string) => {
    const week = this.weeks.find((known) => known.id === id);
    return (
      week && {
        ...week,
        cluster: this.clusters.find((cluster) => cluster.id === week.clusterId),
        days: this.daysOf(week.id),
        plan: this.plan,
      }
    );
  };
  dayForWrite = async (id: string) => {
    const day = this.days.find((known) => known.id === id);
    return day && { ...day, week: await this.weekForWrite(day.weekId) };
  };
  updateWeek = async (id: string, data: any) => {
    const week = this.weeks.find((known) => known.id === id);
    const { attempts, ...rest } = data;
    Object.assign(week, rest, { updatedAt: NOW });
    if (attempts) {
      week.attempts += attempts.increment;
    }
  };
  failWeek = async (id: string) => {
    const week = this.weeks.find((known) => known.id === id);
    if (week.status === 'GENERATING') {
      week.status = 'FAILED';
    }
  };
  angleUses = async (_id: string, clusterId: string, exceptWeekId: string, currentStart: string) => ({
    days: this.days
      .filter((day) => {
        const week = this.weeks.find((known) => known.id === day.weekId);
        return (
          week.clusterId === clusterId &&
          week.id !== exceptWeekId &&
          (day.status === 'RECORDED' ||
            (day.status === 'PLANNED' && week.weekStart >= currentStart))
        );
      })
      .map((day) => ({ angle: day.angle, date: day.date })),
    weeks: this.weeks
      .filter((week) => week.id !== exceptWeekId && week.weekStart >= currentStart)
      .map((week) => ({ weekStart: week.weekStart, carryIn: week.carryIn })),
  });
  saveGeneratedWeek = async (data: any) => {
    const kept = data.days.map((day: any) => day.dayIndex);
    this.days = this.days.filter(
      (day) => !(day.weekId === data.weekId && day.status === 'PLANNED' && !kept.includes(day.dayIndex))
    );
    const week = this.weeks.find((known) => known.id === data.weekId);
    data.days.forEach((fields: any) => {
      const known = this.days.find((day) => day.weekId === data.weekId && day.dayIndex === fields.dayIndex);
      if (known) {
        Object.assign(known, fields, { status: 'PLANNED', busy: false, version: known.version + 1 });
      } else {
        this.addDay(week, { ...fields, version: 1 });
      }
    });
    week.status = 'READY';
    if (data.brief) {
      week.brief = data.brief;
    }
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
  releaseWeekDays = async (weekId: string) => {
    this.daysOf(weekId).forEach((day) => (day.busy = false));
  };
  saveRewrittenDays = async (rewritten: any[], brief: any) => {
    rewritten.forEach((fields) => {
      const day = this.days.find((known) => known.id === fields.id);
      if (day.status === 'PLANNED') {
        const { id, ...rest } = fields;
        Object.assign(day, rest, { busy: false, version: day.version + 1 });
      }
    });
    if (brief) {
      this.weeks.find((week) => week.id === brief.weekId).brief = brief.text;
    }
  };
  replanWeeks = async (_id: string, from: string) =>
    this.sorted()
      .filter((week) => week.status === 'IDEA' && !week.ideaEdited && week.weekStart >= from)
      .map((week) => ({
        ...week,
        cluster: this.clusters.find((cluster) => cluster.id === week.clusterId),
      }));
  saveIdeas = async (items: { id: string; idea: string }[]) => {
    items.forEach((item) => {
      const week = this.weeks.find((known) => known.id === item.id);
      Object.assign(week, { idea: item.idea, outline: null });
    });
  };
}

// A video draft for each slot the generator is asked for.
const draftFor = (slot: any, index: number) => ({
  dayIndex: slot.dayIndex,
  title: `New ${index}`,
  why: 'because',
  beats: [
    { hook: 'h1', say: 's1' },
    { hook: 'h2', say: 's2' },
    { hook: 'h3', say: 's3' },
  ],
  closingLine: 'Thanks',
});

const build = (videosPerWeek = 3) => {
  const repository = new FakeRepository();
  repository.plan.videosPerWeek = videosPerWeek;
  const generator = {
    writeWeek: jest.fn(async (input: any) => ({
      brief: 'Written brief',
      days: input.slots.map(draftFor),
      usage: { prompt: 1, cached: 0, completion: 1 },
    })),
    writeDay: jest.fn(async (input: any) => ({
      day: draftFor(input.slot, 0),
      usage: { prompt: 1, cached: 0, completion: 1 },
    })),
    writeIdeas: jest.fn(async (input: any) => ({
      ideas: input.weeks.map((_: any, index: number) => `Idea ${index}`),
      usage: { prompt: 1, cached: 0, completion: 1 },
    })),
  };
  const spend = jest.fn((_request: any, run: () => Promise<unknown>) => run());
  const service = new ContentPlanService(
    repository as any,
    generator as any,
    { spend } as any,
    {} as any,
    { findOpen: async () => null, rounds: async () => [] } as any
  );
  return { service, repository, generator, spend };
};

// A written week of `count` planned days from `weekStart`, on the SLOT_DAYS offsets.
const readyWeek = (repository: FakeRepository, weekStart: string, count: number, extra = {}) => {
  const week = repository.addWeek({ weekStart, status: 'READY', ...extra });
  SLOT_DAYS[count].forEach((dayIndex, index) =>
    repository.addDay(week, { dayIndex, title: `Old ${index}`, angle: 'story' })
  );
  return week;
};

// A past week of the cluster in which every angle but `trend` was recorded, so `trend` is the only one never used.
const recordedAllButTrend = (repository: FakeRepository) => {
  const week = repository.addWeek({ weekStart: addDays(TODAY, -70), status: 'READY' });
  ANGLES.filter((angle) => angle !== 'trend').forEach((angle, dayIndex) =>
    repository.addDay(week, { dayIndex, angle, status: 'RECORDED' })
  );
};

describe('ContentPlanService weekly engine', () => {
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

  describe('advance', () => {
    it('carries 3 leftovers of an ended week to the next week and marks all 5 days MISSED', async () => {
      const { service, repository } = build(5);
      const ended = readyWeek(repository, addDays(TODAY, -7), 5);
      const current = repository.addWeek({ weekStart: TODAY, clusterId: 'c2', status: 'READY' });
      repository.addDay(current, { dayIndex: 0 });
      const next = repository.addWeek({ weekStart: addDays(TODAY, 7) });
      await service.advance(repository.plan, NOW);
      expect(next.carryIn).toHaveLength(3);
      expect(next.carryIn[0]).toEqual({ title: 'Old 0', angle: 'story', clusterId: ended.clusterId });
      const ofEnded = repository.days.filter((day) => day.weekId === ended.id);
      expect(ofEnded).toHaveLength(5);
      expect(ofEnded.every((day) => day.status === 'MISSED')).toBe(true);
    });

    it('keeps the items a week already carries first and drops the rest above 3', async () => {
      const { service, repository } = build(4);
      readyWeek(repository, addDays(TODAY, -7), 4);
      repository.addWeek({ weekStart: TODAY, status: 'READY' });
      const next = repository.addWeek({
        weekStart: addDays(TODAY, 7),
        carryIn: [
          { title: 'Already', angle: 'steps', clusterId: 'c1' },
          { title: 'Also', angle: 'question', clusterId: 'c1' },
        ],
      });
      await service.advance(repository.plan, NOW);
      expect(next.carryIn.map((item: any) => item.title)).toEqual(['Already', 'Also', 'Old 0']);
    });

    it('writes the current week when it is IDEA', async () => {
      const { service, repository, generator, spend } = build();
      const current = repository.addWeek({ weekStart: TODAY });
      await service.advance(repository.plan, NOW);
      expect(generator.writeWeek).toHaveBeenCalledTimes(1);
      expect(spend.mock.calls.some(([request]) => request.actionKey === 'plan.week')).toBe(true);
      expect(current.status).toBe('READY');
      expect(current.attempts).toBe(1);
      expect(current.brief).toBe('Written brief');
      expect(repository.days.filter((day) => day.weekId === current.id)).toHaveLength(3);
    });

    it('does not retry a FAILED week that has used 3 attempts, and retries one with fewer', async () => {
      const spent = build();
      const done = spent.repository.addWeek({ weekStart: TODAY, status: 'FAILED', attempts: 3 });
      await spent.service.advance(spent.repository.plan, NOW);
      expect(spent.generator.writeWeek).not.toHaveBeenCalled();
      expect(done.status).toBe('FAILED');
      const fresh = build();
      const week = fresh.repository.addWeek({ weekStart: TODAY, status: 'FAILED', attempts: 2 });
      await fresh.service.advance(fresh.repository.plan, NOW);
      expect(fresh.generator.writeWeek).toHaveBeenCalledTimes(1);
      expect(week.status).toBe('READY');
    });

    it('marks the week FAILED when the model fails, and still tops up the roadmap', async () => {
      const { service, repository, generator } = build();
      generator.writeWeek.mockRejectedValueOnce(new Error('boom'));
      const current = repository.addWeek({ weekStart: TODAY });
      await service.advance(repository.plan, NOW);
      expect(current.status).toBe('FAILED');
      expect(repository.weeks).toHaveLength(ROADMAP_WEEKS);
    });

    it('tops the roadmap up to 12 weeks from the current one, on the next clusters of the rotation', async () => {
      const { service, repository, generator } = build();
      repository.addWeek({ weekStart: TODAY, status: 'READY', clusterId: 'c1' });
      await service.advance(repository.plan, NOW);
      const starts = repository.weeks.map((week) => week.weekStart).sort();
      expect(starts).toHaveLength(ROADMAP_WEEKS);
      expect(starts[1]).toBe(addDays(TODAY, 7));
      expect(starts[11]).toBe(addDays(TODAY, 77));
      const added = repository.weeks.filter((week) => week.weekStart > TODAY).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
      expect(added.slice(0, 3).map((week) => week.clusterId)).toEqual(['c2', 'c1', 'c2']);
      expect(generator.writeIdeas.mock.calls[0][0].weeks).toHaveLength(ROADMAP_WEEKS - 1);
    });

    it('starts an idle plan again from today', async () => {
      const { service, repository } = build();
      readyWeek(repository, '2026-01-01', 3);
      await service.advance(repository.plan, NOW);
      const starts = repository.weeks.map((week) => week.weekStart).sort();
      expect(starts).toContain(TODAY);
      const current = repository.weeks.find((week) => week.weekStart === TODAY);
      expect(current.status).toBe('READY');
      expect(repository.weeks.filter((week) => week.weekStart >= TODAY)).toHaveLength(ROADMAP_WEEKS);
    });

    it('does not touch a plan whose roadmap is complete and week is written', async () => {
      const { service, repository, generator } = build();
      for (let index = 0; index < ROADMAP_WEEKS; index += 1) {
        repository.addWeek({ weekStart: addDays(TODAY, index * 7), status: 'READY' });
      }
      await service.advance(repository.plan, NOW);
      expect(generator.writeWeek).not.toHaveBeenCalled();
      expect(generator.writeIdeas).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('advances each plan and survives one that fails', async () => {
      const { service, repository, generator } = build();
      repository.addWeek({ weekStart: TODAY });
      generator.writeIdeas.mockRejectedValueOnce(new Error('boom'));
      await expect(service.tick(NOW)).resolves.toBeUndefined();
      expect(generator.writeWeek).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateWeek', () => {
    it.each([1, 3, 7])('writes exactly %i days on the SLOT_DAYS offsets', async (videos) => {
      const { service, repository } = build(videos);
      const week = repository.addWeek({ weekStart: TODAY });
      await service.generateWeek(week.id);
      const written = repository.days.filter((day) => day.weekId === week.id);
      expect(written.map((day) => day.dayIndex)).toEqual(SLOT_DAYS[videos]);
      expect(written.map((day) => day.date)).toEqual(SLOT_DAYS[videos].map((offset) => addDays(TODAY, offset)));
      expect(written.every((day) => day.status === 'PLANNED' && day.version === 1)).toBe(true);
    });

    it('leaves a week that is already written as it is, even when videosPerWeek changed', async () => {
      const { service, repository, generator } = build(5);
      const week = readyWeek(repository, TODAY, 3);
      await service.generateWeek(week.id);
      expect(generator.writeWeek).not.toHaveBeenCalled();
      expect(repository.days.filter((day) => day.weekId === week.id)).toHaveLength(3);
    });

    it('never sends the angle trend without an urgent note, even for a carried one', async () => {
      const { service, repository, generator } = build(7);
      const week = repository.addWeek({
        weekStart: TODAY,
        carryIn: [{ title: 'Late news', angle: 'trend', clusterId: 'c1' }],
      });
      await service.generateWeek(week.id);
      const angles = generator.writeWeek.mock.calls[0][0].slots.map((slot: any) => slot.angle);
      expect(angles).toHaveLength(7);
      expect(angles).not.toContain('trend');
      expect(generator.writeWeek.mock.calls[0][0].slots.some((slot: any) => slot.carried)).toBe(false);
    });

    it('may use trend when the week has an urgent note', async () => {
      const { service, repository, generator } = build(1);
      recordedAllButTrend(repository);
      const week = repository.addWeek({ weekStart: TODAY, urgentNote: 'A new law' });
      await service.generateWeek(week.id);
      const angles = generator.writeWeek.mock.calls[0][0].slots.map((slot: any) => slot.angle);
      expect(angles).toEqual(['trend']);
    });

    it('puts carried items at the 2nd and 4th video of a 4-video week, the outline elsewhere', async () => {
      const { service, repository, generator } = build(4);
      const week = repository.addWeek({
        weekStart: TODAY,
        outline: [0, 1, 2, 3].map((index) => ({ title: `Outline ${index}`, angle: 'steps' })),
        carryIn: [
          { title: 'Carried A', angle: 'story', clusterId: 'c1' },
          { title: 'Carried B', angle: 'question', clusterId: 'c1' },
          { title: 'Carried C', angle: 'comparison', clusterId: 'c1' },
        ],
      });
      await service.generateWeek(week.id);
      const slots = generator.writeWeek.mock.calls[0][0].slots;
      expect(slots.map((slot: any) => slot.carried?.title ?? slot.outlineTitle)).toEqual([
        'Outline 0',
        'Carried A',
        'Outline 2',
        'Carried B',
      ]);
    });

    it('keeps an edited brief and saves an unedited one', async () => {
      const edited = build();
      const own = edited.repository.addWeek({ weekStart: TODAY, brief: 'Mine', briefEdited: true });
      await edited.service.generateWeek(own.id);
      expect(own.brief).toBe('Mine');
      const plain = build();
      const week = plain.repository.addWeek({ weekStart: TODAY, brief: 'Old' });
      await plain.service.generateWeek(week.id);
      expect(week.brief).toBe('Written brief');
    });

    it('marks the week FAILED and rethrows when the model fails', async () => {
      const { service, repository, generator } = build();
      generator.writeWeek.mockRejectedValueOnce(new Error('boom'));
      const week = repository.addWeek({ weekStart: TODAY });
      await expect(service.generateWeek(week.id)).rejects.toThrow('boom');
      expect(week.status).toBe('FAILED');
      expect(week.attempts).toBe(1);
    });
  });

  describe('regenerateDays', () => {
    it('rewrites only planned days from today on, never a recorded or a past day', async () => {
      const { service, repository, generator } = build(7);
      const week = repository.addWeek({ weekStart: addDays(TODAY, -3), status: 'READY' });
      const days = [0, 1, 2, 3, 4, 5, 6].map((dayIndex) =>
        repository.addDay(week, { dayIndex, status: dayIndex === 4 ? 'RECORDED' : 'PLANNED' })
      );
      await service.regenerateDays(week.id, addDays(TODAY, -10));
      const slots = generator.writeWeek.mock.calls[0][0].slots;
      // days 3..6 are today or later; day 4 is recorded
      expect(slots.map((slot: any) => slot.dayIndex)).toEqual([3, 5, 6]);
      expect(generator.writeWeek.mock.calls[0][0].videosPerWeek).toBe(7);
      expect(days[4].title).toBe('Title 4');
      expect(days[0].title).toBe('Title 0');
      expect(days[3].title).toBe('New 0');
      expect(days[5].title).toBe('New 1');
      expect(days.every((day) => day.busy === false)).toBe(true);
      expect(generator.writeWeek.mock.calls[0][0].otherTitles).toEqual(
        ['Title 0', 'Title 1', 'Title 2', 'Title 4']
      );
    });

    it('keeps the angles without an urgent note and may bring trend with one', async () => {
      const plain = build(3);
      const week = plain.repository.addWeek({ weekStart: TODAY, status: 'READY' });
      [0, 2, 4].forEach((dayIndex) => plain.repository.addDay(week, { dayIndex, angle: 'mistake' }));
      await plain.service.regenerateDays(week.id, TODAY);
      expect(plain.generator.writeWeek.mock.calls[0][0].slots.map((slot: any) => slot.angle)).toEqual([
        'mistake',
        'mistake',
        'mistake',
      ]);
      const urgent = build(3);
      recordedAllButTrend(urgent.repository);
      const noted = urgent.repository.addWeek({ weekStart: TODAY, status: 'READY', urgentNote: 'News' });
      [0, 2, 4].forEach((dayIndex) => urgent.repository.addDay(noted, { dayIndex, angle: 'mistake' }));
      await urgent.service.regenerateDays(noted.id, TODAY);
      expect(urgent.generator.writeWeek.mock.calls[0][0].slots.map((slot: any) => slot.angle)).toContain('trend');
    });

    it('frees the days again when the model fails', async () => {
      const { service, repository, generator } = build(3);
      generator.writeWeek.mockRejectedValueOnce(new Error('boom'));
      const week = repository.addWeek({ weekStart: TODAY, status: 'READY' });
      [0, 2, 4].forEach((dayIndex) => repository.addDay(week, { dayIndex }));
      await expect(service.regenerateDays(week.id, TODAY)).rejects.toThrow('boom');
      expect(repository.days.every((day) => !day.busy && day.title.startsWith('Title'))).toBe(true);
    });
  });

  describe('regenerateDay', () => {
    it('writes one video on an angle none of the week uses, with the other titles', async () => {
      const { service, repository, generator } = build(3);
      const week = repository.addWeek({ weekStart: TODAY, status: 'READY' });
      const angles = ['problem', 'mistake', 'story'];
      const days = [0, 2, 4].map((dayIndex, index) =>
        repository.addDay(week, { dayIndex, angle: angles[index] })
      );
      await service.regenerateDay(days[1].id);
      const input = generator.writeDay.mock.calls[0][0];
      expect(['problem', 'mistake', 'story']).not.toContain(input.slot.angle);
      expect(input.slot.dayIndex).toBe(2);
      expect(input.videosPerWeek).toBe(3);
      expect(input.otherTitles).toEqual(['Title 0', 'Title 4']);
      expect(days[1].title).toBe('New 0');
      expect(days[1].angle).toBe(input.slot.angle);
      expect(days[1].busy).toBe(false);
    });

    it('leaves a recorded day and a past day as they are', async () => {
      const { service, repository, generator } = build(3);
      const week = repository.addWeek({ weekStart: addDays(TODAY, -3), status: 'READY' });
      const past = repository.addDay(week, { dayIndex: 0 });
      const recorded = repository.addDay(week, { dayIndex: 4, status: 'RECORDED' });
      await service.regenerateDay(past.id);
      await service.regenerateDay(recorded.id);
      expect(generator.writeDay).not.toHaveBeenCalled();
      expect(past.title).toBe('Title 0');
      expect(recorded.title).toBe('Title 4');
    });
  });

  describe('extendRoadmap and replan', () => {
    it('gives the model the latest ideas of each cluster', async () => {
      const { service, repository, generator } = build();
      repository.addWeek({ weekStart: addDays(TODAY, -7), status: 'READY', clusterId: 'c2', idea: 'Old c2' });
      repository.addWeek({ weekStart: TODAY, status: 'READY', clusterId: 'c1', idea: 'Now c1' });
      await service.extendRoadmap('plan-1');
      const weeks = generator.writeIdeas.mock.calls[0][0].weeks;
      expect(weeks[0]).toEqual(
        expect.objectContaining({ weekStart: addDays(TODAY, 7), clusterTitle: 'Cluster 2', previousIdeas: ['Old c2'] })
      );
      expect(weeks[1].previousIdeas).toEqual(['Now c1']);
    });

    it('rewrites only the ideas of unwritten, unedited weeks after the current one, clears their outline and frees the plan', async () => {
      const { service, repository, generator } = build();
      repository.plan.busy = 'replan';
      repository.addWeek({ weekStart: TODAY, status: 'READY', idea: 'Current' });
      const open = repository.addWeek({ weekStart: addDays(TODAY, 7), outline: [{ title: 'x', angle: 'story' }] });
      const edited = repository.addWeek({ weekStart: addDays(TODAY, 14), ideaEdited: true, idea: 'Mine' });
      const written = repository.addWeek({ weekStart: addDays(TODAY, 21), status: 'READY', idea: 'Done' });
      await service.replan('plan-1');
      expect(generator.writeIdeas.mock.calls[0][0].weeks).toHaveLength(1);
      expect(open.idea).toBe('Idea 0');
      expect(open.outline).toBeNull();
      expect(edited.idea).toBe('Mine');
      expect(written.idea).toBe('Done');
      expect(repository.plan.busy).toBeNull();
      expect(repository.plan.notice).toBe('roadmap_updated');
    });

    it('tells the owner when a replan could not be applied', async () => {
      const { service, repository } = build();
      repository.plan.busy = 'replan';
      await service.replanFailed('plan-1');
      expect(repository.plan.busy).toBeNull();
      expect(repository.plan.notice).toBe('replan_failed');
    });
  });
});
