// AI video editing (ai.video-editing): the snapshot gate of the shipped text looks, the text palette and the x_* text
// effects (card S5). Installed phones keep a copy of the contract and draw by id, so a released look or effect never
// changes in place: a change needs a new id. The frozen copy below is written out by hand, on purpose, and is never
// built from the live tables. Adding a new id is allowed, and so is a new field beside the old ones of a look or an
// effect (the look format grows additively, card S6); changing, retyping or removing a frozen value fails. Needs no
// database and no Nest.
import { isDeepStrictEqual } from 'util';
import { RegistryEntry, TextLook } from './edit.contract';
import { EFFECTS } from './edit.registry';
import { PALETTE, TEXT_LOOKS } from './edit.styles';

// The six looks released to installed phones, every field, `null` = off. Never edit one; add a new look id instead.
const FROZEN_LOOKS: Record<string, Record<string, unknown>> = {
  sticker: {
    id: 'sticker',
    fill: 'accent',
    stroke: { color: 'ink', width: 0.14 },
    shadow: { color: 'ink', alpha: 1, dx: 0.05, dy: 0.06, blur: 0 },
    glow: null,
    extrude: null,
    background: null,
    bar: null,
    tilt_deg: [-6, 6],
  },
  label_pill: {
    id: 'label_pill',
    fill: 'on_accent',
    stroke: null,
    shadow: { color: 'ink', alpha: 0.35, dx: 0, dy: 0.04, blur: 0.08 },
    glow: null,
    extrude: null,
    background: { color: 'accent', alpha: 1, radius: 0.5, pad_x: 0.35, pad_y: 0.2 },
    bar: null,
    tilt_deg: null,
  },
  '3d': {
    id: '3d',
    fill: 'accent',
    stroke: { color: 'ink', width: 0.06 },
    shadow: null,
    glow: null,
    extrude: { copies: 6, color: 'accent_dark', dx: 0.012, dy: 0.016 },
    background: null,
    bar: null,
    tilt_deg: null,
  },
  glow: {
    id: 'glow',
    fill: 'paper',
    stroke: { color: 'accent', width: 0.04 },
    shadow: null,
    glow: { color: 'accent', alpha: 0.85, blur: 0.35 },
    extrude: null,
    background: null,
    bar: null,
    tilt_deg: null,
  },
  gradient: {
    id: 'gradient',
    fill: { gradient: 'vertical', from: 'paper', to: 'accent' },
    stroke: { color: 'ink', width: 0.1 },
    shadow: null,
    glow: null,
    extrude: null,
    background: null,
    bar: null,
    tilt_deg: null,
  },
  highlighter: {
    id: 'highlighter',
    fill: 'ink',
    stroke: null,
    shadow: null,
    glow: null,
    extrude: null,
    background: null,
    bar: { color: 'accent', alpha: 0.85, height: 0.55 },
    tilt_deg: null,
  },
};

// The palette the roles `ink`, `paper` and the multi colour accents resolve to; its order sets `color_slot`.
const FROZEN_PALETTE: Record<string, unknown> = {
  multi: ['#FF3B30', '#FFD60A', '#34C759', '#32D7FF', '#FF2D92'],
  ink: '#111111',
  paper: '#FFFFFF',
};

// The seventeen x_* text effects released to installed phones, every field of the registry entry as shipped. Motion
// tables (hold, exit, new entries) are not here: they are params chosen per item, not shipped defaults. TS13 changed the
// bound `style_preset` of five of them on purpose (every text look has a background): the look ids only, see `BOXED_LOOK`.
const FROZEN_EFFECTS: Record<string, Record<string, unknown>> = {
  x_marker_sweep: {
    id: 'x_marker_sweep',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'basic',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'sweep', entry_ms: 200, exit_ms: 150 },
    param_limits: { entry_ms: [120, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_pop: {
    id: 'x_pop',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'basic',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150 },
    param_limits: { entry_ms: [120, 300] },
    cooldown_ms: 3000,
    max_per_video: 6,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_stamp: {
    id: 'x_stamp',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'basic',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'stamp', entry_ms: 140, shake_ms: 120, shakes: 3, exit_ms: 150 },
    param_limits: { entry_ms: [120, 180], shake_ms: [80, 140] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_slide_up: {
    id: 'x_slide_up',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'slide_up', entry_ms: 220, from_dy: 0.08, exit_ms: 150 },
    param_limits: { entry_ms: [120, 300], from_dy: [0.04, 0.12] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_typewriter: {
    id: 'x_typewriter',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'M',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'typewriter', typing_ms: 400, exit_ms: 150 },
    param_limits: { typing_ms: [200, 500] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_one_word: {
    id: 'x_one_word',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'word_by_word', entry_ms: 200, exit_ms: 150 },
    param_limits: { entry_ms: [120, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_sticker: {
    id: 'x_sticker',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'basic',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: 'tilt_sticker' },
    param_limits: { entry_ms: [120, 300] },
    cooldown_ms: 3000,
    max_per_video: 6,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_3d: {
    id: 'x_3d',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'basic',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: 'gradient_block' },
    param_limits: { entry_ms: [120, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_glow: {
    id: 'x_glow',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'basic',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: 'neon_box' },
    param_limits: { entry_ms: [120, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_gradient: {
    id: 'x_gradient',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: 'gradient_block' },
    param_limits: { entry_ms: [120, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_label_tag: {
    id: 'x_label_tag',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'basic',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'slide_up', entry_ms: 200, exit_ms: 150, style_preset: 'label_pill' },
    param_limits: { entry_ms: [120, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_tilt_sticker: {
    id: 'x_tilt_sticker',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'pop', entry_ms: 220, exit_ms: 150, style_preset: 'tilt_sticker', tilt_deg: 6 },
    param_limits: { entry_ms: [120, 300], tilt_deg: [3, 6] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_underline_draw: {
    id: 'x_underline_draw',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'M',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'draw', draw_ms: 250, exit_ms: 150 },
    param_limits: { draw_ms: [150, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_circle_draw: {
    id: 'x_circle_draw',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'M',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'draw', draw_ms: 280, exit_ms: 150 },
    param_limits: { draw_ms: [150, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_arrow_draw: {
    id: 'x_arrow_draw',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'M',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'draw', draw_ms: 250, exit_ms: 150 },
    param_limits: { draw_ms: [150, 300] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_count_up: {
    id: 'x_count_up',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'M',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'count_up', count_ms: 800, exit_ms: 150 },
    param_limits: { count_ms: [300, 800] },
    cooldown_ms: 3000,
    max_per_video: 2,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
  x_shake: {
    id: 'x_shake',
    layer: 'text',
    target: 'overlay',
    allowed_components: ['styled_text'],
    min_level: 'standard',
    content_safe: false,
    cost: 'L',
    min_duration_ms: 500,
    max_duration_ms: 2500,
    default_params: { entry: 'pop', entry_ms: 200, shake_ms: 150, amplitude: 0.01, exit_ms: 150 },
    param_limits: { shake_ms: [80, 200], amplitude: [0.004, 0.015] },
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    requires: [],
  },
};

// What a changed frozen item says: the one rule, with the ids and fields that broke it.
const advice = (what: string, id: string, fields: string[]) =>
  `${what} "${id}" is released to installed phones and cannot change (${fields.join(', ')}): add a new id`;

// The frozen fields whose live value differs, strictly (a missing field counts); fields beside the frozen ones are
// allowed. An empty list means the shipped item is intact.
const changedFields = (frozen: Record<string, unknown>, live: object | undefined): string[] =>
  Object.keys(frozen).filter(
    (field) => !live || !isDeepStrictEqual((live as Record<string, unknown>)[field], frozen[field])
  );

// Checks a live table against its frozen copy: every frozen id is present and every frozen field intact. An id that is
// not frozen is a new one, and is not looked at. Throws with the "add a new id" message on the first break.
const assertShippedIntact = (
  what: string,
  frozen: Record<string, Record<string, unknown>>,
  live: { id: string }[]
) => {
  for (const [id, shipped] of Object.entries(frozen)) {
    const fields = changedFields(shipped, live.find((item) => item.id === id));
    if (fields.length) throw new Error(advice(what, id, fields));
  }
};

describe('ai.video-editing: the snapshot gate of shipped looks, palette and effects', () => {
  it('freezes the six looks and the seventeen x_* effects released so far', () => {
    expect(Object.keys(FROZEN_LOOKS)).toEqual(['sticker', 'label_pill', '3d', 'glow', 'gradient', 'highlighter']);
    expect(Object.keys(FROZEN_EFFECTS)).toHaveLength(17);
    Object.entries(FROZEN_LOOKS).forEach(([id, look]) => expect(look.id).toBe(id));
    Object.entries(FROZEN_EFFECTS).forEach(([id, effect]) => expect(effect.id).toBe(id));
  });

  it('keeps every frozen field of every released look exactly as shipped', () => {
    assertShippedIntact('Text look', FROZEN_LOOKS, TEXT_LOOKS);
  });

  it('keeps the text palette, which sets the colours of every look and the colour rotation, as shipped', () => {
    const fields = changedFields(FROZEN_PALETTE, PALETTE);
    if (fields.length) throw new Error(advice('The text palette', 'PALETTE', fields));
  });

  it('keeps every frozen field of every released x_* text effect exactly as shipped', () => {
    assertShippedIntact('Text effect', FROZEN_EFFECTS, EFFECTS);
  });

  it('lets a released look stay under its id when the format grows beside its old fields', () => {
    const base = TEXT_LOOKS.find((look) => look.id === 'sticker') as TextLook;
    expect(changedFields(FROZEN_LOOKS.sticker, { ...base, box: null, opacity: 1 })).toEqual([]);
  });
});

describe('ai.video-editing: the snapshot gate fails when it must, and allows what it must', () => {
  const live = (id: string) => EFFECTS.find((effect) => effect.id === id) as RegistryEntry;

  it('lets a released x_* effect stay under its id when optional fields grow beside its old ones', () => {
    const grown = { ...live('x_pop'), describe: 'plain words', moments: ['claim'], styles: ['calm'], in_drawing: false };
    expect(changedFields(FROZEN_EFFECTS.x_pop, grown)).toEqual([]);
    expect(live('x_pop').styles).toBeUndefined();
  });

  it('fails with "add a new id" when a released look, effect or palette value is changed, retyped or removed', () => {
    const sticker = TEXT_LOOKS.find((look) => look.id === 'sticker') as TextLook;
    const looks = TEXT_LOOKS.filter((look) => look.id !== 'sticker');
    const recoloured = { ...sticker, stroke: { color: 'ink', width: 0.15 } };
    expect(() => assertShippedIntact('Text look', FROZEN_LOOKS, [...looks, recoloured])).toThrow(
      /"sticker" is released.*\(stroke\): add a new id/
    );
    expect(() => assertShippedIntact('Text look', FROZEN_LOOKS, looks)).toThrow(/"sticker".*add a new id/);
    const slower = { ...live('x_pop'), default_params: { entry: 'pop', entry_ms: 250, exit_ms: 150 } };
    const effects = EFFECTS.filter((effect) => effect.id !== 'x_pop');
    expect(() => assertShippedIntact('Text effect', FROZEN_EFFECTS, [...effects, slower])).toThrow(
      /"x_pop" is released.*\(default_params\): add a new id/
    );
    expect(changedFields(FROZEN_PALETTE, { ...PALETTE, multi: [...PALETTE.multi].reverse() })).toEqual(['multi']);
  });

  it('allows a new look id and a new x_* effect id beside the frozen ones', () => {
    const sticker = TEXT_LOOKS.find((look) => look.id === 'sticker') as TextLook;
    const added = [...TEXT_LOOKS, { ...sticker, id: 'brand_new_look' }];
    expect(() => assertShippedIntact('Text look', FROZEN_LOOKS, added)).not.toThrow();
    const effects = [...EFFECTS, { ...live('x_pop'), id: 'x_fade_in' }];
    expect(() => assertShippedIntact('Text effect', FROZEN_EFFECTS, effects)).not.toThrow();
  });
});
