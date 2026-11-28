// AI video editing (ai.video-editing): the assembler (spec section 11, step 7) on hand-built slots in one long free
// window, so every expected time and effect is computed by hand. Needs no database and no Nest.
import { EditLevel, EditStyle, EditWord, MomentLabel, PlanItem } from '../contract/edit.contract';
import { LEGACY_TEXT_MOTIONS } from '../contract/edit.motions';
import { EFFECTS, effectById } from '../contract/edit.registry';
import { TEXT_FEATURES, textLookById } from '../contract/edit.styles';
import { AssembleInput, assemble, momentOnly } from './edit.assembler';
import { Direction, Moment } from './edit.moments';
import { Slot } from './edit.slots';
import { tiltFromId } from './edit.textstyle';
import {
  ALL_OUTPUTS,
  FULL_CAPABILITIES,
  GATED_LOOKS,
  GATED_LOOK_FEATURE,
  GATED_LOOK_ID,
  LEGACY_CAPABILITIES,
} from './fixtures/edit.golden.fixtures';

// 50 words, one every 400 ms, each 300 ms long: word i starts at 100 + 400 i.
const WORDS: EditWord[] = Array.from({ length: 50 }, (_, i) => ({
  i,
  w: `word${i}`,
  start_ms: 100 + 400 * i,
  end_ms: 400 + 400 * i,
}));
const WINDOWS = [{ start_ms: 0, end_ms: 20000 }];
// The 9:16 output with no caption band, so the video shows no captions and keyword echoes are allowed (TS9c); the
// specs with captions on use `ALL_OUTPUTS` and say so.
const OUT916 = [{ ratio: ALL_OUTPUTS[0].ratio, crop: ALL_OUTPUTS[0].crop }];

// A slot on word `wi` of the window.
const slot = (id: string, wi: number, score: number, keyword: string, hook = false): Slot => ({
  id,
  word_index: wi,
  start_ms: WORDS[wi].start_ms,
  end_ms: WORDS[wi].end_ms,
  window: 0,
  reasons: hook ? ['hook'] : ['long_word'],
  score,
  keyword,
});

// The hook on word 2 (900 ms) and three slots at 4900, 10100 and 15300 ms, best score first.
const SLOTS = [
  slot('h1', 2, 0, 'alpha', true),
  slot('s1', 12, 3, 'beta'),
  slot('s2', 25, 2, 'gamma'),
  slot('s3', 38, 1, 'delta'),
];

const input = (level: EditLevel, extra: Partial<AssembleInput> = {}): AssembleInput => ({
  level,
  words: WORDS,
  windows: WINDOWS,
  slots: SLOTS,
  outputs: OUT916,
  facecam: [],
  durationMs: 20000,
  ...extra,
});

const features = (items: PlanItem[]) =>
  items.filter((i) => i.layer !== 'transition' && i.layer !== 'caption');

describe('ai.video-editing: assemble, Basic', () => {
  const { items, captions } = assemble(input('basic'));

  // a request with no capabilities gets the looks of the legacy format only, and every text look has a background
  // (TS13): at Basic that is the label pill alone (the sticker is drawn as `tilt_sticker`, which needs features)
  it('plans a hook, a keyword echo and a punch in, spread over the video', () => {
    expect(
      items.map((i) => [i.id, i.effect, i.start_ms, i.end_ms, i.anchor])
    ).toEqual([
      ['e1', 'x_label_tag', 820, 1620, { word_index: 2, offset_ms: -80 }],
      ['e2', 'x_label_tag', 4820, 5620, { word_index: 12, offset_ms: -80 }],
      ['e3', 'v_punch_in', 10100, 10350, { word_index: 25, offset_ms: 0 }],
    ]);
  });

  it('writes the hook and the echo as Title Case keywords in the looks of Basic, colours rotating', () => {
    expect(items[0].component).toEqual({
      type: 'styled_text',
      kind: 'hook',
      text: 'Alpha',
      style_preset: 'label_pill',
      color_slot: 0,
    });
    expect(items[1].component).toMatchObject({
      kind: 'keyword_echo',
      text: 'Beta',
      style_preset: 'label_pill',
      color_slot: 1,
    });
    expect(items[0].position.zone).toBe('upper_center');
    expect(items[1].position.zone).toBe('upper_left');
  });

  it('uses no sound, no transition and no icon, and keeps to the budget of 3', () => {
    expect(items.every((i) => !i.sound)).toBe(true);
    expect(features(items)).toHaveLength(3);
    expect(items.some((i) => i.layer === 'transition' || i.layer === 'icon')).toBe(false);
  });

  it('emphasises the anchored words and enough more to keep a change every 2.5 s', () => {
    expect(captions.effect).toBe('c_word_highlight');
    expect(captions.emphasis_words).toEqual(expect.arrayContaining([2, 12, 25]));
    const starts = Array.from(
      new Set([0, 20000, ...items.map((i) => i.start_ms), ...captions.emphasis_words.map((w) => WORDS[w].start_ms)])
    ).sort((a, b) => a - b);
    for (let k = 0; k + 1 < starts.length; k++) {
      expect(starts[k + 1] - starts[k]).toBeLessThanOrEqual(3000);
    }
  });

  it('answers the same plan every time', () => {
    expect(assemble(input('basic'))).toEqual(assemble(input('basic')));
  });
});

describe('ai.video-editing: assemble, Standard and Heavy', () => {
  it('pairs each item with a sound of its own effect, rotating, and none when sounds are off', () => {
    const { items } = assemble(input('standard'));
    expect(items[0].sound).toEqual({ id: 'pop_1', offset_ms: 0 });
    for (const item of items) {
      expect(effectById(item.effect).sound).toContain(item.sound.id);
    }
    const quiet = assemble(input('standard', { soundEffects: false }));
    expect(quiet.items.every((i) => !i.sound)).toBe(true);
  });

  it('puts a transition on cut points a few seconds apart, flash then whip', () => {
    const { items } = assemble(input('standard', { cutPoints: [6000, 6500, 12000] }));
    expect(
      items.filter((i) => i.layer === 'transition').map((i) => [i.effect, i.start_ms, i.end_ms])
    ).toEqual([
      ['tr_flash_cut', 5895, 6105],
      ['tr_whip', 11895, 12105],
    ]);
  });

  it('keeps Basic free of transitions even with cut points', () => {
    const { items } = assemble(input('basic', { cutPoints: [6000, 12000] }));
    expect(items.some((i) => i.layer === 'transition')).toBe(false);
  });

  it('cycles through the families of Standard: text, camera, look', () => {
    const { items } = assemble(input('standard'));
    expect(items.map((i) => i.layer)).toEqual(['text', 'text', 'video', 'video']);
    expect(items.map((i) => i.effect).slice(2)).toEqual(['v_punch_in', 'l_flash']);
  });

  it('never goes over the budget and never overlaps two overlays', () => {
    for (const level of ['basic', 'standard', 'heavy'] as EditLevel[]) {
      const { items } = assemble(input(level, { cutPoints: [3000, 9000, 14000] }));
      expect(features(items).length).toBeLessThanOrEqual(
        { basic: 3, standard: 6, heavy: 10 }[level]
      );
      const overlays = items.filter((i) => i.layer === 'text' || i.layer === 'icon');
      for (let k = 0; k + 1 < overlays.length; k++) {
        expect(overlays[k + 1].start_ms).toBeGreaterThanOrEqual(overlays[k].end_ms);
      }
    }
  });

  it('holds a text for 500 ms plus 150 ms a word at least, 2500 ms at most', () => {
    const { items } = assemble(
      input('heavy', { texts: { complementary: { s1: 'Save hours every week' } } })
    );
    const long = items.find((i) => i.component && i.component.type === 'styled_text' && i.component.kind === 'complementary');
    expect(long.end_ms - long.start_ms).toBeGreaterThanOrEqual(500 + 150 * 4);
    for (const item of items.filter((i) => i.layer === 'text')) {
      const n = (item.component as { text: string }).text.split(' ').length;
      expect(item.end_ms - item.start_ms).toBeGreaterThanOrEqual(500 + 150 * n);
      expect(item.end_ms - item.start_ms).toBeLessThanOrEqual(2500);
    }
  });
});

describe('ai.video-editing: assemble, perception scores and written texts', () => {
  const commentary = { s1: 'did_you_know', s2: 'did_you_know', s3: 'did_you_know' };
  const texts = (items: PlanItem[]) =>
    items
      .filter((i) => i.component && i.component.type === 'styled_text')
      .map((i) => (i.component as { kind: string; text: string }).kind + ':' + (i.component as { text: string }).text);

  it('writes a commentary phrase in the video language at Standard', () => {
    const en = assemble(input('standard', { language: 'eng', scores: { commentary } }));
    expect(texts(en.items)).toContain('commentary:Did you know?');
    const bn = assemble(input('standard', { language: 'ben', scores: { commentary } }));
    expect(texts(bn.items)).toContain('commentary:জানেন কি?');
  });

  it('falls back to the keyword when the language has no phrase or the level has no commentary', () => {
    expect(texts(assemble(input('standard', { scores: { commentary } })).items)).not.toContain('commentary:Did you know?');
    expect(texts(assemble(input('standard', { language: 'fra', scores: { commentary } })).items)).toContain('keyword_echo:Beta');
    expect(texts(assemble(input('basic', { language: 'eng', scores: { commentary } })).items)).toContain('keyword_echo:Beta');
  });

  it('uses a written complementary phrase only at Heavy, cut to 4 words', () => {
    const written = { complementary: { s1: 'Save hours every single week' } };
    expect(texts(assemble(input('heavy', { texts: written })).items)).toContain('complementary:Save hours every single');
    expect(texts(assemble(input('standard', { texts: written })).items)).toContain('keyword_echo:Beta');
  });

  it('uses the written hook title in place of the keyword', () => {
    const { items } = assemble(input('heavy', { texts: { hook: 'Save hours every week' } }));
    expect(texts(items)[0]).toBe('hook:Save hours every week');
  });

  it('skips a slot perception gave no family and follows the family it chose', () => {
    const skipped = assemble(input('standard', { scores: { family: { s1: 'none' } } }));
    expect(skipped.items.some((i) => i.anchor && i.anchor.word_index === 12)).toBe(false);
    const chosen = assemble(input('standard', { scores: { family: { s1: 'camera' } } }));
    const onS1 = chosen.items.find((i) => i.anchor && i.anchor.word_index === 12);
    expect(onS1.layer).toBe('video');
  });

  it('emphasises words perception stressed', () => {
    const { captions } = assemble(input('basic', { scores: { emphasis: { 7: 0.9, 8: 0.2 } } }));
    expect(captions.emphasis_words).toContain(7);
    expect(captions.emphasis_words).not.toContain(8);
  });
});

describe('ai.video-editing: assemble, icons, facecam and capabilities', () => {
  it('places an mp4 clip from the resolver, sped up to fit its slot', () => {
    const { items } = assemble(
      input('heavy', {
        scores: { family: { s2: 'icon' } },
        assets: { icons: { s2: { asset_id: 'ic1', kind: 'icon_video', native_duration_ms: 3000 } } },
      })
    );
    const icon = items.find((i) => i.layer === 'icon');
    expect(icon).toMatchObject({
      effect: 'i_scale_pop',
      start_ms: 10020,
      end_ms: 12520,
      position: { zone: 'upper_right' },
      component: {
        type: 'icon_video',
        asset_id: 'ic1',
        native_duration_ms: 3000,
        fit: { mode: 'speed_up', factor: 1.2 },
      },
    });
  });

  it('holds a clip for 2500 ms at most: a 3240 ms clip plays at 1.3, a 7000 ms clip fits, an 8000 ms clip is passed over', () => {
    const clip = (native: number) =>
      assemble(
        input('heavy', {
          scores: { family: { s2: 'icon' } },
          assets: { icons: { s2: { asset_id: 'ic1', kind: 'icon_video', native_duration_ms: native } } },
        })
      );
    const icon = (native: number) => clip(native).items.find((i) => i.layer === 'icon');
    expect(icon(3240)).toMatchObject({ end_ms: icon(3240).start_ms + 2500, component: { fit: { mode: 'speed_up', factor: 1.3 } } });
    expect(icon(7000)).toMatchObject({ end_ms: icon(7000).start_ms + 2500, component: { fit: { mode: 'speed_up', factor: 2.8 } } });
    expect(icon(8000)).toBeUndefined();
    expect(clip(8000).icon_misses).toEqual({ clip_too_long_for_slot: 1 });
  });

  it('never plans more icons than the level allows and passes over a clip that is too long', () => {
    const icons = {
      s1: { asset_id: 'a', kind: 'icon_image' as const },
      s2: { asset_id: 'b', kind: 'icon_image' as const },
      s3: { asset_id: 'c', kind: 'icon_image' as const },
    };
    const family = { s1: 'icon' as const, s2: 'icon' as const, s3: 'icon' as const };
    const { items } = assemble(input('standard', { scores: { family }, assets: { icons } }));
    expect(items.filter((i) => i.layer === 'icon')).toHaveLength(2);
    const tooLong = assemble(
      input('heavy', {
        scores: { family: { s2: 'icon' } },
        assets: { icons: { s2: { asset_id: 'x', kind: 'icon_video', native_duration_ms: 9000 } } },
      })
    );
    expect(tooLong.items.some((i) => i.layer === 'icon')).toBe(false);
  });

  // Five slots 2 s apart (words 12, 17, 22, 27 and 32), the best scored first, each with a resolved icon; the hook on word 2.
  const ROW = [12, 17, 22, 27, 32].map((wi, k) => slot(`s${k + 1}`, wi, 5 - k, `kw${k}`));
  const ROW_SLOTS = [slot('h1', 2, 0, 'alpha', true), ...ROW];
  const ROW_ICONS = Object.fromEntries(ROW.map((s) => [s.id, { asset_id: `ic${s.id}`, kind: 'icon_image' as const }]));

  it('gives a slot its resolved icon whatever the cycle turn, up to the icon budget and with the cooldown', () => {
    const { items } = assemble(input('heavy', { slots: ROW_SLOTS, assets: { icons: ROW_ICONS } }));
    const icons = items.filter((i) => i.layer === 'icon');
    // Heavy has 4 icons: the four best slots, whose cycle turns are text, camera, look and text
    expect(icons.map((i) => i.anchor?.word_index)).toEqual([12, 17, 22, 27]);
    expect(items.some((i) => i.layer === 'icon' && i.anchor?.word_index === 32)).toBe(false);
    for (const a of icons) {
      for (const b of icons.filter((o) => o !== a && o.effect === a.effect)) {
        expect(Math.abs(a.start_ms - b.start_ms)).toBeGreaterThanOrEqual(effectById(a.effect).cooldown_ms);
      }
    }
  });

  it('gives an icon turn of the cycle to the next family when the slot has no resolved icon, and notes no miss', () => {
    // no assets: the fifth slot of the cycle is an icon turn
    const { decisions, icon_misses } = assemble(input('heavy', { slots: ROW_SLOTS }));
    const fifth = decisions.find((d) => d.slot_id === 's5');
    expect(fifth.inputs.preferred).toBe('layout');
    expect(decisions.some((d) => d.inputs.preferred === 'icon')).toBe(false);
    expect(icon_misses).toEqual({});
  });

  it('keeps an overlay clear of the facecam by choosing another zone', () => {
    const facecam = [{ t_ms: 0, cx: 0.5, cy: 0.16, radius: 0.1 }];
    const { items } = assemble(input('basic', { facecam }));
    expect(items[0].effect).toBe('x_label_tag');
    expect(items[0].position.zone).toBe('middle_center');
  });

  it('keeps a text off the live ink and the slide title, and plans as before without keep-outs (TS9d)', () => {
    const baseline = assemble(input('basic'));
    expect(baseline.items[0].position.zone).toBe('upper_center');
    const region = { x: 0, y: 0, w: 1, h: 0.2 };
    const live = assemble(input('basic', { keepouts: [{ start_ms: 0, end_ms: 20000, region }] }));
    expect(live.items[0].effect).toBe('x_label_tag');
    expect(live.items[0].position.zone).toBe('middle_center');
    // the same zone once the ink is gone (it ends before the hook starts at 820 ms)
    const gone = assemble(input('basic', { keepouts: [{ start_ms: 0, end_ms: 800, region }] }));
    expect(gone.items).toEqual(baseline.items);
    // a region the crop does not show keeps nothing off
    const below = assemble(input('basic', { keepouts: [{ start_ms: 0, end_ms: 20000, region: { x: 0, y: 0.9, w: 1, h: 0.1 } }] }));
    expect(below.items).toEqual(baseline.items);
    expect(assemble(input('basic', { keepouts: [] })).items).toEqual(baseline.items);
  });

  it('plans nothing the phone cannot render, but still answers captions', () => {
    const { items, captions } = assemble(
      input('heavy', { capabilities: { effects: ['c_word_highlight', 't_jump_cut'], text_styles: [] } })
    );
    expect(items).toEqual([]);
    expect(captions.effect).toBe('c_word_highlight');
    const noStyles = assemble(
      input('basic', { capabilities: { effects: FULL_CAPABILITIES.effects, text_styles: [] } })
    );
    expect(noStyles.items.every((i) => i.layer !== 'text')).toBe(true);
  });

  it('plans no overlay when no zone fits, and the video effects still go in', () => {
    const wide = ALL_OUTPUTS[0];
    const covered = { ...wide, caption_band: { y0: 0, y1: 1 } };
    const { items } = assemble(input('basic', { outputs: [covered] }));
    expect(items.every((i) => i.layer !== 'text')).toBe(true);
    expect(items.some((i) => i.effect === 'v_punch_in')).toBe(true);
  });
});

describe('ai.video-editing: assemble, budgets per minute (task TS12)', () => {
  // A 3-minute video: 450 words, one every 400 ms, and a slot on every tenth word (every 4 s), the first one the hook,
  // each with a resolved icon, in one long free window.
  const LONG_MS = 180000;
  const LONG_WORDS: EditWord[] = Array.from({ length: 450 }, (_, i) => ({
    i,
    w: `word${i}`,
    start_ms: 100 + 400 * i,
    end_ms: 400 + 400 * i,
  }));
  const longSlots: Slot[] = Array.from({ length: 44 }, (_, k) => {
    const wi = 2 + 10 * k;
    return {
      id: k === 0 ? 'h1' : `s${k}`,
      word_index: wi,
      start_ms: LONG_WORDS[wi].start_ms,
      end_ms: LONG_WORDS[wi].end_ms,
      window: 0,
      reasons: k === 0 ? ['hook'] : ['long_word'],
      score: k === 0 ? 0 : 3 - (k % 3),
      keyword: `topic${k}`,
    };
  });
  const icons = Object.fromEntries(
    longSlots.map((sl) => [sl.id, { asset_id: `ic${sl.id}`, kind: 'icon_image' as const }])
  );
  const longInput = (extra: Partial<AssembleInput> = {}): AssembleInput => ({
    level: 'heavy',
    words: LONG_WORDS,
    windows: [{ start_ms: 0, end_ms: LONG_MS }],
    slots: longSlots,
    outputs: OUT916,
    facecam: [],
    durationMs: LONG_MS,
    assets: { icons },
    ...extra,
  });

  it('plans more than the floor of 10 features and 4 icons in a 3-minute Heavy video, within 30 and 12', () => {
    const { items } = assemble(longInput());
    expect(features(items).length).toBeGreaterThan(10);
    expect(features(items).length).toBeLessThanOrEqual(30);
    const placed = items.filter((i) => i.layer === 'icon');
    expect(placed.length).toBeGreaterThan(4);
    expect(placed.length).toBeLessThanOrEqual(12);
  });

  it('plans no icon at Basic whatever the length, and keeps to 9 features in 3 minutes', () => {
    const { items } = assemble(longInput({ level: 'basic' }));
    expect(items.some((i) => i.layer === 'icon')).toBe(false);
    expect(features(items).length).toBeLessThanOrEqual(9);
  });

  it('keeps the same 10 features and 4 icons as before for a video of up to a minute', () => {
    const { items } = assemble(
      longInput({
        words: LONG_WORDS.slice(0, 150),
        windows: [{ start_ms: 0, end_ms: 60000 }],
        slots: longSlots.filter((sl) => sl.end_ms < 60000),
        durationMs: 60000,
      })
    );
    expect(features(items).length).toBeLessThanOrEqual(10);
    expect(items.filter((i) => i.layer === 'icon').length).toBeLessThanOrEqual(4);
  });
});

describe('ai.video-editing: assemble, text style (card S4)', () => {
  const texts = (items: PlanItem[]) => items.filter((i) => i.layer === 'text');
  const kindOf = (i: PlanItem) => (i.component as { kind: string }).kind;
  const written = { hook: 'Save hours every week', complementary: { s1: 'Save two hours', s2: 'Done in minutes', s3: 'Try it today' } };

  it('keeps the effect own motion and params of a text with no mood, adding only the tilt of a tilting look', () => {
    for (const level of ['basic', 'standard', 'heavy'] as EditLevel[]) {
      const { items } = assemble(input(level, { texts: written }));
      for (const item of texts(items).filter((i) => kindOf(i) !== 'hook')) {
        const own = effectById(item.effect).default_params;
        const { tilt_deg, ...rest } = item.params;
        expect(rest).toEqual(own);
        const range = textLookById((item.component as { style_preset: string }).style_preset).tilt_deg;
        if (range) expect(tilt_deg).toBe(tiltFromId(item.id, range));
        else expect(tilt_deg).toBeUndefined();
      }
    }
  });

  it('writes a signed tilt from the item id inside the look range, the same on every run', () => {
    // the sticker is drawn as `tilt_sticker` (TS13), a look that needs features, whose range is -7 to -5 degrees
    const capabilities = { ...FULL_CAPABILITIES, text_features: TEXT_FEATURES };
    const run = () => texts(assemble(input('heavy', { capabilities, texts: written })).items);
    const stickers = run().filter((i) => (i.component as { style_preset: string }).style_preset === 'tilt_sticker');
    expect(stickers.length).toBeGreaterThan(0);
    for (const item of stickers) {
      expect(Math.abs(item.params.tilt_deg as number)).toBeGreaterThanOrEqual(5);
      expect(Math.abs(item.params.tilt_deg as number)).toBeLessThanOrEqual(7);
      expect(item.params.tilt_deg).toBe(tiltFromId(item.id, [-7, -5]));
    }
    expect(run().map((i) => i.params)).toEqual(run().map((i) => i.params));
  });

  it('gives a phone that listed no motions only the legacy five, with no hold and no exit, whatever the mood', () => {
    for (const mood of [undefined, 'excited', 'calm', 'serious']) {
      for (const level of ['standard', 'heavy'] as EditLevel[]) {
        const { items } = assemble(input(level, { capabilities: LEGACY_CAPABILITIES, scores: { mood }, texts: written }));
        expect(texts(items).length).toBeGreaterThan(0);
        for (const item of texts(items)) {
          expect(LEGACY_TEXT_MOTIONS).toContain(item.params.entry);
          expect(item.params).not.toHaveProperty('hold');
          expect(item.params).not.toHaveProperty('exit');
        }
      }
    }
  });

  it('never gives an excited text a fade, in or out, and a hook always the lively motions', () => {
    const { items } = assemble(input('heavy', { capabilities: FULL_CAPABILITIES, scores: { mood: 'excited' }, texts: written }));
    expect(texts(items).length).toBeGreaterThan(1);
    for (const item of texts(items)) {
      expect(item.params.entry).not.toBe('fade');
      expect(item.params.exit).not.toBe('fade');
    }
    const calm = assemble(input('heavy', { capabilities: FULL_CAPABILITIES, scores: { mood: 'calm' }, texts: written })).items;
    for (const item of texts(calm).filter((i) => kindOf(i) !== 'hook')) {
      expect(['pop', 'stamp']).not.toContain(item.params.entry);
    }
  });

  it('slides in from the side of the zone the text was placed in', () => {
    const sides: Record<string, string> = { upper_left: 'left', upper_center: 'top', upper_right: 'right', middle_center: 'bottom', lower_center: 'bottom' };
    const { items } = assemble(input('heavy', { capabilities: FULL_CAPABILITIES, scores: { mood: 'calm' }, texts: written }));
    const slides = texts(items).filter((i) => String(i.params.entry).startsWith('slide_'));
    for (const item of slides) expect(item.params.entry).toBe(`slide_${sides[item.position.zone]}`);
    for (const item of texts(items).filter((i) => i.params.exit === 'slide_out')) {
      expect(item.params.exit_dir).toBe(sides[item.position.zone]);
    }
  });

  it('plans no look the phone did not list', () => {
    const caps = { ...FULL_CAPABILITIES, text_styles: ['label_pill'] };
    const { items } = assemble(input('heavy', { capabilities: caps, texts: written }));
    expect(texts(items).length).toBeGreaterThan(0);
    for (const item of texts(items)) expect((item.component as { style_preset: string }).style_preset).toBe('label_pill');
  });

  it('plans no look needing a feature the phone did not list (card S9), and the other looks carry the texts', () => {
    const looksOf = (caps: typeof FULL_CAPABILITIES & { text_features?: string[] | null }) =>
      texts(assemble(input('heavy', { capabilities: caps, looks: GATED_LOOKS, texts: written })).items).map(
        (i) => (i.component as { style_preset: string }).style_preset
      );
    for (const features of [undefined, null, [], ['opacity']]) {
      const looks = looksOf({ ...FULL_CAPABILITIES, text_features: features });
      expect(looks.length).toBeGreaterThan(0);
      expect(looks).not.toContain(GATED_LOOK_ID);
    }
    expect(looksOf({ ...FULL_CAPABILITIES, text_features: [GATED_LOOK_FEATURE] })).toContain(GATED_LOOK_ID);
  });

  it('plans no text at all when every look listed needs a missing feature', () => {
    const caps = { ...FULL_CAPABILITIES, text_styles: [GATED_LOOK_ID] };
    const { items, decisions } = assemble(input('heavy', { capabilities: caps, looks: GATED_LOOKS, texts: written }));
    expect(texts(items)).toEqual([]);
    // the hook slot found no look to draw its text with, so it carries no hook, and every slot still has a reason code
    expect(decisions.find((d) => d.slot_id === 'h1')?.reason_code).not.toBe('hook');
    for (const d of decisions) expect(typeof d.reason_code).toBe('string');
  });

  it('plans a new look (card S8) only for a phone that lists it with its features, and then in its own box size', () => {
    const looksOf = (caps: object, extra: Partial<AssembleInput> = {}) =>
      texts(assemble(input('heavy', { capabilities: caps as AssembleInput['capabilities'], texts: written, ...extra })).items).map(
        (i) => (i.component as { style_preset: string }).style_preset
      );
    const shipped = ['sticker', 'label_pill', '3d', 'glow', 'gradient', 'highlighter'];
    // no features listed: the new looks are never planned, with every look id listed or with no capabilities at all
    for (const caps of [FULL_CAPABILITIES, LEGACY_CAPABILITIES, undefined]) {
      for (const look of looksOf(caps as object)) expect(shipped).toContain(look);
    }
    const all = { ...FULL_CAPABILITIES, text_features: TEXT_FEATURES };
    const planned = looksOf(all);
    expect(planned.some((look) => !shipped.includes(look))).toBe(true);
    for (const look of planned) expect(textLookById(look)).toBeDefined();
  });

  it('skips a look whose box no longer fits the text in the zone (card S8) and tries the next option', () => {
    // 28 graphemes in 2 words: the longest text a plain look holds, so a box with a glow and padding (neon_box) cannot
    const long = 'ABCDEFGHIJKLM NOPQRSTUVWXYZA';
    const plannedTexts = (caps: object) =>
      texts(assemble(input('heavy', { capabilities: caps as AssembleInput['capabilities'], texts: { hook: long } })).items).map(
        (i) => (i.component as { text: string }).text
      );
    const neon = { ...FULL_CAPABILITIES, text_styles: ['neon_box'], text_features: TEXT_FEATURES };
    expect(plannedTexts(neon)).not.toContain(long);
    expect(plannedTexts(neon)).toContain('Alpha');
    const plain = { ...neon, text_styles: ['solid_round'] };
    expect(plannedTexts(plain)).toContain(long);
  });

  it('records the style of a kept text in its decision, as codes and ids only', () => {
    const { items, decisions } = assemble(input('heavy', { capabilities: FULL_CAPABILITIES, scores: { mood: 'calm' }, texts: written }));
    const kept = decisions.filter((d) => d.decision === 'kept' && d.inputs.text_style);
    expect(kept.length).toBeGreaterThan(0);
    for (const d of kept) {
      const item = items.find((i) => i.id === d.inputs.item_id);
      const style = d.inputs.text_style as Record<string, string>;
      expect(style.entry).toBe(item.params.entry ?? effectById(item.effect).default_params.entry);
      expect(style.look).toBe((item.component as { style_preset: string }).style_preset);
      expect(Object.values(style).every((v) => /^[a-z0-9_]+$/.test(v))).toBe(true);
    }
  });
});

describe('ai.video-editing: assemble, a director\'s direction (task TS6a)', () => {
  const direct = (style: 'calm' | 'lively', picks?: Record<string, string>) => ({
    direction: { style, source: 'director', moments: [] } as Direction,
    ...(picks ? { scores: { picks } } : {}),
  });
  const transitions = (items: PlanItem[]) =>
    items.filter((i) => i.layer === 'transition').map((i) => [i.effect, i.start_ms, i.end_ms]);
  const CUTS = [3000, 3500, 9000, 14000];

  // ten slots, 2 s apart, on words 2, 7, 12, ... 47 of the 20 s video; the first is the hook
  const manySlots: Slot[] = Array.from({ length: 10 }, (_, k) =>
    slot(k === 0 ? 'h1' : `s${k}`, 2 + 5 * k, k === 0 ? 0 : 3 - (k % 3), `topic${k}`, k === 0)
  );
  const crowded = (extra: Partial<AssembleInput> = {}) => input('heavy', { slots: manySlots, ...extra });

  it('plans exactly what it did without a direction when there is none, or when it is `source: none`', () => {
    const before = assemble(input('standard', { cutPoints: CUTS }));
    // the whip at 8895 would end 995 ms before the punch in at 10100 and the flash at 13895 start 1405 ms from the l_flash at 15300
    // (rules 18 and 19), so the first flash stays and the cut at 14000 gets a whip
    expect(transitions(before.items)).toEqual([
      ['tr_flash_cut', 2895, 3105],
      ['tr_whip', 13895, 14105],
    ]);
    const none = { style: 'calm', source: 'none', moments: [] } as Direction;
    expect(assemble(input('standard', { cutPoints: CUTS, direction: undefined }))).toEqual(before);
    expect(assemble(input('standard', { cutPoints: CUTS, direction: none }))).toEqual(before);
    expect(assemble(input('standard', { cutPoints: CUTS, direction: none, scores: { picks: { cut: 'tr_whip' } } }))).toEqual(
      assemble(input('standard', { cutPoints: CUTS, scores: { picks: { cut: 'tr_whip' } } }))
    );
    expect(before.direction).toBeUndefined();
    expect(assemble(crowded({ cutPoints: CUTS, direction: none }))).toEqual(assemble(crowded({ cutPoints: CUTS })));
  });

  it('gives a calm video at most half the feature budget (rounded up) and none of the lively-only effects', () => {
    const calm = assemble(crowded({ cutPoints: CUTS, ...direct('calm', { cut: 'tr_whip' }) }));
    expect(features(calm.items).length).toBeLessThanOrEqual(Math.ceil(10 * 0.5));
    expect(calm.direction).toMatchObject({ style: 'calm', level_budget: 10, style_budget: 5 });
    expect(calm.direction!.feature_effects).toBe(features(calm.items).length);
    for (const item of calm.items) {
      expect(item.effect.startsWith('l_')).toBe(false);
      expect(['tr_whip', 'tr_flash_cut']).not.toContain(item.effect);
      expect(effectById(item.effect).styles ?? ['calm']).toContain('calm');
    }
    const lively = assemble(crowded({ cutPoints: CUTS, ...direct('lively') }));
    expect(lively.direction).toMatchObject({ style: 'lively', level_budget: 10, style_budget: 10 });
    expect(features(lively.items).length).toBeLessThanOrEqual(10);
  });

  it('rounds the calm budget up: Standard 6 gives 3, and a calm Standard video keeps to it', () => {
    const { items, direction } = assemble(input('standard', direct('calm')));
    expect(direction).toMatchObject({ level_budget: 6, style_budget: 3 });
    expect(features(items).length).toBeLessThanOrEqual(3);
    expect(items[0].layer).toBe('text');
  });

  it('lets a lively video use the lively-only effects of the cycle, as it always did', () => {
    const { items } = assemble(input('standard', direct('lively')));
    expect(items.map((i) => i.effect).slice(2)).toEqual(['v_punch_in', 'l_flash']);
  });

  it('puts no transition on a calm video, whatever the cut pick says', () => {
    const { items, direction } = assemble(input('heavy', { cutPoints: CUTS, ...direct('calm', { cut: 'tr_flash_cut' }) }));
    expect(transitions(items)).toEqual([]);
    expect(direction!.cut_transitions).toEqual({ code: 'style_calm', pick: 'tr_flash_cut', placed: 0 });
  });

  it('puts only the picked id on the cut points of a lively video, 4 s apart', () => {
    // cut points 1000 ms or more from the items of the slots (the punch in at 10100, the l_flash at 15300)
    const cutPoints = [3000, 3500, 8000, 13000];
    const { items, direction } = assemble(input('heavy', { cutPoints, ...direct('lively', { cut: 'tr_whip' }) }));
    expect(transitions(items)).toEqual([
      ['tr_whip', 2895, 3105],
      ['tr_whip', 7895, 8105],
      ['tr_whip', 12895, 13105],
    ]);
    expect(direction!.cut_transitions).toEqual({ code: 'picked', pick: 'tr_whip', placed: 3 });
  });

  it('keeps flash cuts 8 s apart, and 8 s from the l_flash of a slot (rule 19)', () => {
    const cutPoints = [3000, 3500, 8000, 13000];
    const { items, direction } = assemble(input('heavy', { cutPoints, ...direct('lively', { cut: 'tr_flash_cut' }) }));
    // 7895 is 5000 ms after the first flash; 12895 is 10000 ms after it but 2405 ms before the l_flash at 15300
    expect(transitions(items)).toEqual([['tr_flash_cut', 2895, 3105]]);
    expect(direction!.cut_transitions).toEqual({ code: 'picked', pick: 'tr_flash_cut', placed: 1 });
  });

  it('keeps the video, facecam and transition items 1000 ms apart (rule 18)', () => {
    // the punch in of the slot at 10100 would be 995 ms from a transition ending at 9105
    expect(transitions(assemble(input('standard', { cutPoints: [9000] })).items)).toEqual([]);
    expect(transitions(assemble(input('standard', { cutPoints: [13000] })).items)).toEqual([['tr_whip', 12895, 13105]]);
    const { items } = assemble(crowded({ cutPoints: CUTS, ...direct('lively') }));
    const spaced = items.filter((i) => ['video', 'facecam', 'transition'].includes(i.layer));
    for (const a of spaced) {
      for (const b of spaced.filter((x) => x !== a)) {
        expect(Math.max(b.start_ms - a.end_ms, a.start_ms - b.end_ms)).toBeGreaterThanOrEqual(1000);
      }
    }
  });

  it('puts no cut transition on a lively video without a usable cut pick', () => {
    const cases: [Record<string, string> | undefined, string][] = [
      [undefined, 'no_pick'],
      [{ s1: 'f_hero' }, 'no_pick'],
      [{ cut: 'none' }, 'pick_none'],
      // not a cut transition (a chapter one), not in the registry, not an effect of the video's level
      [{ cut: 'tr_push' }, 'pick_unusable'],
      [{ cut: 'tr_made_up' }, 'pick_unusable'],
      [{ cut: 'v_punch_in' }, 'pick_unusable'],
    ];
    for (const [picks, code] of cases) {
      const { items, direction } = assemble(input('heavy', { cutPoints: CUTS, ...direct('lively', picks) }));
      expect(transitions(items)).toEqual([]);
      expect(direction!.cut_transitions.code).toBe(code);
      expect(direction!.cut_transitions.placed).toBe(0);
    }
  });

  it('leaves Basic without transitions, direction or not', () => {
    const { items } = assemble(input('basic', { cutPoints: CUTS, ...direct('lively', { cut: 'tr_flash_cut' }) }));
    expect(transitions(items)).toEqual([]);
  });

  it('answers the same plan every time', () => {
    const run = () => assemble(crowded({ cutPoints: CUTS, ...direct('calm', { cut: 'tr_whip' }) }));
    expect(run()).toEqual(run());
  });
});

describe('ai.video-editing: assemble, the moment pass (task TS6b)', () => {
  const sentence = (id: string, from: number, to: number, label: Moment['label']): Moment => ({
    id,
    kind: 'sentence',
    start_ms: WORDS[from].start_ms,
    end_ms: WORDS[to].end_ms,
    word_from: from,
    word_to: to,
    label,
  });
  const drawing = (id: string, start: number, end: number, region: Moment['region']): Moment => ({
    id,
    kind: 'drawing',
    start_ms: start,
    end_ms: end,
    region,
    label: 'drawing',
  });
  const chapter = (id: string, t: number): Moment => ({ id, kind: 'chapter', start_ms: t - 1, end_ms: t, label: 'chapter' });
  const run = (
    level: EditLevel,
    style: 'calm' | 'lively',
    moments: Moment[],
    picks: Record<string, string>,
    extra: Partial<AssembleInput> = {}
  ) =>
    assemble(
      input(level, {
        direction: { style, source: 'director', moments },
        scores: { picks },
        facecam: FACE,
        ...extra,
      })
    );
  // the facecam sits low on the right of the master frame
  const FACE = [{ t_ms: 0, cx: 0.8, cy: 0.85, radius: 0.1 }];
  const only = (items: PlanItem[], effect: string) => items.filter((i) => i.effect === effect);
  // a region left of the facecam and above its middle: centre (0.2, 0.6)
  const REGION = { x: 0.1, y: 0.5, w: 0.2, h: 0.2 };

  it('steps the face aside and spotlights the region over a drawing, 400 ms before to 600 ms after it', () => {
    const { items, decisions, direction } = run('heavy', 'calm', [drawing('d1', 8000, 9000, REGION)], {
      'd1:face': 'f_step_aside',
      'd1:screen': 'v_spotlight',
    });
    const [aside] = only(items, 'f_step_aside');
    const [spot] = only(items, 'v_spotlight');
    expect([aside.start_ms, aside.end_ms, spot.start_ms, spot.end_ms]).toEqual([7600, 9600, 7600, 9600]);
    // the region centre is above the facecam centre: the face goes down; a calm video slides
    expect(aside.params).toMatchObject({ direction: 'down', motion: 'slide', in_ms: 350, out_ms: 350, fill_color: '#000000' });
    expect(spot.params).toEqual({ x: 0.07, y: 0.47, w: 0.26, h: 0.26, scale_to: 1.1, dim: 0.55, in_ms: 250, out_ms: 250 });
    expect(aside.anchor).toBeUndefined();
    expect(decisions!.filter((d) => d.reason_code === 'moment').map((d) => d.slot_id)).toEqual([
      'moment:d1:face',
      'moment:d1:screen',
    ]);
    expect(direction!.moments).toEqual({ placed: 2, dropped: 0, unusable: 0 });
  });

  it('rolls the face in a lively video, and keeps to the params the entry has and the values it allows', () => {
    const { items } = run('heavy', 'lively', [drawing('d1', 8000, 9000, REGION)], {
      'd1:face': 'f_dodge',
      'd1:screen': 'v_spotlight',
    });
    const [dodge] = only(items, 'f_dodge');
    expect(dodge.params).toEqual({ to: 'right', distance: 0.3, motion: 'roll', in_ms: 350, out_ms: 350, fill_color: '#000000' });
    // v_spotlight has no `motion` and no `direction`
    expect(Object.keys(only(items, 'v_spotlight')[0].params).sort()).toEqual(
      ['dim', 'h', 'in_ms', 'out_ms', 'scale_to', 'w', 'x', 'y']
    );
  });

  it('moves the face away from the region: sideways when the region is not above it, to the far side for a dodge', () => {
    const side = (face: { cx: number; cy: number }, region: Moment['region'], effect: string) =>
      only(
        run('heavy', 'calm', [drawing('d1', 8000, 9000, region)], { 'd1:face': effect }, { facecam: [{ t_ms: 0, radius: 0.1, ...face }] })
          .items,
        effect
      )[0].params;
    // region centre (0.2, 0.6), face top right (0.8, 0.15): the region is not above the face, it is on its left
    expect(side({ cx: 0.8, cy: 0.15 }, REGION, 'f_step_aside')).toMatchObject({ direction: 'right' });
    expect(side({ cx: 0.8, cy: 0.15 }, REGION, 'f_dodge')).toMatchObject({ to: 'right' });
    // region centre (0.7, 0.6), face top left: the region is on its right
    const right = { x: 0.6, y: 0.5, w: 0.2, h: 0.2 };
    expect(side({ cx: 0.2, cy: 0.15 }, right, 'f_step_aside')).toMatchObject({ direction: 'left' });
    expect(side({ cx: 0.2, cy: 0.15 }, right, 'f_dodge')).toMatchObject({ to: 'left' });
    // the face right under the region, and right above it
    const above = { x: 0.4, y: 0.1, w: 0.2, h: 0.2 };
    expect(side({ cx: 0.5, cy: 0.9 }, above, 'f_dodge')).toMatchObject({ to: 'down' });
    expect(side({ cx: 0.5, cy: 0.1 }, { x: 0.4, y: 0.6, w: 0.2, h: 0.2 }, 'f_dodge')).toMatchObject({ to: 'up' });
  });

  it('pads the spotlight by 0.03 and keeps it inside the frame', () => {
    const { items } = run('heavy', 'calm', [drawing('d1', 8000, 9000, { x: 0.01, y: 0.9, w: 0.99, h: 0.1 })], {
      'd1:screen': 'v_spotlight',
    });
    const p = only(items, 'v_spotlight')[0].params as { x: number; y: number; w: number; h: number };
    expect([p.x, p.y, p.w, p.h]).toEqual([0, 0.87, 1, 0.13]);
    expect(p.x + p.w).toBeLessThanOrEqual(1);
    expect(p.y + p.h).toBeLessThanOrEqual(1);
  });

  it('starts a claim item in the pause before its sentence and ends it 300 ms after the sentence, anchored on its first word', () => {
    // words 5 to 9: the sentence starts at 2100, the word before ends at 2000
    const claim = sentence('s2', 5, 9, 'claim');
    const { items, decisions } = run('heavy', 'calm', [claim], { s2: 'f_hero' });
    const [hero] = only(items, 'f_hero');
    expect([hero.start_ms, hero.end_ms]).toEqual([2000, 4300]);
    expect(hero.anchor).toEqual({ word_index: 5, offset_ms: -100 });
    const line = decisions!.find((d) => d.slot_id === 'moment:s2')!;
    expect(line).toMatchObject({
      decision: 'kept',
      reason_code: 'moment',
      inputs: { moment_id: 's2', label: 'claim', pick: 'f_hero', item_id: hero.id },
    });
    // a camera move is cut at the effect's longest duration
    const push = only(run('heavy', 'calm', [claim], { s2: 'v_push_in' }).items, 'v_push_in')[0];
    expect([push.start_ms, push.end_ms]).toEqual([2000, 2000 + effectById('v_push_in').max_duration_ms]);
  });

  it('starts at the sentence when the word before it ends later, and serves a recap and a cta with f_hero too', () => {
    const overlapping = WORDS.map((w) => (w.i === 4 ? { ...w, end_ms: 2300 } : w));
    const { items } = run('heavy', 'calm', [sentence('s2', 5, 9, 'recap')], { s2: 'f_hero' }, { words: overlapping });
    expect(only(items, 'f_hero')[0].start_ms).toBe(2100);
    const cta = run('heavy', 'calm', [sentence('s2', 25, 28, 'cta')], { s2: 'f_hero' });
    expect(only(cta.items, 'f_hero')).toHaveLength(1);
  });

  it('centres a chapter transition on the chapter time, alternating the direction of tr_push', () => {
    const { items } = run('heavy', 'calm', [chapter('c1', 6000), chapter('c2', 14000)], { c1: 'tr_push', c2: 'tr_push' });
    const pushes = only(items, 'tr_push');
    expect(pushes).toHaveLength(2);
    [6000, 14000].forEach((t, k) => {
      expect((pushes[k].start_ms + pushes[k].end_ms) / 2).toBe(t);
      expect(pushes[k].end_ms - pushes[k].start_ms).toBeGreaterThanOrEqual(250);
      expect(pushes[k].end_ms - pushes[k].start_ms).toBeLessThanOrEqual(400);
    });
    expect(pushes.map((p) => p.params.direction)).toEqual(['left', 'right']);
    expect(pushes[0].params.fill_color).toBe('#000000');
  });

  it('rolls the face 300 ms before a chapter for 900 ms, alternating right and left', () => {
    const { items, direction } = run('heavy', 'calm', [chapter('c1', 6000), chapter('c2', 14000)], { c1: 'f_roll', c2: 'f_roll' });
    const rolls = only(items, 'f_roll');
    expect(rolls.map((r) => [r.start_ms, r.end_ms, r.params.direction])).toEqual([
      [5700, 6600, 'right'],
      [13700, 14600, 'left'],
    ]);
    // a roll is a feature, a transition is not
    expect(direction!.feature_effects).toBeGreaterThanOrEqual(2);
    const dip = run('heavy', 'calm', [chapter('c1', 6000)], { c1: 'tr_dip_color' });
    expect(only(dip.items, 'tr_dip_color')).toHaveLength(1);
    expect(dip.direction!.feature_effects).toBe(features(dip.items).length);
  });

  it('ends a claim item one breathing gap before a later drawing item that crowds it, instead of dropping it (task TS8)', () => {
    // the claim's f_hero would run 2000 to 4300; the drawing's step aside starts at 4800, 500 ms later
    const { items, decisions, direction } = run(
      'heavy',
      'calm',
      [drawing('d1', 5200, 6000, REGION), sentence('s2', 5, 9, 'claim')],
      { 'd1:face': 'f_step_aside', s2: 'f_hero' }
    );
    const [hero] = only(items, 'f_hero');
    const [aside] = only(items, 'f_step_aside');
    expect([hero.start_ms, hero.end_ms]).toEqual([2000, 3800]);
    expect(aside.start_ms - hero.end_ms).toBe(1000);
    expect(decisions!.find((d) => d.slot_id === 'moment:s2')).toMatchObject({
      decision: 'kept',
      inputs: { start_ms: 2000, end_ms: 3800 },
    });
    expect(direction!.moments).toMatchObject({ placed: 2, dropped: 0 });
  });

  it('never overlaps two facecam moves, nor a facecam effect of a slot', () => {
    // the drawing's step aside is 7600 to 9600; the claim's f_hero would start at 7600 and is refused
    const { items, decisions, direction } = run(
      'heavy',
      'calm',
      [drawing('d1', 8000, 9000, REGION), sentence('s2', 19, 23, 'claim')],
      { 'd1:face': 'f_step_aside', s2: 'f_hero' }
    );
    expect(only(items, 'f_step_aside')).toHaveLength(1);
    expect(only(items, 'f_hero')).toHaveLength(0);
    expect(decisions!.find((d) => d.slot_id === 'moment:s2')).toMatchObject({
      decision: 'dropped',
      reason_code: 'overlap',
      inputs: { detail: 'face_move_overlap' },
    });
    expect(direction!.moments).toMatchObject({ placed: 1, dropped: 1 });
    // many slots at Heavy, whose cycle has a facecam and a layout turn: no two of them share time with a move
    const many: Slot[] = Array.from({ length: 10 }, (_, k) =>
      slot(k === 0 ? 'h1' : `s${k}`, 2 + 5 * k, k === 0 ? 0 : 3 - (k % 3), `topic${k}`, k === 0)
    );
    const crowded = run(
      'heavy',
      'lively',
      [drawing('d1', 8000, 9000, REGION), chapter('c1', 14000)],
      { 'd1:face': 'f_step_aside', c1: 'f_roll', cut: 'none' },
      { slots: many }
    );
    const moves = crowded.items.filter((i) => i.effect === 'f_step_aside' || i.effect === 'f_roll');
    expect(moves).toHaveLength(2);
    for (const move of moves) {
      for (const other of crowded.items.filter((i) => i !== move && (i.layer === 'facecam' || i.target === 'facecam'))) {
        expect(move.start_ms < other.end_ms && other.start_ms < move.end_ms).toBe(false);
      }
    }
  });

  it('places nothing for a `none` pick or no pick, and counts a pick that fits no moment as unusable', () => {
    const moments = [drawing('d1', 8000, 9000, REGION), sentence('s2', 5, 9, 'claim'), chapter('c1', 14000)];
    const base = run('heavy', 'calm', [], {});
    for (const picks of [{}, { 'd1:face': 'none', 'd1:screen': 'none', s2: 'none', c1: 'none' }]) {
      const none = run('heavy', 'calm', moments, picks);
      expect(none.items).toEqual(base.items);
      expect(none.decisions).toEqual(base.decisions);
      expect(none.direction!.moments).toEqual({ placed: 0, dropped: 0, unusable: 0 });
    }
    const wrong = run('heavy', 'calm', moments, {
      'd1:face': 'v_spotlight', // a screen effect on the face role
      'd1:screen': 'f_step_aside', // a face effect on the screen role
      s2: 'f_roll', // a chapter effect on a claim
      c1: 'tr_made_up', // not in the registry
    });
    expect(wrong.items).toEqual(base.items);
    expect(wrong.direction!.moments).toEqual({ placed: 0, dropped: 0, unusable: 4 });
    // a lively-only effect in a calm video
    expect(run('heavy', 'calm', moments, { s2: 'v_punch_in' }).direction!.moments.unusable).toBe(1);
    expect(run('heavy', 'lively', moments, { s2: 'v_punch_in' }).direction!.moments.placed).toBe(1);
  });

  it('plans no facecam move for a recording without a facecam track, whatever the pick says', () => {
    const moments = [drawing('d1', 8000, 9000, REGION), sentence('s2', 5, 9, 'claim'), chapter('c1', 14000)];
    const { items, direction } = run(
      'heavy',
      'calm',
      moments,
      { 'd1:face': 'f_step_aside', 'd1:screen': 'v_spotlight', s2: 'f_hero', c1: 'f_roll' },
      { facecam: [] }
    );
    expect(items.some((i) => ['f_step_aside', 'f_dodge', 'f_hero', 'f_roll'].includes(i.effect))).toBe(false);
    expect(only(items, 'v_spotlight')).toHaveLength(1);
    expect(direction!.moments).toEqual({ placed: 1, dropped: 0, unusable: 3 });
  });

  it('keeps one place of the budget for the hook when the picks would fill it', () => {
    // Standard calm: 3 features, so the moment pass may place 2; five drawings with two picks each ask for 10
    const drawings = [4000, 8000, 12000, 16000, 19000].map((t, k) => drawing(`d${k + 1}`, t, t + 400, REGION));
    const picks = Object.fromEntries(drawings.flatMap((d) => [[`${d.id}:face`, 'f_step_aside'], [`${d.id}:screen`, 'v_spotlight']]));
    const { items, direction, decisions } = run('standard', 'calm', drawings, picks);
    expect(direction).toMatchObject({ level_budget: 6, style_budget: 3 });
    expect(items.filter((i) => i.effect === 'f_step_aside' || i.effect === 'v_spotlight')).toHaveLength(2);
    expect(items.some((i) => i.component && i.component.type === 'styled_text' && i.component.kind === 'hook')).toBe(true);
    expect(direction!.feature_effects).toBeLessThanOrEqual(3);
    expect(decisions!.find((d) => d.slot_id === 'moment:d2:face')).toMatchObject({
      decision: 'dropped',
      reason_code: 'level_limit',
      inputs: { detail: 'moment_budget' },
    });
    expect(decisions!.find((d) => d.slot_id === 'h1')).toMatchObject({ decision: 'kept', reason_code: 'hook' });
  });

  it('lets only an in-drawing effect sit in a protected span; the others need a free window', () => {
    // 6000 to 9500 is protected: the drawing's items are inside it, the claim starts inside it
    const windows = [{ start_ms: 0, end_ms: 6000 }, { start_ms: 9500, end_ms: 20000 }];
    const { items, decisions } = run(
      'heavy',
      'calm',
      [drawing('d1', 8000, 9000, REGION), sentence('s2', 19, 23, 'claim')],
      { 'd1:face': 'f_step_aside', 'd1:screen': 'v_spotlight', s2: 'v_push_in' },
      { windows, slots: [] }
    );
    expect(only(items, 'f_step_aside')).toHaveLength(1);
    expect(only(items, 'v_spotlight')).toHaveLength(1);
    expect(only(items, 'v_push_in')).toHaveLength(0);
    expect(decisions!.find((d) => d.slot_id === 'moment:s2')).toMatchObject({
      decision: 'dropped',
      inputs: { detail: 'no_free_window' },
    });
  });

  it('keeps a chapter transition 4 s from the cut-point transitions of a lively video', () => {
    const cutPoints = [3000, 6500, 9000, 14000];
    const { items, direction } = run('heavy', 'lively', [chapter('c1', 6000)], { c1: 'tr_push', cut: 'tr_whip' }, { cutPoints });
    const starts = items.filter((i) => i.layer === 'transition').map((i) => [i.effect, i.start_ms]);
    // the cut points at 3000, 6500 and 9000 are within 4 s of the chapter's transition (5845); 14000 is not
    expect(starts).toEqual([
      ['tr_push', 5845],
      ['tr_whip', 13895],
    ]);
    expect(direction!.cut_transitions).toEqual({ code: 'picked', pick: 'tr_whip', placed: 1 });
    const times = items.filter((i) => i.layer === 'transition').map((i) => i.start_ms);
    for (const a of times) for (const b of times) if (a !== b) expect(Math.abs(a - b)).toBeGreaterThanOrEqual(4000);
  });

  it('puts two chapter transitions closer than 4 s apart only once', () => {
    const { items, decisions } = run('heavy', 'calm', [chapter('c1', 6000), chapter('c2', 8000)], { c1: 'tr_push', c2: 'tr_dip_color' });
    expect(items.filter((i) => i.layer === 'transition').map((i) => i.effect)).toEqual(['tr_push']);
    expect(decisions!.find((d) => d.slot_id === 'moment:c2')).toMatchObject({ inputs: { detail: 'transition_spacing' } });
  });

  it('says in each moment decision whether the pick came from the fallback rotation (task TS7)', () => {
    const moments = [sentence('s2', 5, 9, 'claim'), drawing('d1', 8000, 9000, REGION)];
    const picks = { s2: 'f_hero', 'd1:face': 'f_step_aside', 'd1:screen': 'v_spotlight' };
    const fallbackOf = (fallback_picks?: string[]) =>
      Object.fromEntries(
        run('heavy', 'calm', moments, picks, { scores: { picks, fallback_picks } })
          .decisions!.filter((d) => d.reason_code === 'moment')
          .map((d) => [d.slot_id, d.inputs.fallback])
      );

    expect(fallbackOf(['s2', 'd1:screen'])).toEqual({
      'moment:s2': true,
      'moment:d1:face': false,
      'moment:d1:screen': true,
    });
    // scores that name no fallback pick (Clef-omni answered every question, or no scores at all) say false
    expect(Object.values(fallbackOf(undefined))).toEqual([false, false, false]);
    expect(Object.values(fallbackOf([]))).toEqual([false, false, false]);
  });

  it('says `fallback` on a dropped moment line too', () => {
    const picks = { s2: 'f_hero', 'd1:face': 'f_step_aside' };
    const { decisions } = run('heavy', 'calm', [sentence('s2', 5, 9, 'claim'), drawing('d1', 2500, 3500, REGION)], picks, {
      scores: { picks, fallback_picks: ['s2'] },
    });

    // the drawing goes first (2100 to 4100); the claim's f_hero would start at 2000 and is refused
    expect(decisions!.find((d) => d.slot_id === 'moment:d1:face')).toMatchObject({ decision: 'kept', inputs: { fallback: false } });
    expect(decisions!.find((d) => d.slot_id === 'moment:s2')).toMatchObject({
      decision: 'dropped',
      inputs: { detail: 'face_move_overlap', fallback: true },
    });
  });

  it('knows the effects only a pick places: the facecam moves, the spotlight and the chapter transitions', () => {
    expect(EFFECTS.filter(momentOnly).map((e) => e.id).sort()).toEqual(
      ['f_dodge', 'f_hero', 'f_roll', 'f_step_aside', 'tr_dip_color', 'tr_push', 'v_spotlight'].sort()
    );
  });

  it('plans without a direction exactly as before, whatever the picks', () => {
    const picks = { scores: { picks: { s2: 'f_hero', 'd1:face': 'f_step_aside' } }, facecam: FACE };
    expect(assemble(input('heavy', picks))).toEqual(assemble(input('heavy', { facecam: FACE })));
  });

  it('answers the same plan every time', () => {
    const once = () =>
      run('heavy', 'lively', [drawing('d1', 8000, 9000, REGION), sentence('s2', 5, 9, 'claim'), chapter('c1', 14000)], {
        'd1:face': 'f_dodge',
        'd1:screen': 'v_spotlight',
        s2: 'f_hero',
        c1: 'f_roll',
        cut: 'none',
      });
    expect(once()).toEqual(once());
  });
});

describe('ai.video-editing: assemble, no caption echo (task TS9c)', () => {
  // the 9:16 output with its caption band: the captions already show every spoken word
  const CAPTIONED = [ALL_OUTPUTS[0]];
  const textKinds = (items: PlanItem[]) =>
    items.filter((i) => i.layer === 'text').map((i) => (i.component as { kind: string }).kind);

  it('places no keyword echo while an output has a caption band, at every level, and keeps the hook', () => {
    for (const level of ['basic', 'standard', 'heavy'] as EditLevel[]) {
      const { items } = assemble(input(level, { outputs: CAPTIONED }));
      expect(textKinds(items)).not.toContain('keyword_echo');
      expect(textKinds(items)).toContain('hook');
    }
  });

  it('still allows the keyword echo when no output has a caption band', () => {
    expect(textKinds(assemble(input('standard')).items)).toContain('keyword_echo');
    // one output with a band is enough to switch it off
    const mixed = [...OUT916, ALL_OUTPUTS[1]];
    expect(textKinds(assemble(input('standard', { outputs: mixed })).items)).not.toContain('keyword_echo');
  });

  it('still places the hook, a commentary phrase and a complementary phrase', () => {
    const written = { hook: 'Save hours every week', complementary: { s1: 'Save two hours' } };
    const heavy = assemble(input('heavy', { outputs: CAPTIONED, texts: written }));
    expect(textKinds(heavy.items)).toEqual(['hook', 'complementary']);
    const commentary = assemble(
      input('standard', { outputs: CAPTIONED, language: 'eng', scores: { commentary: { s1: 'did_you_know' } } })
    );
    expect(textKinds(commentary.items)).toEqual(['hook', 'commentary']);
  });

  it('leaves a slot that only had an echo plain, and the cycle goes on to the next family', () => {
    const { items, decisions } = assemble(input('standard', { outputs: CAPTIONED }));
    const byId = Object.fromEntries(decisions!.map((d) => [d.slot_id, d]));
    expect(byId.s1).toMatchObject({ decision: 'dropped', reason_code: 'low_score', inputs: { detail: 'caption_echo_only' } });
    expect(byId.s2).toMatchObject({ decision: 'kept', inputs: { family: 'camera' } });
    expect(byId.s3).toMatchObject({ decision: 'kept', inputs: { family: 'look' } });
    expect(items.map((i) => i.layer)).toEqual(['text', 'video', 'video']);
  });
});

describe('ai.video-editing: assemble, icons in a calm video (task TS9c)', () => {
  // 60 s of words, one every 400 ms; slot k on word 2 + 10 k (k 0 is the hook), in sentence k of ten words
  const wordsOf = (n: number): EditWord[] =>
    Array.from({ length: n }, (_, i) => ({ i, w: `word${i}`, start_ms: 100 + 400 * i, end_ms: 400 + 400 * i }));
  const slotsOf = (words: EditWord[], count: number, score: (k: number) => number): Slot[] =>
    Array.from({ length: count }, (_, k) => {
      const wi = 2 + 10 * k;
      return {
        id: k === 0 ? 'h1' : `s${k}`,
        word_index: wi,
        start_ms: words[wi].start_ms,
        end_ms: words[wi].end_ms,
        window: 0,
        reasons: k === 0 ? ['hook'] : ['long_word'],
        score: k === 0 ? 0 : score(k),
        keyword: `topic${k}`,
      };
    });
  const directionOf = (words: EditWord[], style: EditStyle, label: (k: number) => MomentLabel): Direction => ({
    style,
    source: 'director',
    moments: Array.from({ length: Math.floor(words.length / 10) }, (_, k): Moment => ({
      id: `s${k + 1}`,
      kind: 'sentence',
      start_ms: words[10 * k].start_ms,
      end_ms: words[10 * k + 9].end_ms,
      word_from: 10 * k,
      word_to: 10 * k + 9,
      label: label(k),
    })),
  });
  // a resolved icon for each of the slot ids
  const iconsFor = (...ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { asset_id: `ic${id}`, kind: 'icon_image' as const }]));
  const run = (level: EditLevel, style: EditStyle, label: (k: number) => MomentLabel, icons: string[]) => {
    const words = wordsOf(150);
    return assemble({
      level,
      words,
      windows: [{ start_ms: 0, end_ms: 60000 }],
      // plain slots (k a multiple of 3) score best, so by priority alone they would come first
      slots: slotsOf(words, 14, (k) => (k % 3 === 0 ? 3 : k % 3 === 1 ? 2 : 1)),
      outputs: OUT916,
      facecam: [],
      durationMs: 60000,
      direction: directionOf(words, style, label),
      assets: { icons: iconsFor(...icons) },
    });
  };
  const iconWords = (items: PlanItem[]) => items.filter((i) => i.layer === 'icon').map((i) => i.anchor?.word_index);
  // slot k lies in sentence k: k 0 hook, a multiple of 3 plain, 1 mod 3 example, 2 mod 3 reason
  const labelled = (k: number): MomentLabel => (k === 0 ? 'hook' : k % 3 === 0 ? 'plain' : k % 3 === 1 ? 'example' : 'reason');

  it('gives a 60 s Standard calm video one icon, never more', () => {
    const { items } = run('standard', 'calm', labelled, ['s4', 's7']);
    expect(iconWords(items)).toEqual([42]);
  });

  it('gives a 60 s Heavy calm video two icons, on the labelled sentences first (the plain ones score higher)', () => {
    const { items } = run('heavy', 'calm', labelled, ['s3', 's6', 's4', 's7']);
    expect(iconWords(items)).toEqual([42, 72]);
  });

  it('gives an icon to a plain sentence only when no labelled one has one', () => {
    const plainOnly = run('heavy', 'calm', labelled, ['s3', 's6']);
    expect(iconWords(plainOnly.items)).toEqual([32, 62]);
    const oneLabelled = run('heavy', 'calm', labelled, ['s3', 's4']);
    expect(iconWords(oneLabelled.items)).toEqual([42]);
  });

  it('never puts an icon on a hook, recap or cta sentence', () => {
    const recap = (k: number): MomentLabel => (k === 0 ? 'hook' : k % 3 === 0 ? 'cta' : k % 3 === 1 ? 'recap' : 'plain');
    expect(iconWords(run('heavy', 'calm', recap, ['s1', 's3', 's4']).items)).toEqual([]);
    expect(iconWords(run('heavy', 'calm', recap, ['s2', 's5']).items)).toEqual([22, 52]);
  });

  it('gives a 3-minute Heavy calm video at most six icons, more than the 60 s two', () => {
    const words = wordsOf(450);
    const claims = (k: number): MomentLabel => (k === 0 ? 'hook' : k % 3 === 0 ? 'claim' : 'plain');
    const ids = Array.from({ length: 12 }, (_, j) => `s${3 * (j + 1)}`);
    const { items } = assemble({
      level: 'heavy',
      words,
      windows: [{ start_ms: 0, end_ms: 180000 }],
      slots: slotsOf(words, 44, () => 3),
      outputs: OUT916,
      facecam: [],
      durationMs: 180000,
      direction: directionOf(words, 'calm', claims),
      assets: { icons: iconsFor(...ids) },
    });
    const placed = items.filter((i) => i.layer === 'icon').length;
    expect(placed).toBeLessThanOrEqual(6);
    expect(placed).toBeGreaterThan(2);
  });

  it('keeps the icons of TS11 in a lively video: any label, up to the level budget', () => {
    const { items } = run('heavy', 'lively', labelled, ['s3', 's6', 's9', 's12']);
    expect(iconWords(items)).toEqual([32, 62, 92, 122]);
  });
});
