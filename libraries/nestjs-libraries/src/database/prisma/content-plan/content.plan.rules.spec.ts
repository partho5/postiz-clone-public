// Content plan rules: what a slide may contain and the brand context message. Pure, needs no network or database.
import {
  addDays,
  brandContextMessage,
  carryPositions,
  cleanSlideText,
  daysBetween,
  localToday,
  mergeCarry,
  nextClusterId,
  pickAngles,
  rotationOrder,
  slotsForWeek,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import {
  ANGLES,
  Angle,
  CARRY_MAX,
  PlanCarryItem,
  PlanFacts,
  SLOT_DAYS,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

describe('cleanSlideText', () => {
  it('strips list markers and emphasis', () => {
    expect(cleanSlideText('1. **Pick one**')).toBe('Pick one');
    expect(cleanSlideText('1) Pick one')).toBe('Pick one');
    expect(cleanSlideText('# Pick `one`')).toBe('Pick one');
    expect(cleanSlideText('* __Pick__ one')).toBe('Pick one');
    expect(cleanSlideText('• Pick one')).toBe('Pick one');
  });

  it('turns line breaks and tabs into single spaces', () => {
    expect(cleanSlideText('- a\nb')).toBe('a b');
    expect(cleanSlideText('a\t\tb \r\n  c')).toBe('a b c');
  });

  it('unwraps quoted text', () => {
    expect(cleanSlideText('"Pick one"')).toBe('Pick one');
    expect(cleanSlideText('“Pick one”')).toBe('Pick one');
    expect(cleanSlideText('«Pick one»')).toBe('Pick one');
    expect(cleanSlideText('say "hi" now')).toBe('say "hi" now');
  });

  it('leaves Bengali, Arabic and Hindi text unchanged', () => {
    for (const text of [
      'আপনার ব্যবসা',
      'ماذا تفعل الآن',
      'अपना व्यवसाय',
    ]) {
      expect(cleanSlideText(text)).toBe(text);
    }
  });

  it('cuts to 200 characters', () => {
    expect(cleanSlideText('a'.repeat(250))).toHaveLength(200);
  });
});

describe('brandContextMessage', () => {
  const facts: PlanFacts = {
    whatWeDo: 'Bakes bread',
    audience: 'Neighbours',
    problems: ['p1'],
    solution: 'Fresh daily',
    objections: ['o1'],
    tone: 'Warm',
    videoSeconds: 60,
  };

  it('writes the brand, the language, then the facts and direction when present', () => {
    expect(
      brandContextMessage({ name: 'Bakery', locale: 'en', facts: null, direction: null })
    ).toBe('Brand: Bakery\n\nLanguage: en');
    const text = brandContextMessage({
      name: 'Bakery',
      locale: 'en',
      facts,
      direction: 'Teach, do not sell.',
    });
    expect(text).toBe(
      `Brand: Bakery\n\nLanguage: en\n\nAbout the business:\n${JSON.stringify(
        facts
      )}\n\nContent direction:\nTeach, do not sell.`
    );
  });

  it('does not change with the key order of the facts object', () => {
    const shuffled = {
      videoSeconds: 60,
      tone: 'Warm',
      objections: ['o1'],
      solution: 'Fresh daily',
      problems: ['p1'],
      audience: 'Neighbours',
      whatWeDo: 'Bakes bread',
    } as PlanFacts;
    const a = brandContextMessage({ name: 'B', locale: 'en', facts, direction: 'd' });
    const b = brandContextMessage({
      name: 'B',
      locale: 'en',
      facts: shuffled,
      direction: 'd',
    });
    expect(b).toBe(a);
  });
});

describe('localToday', () => {
  it('reads the date across the date line', () => {
    const now = new Date('2026-11-22T20:30:00Z');
    expect(localToday(now, 'UTC')).toBe('2026-11-22');
    expect(localToday(now, 'Asia/Dhaka')).toBe('2026-11-23');
    expect(localToday(now, 'America/Los_Angeles')).toBe('2026-11-22');
    expect(localToday(new Date('2026-11-23T03:00:00Z'), 'America/Los_Angeles')).toBe(
      '2026-11-22'
    );
  });

  it('falls back to UTC for an unknown time zone', () => {
    expect(localToday(new Date('2026-11-22T20:30:00Z'), 'Not/AZone')).toBe(
      '2026-11-22'
    );
  });
});

describe('addDays and daysBetween', () => {
  it('moves across months and years', () => {
    expect(addDays('2026-01-30', 3)).toBe('2026-02-02');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts the days between two dates', () => {
    expect(daysBetween('2026-11-22', '2026-11-29')).toBe(7);
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(daysBetween('2026-11-29', '2026-11-22')).toBe(-7);
  });
});

describe('rotationOrder and nextClusterId', () => {
  const themes = [
    { id: 'T2', position: 1 },
    { id: 'T1', position: 0 },
    { id: 'T3', position: 2 },
  ];
  const clusters = [
    { id: 'c1', themeId: 'T1', position: 0 },
    { id: 'c2', themeId: 'T1', position: 1 },
    { id: 'c3', themeId: 'T1', position: 2 },
    { id: 'c4', themeId: 'T2', position: 0 },
    { id: 'c5', themeId: 'T3', position: 0 },
    { id: 'c6', themeId: 'T3', position: 1 },
  ];

  it('interleaves the themes and skips one that runs out', () => {
    expect(rotationOrder(themes, clusters)).toEqual([
      'c1',
      'c4',
      'c5',
      'c2',
      'c6',
      'c3',
    ]);
  });

  it('gives the next cluster and wraps', () => {
    const rotation = ['c1', 'c4', 'c5'];
    expect(nextClusterId(rotation, null)).toBe('c1');
    expect(nextClusterId(rotation, 'c1')).toBe('c4');
    expect(nextClusterId(rotation, 'c5')).toBe('c1');
    // an archived cluster is not in the rotation: it starts again
    expect(nextClusterId(rotation, 'gone')).toBe('c1');
  });
});

describe('pickAngles', () => {
  const used = (entries: [Angle, string][]) => new Map<Angle, string>(entries);

  it('takes never-used angles first, then the oldest last use', () => {
    const lastUse = used(
      ANGLES.filter((angle) => angle !== 'trend' && angle !== 'story').map(
        (angle, index) => [angle, `2026-10-${String(10 + index).padStart(2, '0')}`]
      )
    );
    const picked = pickAngles(3, lastUse, [], false, 0);
    expect(picked[0]).toBe('story');
    expect(picked[1]).toBe('problem');
    expect(picked[2]).toBe('mistake');
  });

  it('keeps ANGLES order for ties, from the seed, and wraps', () => {
    expect(pickAngles(3, new Map(), [], false, 0)).toEqual([
      'problem',
      'mistake',
      'story',
    ]);
    expect(pickAngles(3, new Map(), [], false, 8)).toEqual([
      'customer_voice',
      'problem',
      'mistake',
    ]);
  });

  it('excludes taken angles and never picks trend unless allowed', () => {
    const picked = pickAngles(9, new Map(), ['problem'], false, 0);
    expect(picked).not.toContain('problem');
    expect(picked).not.toContain('trend');
    expect(pickAngles(10, new Map(), [], true, 0)).toContain('trend');
  });

  it('is never short, even when fewer candidates remain', () => {
    const exclude = ANGLES.filter((angle) => angle !== 'story' && angle !== 'steps');
    const picked = pickAngles(5, new Map(), exclude, false, 0);
    expect(picked).toHaveLength(5);
    expect(new Set(picked)).toEqual(new Set(['story', 'steps']));
  });
});

describe('slotsForWeek', () => {
  const angles: Angle[] = ['problem', 'mistake', 'story', 'question', 'steps', 'comparison', 'trend'];
  const carry = (title: string): PlanCarryItem => ({
    title,
    angle: 'fear_loss',
    clusterId: 'c1',
  });

  it('gives the count and the offsets of SLOT_DAYS for 1 to 7 videos', () => {
    for (let count = 1; count <= 7; count += 1) {
      const slots = slotsForWeek({
        weekStart: '2026-11-22',
        videosPerWeek: count,
        outline: null,
        carryIn: null,
        pickedAngles: angles,
      });
      expect(slots.map((slot) => slot.dayIndex)).toEqual(SLOT_DAYS[count]);
      expect(slots.map((slot) => slot.date)).toEqual(
        SLOT_DAYS[count].map((offset) => addDays('2026-11-22', offset))
      );
    }
  });

  it('uses the outline titles and angles when present', () => {
    const slots = slotsForWeek({
      weekStart: '2026-11-22',
      videosPerWeek: 2,
      outline: [
        { title: 'One', angle: 'story' },
        { title: 'Two', angle: 'steps' },
      ],
      carryIn: null,
      pickedAngles: angles,
    });
    expect(slots.map((slot) => [slot.outlineTitle, slot.angle])).toEqual([
      ['One', 'story'],
      ['Two', 'steps'],
    ]);
  });

  it('puts carried items at the 2nd, 4th and 6th video only where they exist', () => {
    const run = (videosPerWeek: number) =>
      slotsForWeek({
        weekStart: '2026-11-22',
        videosPerWeek,
        outline: null,
        carryIn: [carry('a'), carry('b'), carry('c')],
        pickedAngles: angles,
      })
        .map((slot) => slot.carried?.title ?? '-')
        .join('');
    expect(run(1)).toBe('-');
    expect(run(2)).toBe('-a');
    expect(run(3)).toBe('-a-');
    expect(run(4)).toBe('-a-b');
    expect(run(5)).toBe('-a-b-');
    expect(run(6)).toBe('-a-b-c');
    expect(run(7)).toBe('-a-b-c-');
  });

  it('takes the angle of a carried item', () => {
    const slots = slotsForWeek({
      weekStart: '2026-11-22',
      videosPerWeek: 2,
      outline: null,
      carryIn: [carry('a')],
      pickedAngles: angles,
    });
    expect(slots[1].angle).toBe('fear_loss');
    expect(slots[1].dayIndex).toBe(SLOT_DAYS[2][1]);
  });
});

describe('mergeCarry', () => {
  const item = (title: string): PlanCarryItem => ({ title, angle: 'story', clusterId: 'c1' });

  it('keeps the existing items first and caps at CARRY_MAX', () => {
    const { kept, dropped } = mergeCarry([item('a')], [item('b'), item('c'), item('d')]);
    expect(kept.map((i) => i.title)).toEqual(['a', 'b', 'c']);
    expect(dropped.map((i) => i.title)).toEqual(['d']);
    expect(kept).toHaveLength(CARRY_MAX);
  });

  it('drops nothing under the cap', () => {
    const { kept, dropped } = mergeCarry([], [item('a')]);
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual([]);
  });
});

describe('carryPositions', () => {
  it('takes the 2nd, 4th and 6th video only where they exist', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((videos) => carryPositions(videos, CARRY_MAX))).toEqual([
      [],
      [1],
      [1],
      [1, 3],
      [1, 3],
      [1, 3, 5],
      [1, 3, 5],
    ]);
    expect(carryPositions(7, 2)).toEqual([1, 3]);
  });
});
