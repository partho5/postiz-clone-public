// AI video editing (ai.video-editing): the text motion tables (card S3). Every motion has limits with a default inside,
// the limits obey the speed rules, the legacy list is what installed phones draw, and the existing text effects fit the
// tables as they are. Needs no database and no Nest.
import { SPEED_RULES } from './edit.contract';
import {
  ENTRY_MOTIONS,
  EXIT_DIRS,
  EXIT_MOTIONS,
  HOLD_MOTIONS,
  LEGACY_TEXT_MOTIONS,
  MotionGroup,
  MotionSpec,
  TEXT_MOTION_IDS,
  motionCapabilityId,
  motionSpec,
  motionUsable,
  repairMotionParams,
  swapUnusableMotions,
  takesMotion,
  textMotionsOf,
} from './edit.motions';
import { EFFECTS, effectById } from './edit.registry';

const TABLES: [MotionGroup, MotionSpec[]][] = [
  ['entry', ENTRY_MOTIONS],
  ['hold', HOLD_MOTIONS],
  ['exit', EXIT_MOTIONS],
];

describe('ai.video-editing: text motion tables', () => {
  it('names every entry, hold and exit of the spec', () => {
    expect(ENTRY_MOTIONS.map((m) => m.id).sort()).toEqual(
      [
        'blur_in', 'drop_bounce', 'fade', 'flip', 'glitch', 'pop', 'slide_bottom', 'slide_left', 'slide_right',
        'slide_top', 'slide_up', 'stamp', 'sweep', 'typewriter', 'wipe', 'word_by_word',
      ].sort()
    );
    expect(HOLD_MOTIONS.map((m) => m.id)).toEqual(['none', 'float', 'pulse', 'shake', 'shimmer', 'neon_flicker']);
    expect(EXIT_MOTIONS.map((m) => m.id)).toEqual([
      'fade', 'slide_out', 'shrink', 'pop_out', 'typewriter_delete', 'wipe_out',
    ]);
    expect(EXIT_DIRS).toEqual(['left', 'right', 'top', 'bottom']);
  });

  it.each(TABLES)('has unique ids in the %s table', (_group, table) => {
    expect(new Set(table.map((m) => m.id)).size).toBe(table.length);
  });

  it.each(TABLES)('gives every %s motion a min and max duration with the default inside', (_group, table) => {
    for (const m of table.filter((x) => x.ms_key)) {
      expect(m.min_ms).toBeGreaterThan(0);
      expect(m.min_ms).toBeLessThanOrEqual(m.default_ms);
      expect(m.default_ms).toBeLessThanOrEqual(m.max_ms);
    }
  });

  it('keeps entries inside the speed rules, with typewriter the one longer entry, and exits inside theirs', () => {
    const [entryLo, entryHi] = SPEED_RULES.entry_ms;
    for (const m of ENTRY_MOTIONS.filter((x) => x.id !== 'typewriter')) {
      expect(m.min_ms).toBeGreaterThanOrEqual(entryLo);
      expect(m.max_ms).toBeLessThanOrEqual(entryHi);
    }
    expect(motionSpec('entry', 'typewriter')).toMatchObject({ ms_key: 'typing_ms', min_ms: 200, max_ms: 500 });
    const [exitLo, exitHi] = SPEED_RULES.exit_ms;
    for (const m of EXIT_MOTIONS) {
      expect(m.min_ms).toBeGreaterThanOrEqual(exitLo);
      expect(m.max_ms).toBeLessThanOrEqual(exitHi);
    }
  });

  it('has a still hold with no duration and a duration key for every other motion', () => {
    expect(motionSpec('hold', 'none')?.ms_key).toBeNull();
    HOLD_MOTIONS.filter((m) => m.id !== 'none').forEach((m) => expect(m.ms_key).toBe('hold_ms'));
    EXIT_MOTIONS.forEach((m) => expect(m.ms_key).toBe('exit_ms'));
  });

  it('lists exactly the five legacy entries installed phones draw, all in the entry table', () => {
    expect(LEGACY_TEXT_MOTIONS).toEqual(['pop', 'stamp', 'slide_up', 'word_by_word', 'sweep']);
    LEGACY_TEXT_MOTIONS.forEach((id) => expect(motionSpec('entry', id)).toBeDefined());
    expect(LEGACY_TEXT_MOTIONS).not.toContain('typewriter');
  });

  it('gives each capability id once: entries plain, hold and exit prefixed, the still hold not listed', () => {
    expect(new Set(TEXT_MOTION_IDS).size).toBe(TEXT_MOTION_IDS.length);
    expect(TEXT_MOTION_IDS).toContain('fade');
    expect(TEXT_MOTION_IDS).toContain('hold_float');
    expect(TEXT_MOTION_IDS).toContain('exit_fade');
    expect(TEXT_MOTION_IDS).not.toContain('hold_none');
    expect(motionCapabilityId('exit', 'slide_out')).toBe('exit_slide_out');
    expect(TEXT_MOTION_IDS.length).toBe(ENTRY_MOTIONS.length + HOLD_MOTIONS.length - 1 + EXIT_MOTIONS.length);
    TEXT_MOTION_IDS.forEach((id) => expect(id).toMatch(/^[a-z0-9_]{1,64}$/));
  });
});

describe('ai.video-editing: text motions and the registry', () => {
  const texts = EFFECTS.filter((e) => e.layer === 'text');

  it('takes motions on the effects whose entry is in the table, and not on drawn or counted ones', () => {
    for (const id of ['x_pop', 'x_stamp', 'x_slide_up', 'x_typewriter', 'x_one_word', 'x_marker_sweep', 'x_shake']) {
      expect(takesMotion(effectById(id)!)).toBe(true);
    }
    for (const id of ['x_underline_draw', 'x_circle_draw', 'x_arrow_draw', 'x_count_up', 'p_text_behind', 'v_punch_in']) {
      expect(takesMotion(effectById(id)!)).toBe(false);
    }
  });

  it('keeps every existing text effect valid as it is: its entry, durations and limits sit inside the tables', () => {
    for (const effect of texts.filter(takesMotion)) {
      const params = { ...effect.default_params };
      expect(repairMotionParams(params, effect.default_params)).toEqual([]);
      expect(params).toEqual(effect.default_params);
    }
  });

  it('keeps the legacy values of the shipped x_* effects', () => {
    expect(effectById('x_pop')!.default_params).toEqual({ entry: 'pop', entry_ms: 200, exit_ms: 150 });
    expect(effectById('x_stamp')!.param_limits).toEqual({ entry_ms: [120, 180], shake_ms: [80, 140] });
    expect(effectById('x_typewriter')!.default_params).toEqual({ entry: 'typewriter', typing_ms: 400, exit_ms: 150 });
  });
});

describe('ai.video-editing: repairMotionParams', () => {
  const defaults = effectById('x_pop')!.default_params;

  it('changes nothing for a valid motion and returns no code', () => {
    const params = { ...defaults, entry: 'wipe', entry_ms: 220, hold: 'shimmer', hold_ms: 1000, exit: 'wipe_out', exit_ms: 150 };
    const before = { ...params };
    expect(repairMotionParams(params, defaults)).toEqual([]);
    expect(params).toEqual(before);
  });

  it('fills a missing duration with the default of the chosen motion', () => {
    const params: Record<string, number | string> = { entry: 'typewriter', hold: 'float', exit: 'shrink' };
    expect(repairMotionParams(params, defaults)).toEqual([]);
    expect(params).toMatchObject({ typing_ms: 400, hold_ms: 1800, exit_ms: 150 });
  });

  it('clamps, resets and removes what is outside the tables, one code each', () => {
    const params: Record<string, number | string> = {
      entry: 'fade', entry_ms: 900, hold: 'shake', hold_ms: 'fast', exit: 'nope', exit_dir: 'up',
    };
    expect(repairMotionParams(params, defaults)).toEqual(['param_reset', 'param_reset', 'param_clamped', 'param_reset']);
    expect(params).toMatchObject({ entry: 'fade', entry_ms: 300, hold: 'shake', hold_ms: 120 });
    expect(params).not.toHaveProperty('exit');
    expect(params).not.toHaveProperty('exit_dir');
  });
});

describe('ai.video-editing: text motions a phone draws (card S4)', () => {
  it('reads the list a phone sent, and the legacy five for an absent or null list', () => {
    expect(textMotionsOf({ text_motions: ['fade'] })).toEqual(['fade']);
    expect(textMotionsOf({ text_motions: [] })).toEqual([]);
    expect(textMotionsOf({})).toEqual(LEGACY_TEXT_MOTIONS);
    expect(textMotionsOf({ text_motions: null })).toEqual(LEGACY_TEXT_MOTIONS);
    expect(textMotionsOf(undefined)).toEqual(LEGACY_TEXT_MOTIONS);
  });

  it('looks a hold and an exit up with their group prefix, and always draws the still hold', () => {
    const allowed = ['fade', 'hold_float', 'exit_shrink'];
    expect(motionUsable(allowed, 'entry', 'fade')).toBe(true);
    expect(motionUsable(allowed, 'exit', 'fade')).toBe(false);
    expect(motionUsable(allowed, 'hold', 'float')).toBe(true);
    expect(motionUsable(allowed, 'hold', 'pulse')).toBe(false);
    expect(motionUsable(allowed, 'exit', 'shrink')).toBe(true);
    expect(motionUsable([], 'hold', 'none')).toBe(true);
  });

  it('swaps what the phone does not draw: the entry for the effect own, a hold and an exit removed', () => {
    const defaults = { entry: 'pop', entry_ms: 200, exit_ms: 150 };
    const params: Record<string, number | string> = {
      ...defaults, entry: 'glitch', entry_ms: 180, hold: 'shake', hold_ms: 120, exit: 'slide_out', exit_dir: 'left',
    };
    expect(swapUnusableMotions(params, defaults, LEGACY_TEXT_MOTIONS)).toEqual(['motion_swapped', 'motion_swapped', 'motion_swapped']);
    expect(params).toEqual({ entry: 'pop', entry_ms: 200, exit_ms: 150 });
    expect(swapUnusableMotions(params, defaults, LEGACY_TEXT_MOTIONS)).toEqual([]);
  });
});
