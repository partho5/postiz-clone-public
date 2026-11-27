// AI video editing (ai.video-editing): the effect registry (spec section 14), shared by the server's validator and
// the phone's renderer. Every effect id of the catalog is here; the first wave has the real defaults, the rest
// conservative ones. Every duration obeys SPEED_RULES. The AI only ever sees ids; the validator reads the entries.
import {
  ComponentType,
  EditLevel,
  EDIT_LEVELS,
  EffectLayer,
  EffectTarget,
  RegistryEntry,
} from './edit.contract';

// What a registry entry must say; everything else has a default from its layer.
type EntrySpec = Partial<RegistryEntry> &
  Pick<RegistryEntry, 'min_duration_ms' | 'max_duration_ms'>;

// The components an effect of a layer may carry.
const COMPONENTS: Record<EffectLayer, ComponentType[]> = {
  video: ['video'],
  facecam: ['video'],
  text: ['styled_text'],
  icon: ['icon_video', 'icon_image'],
  transition: ['video'],
  caption: ['captions'],
};

// One registry entry: the layer's defaults, then what the effect says.
const entry = (
  id: string,
  layer: EffectLayer,
  target: EffectTarget,
  spec: EntrySpec
): RegistryEntry => ({
  id,
  layer,
  target,
  allowed_components: COMPONENTS[layer],
  min_level: 'standard',
  content_safe: false,
  cost: 'L',
  default_params: {},
  param_limits: {},
  cooldown_ms: 6000,
  max_per_video: 3,
  sound: [],
  brand_colorable: false,
  requires: [],
  ...spec,
});

// A camera, time, look or layout effect on the whole frame, the slide area or the facecam.
const video = (id: string, target: EffectTarget, spec: EntrySpec) =>
  entry(id, 'video', target, spec);

// An effect on the facecam circle.
const facecam = (id: string, spec: EntrySpec) =>
  entry(id, 'facecam', 'facecam', { content_safe: true, ...spec });

// A styled text overlay: held 500 to 2500 ms, drawn in a text look, coloured from the palette.
const text = (id: string, spec: Partial<EntrySpec>) =>
  entry(id, 'text', 'overlay', {
    min_duration_ms: 500,
    max_duration_ms: 2500,
    cooldown_ms: 3000,
    max_per_video: 4,
    sound: ['pop_1', 'pop_2'],
    brand_colorable: true,
    ...spec,
  });

// An mp4 clip or icon overlay: held 500 to 1500 ms, Standard and Heavy only.
const icon = (id: string, spec: Partial<EntrySpec>) =>
  entry(id, 'icon', 'overlay', {
    min_duration_ms: 500,
    max_duration_ms: 1500,
    cooldown_ms: 5000,
    max_per_video: 4,
    sound: ['pop_2', 'ding'],
    ...spec,
  });

// A transition at a cut point: 150 to 300 ms, never inside a protected span.
const transition = (id: string, spec: Partial<EntrySpec>) =>
  entry(id, 'transition', 'full_frame', {
    min_duration_ms: 150,
    max_duration_ms: 300,
    cooldown_ms: 1500,
    max_per_video: 12,
    sound: ['whoosh_short', 'swoosh'],
    ...spec,
  });

// A caption effect: captions run for the whole video, so no duration, cooldown or count applies.
const caption = (id: string, spec: Partial<EntrySpec>) =>
  entry(id, 'caption', 'caption_area', {
    min_level: 'basic',
    content_safe: true,
    min_duration_ms: 0,
    max_duration_ms: 0,
    cooldown_ms: 0,
    max_per_video: 1,
    ...spec,
  });

// The same defaults for the two layout effects: the facecam grows as a copy, the frame shrinks behind it.
const LAYOUT_GROW: Pick<RegistryEntry, 'default_params' | 'param_limits'> = {
  default_params: {
    face_scale_to: 1.5,
    frame_scale_to: 0.92,
    in_ms: 200,
    out_ms: 150,
    ease: 'out_cubic',
  },
  param_limits: { face_scale_to: [1.2, 1.8], frame_scale_to: [0.85, 0.96] },
};

export const EFFECTS: RegistryEntry[] = [
  // Video: camera movement
  video('v_punch_in', 'full_frame', {
    min_level: 'basic',
    min_duration_ms: 150,
    max_duration_ms: 400,
    default_params: { scale_to: 1.15, ease: 'out_back' },
    param_limits: { scale_to: [1.05, 1.25] },
    cooldown_ms: 6000,
    max_per_video: 3,
    sound: ['whoosh_short', 'pop_1'],
  }),
  video('v_push_in', 'full_frame', {
    min_duration_ms: 400,
    max_duration_ms: 800,
    default_params: { scale_to: 1.08, ease: 'out_cubic' },
    param_limits: { scale_to: [1.06, 1.1] },
    cooldown_ms: 8000,
    max_per_video: 3,
    sound: ['swoosh'],
  }),
  video('v_pull_out', 'full_frame', {
    min_duration_ms: 150,
    max_duration_ms: 400,
    default_params: { scale_from: 1.15, ease: 'out_cubic' },
    param_limits: { scale_from: [1.05, 1.2] },
    sound: ['whoosh_short'],
  }),
  video('v_pan_bounce', 'full_frame', {
    min_duration_ms: 200,
    max_duration_ms: 400,
    default_params: { offset_x: 0.03, ease: 'out_cubic' },
    param_limits: { offset_x: [0.01, 0.05] },
    cooldown_ms: 8000,
    max_per_video: 2,
    sound: ['whoosh_short'],
  }),
  video('v_alt_crop', 'full_frame', {
    min_duration_ms: 1000,
    max_duration_ms: 8000,
    default_params: { scale_to: 1.18, center_x: 0.5, center_y: 0.4, switch_ms: 120, ease: 'out_cubic' },
    param_limits: { scale_to: [1.1, 1.3], switch_ms: [80, 200] },
    cooldown_ms: 4000,
    max_per_video: 4,
  }),
  video('v_beat_rotate', 'full_frame', {
    min_duration_ms: 150,
    max_duration_ms: 400,
    default_params: { angle_deg: 3, ease: 'out_back' },
    param_limits: { angle_deg: [2, 4] },
    cooldown_ms: 8000,
    max_per_video: 2,
    sound: ['pop_1'],
  }),
  video('v_bounce_scale', 'full_frame', {
    min_duration_ms: 150,
    max_duration_ms: 400,
    default_params: { scale_down_to: 0.94, ease: 'out_back' },
    param_limits: { scale_down_to: [0.9, 0.98] },
    cooldown_ms: 8000,
    max_per_video: 2,
    sound: ['pop_1'],
  }),
  video('v_shake', 'full_frame', {
    min_level: 'heavy',
    min_duration_ms: 150,
    max_duration_ms: 400,
    default_params: { amplitude: 0.01, shakes: 3 },
    param_limits: { amplitude: [0.004, 0.015], shakes: [2, 5] },
    cooldown_ms: 10000,
    max_per_video: 2,
    sound: ['impact_soft'],
  }),

  // Video: time
  video('t_speed_ramp', 'full_frame', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 400,
    max_duration_ms: 1500,
    default_params: { rate_to: 1.5, ease: 'out_cubic' },
    param_limits: { rate_to: [1.3, 2.0] },
    cooldown_ms: 10000,
    max_per_video: 2,
    sound: ['whoosh_short'],
  }),
  video('t_slow_beat', 'full_frame', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 200,
    max_duration_ms: 500,
    default_params: { rate_to: 0.5 },
    param_limits: { rate_to: [0.4, 0.7] },
    cooldown_ms: 15000,
    max_per_video: 1,
    sound: ['impact_soft'],
  }),
  video('t_freeze_outline', 'full_frame', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 250,
    max_duration_ms: 400,
    default_params: { outline_width: 0.012, outline_color: '#FFFFFF' },
    param_limits: { outline_width: [0.006, 0.02] },
    cooldown_ms: 15000,
    max_per_video: 1,
    sound: ['impact_soft'],
  }),
  video('t_rewind_short', 'full_frame', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 250,
    max_duration_ms: 400,
    default_params: { rewind_ms: 300 },
    param_limits: { rewind_ms: [200, 400] },
    cooldown_ms: 15000,
    max_per_video: 1,
    sound: ['swoosh'],
  }),
  video('t_stutter', 'full_frame', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 300,
    max_duration_ms: 600,
    default_params: { repeat_ms: 300, repeats: 2 },
    param_limits: { repeat_ms: [200, 300], repeats: [1, 2] },
    cooldown_ms: 15000,
    max_per_video: 1,
    sound: ['click'],
  }),
  video('t_jump_cut', 'full_frame', {
    min_level: 'basic',
    min_duration_ms: 100,
    max_duration_ms: 10000,
    default_params: { keep_ms: 120, alt_crop: false },
    param_limits: { keep_ms: [60, 250] },
    cooldown_ms: 0,
    max_per_video: 1000,
  }),
  video('t_echo_word', 'full_frame', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 400,
    max_duration_ms: 1200,
    default_params: { echo_delay_ms: 150, echo_gain: 0.4 },
    param_limits: { echo_delay_ms: [80, 250], echo_gain: [0.2, 0.6] },
    cooldown_ms: 15000,
    max_per_video: 2,
  }),

  // Video: look and color
  video('l_flash', 'full_frame', {
    content_safe: true,
    min_duration_ms: 80,
    max_duration_ms: 150,
    default_params: { peak_alpha: 0.85, ease: 'out_cubic' },
    param_limits: { peak_alpha: [0.5, 1.0] },
    cooldown_ms: 4000,
    max_per_video: 4,
    sound: ['impact_soft', 'whoosh_short'],
  }),
  video('l_color_pop', 'full_frame', {
    content_safe: true,
    min_duration_ms: 150,
    max_duration_ms: 400,
    default_params: { saturation_to: 1.6 },
    param_limits: { saturation_to: [1.2, 2.0] },
    cooldown_ms: 8000,
    max_per_video: 2,
  }),
  video('l_bw_to_color', 'full_frame', {
    min_level: 'heavy',
    min_duration_ms: 200,
    max_duration_ms: 400,
    default_params: { from_saturation: 0 },
    param_limits: { from_saturation: [0, 0.3] },
    cooldown_ms: 20000,
    max_per_video: 1,
  }),
  video('l_rgb_glitch', 'full_frame', {
    cost: 'M',
    min_duration_ms: 150,
    max_duration_ms: 300,
    default_params: { offset: 0.012 },
    param_limits: { offset: [0.006, 0.02] },
    cooldown_ms: 8000,
    max_per_video: 2,
    sound: ['click', 'impact_soft'],
  }),
  video('l_vhs', 'full_frame', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 200,
    max_duration_ms: 400,
    default_params: { noise: 0.3, offset: 0.008 },
    param_limits: { noise: [0.1, 0.5], offset: [0.004, 0.015] },
    cooldown_ms: 12000,
    max_per_video: 2,
  }),
  video('l_film_grain', 'full_frame', {
    min_level: 'heavy',
    content_safe: true,
    min_duration_ms: 400,
    max_duration_ms: 2000,
    default_params: { intensity: 0.12 },
    param_limits: { intensity: [0.05, 0.25] },
    cooldown_ms: 10000,
    max_per_video: 2,
  }),
  video('l_vignette_pulse', 'full_frame', {
    content_safe: true,
    min_duration_ms: 200,
    max_duration_ms: 400,
    default_params: { strength_to: 0.5 },
    param_limits: { strength_to: [0.3, 0.7] },
    cooldown_ms: 8000,
    max_per_video: 2,
  }),
  video('l_light_leak', 'full_frame', {
    min_level: 'heavy',
    content_safe: true,
    cost: 'M',
    min_duration_ms: 250,
    max_duration_ms: 400,
    default_params: { intensity: 0.6 },
    param_limits: { intensity: [0.3, 0.8] },
    cooldown_ms: 12000,
    max_per_video: 2,
    sound: ['swoosh'],
  }),
  video('l_bloom', 'full_frame', {
    min_level: 'heavy',
    content_safe: true,
    cost: 'M',
    min_duration_ms: 200,
    max_duration_ms: 400,
    default_params: { intensity: 0.5 },
    param_limits: { intensity: [0.3, 0.8] },
    cooldown_ms: 12000,
    max_per_video: 2,
  }),
  video('l_duotone', 'full_frame', {
    min_level: 'heavy',
    min_duration_ms: 200,
    max_duration_ms: 400,
    default_params: { dark: '#1A1A40', light: '#FFD60A' },
    cooldown_ms: 12000,
    max_per_video: 2,
  }),

  // Video: layout
  video('y_split_copy', 'full_frame', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 800,
    max_duration_ms: 2500,
    default_params: { gap: 0.02, in_ms: 200, out_ms: 150 },
    param_limits: { gap: [0, 0.05] },
    cooldown_ms: 12000,
    max_per_video: 1,
  }),
  video('y_mirror', 'full_frame', {
    min_level: 'heavy',
    min_duration_ms: 300,
    max_duration_ms: 1000,
    default_params: { axis: 'x' },
    cooldown_ms: 12000,
    max_per_video: 1,
  }),
  video('y_face_grow_slide_shrink', 'facecam', {
    cost: 'M',
    min_duration_ms: 600,
    max_duration_ms: 2500,
    cooldown_ms: 8000,
    max_per_video: 2,
    sound: ['whoosh_short'],
    ...LAYOUT_GROW,
  }),
  video('y_slide_grow_face_shrink', 'slide_area', {
    cost: 'M',
    min_duration_ms: 600,
    max_duration_ms: 2500,
    cooldown_ms: 8000,
    max_per_video: 2,
    sound: ['whoosh_short'],
    ...LAYOUT_GROW,
  }),
  video('y_slide_blur_face_sharp', 'slide_area', {
    min_level: 'heavy',
    cost: 'M',
    min_duration_ms: 800,
    max_duration_ms: 3000,
    default_params: { blur_radius: 0.012, in_ms: 200, out_ms: 150 },
    param_limits: { blur_radius: [0.006, 0.02] },
    cooldown_ms: 12000,
    max_per_video: 1,
  }),
  video('y_letterbox', 'full_frame', {
    min_level: 'heavy',
    min_duration_ms: 600,
    max_duration_ms: 2500,
    default_params: { bar_height: 0.08, in_ms: 150, out_ms: 150 },
    param_limits: { bar_height: [0.04, 0.12] },
    cooldown_ms: 12000,
    max_per_video: 1,
  }),
  video('y_color_frame', 'full_frame', {
    min_level: 'heavy',
    content_safe: true,
    min_duration_ms: 400,
    max_duration_ms: 2000,
    default_params: { border_width: 0.012, color: '#FFD60A' },
    param_limits: { border_width: [0.006, 0.02] },
    cooldown_ms: 10000,
    max_per_video: 2,
  }),

  // Video: person (needs person segmentation, inside the facecam circle only)
  video('p_bg_blur', 'facecam', {
    min_level: 'heavy',
    content_safe: true,
    cost: 'H',
    min_duration_ms: 800,
    max_duration_ms: 3000,
    default_params: { blur_radius: 0.02 },
    param_limits: { blur_radius: [0.01, 0.04] },
    cooldown_ms: 12000,
    max_per_video: 1,
    requires: ['person_segmentation'],
  }),
  video('p_outline_glow', 'facecam', {
    min_level: 'heavy',
    content_safe: true,
    cost: 'H',
    min_duration_ms: 400,
    max_duration_ms: 1500,
    default_params: { width: 0.008, color: '#32D7FF' },
    param_limits: { width: [0.004, 0.015] },
    cooldown_ms: 12000,
    max_per_video: 1,
    requires: ['person_segmentation'],
  }),
  video('p_bg_color_swap', 'facecam', {
    min_level: 'heavy',
    content_safe: true,
    cost: 'H',
    min_duration_ms: 500,
    max_duration_ms: 2000,
    default_params: { color: '#32D7FF' },
    cooldown_ms: 12000,
    max_per_video: 1,
    requires: ['person_segmentation'],
  }),
  entry('p_text_behind', 'text', 'overlay', {
    min_level: 'heavy',
    cost: 'H',
    min_duration_ms: 600,
    max_duration_ms: 2500,
    cooldown_ms: 12000,
    max_per_video: 1,
    brand_colorable: true,
    requires: ['person_segmentation'],
  }),

  // Facecam
  facecam('f_pop_in', {
    min_duration_ms: 150,
    max_duration_ms: 300,
    default_params: { scale_from: 0.6, overshoot: 1.1, ease: 'out_back' },
    param_limits: { overshoot: [1.05, 1.15] },
    cooldown_ms: 10000,
    max_per_video: 2,
    sound: ['pop_1'],
  }),
  facecam('f_pulse', {
    min_duration_ms: 150,
    max_duration_ms: 300,
    default_params: { scale_to: 1.12, ease: 'out_back' },
    param_limits: { scale_to: [1.05, 1.2] },
    cooldown_ms: 5000,
    max_per_video: 4,
    sound: ['pop_2'],
  }),
  facecam('f_glow_ring', {
    min_duration_ms: 200,
    max_duration_ms: 400,
    default_params: { width: 0.012, color: '#FFD60A' },
    param_limits: { width: [0.006, 0.02] },
    cooldown_ms: 5000,
    max_per_video: 4,
  }),
  facecam('f_corner_shrink', {
    min_level: 'heavy',
    content_safe: false,
    cost: 'M',
    min_duration_ms: 600,
    max_duration_ms: 3000,
    default_params: { scale_to: 0.6, move_ms: 200 },
    param_limits: { scale_to: [0.4, 0.8] },
    cooldown_ms: 12000,
    max_per_video: 2,
  }),
  facecam('f_bounce_entry', {
    min_duration_ms: 200,
    max_duration_ms: 400,
    default_params: { from_dy: 0.08, ease: 'out_back' },
    param_limits: { from_dy: [0.04, 0.12] },
    cooldown_ms: 10000,
    max_per_video: 2,
    sound: ['pop_1'],
  }),
  facecam('f_border_mood', {
    min_level: 'heavy',
    min_duration_ms: 300,
    max_duration_ms: 1500,
    default_params: { width: 0.008 },
    param_limits: { width: [0.004, 0.015] },
    cooldown_ms: 8000,
    max_per_video: 3,
  }),

  // Styled text (overlay): the text look comes from the plan's `style_preset`, the entry from `params.entry`
  text('x_marker_sweep', {
    min_level: 'basic',
    default_params: { entry: 'sweep', entry_ms: 200, exit_ms: 150 },
    param_limits: { entry_ms: [120, 300] },
  }),
  text('x_pop', {
    min_level: 'basic',
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150 },
    param_limits: { entry_ms: [120, 300] },
    max_per_video: 6,
  }),
  text('x_stamp', {
    min_level: 'basic',
    default_params: { entry: 'stamp', entry_ms: 140, shake_ms: 120, shakes: 3, exit_ms: 150 },
    param_limits: { entry_ms: [120, 180], shake_ms: [80, 140] },
  }),
  text('x_slide_up', {
    default_params: { entry: 'slide_up', entry_ms: 220, from_dy: 0.08, exit_ms: 150 },
    param_limits: { entry_ms: [120, 300], from_dy: [0.04, 0.12] },
  }),
  text('x_typewriter', {
    cost: 'M',
    default_params: { entry: 'typewriter', typing_ms: 400, exit_ms: 150 },
    param_limits: { typing_ms: [200, 500] },
  }),
  text('x_one_word', {
    default_params: { entry: 'word_by_word', entry_ms: 200, exit_ms: 150 },
    param_limits: { entry_ms: [120, 300] },
  }),
  text('x_sticker', {
    min_level: 'basic',
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: 'sticker' },
    param_limits: { entry_ms: [120, 300] },
    max_per_video: 6,
  }),
  text('x_3d', {
    min_level: 'basic',
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: '3d' },
    param_limits: { entry_ms: [120, 300] },
  }),
  text('x_glow', {
    min_level: 'basic',
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: 'glow' },
    param_limits: { entry_ms: [120, 300] },
  }),
  text('x_gradient', {
    default_params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: 'gradient' },
    param_limits: { entry_ms: [120, 300] },
  }),
  text('x_label_tag', {
    min_level: 'basic',
    default_params: { entry: 'slide_up', entry_ms: 200, exit_ms: 150, style_preset: 'label_pill' },
    param_limits: { entry_ms: [120, 300] },
  }),
  text('x_tilt_sticker', {
    default_params: { entry: 'pop', entry_ms: 220, exit_ms: 150, style_preset: 'sticker', tilt_deg: 6 },
    param_limits: { entry_ms: [120, 300], tilt_deg: [3, 6] },
  }),
  text('x_underline_draw', {
    cost: 'M',
    default_params: { entry: 'draw', draw_ms: 250, exit_ms: 150 },
    param_limits: { draw_ms: [150, 300] },
  }),
  text('x_circle_draw', {
    cost: 'M',
    default_params: { entry: 'draw', draw_ms: 280, exit_ms: 150 },
    param_limits: { draw_ms: [150, 300] },
  }),
  text('x_arrow_draw', {
    cost: 'M',
    default_params: { entry: 'draw', draw_ms: 250, exit_ms: 150 },
    param_limits: { draw_ms: [150, 300] },
  }),
  text('x_count_up', {
    cost: 'M',
    default_params: { entry: 'count_up', count_ms: 800, exit_ms: 150 },
    param_limits: { count_ms: [300, 800] },
    max_per_video: 2,
  }),
  text('x_shake', {
    default_params: { entry: 'pop', entry_ms: 200, shake_ms: 150, amplitude: 0.01, exit_ms: 150 },
    param_limits: { shake_ms: [80, 200], amplitude: [0.004, 0.015] },
  }),

  // mp4 clip and icon image (overlay): works for both components, each with an entry and an exit
  icon('i_scale_pop', {
    default_params: { entry_ms: 200, exit_ms: 150, ease: 'out_back' },
    param_limits: { entry_ms: [120, 300] },
  }),
  icon('i_slide_in', {
    default_params: { entry_ms: 220, exit_ms: 150, edge: 'right' },
    param_limits: { entry_ms: [120, 300] },
  }),
  icon('i_stroke_draw', {
    default_params: { draw_ms: 250, exit_ms: 150 },
    param_limits: { draw_ms: [150, 300] },
  }),
  icon('i_spin_in', {
    default_params: { entry_ms: 250, exit_ms: 150, turns: 0.5 },
    param_limits: { entry_ms: [120, 300], turns: [0.25, 1] },
  }),
  icon('i_float_fade', {
    default_params: { rise: 0.06, entry_ms: 200, exit_ms: 200 },
    param_limits: { rise: [0.03, 0.1] },
  }),
  icon('i_wiggle', {
    default_params: { entry_ms: 200, exit_ms: 150, angle_deg: 8, cycles: 3 },
    param_limits: { angle_deg: [4, 12], cycles: [2, 4] },
  }),
  icon('i_stamp', {
    default_params: { scale_from: 2.0, entry_ms: 160, exit_ms: 150 },
    param_limits: { scale_from: [1.5, 2.2] },
  }),
  icon('i_burst', {
    cost: 'M',
    default_params: { entry_ms: 200, exit_ms: 150 },
    max_per_video: 2,
  }),
  icon('i_sparkle', {
    default_params: { entry_ms: 200, exit_ms: 150 },
  }),
  icon('i_wipe_reveal', {
    default_params: { wipe_ms: 250, exit_ms: 150 },
    param_limits: { wipe_ms: [150, 300] },
  }),

  // Transitions between segments (phase 1 cut points only)
  transition('tr_whip', {
    default_params: { direction: 'left', ease: 'out_cubic', blur: 0.02 },
    param_limits: { blur: [0.01, 0.04] },
  }),
  transition('tr_zoom_blur', {
    min_level: 'heavy',
    cost: 'M',
    default_params: { scale_to: 1.15, blur: 0.03 },
    param_limits: { scale_to: [1.08, 1.25] },
  }),
  transition('tr_glitch_cut', {
    min_level: 'heavy',
    cost: 'M',
    default_params: { offset: 0.012 },
    param_limits: { offset: [0.006, 0.02] },
    sound: ['click', 'impact_soft'],
  }),
  transition('tr_flash_cut', {
    default_params: { peak_alpha: 0.85 },
    param_limits: { peak_alpha: [0.5, 1.0] },
    sound: ['impact_soft'],
  }),
  transition('tr_spin', {
    min_level: 'heavy',
    cost: 'M',
    default_params: { angle_deg: 15 },
    param_limits: { angle_deg: [8, 30] },
  }),
  transition('tr_shape_wipe', {
    min_level: 'heavy',
    cost: 'M',
    default_params: { shape: 'circle' },
  }),
  transition('tr_push', {
    min_level: 'heavy',
    default_params: { direction: 'left', ease: 'out_cubic' },
  }),
  transition('tr_dip_color', {
    min_level: 'heavy',
    default_params: { color: '#111111' },
  }),

  // Captions: the user's subtitle template (spec section 14, Captions), the engine adds the emphasis
  caption('c_word_highlight', {
    default_params: { highlight: 'active_word' },
  }),
  caption('c_active_pop', {
    default_params: { scale_to: 1.12, pop_ms: 120 },
    param_limits: { scale_to: [1.05, 1.2], pop_ms: [80, 200] },
  }),
  caption('c_karaoke', {
    min_level: 'standard',
    default_params: { lines: 2 },
    param_limits: { lines: [1, 2] },
  }),
  caption('c_emphasis_big', {
    brand_colorable: true,
    default_params: { scale_to: 1.3, color_role: 'accent' },
    param_limits: { scale_to: [1.15, 1.5] },
  }),
  caption('c_emoji_after', {
    min_level: 'standard',
    default_params: { max_emoji: 6 },
    param_limits: { max_emoji: [1, 10] },
  }),
];

// Index by id for the lookups below.
const BY_ID = new Map(EFFECTS.map((effect) => [effect.id, effect]));

// One effect by id, or undefined.
export const effectById = (id: string) => BY_ID.get(id);

// Whether a level may use an effect of the given minimum level.
const levelAtLeast = (level: EditLevel, min: EditLevel) =>
  EDIT_LEVELS.indexOf(level) >= EDIT_LEVELS.indexOf(min);

// The effects a job may use: at its level or below and, when the phone sent its capabilities, ones it can render.
export const effectsForLevel = (
  level: EditLevel,
  capabilities?: { effects: string[] }
) =>
  EFFECTS.filter(
    (effect) =>
      levelAtLeast(level, effect.min_level) &&
      (!capabilities || capabilities.effects.includes(effect.id))
  );
