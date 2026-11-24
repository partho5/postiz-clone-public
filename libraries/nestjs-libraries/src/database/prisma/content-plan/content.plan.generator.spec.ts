// Content plan generator: the AI calls of the content plan. Runs on a stubbed MuseChatService, so it needs no network,
// key or database. Covers the message order and the cache key, the error mapping, the clamping of answers and the
// shapes each public method returns.
import OpenAI from 'openai';
import {
  ContentPlanGenerator,
  PlanAiFailed,
  PlanNotConfigured,
  PlanSlot,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import {
  ANGLE_HINTS,
  PLANNER_MODEL,
  PLANNER_PROMPTS,
  PLANNER_RULES,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/prompts';
import { brandContextMessage } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import {
  ChatTurn,
  MuseChatService,
} from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import {
  LIMITS,
  PlanFacts,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

const USAGE = { prompt: 100, cached: 60, completion: 20 };

const facts = (videoSeconds: PlanFacts['videoSeconds'] = 60): PlanFacts => ({
  whatWeDo: 'Bakes bread',
  audience: 'Neighbours',
  problems: ['p1'],
  solution: 'Fresh daily',
  objections: ['o1'],
  tone: 'Warm',
  videoSeconds,
});

const beat = (n: number) => ({ hook: `Hook ${n}`, say: `Say ${n}` });
const video = (title = 'A title', beats = [1, 2, 3, 4].map(beat)) => ({
  title,
  why: 'Because',
  beats,
  closingLine: 'Call us',
});

// A generator over a stub client; `answer` is what writePlanPart gives (or a function that gives it or throws).
const build = (answer: unknown, configured = true) => {
  const writePlanPart = jest.fn();
  if (typeof answer === 'function') {
    writePlanPart.mockImplementation(answer as () => unknown);
  } else {
    writePlanPart.mockResolvedValue({
      data: answer,
      text: JSON.stringify(answer),
      usage: USAGE,
    });
  }
  const muse = {
    configured: () => configured,
    writePlanPart,
  } as unknown as MuseChatService;
  return { generator: new ContentPlanGenerator(muse), writePlanPart };
};

const context = (videoSeconds: PlanFacts['videoSeconds'] = 60) => ({
  orgId: 'org-1',
  name: 'Bakery',
  locale: 'en',
  direction: 'Teach, do not sell.',
  facts: facts(videoSeconds),
});

const videoContext = (videoSeconds: PlanFacts['videoSeconds'] = 60) => ({
  ...context(videoSeconds),
  idea: 'Idea',
  clusterTitle: 'Cluster',
  problem: 'Problem',
  brief: null,
  briefEdited: false,
  urgentNote: null,
  otherTitles: ['Other'],
});

const slot = (dayIndex: number, angle: PlanSlot['angle'] = 'problem'): PlanSlot => ({
  dayIndex,
  date: `2026-11-${20 + dayIndex}`,
  angle,
});

const setupAnswer = (questions: unknown[] = [], direction = 'Direction') => ({
  direction,
  questions,
  readyForPlan: false,
});

const messagesOf = (writePlanPart: jest.Mock) =>
  writePlanPart.mock.calls[0][2] as ChatTurn[];

describe('ContentPlanGenerator', () => {
  describe('ask', () => {
    it('sends rules, brand context, frame, then the task, with the prompt model, effort and cache key', async () => {
      const { generator, writePlanPart } = build({ ideas: ['One idea'] });
      await generator.writeIdeas({
        ...context(),
        weeks: [
          {
            weekStart: '2026-11-22',
            weekEnd: '2026-11-28',
            clusterTitle: 'C',
            problem: 'P',
            previousIdeas: [],
          },
        ],
      });
      const [model, effort, messages, , , cacheKey] = writePlanPart.mock.calls[0];
      expect(model).toBe(PLANNER_MODEL);
      expect(effort).toBe(PLANNER_PROMPTS['planner.frame.roadmap'].effort);
      expect(cacheKey).toBe('content-plan:planner.frame.roadmap');
      expect(messages).toEqual([
        { role: 'developer', content: PLANNER_RULES },
        {
          role: 'user',
          content: brandContextMessage({
            name: 'Bakery',
            locale: 'en',
            facts: facts(),
            direction: 'Teach, do not sell.',
          }),
        },
        {
          role: 'developer',
          content: PLANNER_PROMPTS['planner.frame.roadmap'].body,
        },
        {
          role: 'user',
          content: JSON.stringify({
            weeks: [
              {
                weekStart: '2026-11-22',
                weekEnd: '2026-11-28',
                clusterTitle: 'C',
                problem: 'P',
                previousIdeas: [],
              },
            ],
          }),
        },
      ]);
    });

    it('sends byte-identical rules and brand context for two calls of one brand', async () => {
      const { generator, writePlanPart } = build({ titles: ['A', 'B'] });
      const input = {
        ...context(),
        idea: 'Idea',
        clusterTitle: 'C',
        problem: 'P',
        angles: ['problem', 'story'] as PlanSlot['angle'][],
        videosPerWeek: 2,
      };
      await generator.writeOutline(input);
      await generator.writeOutline({ ...input, idea: 'Another idea' });
      const [first, second] = writePlanPart.mock.calls.map((c) => c[2] as ChatTurn[]);
      expect(second[0]).toEqual(first[0]);
      expect(second[1]).toEqual(first[1]);
      expect(second[2]).toEqual(first[2]);
      expect(second[3]).not.toEqual(first[3]);
    });

    it('appends the angle hints to the bodies of the outline, week and day frames', () => {
      for (const key of [
        'planner.frame.outline',
        'planner.frame.week',
        'planner.frame.day',
      ] as const) {
        expect(PLANNER_PROMPTS[key].body.endsWith(ANGLE_HINTS)).toBe(true);
      }
    });

    it('throws PlanNotConfigured without a key and makes no call', async () => {
      const { generator, writePlanPart } = build({}, false);
      await expect(
        generator.setupRound({
          orgId: 'org-1',
          brandContext: 'ctx',
          turns: [],
          newUserTurn: '{}',
        })
      ).rejects.toBeInstanceOf(PlanNotConfigured);
      expect(writePlanPart).not.toHaveBeenCalled();
    });

    it('maps a 401, 402 or 403 to PlanNotConfigured', async () => {
      for (const status of [401, 402, 403]) {
        const { generator } = build(() => {
          throw new OpenAI.APIError(status, {}, 'refused', new Headers());
        });
        await expect(
          generator.setupRound({
            orgId: 'org-1',
            brandContext: 'ctx',
            turns: [],
            newUserTurn: '{}',
          })
        ).rejects.toBeInstanceOf(PlanNotConfigured);
      }
    });

    it('maps a 500, a timeout and a null answer to PlanAiFailed', async () => {
      const failures: (() => unknown)[] = [
        () => {
          throw new OpenAI.APIError(500, {}, 'boom', new Headers());
        },
        () => {
          throw new Error('timeout');
        },
        () => ({ data: null, text: '', usage: USAGE }),
      ];
      for (const failure of failures) {
        const { generator } = build(failure);
        await expect(
          generator.setupRound({
            orgId: 'org-1',
            brandContext: 'ctx',
            turns: [],
            newUserTurn: '{}',
          })
        ).rejects.toBeInstanceOf(PlanAiFailed);
      }
    });
  });

  describe('setupRound', () => {
    const run = (answer: unknown, turns: ChatTurn[] = []) => {
      const built = build(answer);
      return {
        ...built,
        result: built.generator.setupRound({
          orgId: 'org-1',
          brandContext: 'ctx',
          turns,
          newUserTurn: '{"sourceText":"s"}',
        }),
      };
    };

    it('re-sends the stored turns unchanged before the new turn', async () => {
      const turns: ChatTurn[] = [
        { role: 'user', content: '{"sourceText":"s"}' },
        { role: 'assistant', content: '{"direction":"d"}' },
      ];
      const { writePlanPart, result } = run(setupAnswer(), turns);
      await result;
      const messages = messagesOf(writePlanPart);
      expect(messages.slice(3, 5)).toEqual(turns);
      expect(messages[5]).toEqual({ role: 'user', content: '{"sourceText":"s"}' });
      expect(messages).toHaveLength(6);
    });

    it('rewrites question and option ids and keeps the raw assistant text', async () => {
      const answer = setupAnswer([
        { text: 'First?', options: ['a', 'b', 'c'], recommendedIndex: 2 },
        { text: 'Second?', options: ['x', 'y'], recommendedIndex: 0 },
      ]);
      const { result } = run(answer);
      const round = await result;
      expect(round.questions).toEqual([
        {
          id: 'q1',
          text: 'First?',
          options: [
            { id: 'o1', label: 'a' },
            { id: 'o2', label: 'b' },
            { id: 'o3', label: 'c' },
          ],
          recommendedOptionId: 'o3',
        },
        {
          id: 'q2',
          text: 'Second?',
          options: [
            { id: 'o1', label: 'x' },
            { id: 'o2', label: 'y' },
          ],
          recommendedOptionId: 'o1',
        },
      ]);
      expect(round.assistantTurn).toBe(JSON.stringify(answer));
      expect(round.usage).toEqual(USAGE);
    });

    it('falls back to the first option for a bad recommendedIndex', async () => {
      for (const recommendedIndex of [-1, 7, 1.5]) {
        const { result } = run(
          setupAnswer([{ text: 'Q?', options: ['a', 'b'], recommendedIndex }])
        );
        expect((await result).questions[0].recommendedOptionId).toBe('o1');
      }
    });

    it('keeps at most 4 questions and 4 options, and drops unusable ones', async () => {
      const good = (n: number) => ({
        text: `Q${n}?`,
        options: ['a', 'b', 'c', 'd', 'e'],
        recommendedIndex: 0,
      });
      const { result } = run(
        setupAnswer([
          { text: 'One option', options: ['a'], recommendedIndex: 0 },
          { text: '  ', options: ['a', 'b'], recommendedIndex: 0 },
          good(1),
          good(2),
          good(3),
          good(4),
          good(5),
        ])
      );
      const round = await result;
      expect(round.questions).toHaveLength(4);
      expect(round.questions[0].options).toHaveLength(4);
      expect(round.questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
    });

    it('clamps an over-long direction and fails on an empty one', async () => {
      const long = `${'word '.repeat(2000)}end`;
      const { result } = run(setupAnswer([], long));
      expect((await result).direction.length).toBeLessThanOrEqual(LIMITS.direction);
      const empty = run(setupAnswer([], '   '));
      await expect(empty.result).rejects.toBeInstanceOf(PlanAiFailed);
    });
  });

  describe('proposeStructure', () => {
    const answer = (overrides: Record<string, unknown> = {}) => ({
      facts: {
        whatWeDo: ' Bakes ',
        audience: 'Neighbours',
        problems: ['p1', ' '],
        solution: 'Fresh',
        objections: [],
        tone: 'Warm',
        videoSeconds: 45,
      },
      themes: [
        { ref: 'a', name: 'T1', description: 'd' },
        { ref: 'b', name: 'T2', description: 'd' },
        { ref: 'c', name: 'T3', description: 'd' },
      ],
      clusters: [
        { ref: 'x', themeRef: 'a', title: 'C1', problem: 'p' },
        { ref: 'y', themeRef: 'b', title: 'C2', problem: 'p' },
        { ref: 'z', themeRef: 'c', title: 'C3', problem: 'p' },
        { ref: 'w', themeRef: 'nope', title: 'C4', problem: 'p' },
      ],
      ...overrides,
    });
    const run = (data: unknown) =>
      build(data).generator.proposeStructure({
        orgId: 'org-1',
        brandContext: 'ctx',
        turns: [],
        newUserTurn: '{"direction":"d"}',
      });

    it('renumbers refs, drops a cluster of an unknown theme and cleans the facts', async () => {
      const result = await run(answer());
      expect(result.themes.map((t) => t.ref)).toEqual(['t1', 't2', 't3']);
      expect(result.clusters).toEqual([
        { ref: 'c1', themeRef: 't1', title: 'C1', problem: 'p' },
        { ref: 'c2', themeRef: 't2', title: 'C2', problem: 'p' },
        { ref: 'c3', themeRef: 't3', title: 'C3', problem: 'p' },
      ]);
      expect(result.facts.whatWeDo).toBe('Bakes');
      expect(result.facts.problems).toEqual(['p1']);
      // 45 is not one of 30/60/90/120
      expect(result.facts.videoSeconds).toBe(60);
    });

    it('fails when a theme ends up with no cluster or fewer than 3 themes remain', async () => {
      const base = answer();
      await expect(
        run(answer({ clusters: base.clusters.slice(0, 2) }))
      ).rejects.toBeInstanceOf(PlanAiFailed);
      await expect(
        run(answer({ themes: base.themes.slice(0, 2) }))
      ).rejects.toBeInstanceOf(PlanAiFailed);
    });
  });

  describe('writeIdeas and writeOutline', () => {
    it('fail on a length mismatch and clamp long strings', async () => {
      const weeks = [1, 2].map((n) => ({
        weekStart: `2026-11-${20 + n}`,
        weekEnd: `2026-11-${26 + n}`,
        clusterTitle: 'C',
        problem: 'P',
        previousIdeas: [],
      }));
      await expect(
        build({ ideas: ['only one'] }).generator.writeIdeas({ ...context(), weeks })
      ).rejects.toBeInstanceOf(PlanAiFailed);
      const { ideas } = await build({
        ideas: [`${'word '.repeat(200)}`, 'short'],
      }).generator.writeIdeas({ ...context(), weeks });
      expect(ideas[0].length).toBeLessThanOrEqual(LIMITS.idea);
      expect(ideas[1]).toBe('short');

      const outline = {
        ...context(),
        idea: 'I',
        clusterTitle: 'C',
        problem: 'P',
        angles: ['problem', 'story'] as PlanSlot['angle'][],
        videosPerWeek: 2,
      };
      await expect(
        build({ titles: ['one'] }).generator.writeOutline(outline)
      ).rejects.toBeInstanceOf(PlanAiFailed);
      const { titles } = await build({
        titles: [`${'word '.repeat(40)}`, 'Second'],
      }).generator.writeOutline(outline);
      expect(titles[0].length).toBeLessThanOrEqual(LIMITS.title);
      expect(titles[1]).toBe('Second');
    });

    it('sends titleMaxChars and one slot per angle in the outline task', async () => {
      const { generator, writePlanPart } = build({ titles: ['A', 'B'] });
      await generator.writeOutline({
        ...context(),
        idea: 'I',
        clusterTitle: 'C',
        problem: 'P',
        angles: ['problem', 'story'],
        videosPerWeek: 2,
      });
      expect(JSON.parse(messagesOf(writePlanPart)[3].content)).toEqual({
        idea: 'I',
        clusterTitle: 'C',
        problem: 'P',
        videosPerWeek: 2,
        titleMaxChars: LIMITS.title,
        slots: [{ angle: 'problem' }, { angle: 'story' }],
      });
    });
  });

  describe('writeWeek and writeDay', () => {
    it('maps answers to slots by position and takes the day index from the slot', async () => {
      const { generator } = build({
        brief: 'The brief',
        videos: [video('First'), video('Second')],
      });
      const week = await generator.writeWeek({
        ...videoContext(),
        slots: [slot(0, 'story'), slot(3, 'steps')],
      });
      expect(week.brief).toBe('The brief');
      expect(week.days.map((d) => [d.dayIndex, d.title])).toEqual([
        [0, 'First'],
        [3, 'Second'],
      ]);
      expect(week.days[0]).not.toHaveProperty('angle');
    });

    it('throws PlanAiFailed when the day count is wrong', async () => {
      const { generator } = build({ brief: 'b', videos: [video()] });
      await expect(
        generator.writeWeek({ ...videoContext(), slots: [slot(0), slot(2)] })
      ).rejects.toBeInstanceOf(PlanAiFailed);
    });

    it('carries beatsCount and targetWords from the video length, and the slot extras', async () => {
      const cases: [PlanFacts['videoSeconds'], number, number][] = [
        [30, 3, 69],
        [60, 4, 138],
        [90, 5, 207],
        [120, 6, 276],
      ];
      for (const [seconds, beatsCount, targetWords] of cases) {
        const { generator, writePlanPart } = build({
          brief: 'b',
          videos: [video()],
        });
        await generator.writeWeek({
          ...videoContext(seconds),
          slots: [
            {
              ...slot(0),
              carried: { title: 'Carried' },
              outlineTitle: 'Outline',
            },
          ],
        });
        expect(JSON.parse(messagesOf(writePlanPart)[3].content)).toEqual({
          idea: 'Idea',
          clusterTitle: 'Cluster',
          problem: 'Problem',
          briefEdited: false,
          otherTitles: ['Other'],
          slots: [
            {
              angle: 'problem',
              carried: { title: 'Carried' },
              outlineTitle: 'Outline',
            },
          ],
          videosPerWeek: 1,
          videoSeconds: seconds,
          beatsCount,
          targetWords,
          titleMaxChars: LIMITS.title,
        });
      }
    });

    it('clamps texts, cleans hooks, drops empty beats and keeps at most 6', async () => {
      const beats = [
        { hook: '1. **Pick one**', say: 'Say 1' },
        { hook: '', say: 'no hook' },
        { hook: 'no say', say: '  ' },
        ...[2, 3, 4, 5, 6, 7].map(beat),
        { hook: `${'word '.repeat(60)}`, say: 'Long hook' },
      ];
      const { generator } = build({
        brief: 'b',
        videos: [
          {
            title: 'word '.repeat(40),
            why: 'why '.repeat(100),
            beats,
            closingLine: 'ok',
          },
        ],
      });
      const { days } = await generator.writeWeek({
        ...videoContext(),
        slots: [slot(0)],
      });
      const [day] = days;
      expect(day.title.length).toBeLessThanOrEqual(LIMITS.title);
      expect(day.why.length).toBeLessThanOrEqual(LIMITS.why);
      expect(day.beats).toHaveLength(6);
      expect(day.beats[0]).toEqual({ hook: 'Pick one', say: 'Say 1' });
    });

    it('cuts a hook to the hook limit', async () => {
      const beats = [1, 2, 3].map((n) => ({
        hook: `${'word '.repeat(60)}`,
        say: `Say ${n}`,
      }));
      const { generator } = build({
        brief: 'b',
        videos: [video('T', beats)],
      });
      const { days } = await generator.writeWeek({
        ...videoContext(),
        slots: [slot(0)],
      });
      for (const day of days) {
        for (const b of day.beats) {
          expect(b.hook.length).toBeLessThanOrEqual(LIMITS.hook);
        }
      }
    });

    it('throws when a day has only 2 usable beats', async () => {
      const { generator } = build({
        brief: 'b',
        videos: [video('T', [beat(1), beat(2), { hook: '', say: 'x' }])],
      });
      await expect(
        generator.writeWeek({ ...videoContext(), slots: [slot(0)] })
      ).rejects.toBeInstanceOf(PlanAiFailed);
    });

    it('writes one day with the week video count and the slot', async () => {
      const { generator, writePlanPart } = build({
        brief: 'ignored',
        videos: [video('Only')],
      });
      const { day } = await generator.writeDay({
        ...videoContext(),
        slot: slot(4, 'question'),
        videosPerWeek: 3,
      });
      expect(day.dayIndex).toBe(4);
      expect(day.title).toBe('Only');
      const task = JSON.parse(messagesOf(writePlanPart)[3].content);
      expect(task.videosPerWeek).toBe(3);
      expect(task.slots).toEqual([{ angle: 'question' }]);
      expect(writePlanPart.mock.calls[0][5]).toBe('content-plan:planner.frame.day');
    });
  });
});
