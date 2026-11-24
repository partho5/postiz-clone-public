// AI video editing (ai.video-editing): the motion tables of a text overlay (spec "Text styles and animations"). Every
// value `params.entry`, `params.hold` and `params.exit` may take, each with its duration key and its limits. Motions are
// params of the existing `x_*` text effects, never new effect ids, and the phone is only sent the ones it listed in
// `capabilities.text_motions` (installed phones know only LEGACY_TEXT_MOTIONS). Every duration obeys SPEED_RULES.
import { ParamValue, RegistryEntry } from './edit.contract';

// The three moments of an overlay's life.
export type MotionGroup = 'entry' | 'hold' | 'exit';

// One motion: its id, the param that carries its duration (null = none) and the limits of that duration in ms.
export interface MotionSpec {
  id: string;
  ms_key: string | null;
  min_ms: number;
  default_ms: number;
  max_ms: number;
}

// One motion of a table.
const motion = (
  id: string,
  ms_key: string | null,
  min_ms: number,
  default_ms: number,
  max_ms: number
): MotionSpec => ({ id, ms_key, min_ms, default_ms, max_ms });

// Entry: fast, 120 to 300 ms (SPEED_RULES.entry_ms); `typewriter` runs about 30 ms a grapheme, its own key `typing_ms`.
export const ENTRY_MOTIONS: MotionSpec[] = [
  motion('pop', 'entry_ms', 120, 200, 300),
  motion('stamp', 'entry_ms', 120, 140, 180),
  motion('slide_up', 'entry_ms', 120, 220, 300),
  motion('word_by_word', 'entry_ms', 120, 200, 300),
  motion('sweep', 'entry_ms', 120, 200, 300),
  motion('fade', 'entry_ms', 120, 180, 300),
  motion('slide_left', 'entry_ms', 120, 220, 300),
  motion('slide_right', 'entry_ms', 120, 220, 300),
  motion('slide_top', 'entry_ms', 120, 220, 300),
  motion('slide_bottom', 'entry_ms', 120, 220, 300),
  motion('typewriter', 'typing_ms', 200, 400, 500),
  motion('wipe', 'entry_ms', 150, 220, 300),
  motion('drop_bounce', 'entry_ms', 150, 260, 300),
  motion('blur_in', 'entry_ms', 150, 220, 300),
  motion('flip', 'entry_ms', 150, 220, 300),
  motion('glitch', 'entry_ms', 120, 180, 260),
];

// Hold: a loop while the text is shown; the duration is one cycle of the loop. `none` is a still hold.
export const HOLD_MOTIONS: MotionSpec[] = [
  motion('none', null, 0, 0, 0),
  motion('float', 'hold_ms', 1200, 1800, 3000),
  motion('pulse', 'hold_ms', 500, 800, 1200),
  motion('shake', 'hold_ms', 80, 120, 200),
  motion('shimmer', 'hold_ms', 600, 1000, 1600),
  motion('neon_flicker', 'hold_ms', 80, 160, 400),
];

// Exit: 100 to 200 ms (SPEED_RULES.exit_ms); the exit ends exactly at the item's end.
export const EXIT_MOTIONS: MotionSpec[] = [
  motion('fade', 'exit_ms', 100, 150, 200),
  motion('slide_out', 'exit_ms', 100, 150, 200),
  motion('shrink', 'exit_ms', 100, 150, 200),
  motion('pop_out', 'exit_ms', 100, 150, 200),
  motion('typewriter_delete', 'exit_ms', 100, 200, 200),
  motion('wipe_out', 'exit_ms', 100, 150, 200),
];

// The sides `params.exit_dir` may name; only `slide_out` reads it (the reveal exits follow the reading direction).
export const EXIT_DIRS = ['left', 'right', 'top', 'bottom'];

// The five entries installed phones draw; any other `params.entry` becomes `pop` on them, so a request without
// `capabilities.text_motions` is planned with these only.
export const LEGACY_TEXT_MOTIONS = ['pop', 'stamp', 'slide_up', 'word_by_word', 'sweep'];

// The params of a text item that belong to its motion, kept by the validator on an effect that takes motions; `tilt_deg`
// is the signed tilt the chooser writes inside the look's range.
export const MOTION_PARAM_KEYS = [
  'entry',
  'entry_ms',
  'typing_ms',
  'hold',
  'hold_ms',
  'exit',
  'exit_ms',
  'exit_dir',
  'tilt_deg',
];

// The table of a group.
const TABLES: Record<MotionGroup, MotionSpec[]> = {
  entry: ENTRY_MOTIONS,
  hold: HOLD_MOTIONS,
  exit: EXIT_MOTIONS,
};

// The id a motion has in `capabilities.text_motions`: entries as they are, the others prefixed with their group
// (`hold_float`, `exit_fade`), as `fade` is both an entry and an exit.
export const motionCapabilityId = (group: MotionGroup, id: string) =>
  group === 'entry' ? id : `${group}_${id}`;

// Every id a phone may list in `capabilities.text_motions`, in table order (the still hold `none` needs no listing).
export const TEXT_MOTION_IDS: string[] = (['entry', 'hold', 'exit'] as MotionGroup[]).flatMap((group) =>
  TABLES[group]
    .filter((spec) => spec.id !== 'none')
    .map((spec) => motionCapabilityId(group, spec.id))
);

// The motions a phone draws: what it listed in `capabilities.text_motions`, or the legacy five when it listed none (the
// list absent or null).
export const textMotionsOf = (capabilities?: { text_motions?: string[] | null }): string[] =>
  capabilities?.text_motions ?? LEGACY_TEXT_MOTIONS;

// Whether a phone that draws `allowed` (see `textMotionsOf`) draws one motion; the still hold is always drawn.
export const motionUsable = (allowed: string[], group: MotionGroup, id: string) =>
  id === 'none' || allowed.includes(motionCapabilityId(group, id));

// One motion of a group by id, or undefined.
export const motionSpec = (group: MotionGroup, id: unknown) =>
  TABLES[group].find((spec) => spec.id === id);

// Whether an effect takes entry, hold and exit params: a text effect whose entry is one of the table (the drawn and
// counted effects `draw` and `count_up` keep their own).
export const takesMotion = (entry: RegistryEntry) =>
  entry.layer === 'text' && !!motionSpec('entry', entry.default_params.entry);

// The duration of one motion inside its limits: a missing key gets the default quietly, a non-number the default and a
// code, a number out of range the nearest limit and a code.
const fitMs = (
  params: Record<string, ParamValue>,
  spec: MotionSpec | undefined,
  codes: string[]
) => {
  if (!spec?.ms_key) return;
  const v = params[spec.ms_key];
  if (v === undefined) {
    params[spec.ms_key] = spec.default_ms;
  } else if (typeof v !== 'number' || !Number.isFinite(v)) {
    params[spec.ms_key] = spec.default_ms;
    codes.push('param_reset');
  } else if (v < spec.min_ms || v > spec.max_ms) {
    params[spec.ms_key] = Math.min(spec.max_ms, Math.max(spec.min_ms, v));
    codes.push('param_clamped');
  }
};

// Repairs the motion params of an item of a motion effect, in place: an unknown entry goes back to the effect's own,
// an unknown hold, exit or exit direction is removed, and each chosen motion's duration is put inside its limits.
// Returns one code per repair (`param_reset`, `param_clamped`).
export const repairMotionParams = (
  params: Record<string, ParamValue>,
  defaults: Record<string, ParamValue>
): string[] => {
  const codes: string[] = [];
  if (!motionSpec('entry', params.entry)) {
    params.entry = defaults.entry;
    codes.push('param_reset');
  }
  for (const [key, group] of [['hold', 'hold'], ['exit', 'exit']] as [string, MotionGroup][]) {
    if (params[key] !== undefined && !motionSpec(group, params[key])) {
      delete params[key];
      codes.push('param_reset');
    }
  }
  if (params.exit_dir !== undefined && !EXIT_DIRS.includes(String(params.exit_dir))) {
    delete params.exit_dir;
    codes.push('param_reset');
  }
  fitMs(params, motionSpec('entry', params.entry), codes);
  fitMs(params, motionSpec('hold', params.hold), codes);
  // exit_ms keeps its limits even with no `exit` named: a legacy exit is a fade
  fitMs(params, motionSpec('exit', params.exit) ?? motionSpec('exit', 'fade'), codes);
  return codes;
};

// Puts the motions a phone does not draw (not in `allowed`) right, in place, for an item whose motions are all known
// ids (after `repairMotionParams`): an entry becomes the effect's own or the first the phone draws, with that entry's
// default duration; a hold or exit is removed (a still hold, a fade exit, which every phone draws). Returns one code
// per swap (`motion_swapped`).
export const swapUnusableMotions = (
  params: Record<string, ParamValue>,
  defaults: Record<string, ParamValue>,
  allowed: string[]
): string[] => {
  const codes: string[] = [];
  const entry = motionSpec('entry', params.entry);
  if (entry && !motionUsable(allowed, 'entry', entry.id)) {
    const next = [defaults.entry, ...ENTRY_MOTIONS.map((spec) => spec.id)]
      .map((id) => motionSpec('entry', id))
      .find((spec) => spec && motionUsable(allowed, 'entry', spec.id));
    if (next) {
      if (entry.ms_key && !(entry.ms_key in defaults)) delete params[entry.ms_key];
      params.entry = next.id;
      if (next.ms_key) params[next.ms_key] = next.default_ms;
      codes.push('motion_swapped');
    }
  }
  const hold = motionSpec('hold', params.hold);
  if (hold && !motionUsable(allowed, 'hold', hold.id)) {
    delete params.hold;
    if (hold.ms_key && !(hold.ms_key in defaults)) delete params[hold.ms_key];
    codes.push('motion_swapped');
  }
  const exit = motionSpec('exit', params.exit);
  if (exit && !motionUsable(allowed, 'exit', exit.id)) {
    delete params.exit;
    delete params.exit_dir;
    codes.push('motion_swapped');
  }
  return codes;
};
