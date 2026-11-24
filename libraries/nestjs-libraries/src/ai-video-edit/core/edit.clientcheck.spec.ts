// AI video editing (ai.video-editing): the client check (tracing card L4), one passing and one failing plan for every lint,
// on a small hand-built plan. Needs no database and no Nest.
import { Plan, PlanAsset, PlanItem } from '../contract/edit.contract';
import { TEXT_LOOKS, lookExtent } from '../contract/edit.styles';
import {
  AssetProbe,
  CheckCode,
  CheckResult,
  ClientCheckInput,
  TEXT_FIT,
  clientCheck,
  isUnusable,
  unreachableAssets,
} from './edit.clientcheck';
import { OVERLAY_SIZE } from './edit.geometry';
import {
  ALL_OUTPUTS,
  FULL_CAPABILITIES,
  GATED_LOOKS,
  GATED_LOOK_FEATURE,
  GATED_LOOK_ID,
} from './fixtures/edit.golden.fixtures';

const DURATION = 10000;

// A styled text item of the sticker look in a zone, 1000 ms from `start`.
const text = (id: string, words: string, over: Partial<PlanItem> = {}, style = 'sticker', start = 1000): PlanItem => ({
  id,
  effect: 'x_sticker',
  layer: 'text',
  target: 'overlay',
  start_ms: start,
  end_ms: start + 1000,
  position: { zone: 'upper_center' },
  component: { type: 'styled_text', kind: 'keyword_echo', text: words, style_preset: style, color_slot: 0 },
  params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: style },
  ...over,
});

// An icon item using an asset.
const icon = (id: string, assetId: string, over: Partial<PlanItem> = {}): PlanItem => ({
  id,
  effect: 'i_scale_pop',
  layer: 'icon',
  target: 'overlay',
  start_ms: 5000,
  end_ms: 6000,
  position: { zone: 'middle_center' },
  component: { type: 'icon_image', asset_id: assetId },
  params: {},
  ...over,
});

// A plan with a facecam far from every overlay zone, the three captions words stressed and no cuts.
const plan = (items: PlanItem[], over: Partial<Plan> = {}): Plan => ({
  contract_version: 2,
  plan_version: 1,
  session_id: 's',
  level: 'heavy',
  video: { output_duration_ms: DURATION },
  structure: { cuts: [], speed_segments: [] },
  facecam_track: [{ t_ms: 0, cx: 0.85, cy: 0.95, radius: 0.08 }],
  palette: { mode: 'multi', colors: ['#FF3B30'] },
  items,
  captions: { effect: 'c_word_highlight', emphasis_words: [0, 1, 2] },
  warnings: [],
  ...over,
});

const ASSETS: PlanAsset[] = [
  { id: 'icon-1', kind: 'icon', url: 'https://cdn.test/icon-1.png' },
  { id: 'pop_1', kind: 'sound', url: 'https://cdn.test/pop_1.wav' },
];

// The check of a plan with the request's size and outputs, the source duration and 10 output words.
const check = (p: Plan, over: Partial<ClientCheckInput> = {}) =>
  clientCheck({
    plan: p,
    assets: ASSETS,
    video: { width: 1080, height: 2400 },
    outputs: ALL_OUTPUTS,
    source_duration_ms: DURATION,
    word_count: 10,
    ...over,
  });

// The codes found, in order.
const codes = (results: CheckResult[]) => results.map((r) => r.code);

describe('ai.video-editing: client check', () => {
  it('finds nothing in a plan the phone can draw', () => {
    const results = check(plan([text('t1', 'KEYBOARD'), icon('i1', 'icon-1'), text('t2', 'SAVE TIME', {}, 'label_pill', 7000)]));

    expect(results).toEqual([]);
  });

  describe.each<[CheckCode, Plan, Partial<ClientCheckInput>?]>([
    ['asset_unresolved', plan([icon('i1', 'missing-icon')])],
    ['asset_unresolved', plan([text('t1', 'KEYBOARD', { sound: { id: 'ghost', offset_ms: 0 } })])],
    ['unknown_zone', plan([text('t1', 'KEYBOARD', { position: { zone: 'nowhere' as any } })])],
    ['unknown_zone', plan([text('t1', 'KEYBOARD', { position: undefined })])],
    ['unknown_style', plan([text('t1', 'KEYBOARD', {}, 'neon')])],
    ['unknown_effect', plan([text('t1', 'KEYBOARD', { effect: 'x_nothing' })])],
    ['unknown_effect', plan([], { captions: { effect: 'x_sticker', emphasis_words: [] } })],
    ['unknown_entry', plan([text('t1', 'KEYBOARD', { params: { entry: 'explode' } })])],
    ['unknown_motion', plan([text('t1', 'KEYBOARD', { params: { entry: 'fade', hold: 'spin' } })])],
    ['unknown_motion', plan([text('t1', 'KEYBOARD', { params: { entry: 'pop', exit: 'slide_out', exit_dir: 'sideways' } })])],
    ['out_of_range', plan([text('t1', 'KEYBOARD', { end_ms: DURATION + 500 })])],
    ['out_of_range', plan([text('t1', 'KEYBOARD', { start_ms: -10, end_ms: 800 })])],
    ['bad_range', plan([text('t1', 'KEYBOARD', { start_ms: 3000, end_ms: 3000 })])],
    ['bad_range', plan([text('t1', 'KEYBOARD', { start_ms: 4000, end_ms: 3000 })])],
    ['layer_overlap', plan([text('t1', 'KEYBOARD'), text('t2', 'SHORTCUTS', {}, 'sticker', 1500)])],
    ['layer_overlap', plan([text('t1', 'KEYBOARD', { end_ms: 5500 }), icon('i1', 'icon-1')])],
    ['emphasis_out_of_range', plan([], { captions: { effect: 'c_word_highlight', emphasis_words: [3, 10] } })],
    ['emphasis_out_of_range', plan([], { captions: { effect: 'c_word_highlight', emphasis_words: [-1] } })],
    ['no_facecam_track', plan([], { facecam_track: [] })],
    ['duration_mismatch', plan([], { video: { output_duration_ms: DURATION - 500 } })],
    ['duration_mismatch', plan([], { structure: { cuts: [{ src_start_ms: 0, src_end_ms: 2000, reason: 'silence' }], speed_segments: [] } })],
    ['text_may_wrap', plan([text('t1', 'SAVE TIME EVERY WEEK', {}, 'label_pill')])],
    ['text_may_wrap', plan([text('t1', 'EVERYONE LOVES KEYBOARDS', {}, 'label_pill')])],
    ['text_may_wrap', plan([text('t1', 'ABCDEFGHIJKLMNOPQRS', {}, 'label_pill')])],
    ['text_too_wide', plan([text('t1', 'EXTRAORDINARILYLONGWORD')])],
  ])('%s', (code, bad) => {
    it('is found in a failing plan', () => {
      expect(codes(check(bad))).toContain(code);
    });
  });

  it('names the item and gives counts and codes in the detail, never the text', () => {
    const results = check(plan([text('t1', 'EVERYONE LOVES KEYBOARDS', {}, 'label_pill')]));

    const wrap = results.find((r) => r.code === 'text_may_wrap');
    expect(wrap).toMatchObject({
      item_id: 't1',
      severity: 'warning',
      detail: 'style=label_pill chars=24 max_chars=18 words=3 max_words=3',
    });
    expect(JSON.stringify(results)).not.toContain('KEYBOARDS');
  });

  describe('the feature gate (card S9)', () => {
    const sticker = () => plan([text('t1', 'KEYBOARD')]);

    it('finds nothing when no capabilities are given, or the phone lists the look and no feature the shipped looks need', () => {
      expect(check(sticker())).toEqual([]);
      expect(check(sticker(), { capabilities: FULL_CAPABILITIES })).toEqual([]);
    });

    it('finds a look the phone did not list, with codes and counts only', () => {
      const text_styles = FULL_CAPABILITIES.text_styles.filter((id) => id !== 'sticker');
      const results = check(sticker(), { capabilities: { text_styles } });
      expect(results).toEqual([
        { code: 'style_not_in_capabilities', item_id: 't1', severity: 'error', detail: 'style=sticker listed=0 missing_features=0' },
      ]);
      expect(isUnusable(results)).toBe(true);
    });

    it('finds a look whose feature the phone did not list, whether the list is absent, null or empty', () => {
      for (const text_features of [undefined, null, [], ['opacity']]) {
        const results = check(sticker(), {
          capabilities: { text_styles: FULL_CAPABILITIES.text_styles, text_features },
          looks: GATED_LOOKS,
        });
        expect(results).toEqual([
          { code: 'style_not_in_capabilities', item_id: 't1', severity: 'error', detail: `style=${GATED_LOOK_ID} listed=1 missing_features=1` },
        ]);
      }
    });

    it('holds the look once the phone lists its feature', () => {
      const capabilities = { text_styles: FULL_CAPABILITIES.text_styles, text_features: [GATED_LOOK_FEATURE] };
      expect(check(sticker(), { capabilities, looks: GATED_LOOKS })).toEqual([]);
    });
  });

  describe('text fit', () => {
    it('flags a 3-word pill label over the pill characters, and holds a short one', () => {
      expect(codes(check(plan([text('t1', 'EVERYONE LOVES KEYBOARDS', {}, 'label_pill')])))).toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'EVERYONE LOVES KEYBOARDS', {}, 'sticker')])))).toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'LOVE YOUR KEYS', {}, 'label_pill')])))).not.toContain('text_may_wrap');
    });

    it('flags a label over the pill words, not the same label in a look that takes more', () => {
      // 4 words in a pill: over the pill's 3, within a sticker's 4
      expect(codes(check(plan([text('t1', 'SAVE TIME EVERY WEEK', {}, 'label_pill')])))).toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'SAVE TIME EVERY WEEK', {}, 'sticker')])))).not.toContain('text_may_wrap');
    });

    it('holds a 3-word pill label at its maximum and flags one over its characters', () => {
      expect(codes(check(plan([text('t1', 'SAVE MORE TIME', {}, 'label_pill')])))).not.toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'SAVE MORE TIME TODAY', {}, 'label_pill')])))).toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'ORGANIZATIONALLY', {}, 'label_pill')])))).not.toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'ORGANIZATIONALLYSOUND', {}, 'label_pill')])))).toContain('text_may_wrap');
    });

    it('has a maximum for every look of the contract', () => {
      for (const look of TEXT_LOOKS) {
        expect(TEXT_FIT[look.id]).toMatchObject({
          max_chars: expect.any(Number),
          max_words: expect.any(Number),
          pad_chars: expect.any(Number),
        });
      }
    });

    it('holds the padding of every look at least as wide as its box takes (card S8): the extent in characters', () => {
      // `s` is `OVERLAY_SIZE.s_w / OVERLAY_SIZE.char_w` characters wide
      const charsPerS = OVERLAY_SIZE.s_w / OVERLAY_SIZE.char_w;
      for (const look of TEXT_LOOKS) {
        expect(TEXT_FIT[look.id].pad_chars).toBeGreaterThanOrEqual(lookExtent(look).x * charsPerS - 1e-9);
      }
    });

    it('flags a text over the maximum of a new look, as for the shipped ones', () => {
      expect(codes(check(plan([text('t1', 'SAVE MORE TIME', {}, 'solid_round')])))).not.toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'SAVE MORE TIME TODAY', {}, 'solid_round')])))).toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'SAVE MORE TIME', {}, 'neon_box')])))).not.toContain('text_may_wrap');
      expect(codes(check(plan([text('t1', 'SAVE MORE TIME NOW', {}, 'neon_box')])))).toContain('text_may_wrap');
    });

    it('counts a code point once', () => {
      // 12 code points, 24 UTF-16 units
      expect(codes(check(plan([text('t1', '😀😀😀😀😀😀😀😀😀😀😀😀')])))).not.toContain('text_may_wrap');
    });
  });

  describe('the facecam', () => {
    // the circle at the top centre of the master, where the first zone of every output is
    const covered = { facecam_track: [{ t_ms: 0, cx: 0.5, cy: 0.1, radius: 0.15 }] };

    it('flags an overlay over the circle, with the ratios it covers it in', () => {
      const results = check(plan([text('t1', 'KEYBOARD')], covered));

      const hit = results.find((r) => r.code === 'facecam_keepout');
      expect(hit).toMatchObject({ item_id: 't1', severity: 'warning' });
      expect(hit?.detail).toContain('9:16');
    });

    it('lets an overlay clear of the circle be, and skips the check without the request', () => {
      expect(codes(check(plan([text('t1', 'KEYBOARD', { position: { zone: 'lower_center' } })], covered)))).not.toContain('facecam_keepout');
      expect(codes(check(plan([text('t1', 'KEYBOARD')], covered), { video: undefined, outputs: undefined }))).not.toContain(
        'facecam_keepout'
      );
    });

    it('reads the outputs of the request', () => {
      // a circle lower on the master than the first zone of the 9:16 output
      const low = { facecam_track: [{ t_ms: 0, cx: 0.5, cy: 0.4, radius: 0.15 }] };
      const only916 = check(plan([text('t1', 'KEYBOARD')], low), { outputs: [ALL_OUTPUTS[0]] });
      expect(codes(only916)).not.toContain('facecam_keepout');
    });
  });

  describe('skipped checks', () => {
    it('skips the duration and emphasis checks without their inputs', () => {
      const bad = plan([], { video: { output_duration_ms: 1 }, captions: { effect: 'c_word_highlight', emphasis_words: [99] } });

      const results = check(bad, { source_duration_ms: undefined, word_count: undefined });

      expect(codes(results)).not.toContain('duration_mismatch');
      expect(codes(results)).not.toContain('emphasis_out_of_range');
    });

    it('does not change the plan', () => {
      const p = plan([text('t1', 'SAVE TIME NOW', {}, 'label_pill')]);
      const before = JSON.stringify(p);

      check(p);

      expect(JSON.stringify(p)).toBe(before);
    });
  });

  describe('isUnusable', () => {
    it('is true for a plan the phone cannot draw and false for warnings', () => {
      expect(isUnusable(check(plan([text('t1', 'KEYBOARD', {}, 'neon')])))).toBe(true);
      expect(isUnusable(check(plan([icon('i1', 'missing-icon')])))).toBe(true);
      expect(isUnusable(check(plan([text('t1', 'KEYBOARD', { start_ms: 4000, end_ms: 3000 })])))).toBe(true);
      expect(isUnusable(check(plan([text('t1', 'SAVE TIME NOW', {}, 'label_pill')], { facecam_track: [] })))).toBe(false);
      expect(isUnusable([])).toBe(false);
    });
  });

  describe('unreachableAssets', () => {
    it('turns the probes that failed into asset_unreachable findings and leaves the good ones out', () => {
      const probes: AssetProbe[] = [
        { id: 'a', ok: true, status: 200 },
        { id: 'b', ok: false, status: 404, reason_code: 'bad_status' },
        { id: 'c', ok: false, reason_code: 'unreachable' },
      ];

      const results = unreachableAssets(probes);

      expect(results).toEqual([
        { code: 'asset_unreachable', item_id: 'b', severity: 'warning', detail: 'reason=bad_status status=404' },
        { code: 'asset_unreachable', item_id: 'c', severity: 'warning', detail: 'reason=unreachable status=0' },
      ]);
      expect(isUnusable(results)).toBe(false);
    });
  });
});
