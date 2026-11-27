// AI video editing (ai.video-editing): the language-neutral engine contract. Types and the fixed rule tables of
// the request, the plan and the effect registry. No Nest, Prisma or network import may ever enter this folder:
// the planner core and the phone's renderer (and a later desktop one) read the same values.

// The contract version travels in every request and plan; the phone refuses a plan it does not know.
export const CONTRACT_VERSION = 2;

// The three editing levels, cheapest first.
export type EditLevel = 'basic' | 'standard' | 'heavy';
export const EDIT_LEVELS: EditLevel[] = ['basic', 'standard', 'heavy'];

// The output ratios, 9:16 first everywhere they are listed.
export type OutputRatio = '9:16' | '4:5' | '1:1';

// The four kinds of overlay text (spec section 13).
export type TextKind = 'keyword_echo' | 'hook' | 'commentary' | 'complementary';

// Where an effect lives in the frame and on the plan.
export type EffectLayer =
  | 'video'
  | 'facecam'
  | 'text'
  | 'icon'
  | 'transition'
  | 'caption';
export type EffectTarget =
  | 'full_frame'
  | 'slide_area'
  | 'facecam'
  | 'overlay'
  | 'caption_area';
export type ComponentType =
  | 'video'
  | 'styled_text'
  | 'icon_video'
  | 'icon_image'
  | 'captions';

// The five named positions of an overlay, resolved by the renderer per output ratio.
export type ZoneId =
  | 'upper_left'
  | 'upper_center'
  | 'upper_right'
  | 'middle_center'
  | 'lower_center';

// The short sound effects the plan may pair with an effect.
export type SoundId =
  | 'pop_1'
  | 'pop_2'
  | 'whoosh_short'
  | 'swoosh'
  | 'ding'
  | 'impact_soft'
  | 'click';

// One rectangle as fractions of its parent; used for the safe rectangle of an output.
export interface SafeRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// What one level may use (spec section 6). `max_feature_effects` leaves out captions and transitions.
export interface LevelRule {
  max_feature_effects: number;
  max_icons: number;
  text_kinds: TextKind[];
  transitions: boolean;
  sounds: boolean;
  perception: boolean;
  writer: boolean;
}

// The speed limits every effect obeys (spec section 12), in milliseconds unless a name says otherwise.
export interface SpeedRules {
  entry_ms: [number, number];
  exit_ms: [number, number];
  transition_ms: [number, number];
  beat_ms: [number, number];
  flash_ms: [number, number];
  push_in_max_ms: number;
  slow_motion_max_ms: number;
  text_hold: { base_ms: number; per_word_ms: number; max_ms: number };
  icon_hold_ms: [number, number];
  clip_max_factor: number;
}

// How protected spans are built from busy spans (spec section 10).
export interface Protection {
  padding_ms: number;
  min_window_ms: number;
  merge_gap_ms: number;
}

// One output's size, bitrate and overlay safe rectangle.
export interface OutputSpec {
  width: number;
  height: number;
  bitrate: number;
  safe: SafeRect;
}

// ---- Request (app to server, spec section 9) ----

// One change of the facecam on the master timeline; `r` is a fraction of the master width.
export interface FacecamKey {
  t_ms: number;
  cx: number;
  cy: number;
  r: number;
}

export type ActivityType =
  | 'brush'
  | 'board_show'
  | 'board_hide'
  | 'slide_change'
  | 'motion';

// One thing that changed on screen; `brush` and `motion` are protected, the rest are markers.
export interface ActivityEntry {
  id: string;
  type: ActivityType;
  start_ms: number;
  end_ms: number;
  region: { x: number; y: number; w: number; h: number };
  strength: number;
  source: 'event_log' | 'frame_diff';
}

// One output the user enabled: its top-anchored crop of the master and the caption band of the user's subtitle style.
export interface EditRequestOutput {
  ratio: OutputRatio;
  crop: { x: number; y: number; w: number; h: number };
  caption_band: { y0: number; y1: number };
}

// The body's `request` object of `POST /public/v1/ai-edits`.
export interface EditRequest {
  contract_version: number;
  video: {
    duration_ms: number;
    width: number;
    height: number;
    fps: number;
    source: 'in_app_recording' | 'imported';
  };
  outputs: EditRequestOutput[];
  facecam_track: FacecamKey[];
  activity_map: ActivityEntry[];
  text_colors: 'multi' | 'brand';
  language?: string;
  // `text_motions` and `text_features` are optional: absent means the legacy motions and looks needing no feature only
  capabilities: { effects: string[]; text_styles: string[]; text_motions?: string[]; text_features?: string[] };
  options: { sound_effects: boolean };
}

// One spoken word of the transcript, `i` counted from 0 over words only.
export interface EditWord {
  i: number;
  w: string;
  start_ms: number;
  end_ms: number;
  conf?: number;
}

// ---- Plan (server to app, spec section 16): every time is on the OUTPUT timeline, in integer milliseconds ----

export interface PlanCut {
  src_start_ms: number;
  src_end_ms: number;
  reason: string;
}

export interface PlanSpeedSegment {
  src_start_ms: number;
  src_end_ms: number;
  rate: number;
}

// The facecam as the plan carries it; the radius is a fraction of the master width.
export interface PlanFacecamKey {
  t_ms: number;
  cx: number;
  cy: number;
  radius: number;
}

// The text colours the server already resolved (multi colour, or the workspace colour).
export interface Palette {
  mode: 'multi' | 'brand';
  colors: string[];
}

// A text overlay: a word or phrase drawn with one text look in one palette colour.
export interface StyledTextComponent {
  type: 'styled_text';
  kind: TextKind;
  text: string;
  style_preset: string;
  color_slot: number;
}

// An mp4 clip or icon image of the plan's asset list; `fit` says how a clip is sped up to the slot.
export interface AssetComponent {
  type: 'icon_video' | 'icon_image';
  asset_id: string;
  native_duration_ms?: number;
  fit?: { mode: 'speed_up' | 'native'; factor: number };
}

export type PlanComponent = StyledTextComponent | AssetComponent;

// One effect on the output timeline. `params` are the registry's `default_params` keys, inside `param_limits`.
export interface PlanItem {
  id: string;
  effect: string;
  layer: EffectLayer;
  target: EffectTarget;
  start_ms: number;
  end_ms: number;
  anchor?: { word_index: number; offset_ms: number };
  position?: { zone: ZoneId };
  component?: PlanComponent;
  params: Record<string, number | string | boolean>;
  sound?: { id: SoundId | string; offset_ms: number };
  reason?: string;
}

// The captions of the whole video: one caption effect plus the words drawn bigger.
export interface PlanCaptions {
  effect: string;
  emphasis_words: number[];
}

// A file the phone downloads once; a component's `asset_id` and a sound's `id` name an entry.
export interface PlanAsset {
  id: string;
  kind: 'video' | 'icon' | 'sound';
  url: string;
  native_duration_ms?: number;
  width?: number;
  height?: number;
}

export interface Plan {
  contract_version: number;
  plan_version: number;
  session_id: string;
  level: EditLevel;
  video: { output_duration_ms: number };
  structure: { cuts: PlanCut[]; speed_segments: PlanSpeedSegment[] };
  facecam_track: PlanFacecamKey[];
  palette: Palette;
  items: PlanItem[];
  captions: PlanCaptions;
  warnings: string[];
}

// Where a job stands (`GET /public/v1/ai-edits/:id`); the last three are final.
export type EditStatus =
  | 'PENDING'
  | 'TRANSCRIBING'
  | 'PLANNING'
  | 'READY'
  | 'NO_SPEECH'
  | 'FAILED';

// ---- Effect registry (spec section 14) ----

export type EffectCost = 'L' | 'M' | 'H';

export type ParamValue = number | string | boolean;

// One effect: what it may target, how long it may last, its defaults and limits. The AI sees ids only; the
// validator and the renderer read the whole entry.
export interface RegistryEntry {
  id: string;
  layer: EffectLayer;
  target: EffectTarget;
  allowed_components: ComponentType[];
  min_level: EditLevel;
  content_safe: boolean;
  cost: EffectCost;
  min_duration_ms: number;
  max_duration_ms: number;
  default_params: Record<string, ParamValue>;
  param_limits: Record<string, [number, number]>;
  cooldown_ms: number;
  max_per_video: number;
  sound: SoundId[];
  brand_colorable: boolean;
  requires: string[];
}

// ---- Text looks (spec section 13): colour roles, never fixed colours; sizes are fractions of the text size `s` ----

export type ColorRole = 'accent' | 'accent_dark' | 'accent_light' | 'on_accent' | 'ink' | 'paper';

// How the derived roles come from the item's accent, the same in multi colour and brand mode (brand has one accent):
// `accent_dark` is the accent with every channel times `factor`; `accent_light` is the accent mixed with paper, `paper_share`
// of it paper. `on_accent` is ink or paper, whichever reads better on the accent.
export interface RoleDerivation {
  accent_dark: { factor: number };
  accent_light: { paper_share: number };
}

// The direction of a gradient over the measured text (or box): left to right, top to bottom, or corner to corner.
export type GradientDirection = 'ltr' | 'ttb' | 'diag';

// One solid colour or one two-stop gradient between colour roles (a box fill adds its own `alpha`).
export type FillSpec =
  | { kind: 'solid'; color: ColorRole }
  | { kind: 'gradient'; direction: GradientDirection; from: ColorRole; to: ColorRole };

export type StrokeJoin = 'round' | 'miter' | 'bevel';
export type BoxShape = 'pill' | 'rounded' | 'sharp';
export type FontFamily = 'sans' | 'sans_condensed' | 'serif' | 'mono';
// `upper` is drawn as Title Case since the owner decision of 2026-11-20 (older phones drew all capitals); the name stays
// for compatibility with installed phones and the six shipped looks.
export type TextCase = 'as_written' | 'upper';

// A shadow of the text or of the box; `blur` 0 is a hard offset block. dx, dy, blur are fractions of `s`.
export interface ShadowSpec {
  color: ColorRole;
  alpha: number;
  dx: number;
  dy: number;
  blur: number;
}

// The box behind the text (new format). `radius` is a fraction of the box height (0.5 = fully round), `padding` of `s`.
// The border sits on the box edge; `ring` is a second outline outside it, `gap` apart, all of `s`.
export interface BoxSpec {
  shape: BoxShape;
  fill: FillSpec & { alpha: number };
  border: { color: ColorRole; width: number; ring: { color: ColorRole; width: number; gap: number } | null } | null;
  radius: number;
  padding: { x: number; y: number };
  shadow: (ShadowSpec & { style: 'soft' | 'hard' }) | null;
  glow: { color: ColorRole; alpha: number; blur: number } | null;
}

// The layers of one text overlay, back to front; two phones must stack them the same.
export type TextLayer =
  | 'box_shadow'
  | 'box_fill'
  | 'box_border'
  | 'text_shadow'
  | 'text_stroke'
  | 'text_fill'
  | 'glow';

// What a look needs the phone to be able to draw beyond the legacy format; a phone lists the ones it passed in
// `capabilities.text_features`. Absent list: only looks needing none.
export type TextFeature =
  | 'text_gradient_ltr'
  | 'text_gradient_diag'
  | 'text_stroke_join'
  | 'box_gradient'
  | 'box_border'
  | 'box_border_ring'
  | 'box_glow'
  | 'opacity'
  | 'font_family'
  | 'font_weight'
  | 'case_as_written'
  | 'letter_spacing';

// A text look. The first block (`fill` to `tilt_deg`) is the legacy format that installed phones read with a strict
// reader: it never changes, and an old phone ignores every key beside it. The second block (`text_fill` to
// `letter_spacing`) is the new format, required on every look, `null` = off, and says the same look completely; where
// both name one thing they draw the same result (see the spec of card S6).
export interface TextLook {
  id: string;
  fill: ColorRole | { gradient: 'vertical'; from: ColorRole; to: ColorRole };
  stroke: { color: ColorRole; width: number } | null;
  shadow: {
    color: ColorRole;
    alpha: number;
    dx: number;
    dy: number;
    blur: number;
  } | null;
  glow: { color: ColorRole; alpha: number; blur: number } | null;
  extrude: { copies: number; color: ColorRole; dx: number; dy: number } | null;
  // A rounded rectangle behind the text; `radius` is a fraction of its height, `pad_x`/`pad_y` of `s`.
  background: {
    color: ColorRole;
    alpha: number;
    radius: number;
    pad_x: number;
    pad_y: number;
  } | null;
  // A marker bar behind the text, `height` a fraction of the line, swept left to right during the entry.
  bar: { color: ColorRole; alpha: number; height: number } | null;
  tilt_deg: [number, number] | null;
  // ---- new format (additive) ----
  text_fill: FillSpec;
  text_stroke: { color: ColorRole; width: number; join: StrokeJoin } | null;
  text_shadow: ShadowSpec | null;
  box: BoxSpec | null;
  // The whole overlay's opacity, 0 to 1.
  opacity: number;
  // The system family and weight (100 to 900) the phone maps to its own fonts; every script falls back.
  font: { family: FontFamily; weight: number };
  case: TextCase;
  // Extra space between graphemes, a fraction of `s` (the phone uses 0 for scripts that join their letters).
  letter_spacing: number;
}

// One closed commentary phrase: its mood tags and its text per language; a language without one falls back to keyword echo.
export interface Phrase {
  id: string;
  mood: string[];
  text: { en: string; bn: string } & Record<string, string>;
}

// The 5 multi colour accents and the two neutrals the looks draw with.
export interface PaletteSpec {
  multi: string[];
  ink: string;
  paper: string;
}

// ---- Rule tables (values exactly as in the task plan's contract) ----

export const LEVEL_RULES: Record<EditLevel, LevelRule> = {
  basic: {
    max_feature_effects: 3,
    max_icons: 0,
    text_kinds: ['keyword_echo', 'hook'],
    transitions: false,
    sounds: false,
    perception: false,
    writer: false,
  },
  standard: {
    max_feature_effects: 6,
    max_icons: 2,
    text_kinds: ['keyword_echo', 'hook', 'commentary'],
    transitions: true,
    sounds: true,
    perception: true,
    writer: false,
  },
  heavy: {
    max_feature_effects: 10,
    max_icons: 4,
    text_kinds: ['keyword_echo', 'hook', 'commentary', 'complementary'],
    transitions: true,
    sounds: true,
    perception: true,
    writer: true,
  },
};

export const SPEED_RULES: SpeedRules = {
  entry_ms: [120, 300],
  exit_ms: [100, 200],
  transition_ms: [150, 300],
  beat_ms: [80, 400],
  flash_ms: [80, 150],
  push_in_max_ms: 800,
  slow_motion_max_ms: 500,
  text_hold: { base_ms: 500, per_word_ms: 150, max_ms: 2500 },
  icon_hold_ms: [500, 1500],
  clip_max_factor: 3.0,
};

export const PROTECTION: Protection = {
  padding_ms: 300,
  min_window_ms: 500,
  merge_gap_ms: 400,
};

// One entry per ratio, 9:16 first (object key order is the listing order).
export const OUTPUTS: Record<OutputRatio, OutputSpec> = {
  '9:16': {
    width: 1080,
    height: 1920,
    bitrate: 12000000,
    safe: { x0: 0.06, x1: 0.94, y0: 0.1, y1: 0.62 },
  },
  '4:5': {
    width: 720,
    height: 900,
    bitrate: 6000000,
    safe: { x0: 0.06, x1: 0.94, y0: 0.08, y1: 0.66 },
  },
  '1:1': {
    width: 720,
    height: 720,
    bitrate: 6000000,
    safe: { x0: 0.06, x1: 0.94, y0: 0.08, y1: 0.68 },
  },
};

// Zone centres as fractions of an output's safe rectangle (x across x0 to x1, y across y0 to y1).
export const ZONES: Record<ZoneId, [number, number]> = {
  upper_left: [0.22, 0.2],
  upper_center: [0.5, 0.2],
  upper_right: [0.78, 0.2],
  middle_center: [0.5, 0.55],
  lower_center: [0.5, 0.85],
};

// How long a text overlay of `words` words is held: 500 ms plus 150 ms a word, at most 2500 ms.
export const textHoldMs = (words: number) =>
  Math.min(
    SPEED_RULES.text_hold.max_ms,
    SPEED_RULES.text_hold.base_ms + SPEED_RULES.text_hold.per_word_ms * words
  );
