// AI video editing (ai.video-editing): the text style chooser (card S4). The slide side follows the zone, the excited
// never fade, a phone that listed no motions gets only the legacy five, a look the phone did not list is never chosen,
// the tilt is signed, inside the look's range and the same for the same id, and every choice is a set of motion params the
// validator keeps as they are. Needs no database and no Nest.
import { EDIT_LEVELS, EditLevel, TextKind, ZONES, ZoneId } from '../contract/edit.contract';
import { LEGACY_TEXT_MOTIONS, repairMotionParams, swapUnusableMotions, textMotionsOf } from '../contract/edit.motions';
import { effectById } from '../contract/edit.registry';
import { TEXT_FEATURES, TEXT_LOOKS, lookUsable, requiredFeatures, textLookById } from '../contract/edit.styles';
import { MOODS } from './edit.perception';
import { TextStyle, chooseTextStyle, textEnergy, textStyleCandidates, tiltFromId } from './edit.textstyle';
import {
  FULL_CAPABILITIES,
  GATED_LOOKS,
  GATED_LOOK_FEATURE,
  GATED_LOOK_ID,
  LEGACY_CAPABILITIES,
} from './fixtures/edit.golden.fixtures';

// The looks released before card S8 and the ten of card S8.
const SHIPPED_IDS = ['sticker', 'label_pill', '3d', 'glow', 'gradient', 'highlighter'];
const NEW_IDS = TEXT_LOOKS.map((look) => look.id).filter((id) => !SHIPPED_IDS.includes(id));

const ZONE_IDS = Object.keys(ZONES) as ZoneId[];
const KINDS: TextKind[] = ['hook', 'keyword_echo'];
const MOOD_LIST = [undefined, ...Object.keys(MOODS)];

// Every style the chooser can answer at one level: each mood, kind, zone, pair position and motion count.
const everyStyle = (caps: Parameters<typeof chooseTextStyle>[5], levels: EditLevel[] = EDIT_LEVELS) => {
  const out: { level: EditLevel; mood?: string; kind: TextKind; zone: ZoneId; style: TextStyle }[] = [];
  for (const level of levels) {
    for (const mood of MOOD_LIST) {
      for (const kind of KINDS) {
        for (const zone of ZONE_IDS) {
          for (let pair = 0; pair < 8; pair++) {
            for (let motion = 0; motion < 12; motion++) {
              const style = chooseTextStyle(kind, mood, zone, { pair, motion }, level, caps);
              if (style) out.push({ level, mood, kind, zone, style });
            }
          }
        }
      }
    }
  }
  return out;
};

describe('ai.video-editing: chooseTextStyle, mood to energy', () => {
  it('makes a hook and the excited lively, the calm and serious quiet, and the rest in between', () => {
    expect(textEnergy('hook', 'calm')).toEqual(['high', 'hook']);
    expect(textEnergy('keyword_echo', 'excited')).toEqual(['high', 'mood']);
    expect(textEnergy('keyword_echo', 'surprising')[0]).toBe('high');
    expect(textEnergy('keyword_echo', 'calm')).toEqual(['low', 'mood']);
    expect(textEnergy('keyword_echo', 'serious')[0]).toBe('low');
    expect(textEnergy('keyword_echo', 'funny')[0]).toBe('mid');
    expect(textEnergy('keyword_echo', undefined)).toEqual(['mid', 'default']);
    expect(textEnergy('keyword_echo', 'constructor')).toEqual(['mid', 'default']);
  });

  it('never gives an excited text or a hook a fade, in or out', () => {
    for (const { kind, mood, style } of everyStyle(FULL_CAPABILITIES)) {
      if (kind !== 'hook' && mood !== 'excited' && mood !== 'surprising') continue;
      expect(style.entry).not.toBe('fade');
      expect(style.exit).not.toBe('fade');
      expect(style.params.entry).not.toBe('fade');
      expect(style.params.exit).not.toBe('fade');
    }
  });

  it('gives the calm and serious fades, typewriter and slides, never a pop or a stamp of their own', () => {
    const entries = new Set<string>();
    for (const { kind, mood, style } of everyStyle(FULL_CAPABILITIES, ['heavy'])) {
      if (kind === 'hook' || (mood !== 'calm' && mood !== 'serious')) continue;
      // a fixed effect (the marker sweep) keeps its own entry; every other one follows the energy
      if (style.why.entry === 'fixed') continue;
      entries.add(style.entry);
    }
    expect([...entries].sort()).toEqual(
      ['blur_in', 'fade', 'slide_bottom', 'slide_left', 'slide_right', 'slide_top', 'typewriter', 'wipe'].sort()
    );
  });

  it('leaves out the stamp for a calm text and keeps it for a lively one', () => {
    const calm = textStyleCandidates('keyword_echo', 'calm', 'standard', FULL_CAPABILITIES).map((c) => c.effect);
    const lively = textStyleCandidates('keyword_echo', 'excited', 'standard', FULL_CAPABILITIES).map((c) => c.effect);
    expect(calm).not.toContain('x_stamp');
    expect(lively).toContain('x_stamp');
  });

  it('keeps the entry of a fixed effect and the sweep of the highlighter', () => {
    const stamp = everyStyle(FULL_CAPABILITIES).filter((c) => c.style.effect === 'x_stamp');
    const sweep = everyStyle(FULL_CAPABILITIES).filter((c) => c.style.effect === 'x_marker_sweep');
    expect(stamp.length).toBeGreaterThan(0);
    expect(sweep.length).toBeGreaterThan(0);
    for (const { style } of stamp) expect(style.entry).toBe('stamp');
    for (const { style } of sweep) expect(style.entry).toBe('sweep');
  });

  it('rotates the entry, hold and exit by the motion count, so a look is not always seen with one motion', () => {
    const entries = new Set<string>();
    const holds = new Set<string>();
    const exits = new Set<string>();
    for (let motion = 0; motion < 12; motion++) {
      const style = chooseTextStyle('keyword_echo', 'calm', 'upper_center', { pair: 0, motion }, 'heavy', FULL_CAPABILITIES)!;
      entries.add(style.entry);
      holds.add(style.hold);
      exits.add(style.exit);
    }
    expect(entries.size).toBeGreaterThanOrEqual(4);
    expect(holds.size).toBeGreaterThanOrEqual(2);
    expect(exits.size).toBeGreaterThanOrEqual(2);
  });
});

describe('ai.video-editing: chooseTextStyle, the slide follows the zone', () => {
  const SIDE: Record<ZoneId, string> = {
    upper_left: 'left',
    upper_center: 'top',
    upper_right: 'right',
    middle_center: 'bottom',
    lower_center: 'bottom',
  };

  it.each(ZONE_IDS)('comes in and goes out on the side of %s', (zone) => {
    // calm, first effect (not fixed): the entries rotate fade, slide, ...; the exits fade, slide_out
    const style = chooseTextStyle('keyword_echo', 'calm', zone, { pair: 0, motion: 1 }, 'heavy', FULL_CAPABILITIES)!;
    expect(style.entry).toBe(`slide_${SIDE[zone]}`);
    expect(style.params.entry).toBe(`slide_${SIDE[zone]}`);
    expect(style.exit).toBe('slide_out');
    expect(style.params.exit_dir).toBe(SIDE[zone]);
  });

  it('writes an exit direction only with a slide out', () => {
    for (const { style } of everyStyle(FULL_CAPABILITIES, ['heavy'])) {
      if (style.exit !== 'slide_out') expect(style.params).not.toHaveProperty('exit_dir');
    }
  });
});

describe('ai.video-editing: chooseTextStyle, what the phone listed', () => {
  it('gives a phone that listed no motions (absent or null) only the legacy five, no hold and no exit', () => {
    for (const caps of [LEGACY_CAPABILITIES, { ...LEGACY_CAPABILITIES, text_motions: null }]) {
      expect(textMotionsOf(caps)).toEqual(LEGACY_TEXT_MOTIONS);
      for (const { style } of everyStyle(caps)) {
        expect(LEGACY_TEXT_MOTIONS).toContain(style.entry);
        expect(style.hold).toBe('none');
        expect(style.exit).toBe('none');
        expect(style.params).not.toHaveProperty('hold');
        expect(style.params).not.toHaveProperty('exit');
        if (style.params.entry !== undefined) expect(LEGACY_TEXT_MOTIONS).toContain(style.params.entry);
      }
    }
  });

  it('plans with no capabilities at all as with the legacy list', () => {
    for (const { style } of everyStyle(undefined)) expect(LEGACY_TEXT_MOTIONS).toContain(style.entry);
  });

  it('keeps the effect own entry of a text with no mood on a phone that listed no motions', () => {
    for (let pair = 0; pair < 8; pair++) {
      const style = chooseTextStyle('keyword_echo', undefined, 'upper_center', { pair, motion: 3 }, 'heavy', LEGACY_CAPABILITIES)!;
      expect(style.params).toEqual({});
      expect(style.entry).toBe(effectById(style.effect)!.default_params.entry);
    }
  });

  it('uses only the motions listed, with the hold and exit prefixed by their group', () => {
    const caps = { ...FULL_CAPABILITIES, text_motions: ['pop', 'fade', 'hold_pulse', 'exit_shrink'] };
    for (const { style } of everyStyle(caps)) {
      expect(['pop', 'fade']).toContain(style.entry);
      expect(['none', 'pulse']).toContain(style.hold);
      expect(['none', 'shrink']).toContain(style.exit);
      if (style.params.entry !== undefined) expect(['pop', 'fade']).toContain(style.params.entry);
    }
    // an exit listed by its plain name does not count: `fade` is an entry here
    const exits = everyStyle({ ...FULL_CAPABILITIES, text_motions: ['fade'] }).map((c) => c.style.exit);
    expect(new Set(exits)).toEqual(new Set(['none']));
  });

  it('never chooses a look the phone did not list', () => {
    for (const listed of [['sticker'], ['glow', 'gradient'], ['label_pill', '3d', 'highlighter']]) {
      const caps = { ...FULL_CAPABILITIES, text_styles: listed };
      for (const { style } of everyStyle(caps)) expect(listed).toContain(style.look);
    }
    expect(chooseTextStyle('hook', undefined, 'upper_center', { pair: 0, motion: 0 }, 'heavy', { ...FULL_CAPABILITIES, text_styles: [] })).toBeNull();
    expect(textStyleCandidates('hook', undefined, 'heavy', { ...FULL_CAPABILITIES, text_styles: [] })).toEqual([]);
  });

  it('never chooses an effect the phone or the level does not allow', () => {
    const caps = { ...FULL_CAPABILITIES, effects: ['x_sticker', 'x_3d', 'x_gradient'] };
    for (const { level, style } of everyStyle(caps)) {
      expect(caps.effects).toContain(style.effect);
      expect(EDIT_LEVELS.indexOf(effectById(style.effect)!.min_level)).toBeLessThanOrEqual(EDIT_LEVELS.indexOf(level));
    }
    expect(textStyleCandidates('hook', undefined, 'basic', { ...FULL_CAPABILITIES, effects: ['c_word_highlight'] })).toEqual([]);
  });

  it('leaves out a fixed effect whose entry the phone does not draw', () => {
    const caps = { ...FULL_CAPABILITIES, text_motions: ['pop', 'sweep'] };
    const effects = textStyleCandidates('hook', undefined, 'heavy', caps).map((c) => c.effect);
    expect(effects).toContain('x_marker_sweep');
    expect(effects).not.toContain('x_stamp');
  });
});

describe('ai.video-editing: chooseTextStyle, the same input gives the same style', () => {
  it('answers the same style for the same input and wraps a cursor past the candidates', () => {
    const a = chooseTextStyle('hook', 'excited', 'upper_left', { pair: 3, motion: 5 }, 'heavy', FULL_CAPABILITIES);
    const b = chooseTextStyle('hook', 'excited', 'upper_left', { pair: 3, motion: 5 }, 'heavy', FULL_CAPABILITIES);
    expect(a).toEqual(b);
    const n = textStyleCandidates('hook', 'excited', 'heavy', FULL_CAPABILITIES).length;
    const wrapped = chooseTextStyle('hook', 'excited', 'upper_left', { pair: 3 + n, motion: 5 }, 'heavy', FULL_CAPABILITIES);
    expect(wrapped).toEqual(a);
    expect(a!.index).toBe(3);
  });

  it('keeps a reason code for every decision, codes only', () => {
    for (const { style } of everyStyle(FULL_CAPABILITIES, ['heavy'])) {
      expect(Object.keys(style.why).sort()).toEqual(['energy', 'energy_from', 'entry', 'exit', 'hold', 'side']);
      for (const value of Object.values(style.why)) expect(value).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('ai.video-editing: chooseTextStyle, motion params the validator keeps', () => {
  it('lays only params inside the motion tables, so repairing them changes nothing', () => {
    for (const caps of [FULL_CAPABILITIES, LEGACY_CAPABILITIES]) {
      const allowed = textMotionsOf(caps);
      for (const { style } of everyStyle(caps)) {
        const defaults = effectById(style.effect)!.default_params;
        const params = { ...defaults, ...style.params };
        const before = { ...params };
        expect(repairMotionParams(params, defaults)).toEqual([]);
        expect(swapUnusableMotions(params, defaults, allowed)).toEqual([]);
        expect(params).toEqual(before);
      }
    }
  });
});

describe('ai.video-editing: tilt', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `e${i + 1}`);

  it('is the same for the same id', () => {
    for (const id of ids) expect(tiltFromId(id, [-6, 6])).toBe(tiltFromId(id, [-6, 6]));
  });

  it('is signed, at least half the bound and inside the range of the look', () => {
    const tilts = ids.map((id) => tiltFromId(id, [-6, 6]));
    for (const t of tilts) {
      expect(Math.abs(t)).toBeGreaterThanOrEqual(3);
      expect(Math.abs(t)).toBeLessThanOrEqual(6);
    }
    expect(tilts.some((t) => t > 0)).toBe(true);
    expect(tilts.some((t) => t < 0)).toBe(true);
    expect(new Set(tilts).size).toBeGreaterThan(10);
  });

  it('stays on one side of a range that does not cross zero, and inside a narrow one', () => {
    for (const id of ids) {
      const t = tiltFromId(id, [3, 6]);
      expect(t).toBeGreaterThanOrEqual(3);
      expect(t).toBeLessThanOrEqual(6);
      const n = tiltFromId(id, [-2.55, -0.45]);
      expect(n).toBeGreaterThanOrEqual(-2.55);
      expect(n).toBeLessThanOrEqual(-0.45);
    }
    expect(tiltFromId('e1', [4, 4])).toBe(4);
  });

  it('is offered by a look with a range only', () => {
    const sticker = chooseTextStyle('keyword_echo', undefined, 'upper_center', { pair: 0, motion: 0 }, 'basic', FULL_CAPABILITIES)!;
    expect(sticker.look).toBe('sticker');
    expect(sticker.tilt).toEqual(textLookById('sticker')!.tilt_deg);
    const pill = chooseTextStyle('keyword_echo', undefined, 'upper_center', { pair: 1, motion: 0 }, 'basic', FULL_CAPABILITIES)!;
    expect(pill.look).toBe('label_pill');
    expect(pill.tilt).toBeNull();
  });
});

describe('ai.video-editing: chooseTextStyle, the feature gate (card S9)', () => {
  const choose = (caps: Parameters<typeof chooseTextStyle>[5]) => {
    const out: string[] = [];
    for (const level of EDIT_LEVELS) {
      for (const kind of KINDS) {
        for (let pair = 0; pair < 8; pair++) {
          const style = chooseTextStyle(kind, undefined, 'upper_center', { pair, motion: 0 }, level, caps, GATED_LOOKS);
          if (style) out.push(style.look);
        }
      }
    }
    return out;
  };

  it('needs no feature for any shipped look, and one for the test look', () => {
    for (const look of TEXT_LOOKS.filter((entry) => SHIPPED_IDS.includes(entry.id))) expect(requiredFeatures(look)).toEqual([]);
    expect(requiredFeatures(GATED_LOOKS.find((l) => l.id === GATED_LOOK_ID)!)).toEqual([GATED_LOOK_FEATURE]);
  });

  it('never chooses a look whose feature is not listed, whether the list is absent, null or empty', () => {
    for (const features of [undefined, null, [], ['box_glow', 'opacity']]) {
      const looks = choose({ ...FULL_CAPABILITIES, text_features: features });
      expect(looks.length).toBeGreaterThan(0);
      expect(looks).not.toContain(GATED_LOOK_ID);
    }
  });

  it('chooses the look once every feature it needs is listed', () => {
    const looks = choose({ ...FULL_CAPABILITIES, text_features: [GATED_LOOK_FEATURE] });
    expect(looks).toContain(GATED_LOOK_ID);
  });

  it('still needs the look itself in text_styles when the feature is listed', () => {
    const text_styles = FULL_CAPABILITIES.text_styles.filter((id) => id !== GATED_LOOK_ID);
    expect(choose({ ...FULL_CAPABILITIES, text_styles, text_features: [GATED_LOOK_FEATURE] })).not.toContain(GATED_LOOK_ID);
  });

  it('answers no style, and no candidates, when the only look listed needs a missing feature', () => {
    const caps = { ...FULL_CAPABILITIES, text_styles: [GATED_LOOK_ID] };
    expect(chooseTextStyle('hook', undefined, 'upper_center', { pair: 0, motion: 0 }, 'heavy', caps, GATED_LOOKS)).toBeNull();
    expect(textStyleCandidates('hook', undefined, 'heavy', caps, GATED_LOOKS)).toEqual([]);
    expect(textStyleCandidates('hook', undefined, 'heavy', { ...caps, text_features: [GATED_LOOK_FEATURE] }, GATED_LOOKS).length).toBeGreaterThan(0);
  });

  it('keeps the shipped table as the default, where every shipped look is usable with no feature listed', () => {
    for (const look of TEXT_LOOKS.filter((entry) => SHIPPED_IDS.includes(entry.id))) {
      expect(lookUsable(look, FULL_CAPABILITIES)).toBe(true);
    }
    expect(lookUsable(undefined, FULL_CAPABILITIES)).toBe(false);
    expect(lookUsable(GATED_LOOKS.find((l) => l.id === GATED_LOOK_ID), FULL_CAPABILITIES)).toBe(false);
    // no capabilities at all means no gate
    expect(lookUsable(GATED_LOOKS.find((l) => l.id === GATED_LOOK_ID))).toBe(true);
  });
});

describe('ai.video-editing: chooseTextStyle, the ten new looks (card S8)', () => {
  // Every look the chooser can answer with for a phone at the three levels, both kinds, every mood, over 20 positions.
  const looksOf = (caps: Parameters<typeof chooseTextStyle>[5]) => {
    const out = new Set<string>();
    for (const level of EDIT_LEVELS) {
      for (const kind of KINDS) {
        for (const mood of MOOD_LIST) {
          for (let pair = 0; pair < 20; pair++) {
            const style = chooseTextStyle(kind, mood, 'upper_center', { pair, motion: 0 }, level, caps);
            if (style) out.add(style.look);
          }
        }
      }
    }
    return out;
  };

  it('plans a phone that lists none of them, or none of their features, exactly as before', () => {
    for (const caps of [FULL_CAPABILITIES, LEGACY_CAPABILITIES, { ...FULL_CAPABILITIES, text_features: ['opacity'] }]) {
      const before = { ...caps, text_styles: SHIPPED_IDS };
      for (const level of EDIT_LEVELS) {
        for (const kind of KINDS) {
          for (const mood of MOOD_LIST) {
            expect(textStyleCandidates(kind, mood, level, caps)).toEqual(textStyleCandidates(kind, mood, level, before));
            for (let pair = 0; pair < 20; pair++) {
              const cursor = { pair, motion: pair % 5 };
              expect(chooseTextStyle(kind, mood, 'upper_left', cursor, level, caps)).toEqual(
                chooseTextStyle(kind, mood, 'upper_left', cursor, level, before)
              );
            }
          }
        }
      }
    }
    expect([...looksOf(FULL_CAPABILITIES)].sort()).toEqual([...SHIPPED_IDS].sort());
  });

  it('plans a request with no capabilities at all with the looks of the legacy format only', () => {
    expect([...looksOf(undefined)].sort()).toEqual([...SHIPPED_IDS].sort());
  });

  it('chooses each of them once the phone lists the look and every feature it needs: two at basic, six at standard, all at heavy', () => {
    const all = { ...FULL_CAPABILITIES, text_features: TEXT_FEATURES };
    expect([...looksOf(all)].sort()).toEqual(TEXT_LOOKS.map((look) => look.id).sort());
    const newAt = (level: EditLevel) =>
      textStyleCandidates('hook', undefined, level, all).map((pair) => pair.look).filter((id) => NEW_IDS.includes(id));
    expect(newAt('basic')).toEqual(['pill_ring', 'solid_round']);
    expect(newAt('standard')).toEqual(['neon_box', 'pill_ring', 'tilt_sticker', 'solid_round', 'yellow_bold', 'flat_rect']);
    expect(newAt('heavy')).toEqual(NEW_IDS);
  });

  it.each(NEW_IDS)('chooses %s only with its own features and its own id listed', (id) => {
    const look = textLookById(id)!;
    const features = requiredFeatures(look);
    expect(features.length).toBeGreaterThan(0);
    const listed = { ...FULL_CAPABILITIES, text_styles: [id], text_features: features };
    expect([...looksOf(listed)]).toEqual([id]);
    for (const missing of features) {
      const caps = { ...listed, text_features: features.filter((feature) => feature !== missing) };
      expect(looksOf(caps).size).toBe(0);
      expect(textStyleCandidates('hook', undefined, 'heavy', caps)).toEqual([]);
    }
    expect(looksOf({ ...listed, text_styles: SHIPPED_IDS }).has(id)).toBe(false);
  });

  it('writes the neon flicker hold for the neon box and the shimmer for the gradient block, as for their shipped kin', () => {
    const caps = { ...FULL_CAPABILITIES, text_features: TEXT_FEATURES };
    const holds = new Map<string, Set<string>>();
    for (let pair = 0; pair < 20; pair++) {
      for (let motion = 0; motion < 6; motion++) {
        const style = chooseTextStyle('keyword_echo', 'funny', 'upper_center', { pair, motion }, 'heavy', caps)!;
        holds.set(style.look, (holds.get(style.look) ?? new Set()).add(style.hold));
      }
    }
    expect(holds.get('neon_box')?.has('neon_flicker')).toBe(true);
    expect(holds.get('gradient_block')?.has('shimmer')).toBe(true);
    expect(holds.get('pill_ring')?.has('neon_flicker')).toBe(false);
  });

  it('hands the tilted sticker its negative range, and tilts only that one of the new looks', () => {
    const caps = { ...FULL_CAPABILITIES, text_features: TEXT_FEATURES };
    for (const id of NEW_IDS) {
      const style = chooseTextStyle('hook', undefined, 'upper_center', { pair: 0, motion: 0 }, 'heavy', { ...caps, text_styles: [id] })!;
      expect(style.tilt).toEqual(id === 'tilt_sticker' ? [-7, -5] : null);
    }
    for (const item of ['a1', 'b2', 'c3', 'd4', 'e5']) {
      const tilt = tiltFromId(item, [-7, -5]);
      expect(tilt).toBeGreaterThanOrEqual(-7);
      expect(tilt).toBeLessThanOrEqual(-5);
    }
  });

  it('pairs a look only with an effect that binds no other look, or the one it binds (the validator puts a bound look back)', () => {
    const caps = { ...FULL_CAPABILITIES, text_features: TEXT_FEATURES };
    for (const level of EDIT_LEVELS) {
      for (const { effect, look } of textStyleCandidates('hook', undefined, level, caps)) {
        const bound = effectById(effect)!.default_params.style_preset;
        if (typeof bound === 'string') expect(bound).toBe(look);
      }
    }
  });

  it('pairs every look with an effect of its level and never one the phone lacks', () => {
    const caps = { ...FULL_CAPABILITIES, text_features: TEXT_FEATURES, effects: ['x_pop', 'x_label_tag'] };
    for (const level of EDIT_LEVELS) {
      for (const { effect, look } of textStyleCandidates('hook', undefined, level, caps)) {
        expect(caps.effects).toContain(effect);
        expect(TEXT_LOOKS.map((entry) => entry.id)).toContain(look);
        expect(EDIT_LEVELS.indexOf(effectById(effect)!.min_level)).toBeLessThanOrEqual(EDIT_LEVELS.indexOf(level));
      }
    }
  });
});
