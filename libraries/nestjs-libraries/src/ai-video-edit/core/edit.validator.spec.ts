// AI video editing (ai.video-editing): the validator (spec section 17), one passing and one failing case for every
// rule, on a small hand-built plan: 40 words one every 450 ms, free windows 0-6000 and 7000-19000 ms, a protected
// span in between, a 9:16 output and the facecam at the lower right. Needs no database and no Nest.
import { EditWord, Plan, PlanItem } from '../contract/edit.contract';
import { effectById } from '../contract/edit.registry';
import { PALETTE, TEXT_FEATURES, hasBackground, textLookById } from '../contract/edit.styles';
import { ValidationContext, validatePlan } from './edit.validator';
import {
  ALL_OUTPUTS,
  FULL_CAPABILITIES,
  GATED_LOOKS,
  GATED_LOOK_FEATURE,
  GATED_LOOK_ID,
} from './fixtures/edit.golden.fixtures';

// Word i starts at 200 + 450 i and lasts 300 ms.
const WORDS: EditWord[] = Array.from({ length: 40 }, (_, i) => ({
  i,
  w: `word${i}`,
  start_ms: 200 + 450 * i,
  end_ms: 500 + 450 * i,
}));
const DURATION = 19000;

// A phone that draws every look: x_sticker is bound to `tilt_sticker` (TS13), a look that needs features.
const CAPS = { ...FULL_CAPABILITIES, text_features: TEXT_FEATURES };

const BASE: ValidationContext = {
  request: {
    contract_version: 2,
    video: { duration_ms: DURATION, width: 1080, height: 2400, fps: 30, source: 'in_app_recording' },
    outputs: [ALL_OUTPUTS[0]],
    capabilities: CAPS,
    options: { sound_effects: true },
  },
  words: WORDS,
  windows: [
    { start_ms: 0, end_ms: 6000 },
    { start_ms: 7000, end_ms: 19000 },
  ],
  protected_src: [{ start_ms: 6000, end_ms: 7000 }],
  source_duration_ms: DURATION,
};

// A caption emphasis every 5 words keeps the plan's pacing under 3 s without any effect.
const EMPHASIS = [0, 5, 10, 15, 20, 25, 30, 35, 39];

const plan = (items: PlanItem[], over: Partial<Plan> = {}): Plan => ({
  contract_version: 2,
  plan_version: 1,
  session_id: 'session',
  level: 'heavy',
  video: { output_duration_ms: DURATION },
  structure: { cuts: [], speed_segments: [] },
  facecam_track: [{ t_ms: 0, cx: 0.78, cy: 0.62, radius: 0.13 }],
  palette: { mode: 'multi', colors: PALETTE.multi },
  items,
  captions: { effect: 'c_word_highlight', emphasis_words: EMPHASIS },
  warnings: [],
  ...over,
});

const run = (items: PlanItem[], planOver: Partial<Plan> = {}, ctxOver: Partial<ValidationContext> = {}) =>
  validatePlan(plan(items, planOver), { ...BASE, ...ctxOver });

const params = (id: string) => ({ ...effectById(id).default_params });

// A one word text overlay anchored 80 ms before word `wi`, 800 ms long, in the upper centre.
const text = (id: string, wi: number, over: Partial<PlanItem> = {}): PlanItem => {
  const start = WORDS[wi].start_ms - 80;
  return {
    id,
    effect: 'x_sticker',
    layer: 'text',
    target: 'overlay',
    start_ms: start,
    end_ms: start + 800,
    anchor: { word_index: wi, offset_ms: -80 },
    position: { zone: 'upper_center' },
    component: { type: 'styled_text', kind: 'keyword_echo', text: 'HELLO', style_preset: 'tilt_sticker', color_slot: 0 },
    params: params('x_sticker'),
    sound: { id: 'pop_1', offset_ms: 0 },
    ...over,
  };
};

// A video effect with no anchor.
const video = (id: string, effect: string, start: number, dur: number, over: Partial<PlanItem> = {}): PlanItem => {
  const e = effectById(effect);
  return { id, effect, layer: e.layer, target: e.target, start_ms: start, end_ms: start + dur, params: params(effect), ...over };
};

// An icon or mp4 clip overlay with no anchor.
const icon = (id: string, effect: string, start: number, dur: number, component: PlanItem['component']): PlanItem =>
  video(id, effect, start, dur, { position: { zone: 'upper_right' }, component });

// The sound assets of a plan that lists its assets: the hook's sound must be among them.
const SOUNDS = [{ id: 'pop_1', kind: 'sound' as const, url: 'u' }];

// The text overlay that opens every plan: inside the first 3 s, so the hook rule holds.
const HOOK = text('e1', 2);

const rej = (id: string, effect: string, rule: number, code: string, action: 'repaired' | 'dropped') => ({
  id,
  effect,
  rule,
  code,
  action,
});

// The log lines of one rule only, for a test of that rule on a plan where another rule (18, 19) also acts.
const ofRule = (r: ReturnType<typeof run>, rule: number) => r.rejections.filter((x) => x.rule === rule);

// Whether every two video, facecam and transition items of a plan are at least 1000 ms apart (rule 18).
const breathes = (items: PlanItem[]) =>
  items
    .filter((i) => ['video', 'facecam', 'transition'].includes(i.layer))
    .every((a, k, all) =>
      all.slice(k + 1).every((b) => Math.max(b.start_ms - a.end_ms, a.start_ms - b.end_ms) >= 1000)
    );

describe('ai.video-editing: validatePlan, a clean plan', () => {
  it('keeps a valid plan as it is, with no warning and no rejection', () => {
    const r = run([HOOK]);
    expect(r.rejections).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.plan.items).toEqual([HOOK]);
    expect(r.plan.warnings).toEqual([]);
  });

  it('does not change the plan it is given, and validating its answer again changes nothing', () => {
    const input = plan([HOOK, text('e2', 12)]);
    const before = JSON.parse(JSON.stringify(input));
    const first = validatePlan(input, BASE);
    expect(input).toEqual(before);
    const second = validatePlan(first.plan, BASE);
    expect(second.rejections).toEqual([]);
    expect(second.plan).toEqual(first.plan);
  });
});

describe('ai.video-editing: validatePlan rule 1, contract version, known effect, capabilities', () => {
  it('drops an item whose effect is not in the registry', () => {
    const r = run([HOOK, { ...video('e2', 'v_punch_in', 8000, 250), effect: 'x_nope' }]);
    expect(r.rejections).toEqual([rej('e2', 'x_nope', 1, 'unknown_effect', 'dropped')]);
    expect(r.plan.items).toHaveLength(1);
  });

  it('drops an effect the phone cannot render and keeps the rest', () => {
    const caps = { ...CAPS, effects: CAPS.effects.filter((e) => e !== 'v_punch_in') };
    const r = run([HOOK, video('e2', 'v_punch_in', 8000, 250)], {}, { request: { ...BASE.request, capabilities: caps } });
    expect(r.rejections).toEqual([rej('e2', 'v_punch_in', 1, 'not_in_capabilities', 'dropped')]);
  });

  it('trusts no item of another contract version', () => {
    const r = run([HOOK], { contract_version: 1 });
    expect(r.plan.items).toEqual([]);
    expect(r.warnings).toEqual(['contract_version_mismatch']);
    expect(r.rejections[0]).toMatchObject({ rule: 1, code: 'contract_version', action: 'dropped' });
  });

  it('states the layer and target of the registry when the plan states others', () => {
    const r = run([{ ...HOOK, layer: 'video', target: 'full_frame' }]);
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 1, 'layer_target_fixed', 'repaired')]);
    expect(r.plan.items[0]).toMatchObject({ layer: 'text', target: 'overlay' });
  });

  it('swaps a caption effect the phone lacks and warns when it has none', () => {
    const swapped = run([HOOK], { captions: { effect: 'c_nope', emphasis_words: EMPHASIS } });
    expect(swapped.plan.captions.effect).toBe('c_word_highlight');
    expect(swapped.rejections).toEqual([rej('captions', 'c_nope', 1, 'captions_effect_swapped', 'repaired')]);
    const none = run([HOOK], {}, { request: { ...BASE.request, capabilities: { effects: ['x_sticker'], text_styles: ['sticker'] } } });
    expect(none.warnings).toContain('captions_unavailable');
  });
});

describe('ai.video-editing: validatePlan rule 2, level', () => {
  const gradient = text('e1', 2, {
    effect: 'x_gradient',
    params: params('x_gradient'),
    component: { type: 'styled_text', kind: 'keyword_echo', text: 'HELLO', style_preset: 'gradient_block', color_slot: 0 },
  });

  it('keeps an effect at its minimum level and drops it below', () => {
    expect(run([gradient], { level: 'standard' }).rejections).toEqual([]);
    expect(run([gradient], { level: 'basic' }).rejections).toEqual([rej('e1', 'x_gradient', 2, 'level_too_low', 'dropped')]);
  });

  it('drops a text kind the level does not allow', () => {
    const commentary = text('e1', 2, {
      component: { type: 'styled_text', kind: 'commentary', text: 'WAIT', style_preset: 'tilt_sticker', color_slot: 0 },
    });
    expect(run([commentary], { level: 'basic' }).rejections).toEqual([rej('e1', 'x_sticker', 2, 'kind_not_allowed', 'dropped')]);
    expect(run([commentary], { level: 'standard' }).rejections).toEqual([]);
  });

  it('removes a sound the level or the user does not allow', () => {
    const basic = run([HOOK], { level: 'basic' });
    expect(basic.rejections).toEqual([rej('e1', 'x_sticker', 2, 'sound_removed', 'repaired')]);
    expect(basic.plan.items[0].sound).toBeUndefined();
    const muted = run([HOOK], {}, { request: { ...BASE.request, options: { sound_effects: false } } });
    expect(muted.plan.items[0].sound).toBeUndefined();
  });

  it('swaps a sound the effect does not list for one it does', () => {
    const r = run([text('e1', 2, { sound: { id: 'ding', offset_ms: 0 } })]);
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 2, 'sound_swapped', 'repaired')]);
    expect(r.plan.items[0].sound).toEqual({ id: 'pop_1', offset_ms: 0 });
  });
});

describe('ai.video-editing: validatePlan rule 3, free windows', () => {
  it('shifts an item that runs past its window back inside it, and moves its anchor offset with it', () => {
    const r = run([HOOK, text('e2', 12)]);
    expect(r.rejections).toEqual([rej('e2', 'x_sticker', 3, 'shifted', 'repaired')]);
    expect(r.plan.items[1]).toMatchObject({ start_ms: 5200, end_ms: 6000, anchor: { word_index: 12, offset_ms: -400 } });
  });

  it('moves an item out of a protected span to the nearest window', () => {
    const r = run([HOOK, video('e2', 'v_punch_in', 6200, 250)]);
    expect(r.rejections).toEqual([rej('e2', 'v_punch_in', 3, 'shifted', 'repaired')]);
    expect(r.plan.items[1]).toMatchObject({ start_ms: 5750, end_ms: 6000 });
  });

  it('drops an item when there is no free window at all', () => {
    const r = run([HOOK], {}, { windows: [] });
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 3, 'no_window', 'dropped')]);
  });
});

describe('ai.video-editing: validatePlan rule 4, duration', () => {
  it('shortens an effect that lasts too long and lengthens one that is too short', () => {
    const long = run([HOOK, video('e2', 'l_flash', 8000, 400)]);
    expect(long.rejections).toEqual([rej('e2', 'l_flash', 4, 'shortened', 'repaired')]);
    expect(long.plan.items[1].end_ms).toBe(8150);
    const short = run([text('e1', 2, { end_ms: 1020 + 300 })]);
    expect(short.rejections).toEqual([rej('e1', 'x_sticker', 4, 'lengthened', 'repaired')]);
    expect(short.plan.items[0].end_ms).toBe(1020 + 650);
  });

  it('keeps an effect whose duration is inside its range', () => {
    expect(run([HOOK, video('e2', 'l_flash', 8000, 150)]).rejections).toEqual([]);
  });
});

describe('ai.video-editing: validatePlan rule 5, params', () => {
  it('drops a param the effect does not have and clamps one outside its limits', () => {
    const item = video('e2', 'v_punch_in', 8000, 250, { params: { scale_to: 2, ease: 'out_back', junk: 1 } });
    const r = run([HOOK, item]);
    expect(r.rejections).toEqual([
      rej('e2', 'v_punch_in', 5, 'param_unknown', 'repaired'),
      rej('e2', 'v_punch_in', 5, 'param_clamped', 'repaired'),
    ]);
    expect(r.plan.items[1].params).toEqual({ scale_to: 1.25, ease: 'out_back' });
  });

  it('resets a param of the wrong type to the default', () => {
    const r = run([HOOK, video('e2', 'v_punch_in', 8000, 250, { params: { scale_to: 'big', ease: 'out_back' } })]);
    expect(r.rejections).toEqual([rej('e2', 'v_punch_in', 5, 'param_reset', 'repaired')]);
    expect(r.plan.items[1].params.scale_to).toBe(1.15);
  });

  it('keeps params inside their limits', () => {
    const item = video('e2', 'v_punch_in', 8000, 250, { params: { scale_to: 1.2, ease: 'out_back' } });
    expect(run([HOOK, item]).rejections).toEqual([]);
  });
});

describe('ai.video-editing: validatePlan rule 5, text motions', () => {
  // The hook with the motion params of a text effect that takes motions.
  const moving = (motion: Record<string, number | string>) => text('e1', 2, { params: { ...params('x_sticker'), ...motion } });

  it('keeps a new entry, hold, exit and exit direction with their durations', () => {
    const motion = { entry: 'slide_left', entry_ms: 250, hold: 'float', hold_ms: 2000, exit: 'slide_out', exit_ms: 180, exit_dir: 'right' };
    const r = run([moving(motion)]);
    expect(r.rejections).toEqual([]);
    expect(r.plan.items[0].params).toMatchObject(motion);
  });

  it('fills the duration of a motion the effect had no key for', () => {
    const r = run([moving({ entry: 'typewriter' })]);
    expect(r.rejections).toEqual([]);
    expect(r.plan.items[0].params).toMatchObject({ entry: 'typewriter', typing_ms: 400 });
  });

  it('clamps a motion duration to the limits of its table', () => {
    const r = run([moving({ entry: 'glitch', entry_ms: 290, hold: 'pulse', hold_ms: 50, exit_ms: 400 })]);
    expect(r.rejections.map((x) => x.code)).toEqual(['param_clamped', 'param_clamped', 'param_clamped']);
    expect(r.plan.items[0].params).toMatchObject({ entry: 'glitch', entry_ms: 260, hold: 'pulse', hold_ms: 500, exit_ms: 200 });
  });

  it('resets an unknown entry to the effect own and removes an unknown hold, exit or exit direction', () => {
    const r = run([moving({ entry: 'explode', hold: 'spin', exit: 'vanish', exit_dir: 'sideways' })]);
    expect(r.rejections.map((x) => x.code)).toEqual(['param_reset', 'param_reset', 'param_reset', 'param_reset']);
    const p = r.plan.items[0].params;
    expect(p.entry).toBe('pop');
    expect(p).not.toHaveProperty('hold');
    expect(p).not.toHaveProperty('exit');
    expect(p).not.toHaveProperty('exit_dir');
  });

  it('still removes motion keys from an effect that does not take motions', () => {
    const item = video('e2', 'v_punch_in', 8000, 250, { params: { ...params('v_punch_in'), hold: 'float' } });
    expect(run([HOOK, item]).rejections).toEqual([rej('e2', 'v_punch_in', 5, 'param_unknown', 'repaired')]);
  });

  // The same plan for a phone that lists these motions (the cases below), or none (the legacy five).
  const asked = (text_motions: string[] | null | undefined) => ({
    request: { ...BASE.request, capabilities: { ...CAPS, text_motions: text_motions as string[] } },
  });

  it('swaps an entry the phone did not list for the effect own entry, with that entry duration', () => {
    const item = moving({ entry: 'slide_left', entry_ms: 250 });
    const r = run([item], {}, asked(['pop', 'hold_float']));
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 5, 'motion_swapped', 'repaired')]);
    expect(r.plan.items[0].params).toMatchObject({ entry: 'pop', entry_ms: 200 });
  });

  it('swaps an entry to the first the phone draws when the effect own is not listed either', () => {
    const r = run([moving({ entry: 'slide_left', entry_ms: 250 })], {}, asked(['fade']));
    expect(r.plan.items[0].params).toMatchObject({ entry: 'fade', entry_ms: 180 });
  });

  it('removes a hold and an exit the phone did not list, with the exit direction', () => {
    const motion = { hold: 'float', hold_ms: 2000, exit: 'slide_out', exit_ms: 180, exit_dir: 'right' };
    const r = run([moving(motion)], {}, asked(['pop', 'hold_pulse', 'exit_fade']));
    expect(r.rejections.map((x) => x.code)).toEqual(['motion_swapped', 'motion_swapped']);
    const p = r.plan.items[0].params;
    expect(p).not.toHaveProperty('hold');
    expect(p).not.toHaveProperty('hold_ms');
    expect(p).not.toHaveProperty('exit');
    expect(p).not.toHaveProperty('exit_dir');
  });

  it('plans only the legacy motions for a phone that listed none, absent or null', () => {
    for (const list of [undefined, null]) {
      const item = moving({ entry: 'typewriter', typing_ms: 400, hold: 'shake', hold_ms: 120, exit: 'shrink' });
      const r = run([item], {}, asked(list));
      expect(r.plan.items[0].params).toMatchObject({ entry: 'pop', entry_ms: 200 });
      expect(r.plan.items[0].params).not.toHaveProperty('hold');
      expect(r.plan.items[0].params).not.toHaveProperty('exit');
    }
  });

  it('keeps a legacy entry for a phone that listed none', () => {
    const r = run([moving({ entry: 'stamp', entry_ms: 140 })], {}, asked(undefined));
    expect(r.rejections).toEqual([]);
  });

  it('keeps the tilt of the look inside its range and drops one a look without a tilt cannot have', () => {
    // tilt_sticker, the look x_sticker is bound to, tilts from -7 to -5 degrees
    expect(run([moving({ tilt_deg: -6 })]).rejections).toEqual([]);
    const over = run([moving({ tilt_deg: 11 })]);
    expect(over.rejections).toEqual([rej('e1', 'x_sticker', 5, 'param_clamped', 'repaired')]);
    expect(over.plan.items[0].params.tilt_deg).toBe(-5);
    const pill = text('e1', 2, {
      effect: 'x_label_tag',
      params: { ...params('x_label_tag'), tilt_deg: 3 },
      component: { type: 'styled_text', kind: 'keyword_echo', text: 'HELLO', style_preset: 'label_pill', color_slot: 0 },
    });
    const none = run([pill]);
    expect(none.rejections).toEqual([rej('e1', 'x_label_tag', 5, 'param_unknown', 'repaired')]);
    expect(none.plan.items[0].params).not.toHaveProperty('tilt_deg');
  });
});

describe('ai.video-editing: validatePlan rule 6, overlays', () => {
  const facecamUp = { facecam_track: [{ t_ms: 0, cx: 0.5, cy: 0.16, radius: 0.1 }] };

  it('moves an overlay off the facecam to a zone that is free', () => {
    const r = run([HOOK], facecamUp);
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 6, 'zone_moved', 'repaired')]);
    expect(r.plan.items[0].position.zone).toBe('middle_center');
  });

  it('drops an overlay when no zone is clear of the facecam', () => {
    const r = run([HOOK], { facecam_track: [{ t_ms: 0, cx: 0.5, cy: 0.3, radius: 0.45 }] });
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 6, 'no_zone', 'dropped')]);
  });

  it('keeps an overlay out of the caption band', () => {
    const band = { ...ALL_OUTPUTS[0], caption_band: { y0: 0.1, y1: 0.3 } };
    const r = run([HOOK], {}, { request: { ...BASE.request, outputs: [band] } });
    expect(r.plan.items[0].position.zone).toBe('middle_center');
  });

  it('keeps a long text inside the safe rectangle by moving it to the centre', () => {
    const wide = text('e1', 2, {
      position: { zone: 'upper_left' },
      component: { type: 'styled_text', kind: 'keyword_echo', text: 'EXTRAORDINARY', style_preset: 'tilt_sticker', color_slot: 0 },
    });
    const r = run([wide]);
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 6, 'zone_moved', 'repaired')]);
    expect(r.plan.items[0].position.zone).toBe('upper_center');
  });

  it('checks the facecam only in an output where it shows inside the crop', () => {
    const low = text('e1', 2, { position: { zone: 'lower_center' } });
    const face = { facecam_track: [{ t_ms: 0, cx: 0.5, cy: 0.52, radius: 0.1 }] };
    expect(run([low], face).plan.items[0].position.zone).toBe('upper_center');
    const square = { ...BASE.request, outputs: [ALL_OUTPUTS[2]] };
    const r = run([low], face, { request: square });
    expect(r.rejections).toEqual([]);
    expect(r.plan.items[0].position.zone).toBe('lower_center');
  });

  it('checks every output the user asked for', () => {
    const all = { ...BASE.request, outputs: ALL_OUTPUTS };
    expect(run([HOOK], {}, { request: all }).rejections).toEqual([]);
  });

  it('moves an overlay off the content it would cover while it is live, and leaves it once the content is gone (TS9d)', () => {
    const ink = { start_ms: 0, end_ms: 60000, region: { x: 0, y: 0, w: 1, h: 0.2 } };
    const live = run([HOOK], {}, { keepouts: [ink] });
    expect(live.rejections).toEqual([rej('e1', 'x_sticker', 6, 'zone_moved', 'repaired')]);
    expect(live.plan.items[0].position.zone).toBe('middle_center');
    const gone = run([HOOK], {}, { keepouts: [{ ...ink, end_ms: HOOK.start_ms }] });
    expect(gone.rejections).toEqual([]);
    expect(gone.plan.items[0].position.zone).toBe('upper_center');
  });

  it('drops an overlay as content_collision when only the content keeps every zone from it (TS9d)', () => {
    const everything = { start_ms: 0, end_ms: 60000, region: { x: 0, y: 0, w: 1, h: 1 } };
    const r = run([HOOK], {}, { keepouts: [everything] });
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 6, 'content_collision', 'dropped')]);
    expect(run([HOOK], {}, { keepouts: [] }).rejections).toEqual([]);
  });
});

describe('ai.video-editing: validatePlan rule 7, budget', () => {
  const seven = [
    // 1000 ms or more between the end of one and the start of the next (rule 18), the windows are 0-6000 and 7000-19000
    video('e1', 'v_punch_in', 1000, 250),
    video('e2', 'v_push_in', 2500, 500),
    video('e3', 'v_pull_out', 4250, 250),
    video('e4', 'v_bounce_scale', 5750, 250),
    video('e5', 'v_beat_rotate', 7250, 250),
    video('e6', 'v_pan_bounce', 8500, 250),
    video('e7', 'l_flash', 10000, 100),
  ];

  it('keeps 6 feature effects at Standard and drops the 7th', () => {
    const r = run(seven, { level: 'standard' });
    expect(r.rejections).toEqual([rej('e7', 'l_flash', 7, 'over_budget', 'dropped')]);
    expect(r.plan.items).toHaveLength(6);
  });

  it('allows the 7th at Heavy', () => {
    expect(run(seven, { level: 'heavy' }).rejections).toEqual([]);
  });

  it('counts neither captions nor transitions, and caps icons per level', () => {
    const assets = [...SOUNDS, ...['a1', 'a2', 'a3'].map((id) => ({ id, kind: 'icon' as const, url: 'u' }))];
    const make = (id: string, effect: string, start: number, asset: string) =>
      icon(id, effect, start, 1000, { type: 'icon_image', asset_id: asset });
    const three = [make('e1', 'i_scale_pop', 1000, 'a1'), make('e2', 'i_wipe_reveal', 3000, 'a2'), make('e3', 'i_stamp', 5000, 'a3')];
    const r = run(three, { level: 'standard' }, { assets });
    expect(r.rejections).toEqual([rej('e3', 'i_stamp', 7, 'over_icon_budget', 'dropped')]);
    expect(run(three, { level: 'heavy' }, { assets }).rejections).toEqual([]);
  });
});

describe('ai.video-editing: validatePlan rule 8, cooldown and count per video', () => {
  it('drops a repeat inside the cooldown when no other effect can stand in', () => {
    const r = run([video('e1', 'v_punch_in', 1000, 250), video('e2', 'v_punch_in', 3000, 250)], { level: 'basic' });
    expect(r.rejections).toEqual([rej('e2', 'v_punch_in', 8, 'cooldown', 'dropped')]);
  });

  it('swaps a repeat of a text effect for another text effect', () => {
    const r = run([HOOK, text('e2', 5)]);
    expect(r.rejections).toEqual([rej('e2', 'x_sticker', 8, 'swapped', 'repaired')]);
    expect(r.plan.items[1].effect).toBe('x_marker_sweep');
  });

  it('keeps a repeat after the cooldown', () => {
    const r = run([video('e1', 'v_punch_in', 1000, 250), video('e2', 'v_punch_in', 8000, 250)], { level: 'basic' });
    expect(r.rejections).toEqual([]);
  });

  it('allows at most max_per_video of one effect: the 4th use is swapped for another', () => {
    const items = [1000, 8000, 14500, 17500].map((t, k) => video(`e${k + 1}`, 'v_punch_in', t, 250));
    const r = run(items, { level: 'standard' });
    expect(r.rejections).toEqual([rej('e4', 'v_punch_in', 8, 'swapped', 'repaired')]);
    expect(r.plan.items[3].effect).toBe('v_push_in');
    expect(r.plan.items.filter((i) => i.effect === 'v_punch_in')).toHaveLength(3);
  });
});

// The context of a video of `ms`: one long free window after the protected span, the duration set everywhere it is read.
const lengthOf = (ms: number): { planOver: Partial<Plan>; ctx: Partial<ValidationContext> } => ({
  planOver: { video: { output_duration_ms: ms } },
  ctx: {
    request: { ...BASE.request, video: { ...BASE.request.video, duration_ms: ms } },
    windows: [
      { start_ms: 0, end_ms: 6000 },
      { start_ms: 7000, end_ms: ms },
    ],
    source_duration_ms: ms,
  },
});

describe('ai.video-editing: validatePlan rule 8, count per minute of video', () => {
  // An effect allowed 4 times a minute, used 5 times 5 s apart, in a video of `ms`.
  const longRun = (ms: number) => {
    const { planOver, ctx } = lengthOf(ms);
    const uses = [8000, 13000, 18000, 23000, 28000].map((t, k) => video(`a${k + 1}`, 'v_alt_crop', t, 2000));
    return run([HOOK, ...uses], planOver, ctx);
  };

  it('has an effect allowed 4 times a minute', () => {
    expect(effectById('v_alt_crop').max_per_video).toBe(4);
  });

  it('repairs or drops the 5th use in a 1-minute video', () => {
    const r = longRun(60000);
    expect(r.rejections.map((x) => [x.id, x.rule])).toEqual([['a5', 8]]);
    expect(r.plan.items.filter((i) => i.effect === 'v_alt_crop')).toHaveLength(4);
  });

  it('keeps the 5th use in a 2-minute video', () => {
    const r = longRun(120000);
    expect(r.rejections).toEqual([]);
    expect(r.plan.items.filter((i) => i.effect === 'v_alt_crop')).toHaveLength(5);
  });
});

describe('ai.video-editing: validatePlan rule 7, the budget grows with a long video', () => {
  // The hook and 10 more feature effects, 10 s apart: 11, one over the floor of Heavy.
  const eleven = [HOOK, ...Array.from({ length: 10 }, (_, k) => video(`m${k + 1}`, 'v_alt_crop', 8000 + 10000 * k, 2000))];

  it('keeps all 11 in a 3-minute video, where the budget of Heavy is 30', () => {
    const { planOver, ctx } = lengthOf(180000);
    const r = run(eleven, planOver, ctx);
    expect(r.rejections).toEqual([]);
    expect(r.plan.items).toHaveLength(11);
  });
});

describe('ai.video-editing: validatePlan rule 9, effects at the same moment', () => {
  it('shifts a third effect that would make 3 active, until the others have ended', () => {
    const items = [video('e1', 'v_punch_in', 1000, 250), video('e2', 'l_flash', 1000, 100), video('e3', 'l_rgb_glitch', 1000, 210)];
    const r = run(items, { level: 'standard' });
    // rule 18 then spaces the three out; the first stays where it was
    expect(ofRule(r, 9)).toEqual([rej('e3', 'l_rgb_glitch', 9, 'shifted', 'repaired')]);
    expect(r.plan.items).toHaveLength(3);
    expect(r.plan.items[0]).toMatchObject({ effect: 'v_punch_in', start_ms: 1000, end_ms: 1250 });
    expect(breathes(r.plan.items)).toBe(true);
  });

  it('allows two at once', () => {
    const r = run([video('e1', 'v_punch_in', 1000, 250), video('e2', 'l_flash', 1000, 100)], { level: 'standard' });
    expect(ofRule(r, 9)).toEqual([]);
  });

  it('shows one overlay at a time: shifts the second, or drops it when there is no room', () => {
    const label = (id: string, start: number): PlanItem =>
      text(id, 2, {
        effect: 'x_label_tag',
        params: params('x_label_tag'),
        anchor: undefined,
        start_ms: start,
        end_ms: start + 800,
        component: { type: 'styled_text', kind: 'keyword_echo', text: 'HELLO', style_preset: 'label_pill', color_slot: 1 },
      });
    const roomy = run([text('e1', 2), label('e2', 1500)]);
    expect(roomy.rejections).toEqual([rej('e2', 'x_label_tag', 9, 'shifted', 'repaired')]);
    expect(roomy.plan.items[1]).toMatchObject({ start_ms: 1820, end_ms: 2620 });
    const cramped = run([text('e1', 11, { anchor: undefined, start_ms: 5000, end_ms: 5800 }), label('e2', 5300)]);
    expect(cramped.rejections.filter((r) => r.action === 'dropped')).toEqual([rej('e2', 'x_label_tag', 9, 'overlay_overlap', 'dropped')]);
    expect(cramped.plan.items).toHaveLength(1);
  });

  it('never lets two cost H effects overlap', () => {
    const r = run([video('e1', 'p_bg_blur', 1000, 800), video('e2', 'p_outline_glow', 1000, 400)]);
    expect(r.rejections).toEqual([
      rej('e2', 'p_outline_glow', 9, 'shifted', 'repaired'),
      rej('e2', 'p_outline_glow', 18, 'breathing_gap', 'repaired'),
    ]);
    // rule 9 moved it to 1800, the end of the first; rule 18 leaves 1000 ms after that
    expect(r.plan.items[1]).toMatchObject({ start_ms: 2800, end_ms: 3200 });
  });
});

describe('ai.video-editing: validatePlan rule 10, hook', () => {
  it('warns when no strong effect starts in the first 3 seconds', () => {
    const r = run([video('e1', 'v_punch_in', 8000, 250)]);
    expect(r.warnings).toContain('hook_missing');
    expect(run([HOOK]).warnings).not.toContain('hook_missing');
  });

  it('does not count a transition as a hook', () => {
    const r = run([video('e1', 'tr_flash_cut', 1000, 210)]);
    expect(r.warnings).toContain('hook_missing');
  });
});

describe('ai.video-editing: validatePlan rule 11, pacing', () => {
  it('warns about a stretch longer than 3 seconds with no visible change', () => {
    const r = run([HOOK], { captions: { effect: 'c_word_highlight', emphasis_words: [] } });
    expect(r.warnings).toEqual(['pacing_gap:1020-19000']);
    expect(r.plan.warnings).toEqual(['pacing_gap:1020-19000']);
  });

  it('counts caption emphasis, effect starts and cuts as changes', () => {
    expect(run([HOOK]).warnings).toEqual([]);
    const cuts = { structure: { cuts: [{ src_start_ms: 9000, src_end_ms: 9500, reason: 'silence' }], speed_segments: [] }, video: { output_duration_ms: 18500 } };
    const r = run([HOOK], { ...cuts, captions: { effect: 'c_word_highlight', emphasis_words: [] } });
    expect(r.warnings).toEqual(['pacing_gap:1020-9000', 'pacing_gap:9000-18500']);
  });
});

describe('ai.video-editing: validatePlan rule 12, clip fit', () => {
  const clip = (native: number, dur: number, fit?: { mode: 'speed_up' | 'native'; factor: number }) =>
    icon('e2', 'i_scale_pop', 8000, dur, { type: 'icon_video', asset_id: 'L1', native_duration_ms: native, ...(fit ? { fit } : {}) });
  const assets = (native: number) => [...SOUNDS, { id: 'L1', kind: 'video' as const, url: 'u', native_duration_ms: native }];

  it('keeps a fit factor between 1 and 3', () => {
    const r = run([HOOK, clip(3000, 1500, { mode: 'speed_up', factor: 2 })], {}, { assets: assets(3000) });
    expect(r.rejections).toEqual([]);
  });

  it('drops a clip that would need more than 3 times speed even at the longest hold', () => {
    const r = run([HOOK, clip(9000, 1000, { mode: 'speed_up', factor: 9 })], {}, { assets: assets(9000) });
    expect(r.rejections).toEqual([rej('e2', 'i_scale_pop', 12, 'clip_too_long', 'dropped')]);
  });

  it('recomputes a wrong factor from the final duration', () => {
    const r = run([HOOK, clip(3000, 1500, { mode: 'speed_up', factor: 5 })], {}, { assets: assets(3000) });
    expect(r.rejections).toEqual([rej('e2', 'i_scale_pop', 12, 'fit_recomputed', 'repaired')]);
    expect(r.plan.items[1].component).toMatchObject({ fit: { mode: 'speed_up', factor: 2 } });
  });

  it('never slows a clip below its native speed', () => {
    const r = run([HOOK, clip(600, 1000, { mode: 'speed_up', factor: 0.6 })], {}, { assets: assets(600) });
    expect(r.plan.items[1].component).toMatchObject({ fit: { mode: 'native', factor: 1 } });
  });

  it('holds an icon for 2500 ms: a 7500 ms clip at 3 times speed stays, a longer hold is cut to 2500 ms', () => {
    const kept = run([HOOK, clip(7500, 2500, { mode: 'speed_up', factor: 3 })], {}, { assets: assets(7500) });
    expect(kept.rejections).toEqual([]);
    const cut = run([HOOK, clip(3240, 3000, { mode: 'speed_up', factor: 1.08 })], {}, { assets: assets(3240) });
    expect(cut.rejections).toEqual([
      rej('e2', 'i_scale_pop', 4, 'shortened', 'repaired'),
      rej('e2', 'i_scale_pop', 12, 'fit_recomputed', 'repaired'),
    ]);
    expect(cut.plan.items[1].end_ms - cut.plan.items[1].start_ms).toBe(2500);
    expect(cut.plan.items[1].component).toMatchObject({ fit: { mode: 'speed_up', factor: 1.3 } });
  });

  it('drops a clip of 8000 ms: even held 2500 ms it would need more than 3 times speed', () => {
    const r = run([HOOK, clip(8000, 2500)], {}, { assets: assets(8000) });
    expect(r.rejections).toEqual([rej('e2', 'i_scale_pop', 12, 'clip_too_long', 'dropped')]);
  });

  it('drops an icon the plan has no asset for', () => {
    const r = run([HOOK, clip(3000, 1500)], {}, { assets: SOUNDS });
    expect(r.rejections).toEqual([rej('e2', 'i_scale_pop', 1, 'asset_missing', 'dropped')]);
  });
});

describe('ai.video-editing: validatePlan rule 13, text', () => {
  const withText = (t: string, over: Partial<PlanItem> = {}) =>
    text('e1', 2, {
      component: { type: 'styled_text', kind: 'keyword_echo', text: t, style_preset: 'tilt_sticker', color_slot: 0 },
      ...over,
    });

  it('keeps a text of 1 to 4 words and cuts a longer one to 4', () => {
    expect(run([withText('ONE TWO THREE FOUR', { end_ms: 1020 + 1200 })]).rejections).toEqual([]);
    const r = run([withText('ONE TWO THREE FOUR FIVE', { end_ms: 1020 + 1200 })]);
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 13, 'text_truncated', 'repaired')]);
    expect((r.plan.items[0].component as { text: string }).text).toBe('ONE TWO THREE FOUR');
  });

  it('drops an empty text', () => {
    expect(run([withText('   ')]).rejections).toEqual([rej('e1', 'x_sticker', 13, 'text_empty', 'dropped')]);
  });

  it('drops a text with a banned word of the brand, whatever its case', () => {
    expect(run([HOOK], {}, { banned_words: ['spam'] }).rejections).toEqual([]);
    const r = run([HOOK], {}, { banned_words: ['hello'] });
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 13, 'banned_word', 'dropped')]);
  });

  it('holds a text 500 ms plus 150 ms a word at least', () => {
    const r = run([withText('ONE TWO THREE', { end_ms: 1020 + 600 })]);
    expect(r.plan.items[0].end_ms - r.plan.items[0].start_ms).toBe(950);
    const long = run([withText('HELLO', { end_ms: 1020 + 3000 })]);
    expect(long.plan.items[0].end_ms - long.plan.items[0].start_ms).toBe(2500);
  });

  it('uses the look the effect is bound to and a colour the palette has', () => {
    const glow = withText('HELLO', {
      component: { type: 'styled_text', kind: 'keyword_echo', text: 'HELLO', style_preset: 'glow', color_slot: 9 },
    });
    const r = run([glow]);
    expect(r.rejections).toEqual([
      rej('e1', 'x_sticker', 13, 'style_fixed', 'repaired'),
      rej('e1', 'x_sticker', 13, 'color_slot_fixed', 'repaired'),
    ]);
    expect(r.plan.items[0].component).toMatchObject({ style_preset: 'tilt_sticker', color_slot: 4 });
  });

  it('drops a text whose look the phone cannot draw', () => {
    const caps = { effects: CAPS.effects, text_styles: ['glow'] };
    const r = run([HOOK], {}, { request: { ...BASE.request, capabilities: caps } });
    expect(r.rejections).toEqual([rej('e1', 'x_sticker', 13, 'style_not_in_capabilities', 'dropped')]);
  });
});

describe('ai.video-editing: validatePlan rule 13, a look for a text that names none (TS13)', () => {
  it('gives an effect bound to no look, whose text names no look the phone knows, a look with a background', () => {
    const none = text('e1', 2, {
      effect: 'x_pop',
      params: params('x_pop'),
      component: { type: 'styled_text', kind: 'keyword_echo', text: 'HELLO', style_preset: undefined as unknown as string, color_slot: 0 },
    });
    const r = run([none]);
    expect(r.rejections).toEqual([rej('e1', 'x_pop', 13, 'style_fixed', 'repaired')]);
    const look = textLookById((r.plan.items[0].component as { style_preset: string }).style_preset);
    expect(look && hasBackground(look)).toBe(true);
    expect(r.plan.items[0].component).toMatchObject({ style_preset: 'label_pill' });
  });
});

describe('ai.video-editing: validatePlan rule 13, the feature gate (card S9)', () => {
  const withCaps = (caps: object, items = [HOOK]) =>
    run(items, {}, { looks: GATED_LOOKS, request: { ...BASE.request, capabilities: { ...CAPS, ...caps } } });
  const glowText = (look: string) =>
    text('e1', 2, { component: { type: 'styled_text', kind: 'keyword_echo', text: 'HELLO', style_preset: look, color_slot: 0 } });
  // the gated look is label_pill, the look x_label_tag is bound to
  const boundText = { ...glowText(GATED_LOOK_ID), effect: 'x_label_tag', params: params('x_label_tag') };

  it('swaps a look needing a feature the phone lacks for one it draws, whether the list is absent, null or empty', () => {
    // x_pop is bound to no look, so the item can take another one
    const free = { ...glowText(GATED_LOOK_ID), effect: 'x_pop', params: params('x_pop') };
    for (const features of [undefined, null, []]) {
      const r = withCaps({ text_features: features }, [free]);
      expect(r.rejections).toEqual([rej('e1', 'x_pop', 13, 'style_fixed', 'repaired')]);
      // the first look the phone draws that has a background (the table starts with the ones that have none)
      expect(r.plan.items[0].component).toMatchObject({ style_preset: 'highlighter' });
    }
    const listed = withCaps({ text_features: [GATED_LOOK_FEATURE] }, [free]);
    expect(listed.rejections).toEqual([]);
    expect(listed.plan.items[0].component).toMatchObject({ style_preset: GATED_LOOK_ID });
  });

  it('drops a text whose bound look needs a feature the phone lacks, with a reason code', () => {
    for (const features of [undefined, null, [], ['opacity']]) {
      const r = withCaps({ text_features: features }, [boundText]);
      expect(r.plan.items).toEqual([]);
      expect(r.rejections).toEqual([rej('e1', 'x_label_tag', 13, 'style_not_in_capabilities', 'dropped')]);
    }
  });

  it('keeps the text once the phone lists every feature of the look', () => {
    const r = withCaps({ text_features: [GATED_LOOK_FEATURE] }, [boundText]);
    expect(r.rejections).toEqual([]);
    expect(r.plan.items).toHaveLength(1);
  });

  it('drops a text when no look the phone lists is usable at all', () => {
    const r = withCaps({ text_styles: [GATED_LOOK_ID] }, [HOOK]);
    expect(r.plan.items).toEqual([]);
    expect(r.rejections.map((x) => x.code)).toEqual(['style_not_in_capabilities']);
  });
});

describe('ai.video-editing: validatePlan rule 14, anchors', () => {
  it('drops an item anchored on a word that does not exist', () => {
    const r = run([HOOK, video('e2', 'v_punch_in', 8000, 250, { anchor: { word_index: 999, offset_ms: 0 } })]);
    expect(r.rejections).toEqual([rej('e2', 'v_punch_in', 14, 'anchor_missing', 'dropped')]);
  });

  it('trusts the anchor when the time disagrees and recomputes the time', () => {
    const r = run([HOOK, video('e2', 'v_punch_in', 4800, 250, { anchor: { word_index: 10, offset_ms: 0 } })]);
    expect(r.rejections).toEqual([rej('e2', 'v_punch_in', 14, 'anchor_retimed', 'repaired')]);
    expect(r.plan.items[1]).toMatchObject({ start_ms: 4700, end_ms: 4950 });
  });

  it('drops emphasis words that do not exist, and repeats', () => {
    const r = run([HOOK], { captions: { effect: 'c_word_highlight', emphasis_words: [...EMPHASIS, 999, 5] } });
    expect(r.plan.captions.emphasis_words).toEqual(EMPHASIS);
    expect(r.rejections).toEqual([rej('captions', 'c_word_highlight', 14, 'emphasis_word_missing', 'repaired')]);
  });
});

describe('ai.video-editing: validatePlan rule 15, cuts and speed against protected spans', () => {
  it('warns about a cut inside a protected span and not about one outside', () => {
    const inside = run([HOOK], {
      structure: { cuts: [{ src_start_ms: 6200, src_end_ms: 6600, reason: 'silence' }], speed_segments: [] },
      video: { output_duration_ms: 18600 },
    });
    expect(inside.warnings).toContain('cut_in_protected_span:6200-6600');
    const outside = run([HOOK], {
      structure: { cuts: [{ src_start_ms: 3000, src_end_ms: 3500, reason: 'silence' }], speed_segments: [] },
      video: { output_duration_ms: 18500 },
    });
    expect(outside.warnings.filter((w) => w.startsWith('cut_in'))).toEqual([]);
  });

  it('warns about a speed segment inside a protected span', () => {
    const r = run([HOOK], {
      structure: { cuts: [], speed_segments: [{ src_start_ms: 6100, src_end_ms: 6900, rate: 1.4 }] },
      video: { output_duration_ms: 18771 },
    });
    expect(r.warnings).toContain('speed_in_protected_span:6100-6900');
  });

  it('warns when the output duration does not match the structure', () => {
    const r = run([HOOK], { video: { output_duration_ms: 12000 } });
    expect(r.warnings).toContain('duration_mismatch');
  });
});

describe('ai.video-editing: validatePlan rule 16, order and ids', () => {
  it('sorts by start and gives a repeated id a new one', () => {
    const r = run([video('e1', 'v_punch_in', 8000, 250), video('e1', 'l_flash', 1000, 100)], { level: 'standard' });
    expect(r.plan.items.map((i) => [i.id, i.effect])).toEqual([
      ['e1', 'l_flash'],
      ['e2', 'v_punch_in'],
    ]);
    expect(r.rejections).toEqual([rej('e1', 'v_punch_in', 16, 'id_renamed', 'repaired')]);
  });

  it('keeps ids that are already unique and in order', () => {
    const r = run([video('e1', 'l_flash', 1000, 100), video('e2', 'v_punch_in', 8000, 250)], { level: 'standard' });
    expect(r.rejections).toEqual([]);
    expect(r.plan.items.map((i) => i.id)).toEqual(['e1', 'e2']);
  });
});

// The effects of the director's moments (task TS7). The sentences end after words 9 and 19, so a sentence starts at 4700 and
// at 9200 ms (the words are 150 ms apart, so no word gap is a pause).
const SENTENCES: EditWord[] = WORDS.map((w) => (w.i === 9 || w.i === 19 ? { ...w, w: `${w.w}.` } : w));

describe('ai.video-editing: validatePlan rule 3, an effect that may sit in a drawing (task TS7)', () => {
  it('keeps an in-drawing effect inside a protected span, where the same time moves any other effect', () => {
    // 6000 to 7000 ms is the protected span between the two free windows
    const r = run([HOOK, video('e2', 'f_step_aside', 6000, 1000), video('e3', 'v_spotlight', 6000, 1000)], {}, { drawing_pairs: [['e2', 'e3']] });
    expect(r.rejections).toEqual([]);
    expect(r.plan.items.slice(1).map((i) => [i.effect, i.start_ms, i.end_ms])).toEqual([
      ['f_step_aside', 6000, 7000],
      ['v_spotlight', 6000, 7000],
    ]);
    const other = run([HOOK, video('e2', 'f_roll', 6000, 1000)]);
    expect(other.rejections).toEqual([rej('e2', 'f_roll', 3, 'shifted', 'repaired')]);
  });
});

describe('ai.video-editing: validatePlan rule 5, enums, fill colour and the spotlight box (task TS7)', () => {
  const aside = (over: Record<string, string | number>) =>
    video('e2', 'f_step_aside', 8000, 1000, { params: { ...params('f_step_aside'), ...over } });

  it('resets a string param outside the entry enum to its first value, and keeps any listed value', () => {
    const bad = run([HOOK, aside({ direction: 'up', motion: 'wobble' })]);
    expect(bad.rejections).toEqual([
      rej('e2', 'f_step_aside', 5, 'param_enum_reset', 'repaired'),
      rej('e2', 'f_step_aside', 5, 'param_enum_reset', 'repaired'),
    ]);
    expect(bad.plan.items[1].params).toMatchObject({ direction: 'down', motion: 'slide' });
    const wrongType = run([HOOK, aside({ direction: 3 })]);
    expect(wrongType.rejections).toEqual([rej('e2', 'f_step_aside', 5, 'param_enum_reset', 'repaired')]);
    const last = run([HOOK, aside({ direction: 'right', motion: 'roll' })]);
    expect(last.rejections).toEqual([]);
    expect(last.plan.items[1].params).toMatchObject({ direction: 'right', motion: 'roll' });
  });

  it('resets a fill colour that is not #RRGGBB to #000000, and keeps one that is', () => {
    for (const bad of ['red', '#12345', '#1234567', '#12345G', 5]) {
      const r = run([HOOK, aside({ fill_color: bad })]);
      expect(r.rejections).toEqual([rej('e2', 'f_step_aside', 5, 'fill_color_reset', 'repaired')]);
      expect(r.plan.items[1].params.fill_color).toBe('#000000');
    }
    const ok = run([HOOK, aside({ fill_color: '#abCDef' })]);
    expect(ok.rejections).toEqual([]);
    expect(ok.plan.items[1].params.fill_color).toBe('#abCDef');
  });

  it('keeps the spotlight box inside the frame: x + w and y + h at most 1, the size kept', () => {
    const spot = (over: Record<string, number>) =>
      video('e2', 'v_spotlight', 8000, 1000, { params: { ...params('v_spotlight'), ...over } });
    const r = run([HOOK, spot({ x: 0.8, w: 0.5, y: 0.9, h: 0.5 })]);
    expect(r.rejections).toEqual([
      rej('e2', 'v_spotlight', 5, 'param_box_fixed', 'repaired'),
      rej('e2', 'v_spotlight', 5, 'param_box_fixed', 'repaired'),
    ]);
    expect(r.plan.items[1].params).toMatchObject({ x: 0.5, w: 0.5, y: 0.5, h: 0.5 });
    // a box that fits exactly, and the default full-frame box, are left alone
    expect(run([HOOK, spot({ x: 0.25, w: 0.75, y: 0.5, h: 0.5 })]).rejections).toEqual([]);
    expect(run([HOOK, spot({})]).rejections).toEqual([]);
  });
});

describe('ai.video-editing: validatePlan rule 17, face moves (task TS7)', () => {
  const inSentences = { words: SENTENCES };

  it('keeps a face move for a sentence that starts at a pause or within 600 ms of one', () => {
    const at = run([HOOK, video('e2', 'f_hero', 9200, 2000)], {}, inSentences);
    expect(at.rejections).toEqual([]);
    const near = run([HOOK, video('e2', 'f_hero', 9700, 2000)], {}, inSentences);
    expect(near.rejections).toEqual([]);
    expect(near.plan.items[1].start_ms).toBe(9700);
  });

  it('keeps a face move that starts in a word gap of 200 ms or more', () => {
    // word 20 starts 250 ms after word 19 ends (150 ms in the plain words): the pause is 9050 to 9300 and no word ends a sentence
    const gap = WORDS.map((w) => (w.i >= 20 ? { ...w, start_ms: w.start_ms + 100, end_ms: w.end_ms + 100 } : w));
    expect(run([HOOK, video('e2', 'f_hero', 9800, 2000)], {}, { words: gap }).rejections).toEqual([]);
    // the same start is mid-phrase when the gap is 150 ms
    expect(run([HOOK, video('e2', 'f_hero', 9800, 2000)]).rejections).toEqual([
      rej('e2', 'f_hero', 17, 'face_move_mid_phrase', 'dropped'),
    ]);
  });

  it('shifts a face move that starts in the middle of a phrase to the nearest pause', () => {
    const r = run([HOOK, video('e2', 'f_hero', 10000, 2000)], {}, inSentences);
    expect(r.rejections).toEqual([rej('e2', 'f_hero', 17, 'face_move_mid_phrase', 'repaired')]);
    expect(r.plan.items[1]).toMatchObject({ start_ms: 9200, end_ms: 11200 });
  });

  it('moves the anchor offset of a shifted face move with it', () => {
    const anchored = video('e2', 'f_hero', 10000, 2000, { anchor: { word_index: 22, offset_ms: 10000 - WORDS[22].start_ms } });
    const r = run([HOOK, anchored], {}, inSentences);
    expect(r.rejections).toEqual([rej('e2', 'f_hero', 17, 'face_move_mid_phrase', 'repaired')]);
    expect(r.plan.items[1].anchor).toEqual({ word_index: 22, offset_ms: 9200 - WORDS[22].start_ms });
  });

  it('drops a face move that starts far from every pause', () => {
    const r = run([HOOK, video('e2', 'f_hero', 12500, 2000)], {}, inSentences);
    expect(r.rejections).toEqual([rej('e2', 'f_hero', 17, 'face_move_mid_phrase', 'dropped')]);
    expect(r.plan.items).toHaveLength(1);
  });

  it('drops a face move whose nearest pause leaves no free window for it', () => {
    // the window ends at 5000: the move is first shifted to 3500 to 5000, 1200 ms before the pause at 4700, and from there
    // it would end at 6200
    const windows = [{ start_ms: 0, end_ms: 5000 }, { start_ms: 7000, end_ms: 19000 }];
    const r = run([HOOK, video('e2', 'f_hero', 4000, 1500)], {}, { words: SENTENCES, windows });
    expect(r.rejections.filter((x) => x.rule === 17)).toEqual([rej('e2', 'f_hero', 17, 'face_move_mid_phrase', 'dropped')]);
  });

  it('asks nothing of a face move that is not for a sentence', () => {
    // f_roll serves a chapter and f_dodge a drawing: they start where the moment says, mid-phrase or not
    const r = run([HOOK, video('e2', 'f_roll', 8000, 900), video('e3', 'f_dodge', 12500, 1000)], {}, inSentences);
    expect(r.rejections).toEqual([]);
  });

  it('shortens a face move to end where an overlapping layout effect starts', () => {
    const r = run([HOOK, video('e2', 'f_hero', 9200, 2000), video('e3', 'y_face_grow_slide_shrink', 10600, 1000)], {}, inSentences);
    expect(r.rejections).toEqual([
      rej('e2', 'f_hero', 17, 'face_move_overlap', 'repaired'),
      rej('e3', 'y_face_grow_slide_shrink', 18, 'breathing_gap', 'repaired'),
    ]);
    // the layout effect then waits 1000 ms after the shortened move (rule 18)
    expect(r.plan.items.slice(1).map((i) => [i.effect, i.start_ms, i.end_ms])).toEqual([
      ['f_hero', 9200, 10600],
      ['y_face_grow_slide_shrink', 11600, 12600],
    ]);
  });

  it('shortens the earlier of two overlapping face moves, and keeps two that only touch', () => {
    const r = run([HOOK, video('e2', 'f_roll', 8000, 1400), video('e3', 'f_dodge', 8900, 1000)]);
    expect(ofRule(r, 17)).toEqual([rej('e2', 'f_roll', 17, 'face_move_overlap', 'repaired')]);
    expect(r.plan.items[1]).toMatchObject({ effect: 'f_roll', start_ms: 8000, end_ms: 8900 });
    const touching = run([HOOK, video('e2', 'f_roll', 8000, 900), video('e3', 'f_dodge', 8900, 1000)]);
    expect(ofRule(touching, 17)).toEqual([]);
  });

  it('shortens a face move to end where an overlapping facecam effect of a slot starts', () => {
    const r = run([HOOK, video('e2', 'f_roll', 8000, 1400), video('e3', 'f_pulse', 8900, 300)]);
    expect(ofRule(r, 17)).toEqual([rej('e2', 'f_roll', 17, 'face_move_overlap', 'repaired')]);
    expect(r.plan.items[1].end_ms).toBe(8900);
  });

  it('drops a face move when it would be left shorter than its minimum', () => {
    const r = run([HOOK, video('e2', 'f_hero', 9200, 1200), video('e3', 'y_face_grow_slide_shrink', 9800, 1000)], {}, inSentences);
    expect(r.rejections).toEqual([rej('e2', 'f_hero', 17, 'face_move_overlap', 'dropped')]);
    expect(r.plan.items.map((i) => i.effect)).toEqual(['x_sticker', 'y_face_grow_slide_shrink']);
  });

  it('drops a face move that starts inside an effect that is already moving the face', () => {
    const r = run([HOOK, video('e2', 'y_slide_grow_face_shrink', 8000, 1000), video('e3', 'f_roll', 8500, 1000)]);
    expect(r.rejections).toEqual([rej('e3', 'f_roll', 17, 'face_move_overlap', 'dropped')]);
  });

  it('leaves two effects that do not move the face to the other rules', () => {
    const r = run([HOOK, video('e2', 'f_roll', 8000, 1000), video('e3', 'v_spotlight', 8200, 1000)]);
    expect(ofRule(r, 17)).toEqual([]);
  });
});

describe('ai.video-editing: validatePlan, a swap never lands on a moment-only effect (task TS7)', () => {
  // A phone that draws only the effects below: the one a swap could land on is `v_spotlight`, or a chapter transition.
  const caps = {
    ...CAPS,
    effects: CAPS.effects.filter((id) =>
      ['c_', 'x_sticker', 'v_punch_in', 'v_spotlight', 'tr_whip', 'tr_push', 'tr_dip_color'].some((p) => id.startsWith(p))
    ),
  };
  const phone = { request: { ...BASE.request, capabilities: caps } };

  it('drops a repeat of a camera effect instead of swapping it into the spotlight', () => {
    const r = run([HOOK, video('e2', 'v_punch_in', 8000, 250), video('e3', 'v_punch_in', 10000, 250)], {}, phone);
    expect(r.rejections).toEqual([rej('e3', 'v_punch_in', 8, 'cooldown', 'dropped')]);
  });

  it('drops a repeat of a cut transition instead of swapping it into a chapter transition', () => {
    const r = run([HOOK, video('e2', 'tr_whip', 8000, 200), video('e3', 'tr_whip', 9000, 200)], {}, phone);
    expect(r.rejections).toEqual([rej('e3', 'tr_whip', 8, 'cooldown', 'dropped')]);
  });

  it('drops a moment-only effect that fails its cooldown, where a slot effect would be swapped', () => {
    const r = run([HOOK, video('e2', 'f_step_aside', 8000, 1000), video('e3', 'f_step_aside', 10000, 1000)]);
    expect(r.rejections).toEqual([rej('e3', 'f_step_aside', 8, 'cooldown', 'dropped')]);
  });
});

describe('ai.video-editing: validatePlan rule 19, flash spacing (task TS9b)', () => {
  it('keeps one of two flashes 3 s apart, the earlier, and keeps two 8 s apart', () => {
    const near = run([HOOK, video('e2', 'l_flash', 8000, 100), video('e3', 'tr_flash_cut', 11000, 210)]);
    expect(near.rejections).toEqual([rej('e3', 'tr_flash_cut', 19, 'flash_spacing', 'dropped')]);
    expect(near.plan.items.map((i) => i.effect)).toEqual(['x_sticker', 'l_flash']);
    const apart = run([HOOK, video('e2', 'l_flash', 8000, 100), video('e3', 'tr_flash_cut', 16000, 210)]);
    expect(apart.rejections).toEqual([]);
  });

  it('does not count a dark dip to colour as a flash, and counts a light one', () => {
    const dark = run([HOOK, video('e2', 'l_flash', 8000, 100), video('e3', 'tr_dip_color', 11000, 400)]);
    expect(dark.rejections).toEqual([]);
    const darkGrey = video('e3', 'tr_dip_color', 11000, 400, { params: { color: '#666666' } });
    expect(run([HOOK, video('e2', 'l_flash', 8000, 100), darkGrey]).rejections).toEqual([]);
    const light = video('e3', 'tr_dip_color', 11000, 400, { params: { color: '#CCCCCC' } });
    expect(run([HOOK, video('e2', 'l_flash', 8000, 100), light]).rejections).toEqual([
      rej('e3', 'tr_dip_color', 19, 'flash_spacing', 'dropped'),
    ]);
  });
});

describe('ai.video-editing: validatePlan rule 18, breathing gap (task TS9b)', () => {
  it('moves a face move that starts 200 ms after a flash to 1000 ms after the flash', () => {
    const items = [HOOK, video('e2', 'l_flash', 8000, 100), video('e3', 'f_roll', 8300, 700)];
    const r = run(items);
    expect(r.rejections).toEqual([rej('e3', 'f_roll', 18, 'breathing_gap', 'repaired')]);
    expect(r.plan.items[2]).toMatchObject({ effect: 'f_roll', start_ms: 9100, end_ms: 9800 });
    // the answer is already spaced: validating it again changes nothing
    const again = validatePlan(r.plan, BASE);
    expect(again.rejections).toEqual([]);
    expect(again.plan.items).toEqual(r.plan.items);
  });

  it('drops the later item when it cannot move 1000 ms later inside its window', () => {
    const windows = [
      { start_ms: 0, end_ms: 6000 },
      { start_ms: 7000, end_ms: 9500 },
    ];
    const r = run([HOOK, video('e2', 'l_flash', 8000, 100), video('e3', 'f_roll', 8300, 700)], {}, { windows });
    expect(r.rejections).toEqual([rej('e3', 'f_roll', 18, 'breathing_gap', 'dropped')]);
    expect(r.plan.items.map((i) => i.effect)).toEqual(['x_sticker', 'l_flash']);
  });

  it('drops a transition that is too close to the item before it, since it stays at its cut', () => {
    const r = run([HOOK, video('e2', 'v_punch_in', 8000, 250), video('e3', 'tr_whip', 8600, 200)]);
    expect(r.rejections).toEqual([rej('e3', 'tr_whip', 18, 'breathing_gap', 'dropped')]);
  });

  it('keeps items that are 1000 ms apart end to start, and counts an overlap as too close', () => {
    expect(run([HOOK, video('e2', 'v_punch_in', 8000, 250), video('e3', 'v_push_in', 9250, 500)]).rejections).toEqual([]);
    const r = run([HOOK, video('e2', 'v_punch_in', 8000, 250), video('e3', 'v_push_in', 8100, 500)]);
    expect(r.rejections.map((x) => [x.id, x.rule, x.code])).toEqual([['e3', 18, 'breathing_gap']]);
    expect(breathes(r.plan.items)).toBe(true);
  });

  it('lets the face and screen items of one drawing moment share time, whether or not they end together', () => {
    const pair = [video('e2', 'f_step_aside', 8000, 1200), video('e3', 'v_spotlight', 8000, 1000)];
    expect(run([HOOK, ...pair], {}, { drawing_pairs: [['e2', 'e3']] }).rejections).toEqual([]);
    expect(run([HOOK, ...pair], {}, { drawing_pairs: [['e3', 'e2']] }).rejections).toEqual([]);
    // without the pair, the later one moves 1000 ms after the first
    const alone = run([HOOK, ...pair]);
    expect(alone.rejections).toEqual([rej('e3', 'v_spotlight', 18, 'breathing_gap', 'repaired')]);
    expect(alone.plan.items[2]).toMatchObject({ effect: 'v_spotlight', start_ms: 10200 });
  });

  it('still spaces another item from a drawing pair', () => {
    const pair = [video('e2', 'f_step_aside', 8000, 1200), video('e3', 'v_spotlight', 8000, 1000)];
    const r = run([HOOK, ...pair, video('e4', 'v_punch_in', 9500, 250)], {}, { drawing_pairs: [['e2', 'e3']] });
    expect(r.rejections.map((x) => [x.id, x.rule])).toEqual([['e4', 18]]);
  });

  it('never touches a text or an icon, whatever is near it', () => {
    // the hook text is shown 1020 to 1820 ms; the punch in starts inside it
    const r = run([HOOK, video('e2', 'v_punch_in', 1100, 250)]);
    expect(r.rejections).toEqual([]);
    expect(r.plan.items[0]).toEqual(HOOK);
    expect(r.plan.items[1]).toMatchObject({ start_ms: 1100, end_ms: 1350 });
    const assets = [...SOUNDS, { id: 'a1', kind: 'icon' as const, url: 'u' }];
    const withIcon = [HOOK, icon('e2', 'i_scale_pop', 8000, 1000, { type: 'icon_image', asset_id: 'a1' }), video('e3', 'v_punch_in', 8100, 250)];
    const i = run(withIcon, {}, { assets });
    expect(i.rejections.filter((x) => x.id === 'e2')).toEqual([]);
    expect(i.plan.items.find((x) => x.id === 'e2')).toMatchObject({ start_ms: 8000, end_ms: 9000 });
  });
});
