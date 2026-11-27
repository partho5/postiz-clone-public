// AI video editing (ai.video-editing): the assembler (spec section 11, step 7) on hand-built slots in one long free
// window, so every expected time and effect is computed by hand. Needs no database and no Nest.
import { EditLevel, EditWord, PlanItem } from '../contract/edit.contract';
import { LEGACY_TEXT_MOTIONS } from '../contract/edit.motions';
import { effectById } from '../contract/edit.registry';
import { TEXT_FEATURES, textLookById } from '../contract/edit.styles';
import { AssembleInput, assemble } from './edit.assembler';
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
const OUT916 = [ALL_OUTPUTS[0]];

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

  it('plans a hook, a keyword echo and a punch in, spread over the video', () => {
    expect(
      items.map((i) => [i.id, i.effect, i.start_ms, i.end_ms, i.anchor])
    ).toEqual([
      ['e1', 'x_sticker', 820, 1620, { word_index: 2, offset_ms: -80 }],
      ['e2', 'x_label_tag', 4820, 5620, { word_index: 12, offset_ms: -80 }],
      ['e3', 'v_punch_in', 10100, 10350, { word_index: 25, offset_ms: 0 }],
    ]);
  });

  it('writes the hook and the echo as Title Case keywords in the looks of Basic, colours rotating', () => {
    expect(items[0].component).toEqual({
      type: 'styled_text',
      kind: 'hook',
      text: 'Alpha',
      style_preset: 'sticker',
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
      end_ms: 11520,
      position: { zone: 'upper_right' },
      component: {
        type: 'icon_video',
        asset_id: 'ic1',
        native_duration_ms: 3000,
        fit: { mode: 'speed_up', factor: 2 },
      },
    });
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

  it('keeps an overlay clear of the facecam by choosing another zone', () => {
    const facecam = [{ t_ms: 0, cx: 0.5, cy: 0.16, radius: 0.1 }];
    const { items } = assemble(input('basic', { facecam }));
    expect(items[0].effect).toBe('x_sticker');
    expect(items[0].position.zone).toBe('middle_center');
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
    const run = () => texts(assemble(input('heavy', { capabilities: FULL_CAPABILITIES, texts: written })).items);
    const stickers = run().filter((i) => (i.component as { style_preset: string }).style_preset === 'sticker');
    expect(stickers.length).toBeGreaterThan(0);
    for (const item of stickers) {
      expect(Math.abs(item.params.tilt_deg as number)).toBeGreaterThanOrEqual(3);
      expect(Math.abs(item.params.tilt_deg as number)).toBeLessThanOrEqual(6);
      expect(item.params.tilt_deg).toBe(tiltFromId(item.id, [-6, 6]));
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
