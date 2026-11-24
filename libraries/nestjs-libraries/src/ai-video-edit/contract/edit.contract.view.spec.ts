// AI video editing (ai.video-editing): the contract JSON the route serves. Checks its version, levels, output order,
// the effect registry against the catalog of spec section 14, the speed rules, phrases and the purity of the folder.
// Needs no database and no Nest.
import * as fs from 'fs';
import * as path from 'path';
import { contractView } from './edit.contract.view';
import { SPEED_RULES } from './edit.contract';
import { effectById, effectsForLevel } from './edit.registry';
import { SOUND_IDS } from './edit.sounds';
import { TEXT_LOOKS } from './edit.styles';

// Every effect id of spec section 14, by group.
const CATALOG = [
  'v_punch_in', 'v_push_in', 'v_pull_out', 'v_pan_bounce', 'v_alt_crop', 'v_beat_rotate', 'v_bounce_scale', 'v_shake',
  't_speed_ramp', 't_slow_beat', 't_freeze_outline', 't_rewind_short', 't_stutter', 't_jump_cut', 't_echo_word',
  'l_flash', 'l_color_pop', 'l_bw_to_color', 'l_rgb_glitch', 'l_vhs', 'l_film_grain', 'l_vignette_pulse',
  'l_light_leak', 'l_bloom', 'l_duotone',
  'y_split_copy', 'y_mirror', 'y_face_grow_slide_shrink', 'y_slide_grow_face_shrink', 'y_slide_blur_face_sharp',
  'y_letterbox', 'y_color_frame',
  'p_bg_blur', 'p_outline_glow', 'p_bg_color_swap', 'p_text_behind',
  'f_pop_in', 'f_pulse', 'f_glow_ring', 'f_corner_shrink', 'f_bounce_entry', 'f_border_mood',
  'x_marker_sweep', 'x_pop', 'x_stamp', 'x_slide_up', 'x_typewriter', 'x_one_word', 'x_sticker', 'x_3d', 'x_glow',
  'x_gradient', 'x_label_tag', 'x_tilt_sticker', 'x_underline_draw', 'x_circle_draw', 'x_arrow_draw', 'x_count_up',
  'x_shake',
  'i_scale_pop', 'i_slide_in', 'i_stroke_draw', 'i_spin_in', 'i_float_fade', 'i_wiggle', 'i_stamp', 'i_burst',
  'i_sparkle', 'i_wipe_reveal',
  'tr_whip', 'tr_zoom_blur', 'tr_glitch_cut', 'tr_flash_cut', 'tr_spin', 'tr_shape_wipe', 'tr_push', 'tr_dip_color',
  'c_word_highlight', 'c_active_pop', 'c_karaoke', 'c_emphasis_big', 'c_emoji_after',
];

// The first wave of spec section 14 (build priority).
const FIRST_WAVE = [
  'c_word_highlight', 'c_active_pop', 'c_emphasis_big',
  'v_punch_in', 'v_push_in', 'v_alt_crop', 't_jump_cut', 'l_flash', 'l_rgb_glitch',
  'y_slide_grow_face_shrink', 'y_face_grow_slide_shrink',
  'x_pop', 'x_stamp', 'x_sticker', 'x_3d', 'x_glow', 'x_marker_sweep', 'x_label_tag',
  'i_scale_pop', 'tr_whip', 'tr_flash_cut',
];

describe('ai.video-editing: contractView', () => {
  const view = contractView();

  it('carries version 2 and every top-level key of the contract, in order', () => {
    expect(view.contract_version).toBe(2);
    expect(Object.keys(view)).toEqual([
      'contract_version', 'levels', 'speed', 'protection', 'outputs', 'zones', 'effects', 'text_styles', 'palette',
      'color_roles', 'text_layer_order', 'text_features', 'look_vectors', 'phrases', 'sounds',
    ]);
  });

  it('has the three levels with the budgets of spec section 6', () => {
    expect(Object.keys(view.levels)).toEqual(['basic', 'standard', 'heavy']);
    expect(view.levels.basic).toEqual({
      max_feature_effects: 3, max_icons: 0, text_kinds: ['keyword_echo', 'hook'],
      transitions: false, sounds: false, perception: false, writer: false,
    });
    expect(view.levels.standard.max_feature_effects).toBe(6);
    expect(view.levels.standard.max_icons).toBe(2);
    expect(view.levels.standard.writer).toBe(false);
    expect(view.levels.heavy.max_feature_effects).toBe(10);
    expect(view.levels.heavy.max_icons).toBe(4);
    expect(view.levels.heavy.text_kinds).toEqual(['keyword_echo', 'hook', 'commentary', 'complementary']);
    expect(view.levels.heavy.writer).toBe(true);
  });

  it('lists the outputs with 9:16 first and the sizes of spec section 19', () => {
    expect(Object.keys(view.outputs)).toEqual(['9:16', '4:5', '1:1']);
    expect(view.outputs['9:16']).toMatchObject({ width: 1080, height: 1920, bitrate: 12000000 });
    expect(view.outputs['4:5']).toMatchObject({ width: 720, height: 900, bitrate: 6000000 });
    expect(view.outputs['1:1']).toMatchObject({ width: 720, height: 720, bitrate: 6000000 });
    expect(view.outputs['9:16'].safe).toEqual({ x0: 0.06, x1: 0.94, y0: 0.1, y1: 0.62 });
  });

  it('has the five zones, the protection numbers and the speed table', () => {
    expect(Object.keys(view.zones)).toEqual([
      'upper_left', 'upper_center', 'upper_right', 'middle_center', 'lower_center',
    ]);
    expect(view.protection).toEqual({ padding_ms: 300, min_window_ms: 500, merge_gap_ms: 400 });
    expect(view.speed.text_hold).toEqual({ base_ms: 500, per_word_ms: 150, max_ms: 2500 });
    expect(view.speed.clip_max_factor).toBe(3);
  });

  it('has every effect id of the catalog once, and the whole first wave', () => {
    const ids = view.effects.map((effect) => effect.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...CATALOG].sort());
    for (const id of FIRST_WAVE) {
      expect(effectById(id)).toBeDefined();
    }
  });

  it('gives the first wave its real defaults', () => {
    expect(effectById('v_punch_in')).toMatchObject({
      min_level: 'basic', min_duration_ms: 150, max_duration_ms: 400,
      default_params: { scale_to: 1.15, ease: 'out_back' }, param_limits: { scale_to: [1.05, 1.25] },
    });
    expect(effectById('v_push_in')).toMatchObject({
      min_duration_ms: 400, max_duration_ms: 800, param_limits: { scale_to: [1.06, 1.1] },
    });
    expect(effectById('v_alt_crop')?.default_params).toMatchObject({ scale_to: 1.18, center_x: 0.5, center_y: 0.4 });
    expect(effectById('l_flash')).toMatchObject({ default_params: { peak_alpha: 0.85 } });
    expect(effectById('l_rgb_glitch')?.default_params).toMatchObject({ offset: 0.012 });
    expect(effectById('l_rgb_glitch')).toMatchObject({ min_duration_ms: 150, max_duration_ms: 300 });
    expect(effectById('y_face_grow_slide_shrink')?.default_params).toMatchObject({
      face_scale_to: 1.5, frame_scale_to: 0.92,
    });
  });

  it('keeps every entry inside the speed rules and the level order', () => {
    for (const effect of view.effects) {
      expect(effect.min_duration_ms).toBeLessThanOrEqual(effect.max_duration_ms);
      expect(['basic', 'standard', 'heavy']).toContain(effect.min_level);
      expect(['L', 'M', 'H']).toContain(effect.cost);
      effect.sound.forEach((sound) => expect(SOUND_IDS).toContain(sound));
      Object.entries(effect.param_limits).forEach(([key, [low, high]]) => {
        expect(low).toBeLessThanOrEqual(high);
        const value = effect.default_params[key];
        if (typeof value === 'number') {
          expect(value).toBeGreaterThanOrEqual(low);
          expect(value).toBeLessThanOrEqual(high);
        }
      });
    }
    const [flashMin, flashMax] = SPEED_RULES.flash_ms;
    expect(effectById('l_flash')!.min_duration_ms).toBeGreaterThanOrEqual(flashMin);
    expect(effectById('l_flash')!.max_duration_ms).toBeLessThanOrEqual(flashMax);
    expect(effectById('v_push_in')!.max_duration_ms).toBeLessThanOrEqual(SPEED_RULES.push_in_max_ms);
    expect(effectById('t_slow_beat')!.max_duration_ms).toBeLessThanOrEqual(SPEED_RULES.slow_motion_max_ms);
    view.effects.filter((effect) => effect.layer === 'transition').forEach((effect) => {
      expect(effect.min_duration_ms).toBeGreaterThanOrEqual(SPEED_RULES.transition_ms[0]);
      expect(effect.max_duration_ms).toBeLessThanOrEqual(SPEED_RULES.transition_ms[1]);
    });
    view.effects.filter((effect) => effect.layer === 'icon').forEach((effect) => {
      expect(effect.min_duration_ms).toBeGreaterThanOrEqual(SPEED_RULES.icon_hold_ms[0]);
      expect(effect.max_duration_ms).toBeLessThanOrEqual(SPEED_RULES.icon_hold_ms[1]);
    });
  });

  it('lets Basic use only punch in as a video effect, no icons and no transitions', () => {
    const basic = effectsForLevel('basic').map((effect) => effect.id);
    expect(basic.filter((id) => /^(v_|l_|y_|f_|p_)/.test(id))).toEqual(['v_punch_in']);
    expect(basic.some((id) => id.startsWith('i_') || id.startsWith('tr_'))).toBe(false);
    expect(basic).toEqual(expect.arrayContaining(['t_jump_cut', 'x_sticker', 'c_word_highlight']));
  });

  it('narrows the list to the capabilities the phone sent', () => {
    const ids = effectsForLevel('heavy', { effects: ['v_punch_in', 'v_shake', 'nope'] }).map((effect) => effect.id);
    expect(ids).toEqual(['v_punch_in', 'v_shake']);
    expect(effectsForLevel('standard', { effects: ['v_shake'] })).toEqual([]);
  });

  it('has the six shipped text looks and the ten of card S8, with colour roles only', () => {
    expect(view.text_styles.map((look) => look.id)).toEqual([
      'sticker', 'label_pill', '3d', 'glow', 'gradient', 'highlighter',
      'neon_box', 'pill_ring', 'gradient_block', 'tilt_sticker', 'solid_round', 'pastel_pill', 'flat_rect', 'yellow_bold',
      'dark_accent', 'coral_pill',
    ]);
    expect(TEXT_LOOKS.find((look) => look.id === '3d')?.extrude).toEqual({
      copies: 6, color: 'accent_dark', dx: 0.012, dy: 0.016,
    });
    expect(JSON.stringify(view.text_styles)).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(view.palette.multi).toHaveLength(5);
  });

  it('has about 40 phrases, each with a unique id, an English text and a mood tag', () => {
    expect(view.phrases.length).toBeGreaterThanOrEqual(38);
    expect(new Set(view.phrases.map((phrase) => phrase.id)).size).toBe(view.phrases.length);
    for (const phrase of view.phrases) {
      expect(phrase.text.en.length).toBeGreaterThan(0);
      expect(phrase.text.bn.length).toBeGreaterThan(0);
      expect(phrase.mood.length).toBeGreaterThan(0);
    }
  });

  it('lists the seven sounds', () => {
    expect(view.sounds).toEqual(['pop_1', 'pop_2', 'whoosh_short', 'swoosh', 'ding', 'impact_soft', 'click']);
  });

  it('is plain JSON that survives a round trip, and a fresh copy each call', () => {
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    view.levels.basic.max_feature_effects = 99;
    expect(contractView().levels.basic.max_feature_effects).toBe(3);
  });
});

describe('ai.video-editing: the contract folder is pure', () => {
  it('imports nothing but its own files', () => {
    const files = fs
      .readdirSync(__dirname)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = fs.readFileSync(path.join(__dirname, name), 'utf8');
      const imports = text.match(/from\s+'[^']+'/g) || [];
      imports.forEach((line) => expect(line).toMatch(/^from\s+'\.\//));
    }
  });
});
