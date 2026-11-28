// AI video editing (ai.video-editing), planner core: the text style chooser (spec "Text styles and animations", card
// S4). Picks, for one text on a zone already found, the effect and look (rotating for variety), the entry, hold and
// exit motions (energy from the mood, slide side from the zone) and the tilt range of the look, filtered by what the
// phone listed in `capabilities` (`text_styles` and `text_features` for a look, `text_motions` for the motions; absent
// motions: the legacy five, absent features: none, so only a look needing none). Every pick keeps a
// reason code for the trace. Pure functions, no Nest or Prisma import.
import { EditLevel, ParamValue, TextKind, TextLook, ZoneId } from '../contract/edit.contract';
import { effectById, effectsForLevel } from '../contract/edit.registry';
import { ENTRY_MOTIONS, MotionGroup, motionSpec, motionUsable, textMotionsOf } from '../contract/edit.motions';
import { TEXT_LOOKS, boxedLookId, lookUsable, requiredFeatures, textLookById } from '../contract/edit.styles';

// What the chooser reads of the request's capabilities.
export interface TextStyleCapabilities {
  effects: string[];
  text_styles: string[];
  text_motions?: string[] | null;
  text_features?: string[] | null;
}

// How lively a text moves: `high` (excited, a hook), `low` (calm, serious, sad), `mid` (no mood, playful).
export type TextEnergy = 'high' | 'mid' | 'low';

// An effect and the look it draws. `fixed` marks an effect whose entry is part of its identity (the stamp, the marker
// sweep): its entry is never replaced.
interface TextPair {
  effect: string;
  look: string;
  fixed?: boolean;
}

// The text effect and the look it draws, in the order they are rotated for variety, per level. The looks of card S8 are
// interleaved with the shipped pairs, so a video of a few texts shows them too; a phone that lists none of them (or lacks
// their features) has them filtered out. The pairs are written with the look of their effect; `pairsFor` draws a look
// without a background as the box look it maps to (TS13), so these four stay as released and are never planned as they are.
// A new look rides `x_pop` or `x_slide_up`, which bind no look: the validator puts the look an effect binds back (rule 13).
const TEXT_STYLE_PAIRS: Record<EditLevel, TextPair[]> = {
  basic: [
    { effect: 'x_sticker', look: 'sticker' },
    { effect: 'x_pop', look: 'pill_ring' },
    { effect: 'x_label_tag', look: 'label_pill' },
    { effect: 'x_pop', look: 'solid_round' },
  ],
  standard: [
    { effect: 'x_sticker', look: 'sticker' },
    { effect: 'x_pop', look: 'neon_box' },
    { effect: 'x_label_tag', look: 'label_pill' },
    { effect: 'x_slide_up', look: 'pill_ring' },
    { effect: 'x_3d', look: '3d' },
    { effect: 'x_pop', look: 'tilt_sticker' },
    { effect: 'x_glow', look: 'glow' },
    { effect: 'x_pop', look: 'solid_round' },
    { effect: 'x_stamp', look: 'sticker', fixed: true },
    { effect: 'x_pop', look: 'yellow_bold' },
    { effect: 'x_slide_up', look: 'flat_rect' },
  ],
  heavy: [
    { effect: 'x_sticker', look: 'sticker' },
    { effect: 'x_pop', look: 'neon_box' },
    { effect: 'x_label_tag', look: 'label_pill' },
    { effect: 'x_slide_up', look: 'pill_ring' },
    { effect: 'x_3d', look: '3d' },
    { effect: 'x_pop', look: 'gradient_block' },
    { effect: 'x_glow', look: 'glow' },
    { effect: 'x_pop', look: 'tilt_sticker' },
    { effect: 'x_marker_sweep', look: 'highlighter', fixed: true },
    { effect: 'x_pop', look: 'solid_round' },
    { effect: 'x_stamp', look: 'sticker', fixed: true },
    { effect: 'x_slide_up', look: 'pastel_pill' },
    { effect: 'x_gradient', look: 'gradient' },
    { effect: 'x_slide_up', look: 'flat_rect' },
    { effect: 'x_pop', look: 'label_pill' },
    { effect: 'x_pop', look: 'yellow_bold' },
    { effect: 'x_slide_up', look: 'dark_accent' },
    { effect: 'x_pop', look: 'coral_pill' },
  ],
};

// The energy of each mood perception answers with; a mood not here (or none) is `mid`.
const MOOD_ENERGY = new Map<string, TextEnergy>([
  ['excited', 'high'],
  ['surprising', 'high'],
  ['funny', 'mid'],
  ['calm', 'low'],
  ['serious', 'low'],
  ['sad', 'low'],
]);

// The entries of each energy, in the order they rotate. `own` is the effect's own entry and `slide` the one from the
// side of the zone; an entry the phone does not draw is skipped, and a `mid` text on a phone that lists no motion keeps
// its effect's own entry.
const ENTRIES: Record<TextEnergy, string[]> = {
  high: ['pop', 'stamp', 'drop_bounce', 'flip', 'glitch'],
  mid: ['own', 'fade', 'slide', 'wipe', 'typewriter'],
  low: ['fade', 'slide', 'typewriter', 'wipe', 'blur_in'],
};

// The holds of each energy, in rotation order (`none` is a still hold).
const HOLDS: Record<TextEnergy, string[]> = {
  high: ['shake', 'pulse', 'none'],
  mid: ['none', 'float', 'pulse'],
  low: ['none', 'float', 'shimmer'],
};

// The exits of each energy, in rotation order (the excited never fade out).
const EXITS: Record<TextEnergy, string[]> = {
  high: ['pop_out', 'shrink', 'slide_out'],
  mid: ['fade', 'slide_out', 'shrink'],
  low: ['fade', 'slide_out'],
};

// A hold that belongs to a look, offered with the energy's own holds.
const LOOK_HOLD: Record<string, string> = {
  neon_box: 'neon_flicker',
  gradient_block: 'shimmer',
};

// The exit that undoes an entry (the text is taken away the way it came).
const ENTRY_EXIT: Record<string, string> = { typewriter: 'typewriter_delete', wipe: 'wipe_out' };

// The side of the frame a zone is nearest, for the slide in and out.
const ZONE_SIDE: Record<ZoneId, 'left' | 'right' | 'top' | 'bottom'> = {
  upper_left: 'left',
  upper_center: 'top',
  upper_right: 'right',
  middle_center: 'bottom',
  lower_center: 'bottom',
};

// The cursor of the rotations: `pair` is the effect and look to try first, `motion` how many texts are placed so far
// (the motions rotate by it, so a look does not always carry the same motion).
export interface TextCursor {
  pair: number;
  motion: number;
}

// What the chooser decided. `params` are the motion params to lay over the effect's own `default_params`; `tilt` is the
// look's tilt range (the item's signed `params.tilt_deg` comes from `tiltFromId` once its id is known); `index` is the
// position of the effect and look in the candidates (the next cursor is `index + 1`); `why` holds the reason codes.
export interface TextStyle {
  index: number;
  effect: string;
  look: string;
  entry: string;
  hold: string;
  exit: string;
  params: Record<string, ParamValue>;
  tilt: [number, number] | null;
  why: Record<string, string>;
}

// The energy of a text: a hook is lively, otherwise the mood decides. Also the code of where it came from.
export const textEnergy = (kind: TextKind, mood?: string): [TextEnergy, string] => {
  if (kind === 'hook') return ['high', 'hook'];
  const energy = mood ? MOOD_ENERGY.get(mood) : undefined;
  return energy ? [energy, 'mood'] : ['mid', 'default'];
};

// The effects and looks a text of this energy may take at a level: effects the level and the phone allow, looks the
// phone lists and has every feature of (`looks` is the look table, the shipped one by default), no fixed effect whose entry the phone does not draw, and not one whose fixed entry belongs to the
// opposite energy (that last rule falls back to all of them). Every text has a background: a pair's look is the one
// drawn in its place (`boxedLookId`), and a pair that becomes the same as an earlier one is dropped.
const pairsFor = (
  energy: TextEnergy,
  level: EditLevel,
  caps?: TextStyleCapabilities,
  looks: TextLook[] = TEXT_LOOKS
): TextPair[] => {
  const allowed = new Set(effectsForLevel(level, caps).map((e) => e.id));
  const motions = textMotionsOf(caps);
  const ownEntry = (p: TextPair) => String(effectById(p.effect)?.default_params.entry);
  // a plan with no capabilities at all (no phone to ask) gets only the looks of the legacy format, as it gets only the
  // legacy motions: a look needing a feature waits for a phone that lists it
  const drawable = (look: TextLook | undefined) => lookUsable(look, caps) && (!!caps || !requiredFeatures(look!).length);
  const boxed = TEXT_STYLE_PAIRS[level]
    .map((p) => ({ ...p, look: boxedLookId(p.look, looks) }))
    .filter((p, at, all) => all.findIndex((q) => q.effect === p.effect && q.look === p.look) === at);
  const pairs = boxed.filter(
    (p) =>
      allowed.has(p.effect) &&
      drawable(textLookById(p.look, looks)) &&
      (!p.fixed || motionUsable(motions, 'entry', ownEntry(p)))
  );
  const opposite = energy === 'high' ? 'low' : energy === 'low' ? 'high' : null;
  const fits = pairs.filter((p) => !p.fixed || !opposite || !ENTRIES[opposite].includes(ownEntry(p)));
  return fits.length ? fits : pairs;
};

// The effect and look candidates of a text, in rotation order, so the caller can try the next one on a conflict.
export const textStyleCandidates = (
  kind: TextKind,
  mood: string | undefined,
  level: EditLevel,
  caps?: TextStyleCapabilities,
  looks: TextLook[] = TEXT_LOOKS
): { effect: string; look: string }[] => pairsFor(textEnergy(kind, mood)[0], level, caps, looks);

// Picks the motion at `at` of a rotation, or undefined for an empty one.
const rotate = <T>(list: T[], at: number): T | undefined => (list.length ? list[at % list.length] : undefined);

// The style of one text on a zone: effect, look, entry, hold, exit and tilt range, or null when no effect and look is
// allowed. `cursor` says where the rotations stand; the same inputs always give the same style.
export const chooseTextStyle = (
  kind: TextKind,
  mood: string | undefined,
  zone: ZoneId,
  cursor: TextCursor,
  level: EditLevel,
  caps?: TextStyleCapabilities,
  looks: TextLook[] = TEXT_LOOKS
): TextStyle | null => {
  const [energy, energyFrom] = textEnergy(kind, mood);
  const pairs = pairsFor(energy, level, caps, looks);
  if (!pairs.length) return null;
  const index = ((cursor.pair % pairs.length) + pairs.length) % pairs.length;
  const pair = pairs[index];
  const own = String(effectById(pair.effect)?.default_params.entry);
  const allowed = textMotionsOf(caps);
  const usable = (group: MotionGroup, id: string) => !!motionSpec(group, id) && motionUsable(allowed, group, id);
  const side = ZONE_SIDE[zone];
  const why: Record<string, string> = { energy, energy_from: energyFrom, side };
  const params: Record<string, ParamValue> = {};

  // entry: the effect's own when it is fixed, else the energy's rotation, else the effect's own or the first one the
  // phone draws
  const wanted = pair.fixed
    ? []
    : ENTRIES[energy]
        .map((id) => (id === 'own' ? own : id === 'slide' ? `slide_${side}` : id))
        .filter((id) => usable('entry', id));
  const entry =
    rotate(wanted, cursor.motion) ??
    [own, ...ENTRY_MOTIONS.map((spec) => spec.id)].find((id) => usable('entry', id)) ??
    own;
  why.entry = pair.fixed ? 'fixed' : wanted.length ? 'energy' : 'own';
  if (entry !== own) {
    const spec = motionSpec('entry', entry);
    params.entry = entry;
    if (spec?.ms_key) params[spec.ms_key] = spec.default_ms;
  }

  // hold: a still hold needs no param
  const holds = [LOOK_HOLD[pair.look], ...HOLDS[energy]].filter((id): id is string => !!id && usable('hold', id));
  const hold = rotate(holds, cursor.motion + 1) ?? 'none';
  why.hold = hold === 'none' ? 'still' : 'energy';
  if (hold !== 'none') {
    const spec = motionSpec('hold', hold);
    params.hold = hold;
    if (spec?.ms_key) params[spec.ms_key] = spec.default_ms;
  }

  // exit: the one that undoes the entry when there is one, else the energy's rotation; none (the phone's own fade) when
  // the phone lists none
  const paired = ENTRY_EXIT[entry];
  const exits = paired && usable('exit', paired) ? [paired] : EXITS[energy].filter((id) => usable('exit', id));
  const exit = rotate(exits, cursor.motion + 2) ?? 'none';
  why.exit = !exits.length ? 'legacy' : exits[0] === paired ? 'paired' : 'energy';
  if (exits.length) {
    const spec = motionSpec('exit', exit);
    params.exit = exit;
    if (spec?.ms_key) params[spec.ms_key] = spec.default_ms;
    if (exit === 'slide_out') params.exit_dir = side;
  }

  return {
    index,
    effect: pair.effect,
    look: pair.look,
    entry,
    hold,
    exit,
    params,
    tilt: textLookById(pair.look, looks)?.tilt_deg ?? null,
    why,
  };
};

// The signed tilt in degrees of an item, from a hash (FNV-1a, mixed) of its id, inside the look's range: the same id always
// gives the same tilt. A range around 0 tilts at least half its bound, so a tilt is always seen.
export const tiltFromId = (id: string, range: [number, number]): number => {
  let h = 2166136261;
  for (const ch of id) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 16777619) >>> 0;
  }
  // a finishing mix, so ids that differ in one character still spread over the range
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  const u = (h >>> 8) / 0x1000000;
  const [lo, hi] = range;
  let tilt = lo + (hi - lo) * u;
  if (lo < 0 && hi > 0) {
    const positive = (h & 1) === 1;
    const mag = (positive ? hi : -lo) * (0.5 + 0.5 * u);
    tilt = positive ? mag : -mag;
  }
  return Math.min(hi, Math.max(lo, Math.round(tilt * 10) / 10));
};
