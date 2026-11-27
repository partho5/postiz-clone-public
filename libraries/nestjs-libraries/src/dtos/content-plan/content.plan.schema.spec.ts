// Content plan: the shared constants and the request body schemas. Pure, needs no database.
import {
  AnswerSetupSchema,
  BriefSchema,
  DirectionSchema,
  FactsSchema,
  IdeaSchema,
  InstantIdeaSchema,
  LIMITS,
  ProposeSchema,
  ReviseSchema,
  SLOT_DAYS,
  StartSetupSchema,
  UrgentSchema,
  VideosPerWeekSchema,
  beatsFor,
  targetWordsFor,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

describe('content plan constants', () => {
  it('has one set of slot days per videos-per-week, spread inside the 7 days', () => {
    for (let count = 1; count <= 7; count++) {
      expect(SLOT_DAYS[count]).toHaveLength(count);
      expect(SLOT_DAYS[count]).toEqual(
        Array.from({ length: count }, (_, i) => Math.floor((i * 7) / count))
      );
    }
  });

  it('decides the beats and the spoken words from the video length', () => {
    expect([30, 45, 60, 75, 90, 105, 120].map(beatsFor)).toEqual([
      3, 3, 4, 4, 5, 5, 6,
    ]);
    expect(targetWordsFor(60)).toBe(138);
  });
});

describe('content plan body schemas', () => {
  const answer = { questionId: 'q1', optionId: 'o1', other: null };

  it('accepts a good body for each route', () => {
    expect(StartSetupSchema.safeParse({ sourceText: ' We sell tea ' })).toMatchObject({
      success: true,
      data: { sourceText: 'We sell tea' },
    });
    expect(
      AnswerSetupSchema.safeParse({ roundId: 'r1', direction: 'd', answers: [answer] }).success
    ).toBe(true);
    expect(
      ProposeSchema.safeParse({ direction: 'd', videosPerWeek: 3 }).success
    ).toBe(true);
    expect(ReviseSchema.safeParse({ proposalVersion: 1, feedback: 'more' }).success).toBe(true);
    expect(DirectionSchema.safeParse({ direction: 'd' }).success).toBe(true);
    expect(BriefSchema.safeParse({ brief: 'b' }).success).toBe(true);
    expect(IdeaSchema.safeParse({ idea: 'i' }).success).toBe(true);
    expect(UrgentSchema.safeParse({ note: 'n' }).success).toBe(true);
    expect(InstantIdeaSchema.safeParse({ idea: 'i', date: '2026-11-22' }).success).toBe(true);
    expect(
      FactsSchema.safeParse({
        facts: {
          whatWeDo: 'a',
          audience: 'b',
          problems: ['c'],
          solution: 'd',
          objections: [],
          tone: 'e',
          videoSeconds: 60,
        },
      }).success
    ).toBe(true);
  });

  it('refuses an empty or blank direction, brief, idea, note and feedback', () => {
    for (const blank of ['', '   ']) {
      expect(DirectionSchema.safeParse({ direction: blank }).success).toBe(false);
      expect(BriefSchema.safeParse({ brief: blank }).success).toBe(false);
      expect(IdeaSchema.safeParse({ idea: blank }).success).toBe(false);
      expect(UrgentSchema.safeParse({ note: blank }).success).toBe(false);
      expect(ReviseSchema.safeParse({ proposalVersion: 0, feedback: blank }).success).toBe(false);
    }
  });

  it('refuses an over-long text', () => {
    expect(BriefSchema.safeParse({ brief: 'a'.repeat(LIMITS.brief + 1) }).success).toBe(false);
    expect(BriefSchema.safeParse({ brief: 'a'.repeat(LIMITS.brief) }).success).toBe(true);
    expect(IdeaSchema.safeParse({ idea: 'a'.repeat(LIMITS.idea + 1) }).success).toBe(false);
  });

  it('refuses a field it does not know', () => {
    expect(DirectionSchema.safeParse({ direction: 'd', extra: 1 }).success).toBe(false);
  });

  it('needs an option or a non-empty other text in every answer', () => {
    const body = (a: object) => ({ roundId: 'r1', direction: 'd', answers: [a] });
    expect(AnswerSetupSchema.safeParse(body({ questionId: 'q1' })).success).toBe(false);
    expect(
      AnswerSetupSchema.safeParse(body({ questionId: 'q1', optionId: null, other: '  ' })).success
    ).toBe(false);
    expect(
      AnswerSetupSchema.safeParse(body({ questionId: 'q1', optionId: null, other: 'my own' })).success
    ).toBe(true);
    expect(
      AnswerSetupSchema.safeParse(body({ questionId: 'q1', optionIds: ['o1', 'o2'] })).success
    ).toBe(true);
    expect(
      AnswerSetupSchema.safeParse(body({ questionId: 'q1', optionIds: ['o1', 'o2', 'o3', 'o4', 'o5'] })).success
    ).toBe(false);
    expect(
      ProposeSchema.safeParse({
        direction: 'd',
        videosPerWeek: 3,
        answers: [{ questionId: 'q1' }],
      }).success
    ).toBe(false);
  });

  it('takes videosPerWeek 1-7 and refuses 0, 8 and 2.5', () => {
    for (const value of [1, 2, 3, 4, 5, 6, 7]) {
      expect(VideosPerWeekSchema.safeParse({ videosPerWeek: value }).success).toBe(true);
      expect(
        ProposeSchema.safeParse({ direction: 'd', videosPerWeek: value }).success
      ).toBe(true);
    }
    for (const value of [0, 8, 2.5, -1, '3']) {
      expect(VideosPerWeekSchema.safeParse({ videosPerWeek: value }).success).toBe(false);
      expect(
        ProposeSchema.safeParse({ direction: 'd', videosPerWeek: value }).success
      ).toBe(false);
    }
  });

  it('refuses a date that is not a real calendar day', () => {
    for (const date of ['2026-13-01', '2026-02-30', '22-11-2026', '']) {
      expect(InstantIdeaSchema.safeParse({ idea: 'i', date }).success).toBe(false);
    }
  });
});
