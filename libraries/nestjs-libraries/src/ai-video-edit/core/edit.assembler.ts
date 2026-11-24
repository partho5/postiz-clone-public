// AI video editing (ai.video-editing), planner core: the assembler (spec section 11, step 7). Turns candidate slots
// (and, when there are any, perception scores, written texts and resolved assets) into plan items with deterministic
// rules: the level budget, pacing, variety, cooldowns, one overlay at a time, zones, text hold time, sound pairing and
// the colour rotation. It works with no scores and no texts: Basic is keyword echoes in `sticker` or `label_pill`,
// `v_punch_in` and caption emphasis. Pure functions, no Nest or Prisma import.
import {
  AssetComponent,
  EditLevel,
  EditRequestOutput,
  EditWord,
  LEVEL_RULES,
  PlanCaptions,
  PlanComponent,
  PlanFacecamKey,
  PlanItem,
  RegistryEntry,
  SPEED_RULES,
  TextKind,
  TextLook,
  ZoneId,
  textHoldMs,
} from '../contract/edit.contract';
import { phraseById } from '../contract/edit.phrases';
import { effectById, effectsForLevel } from '../contract/edit.registry';
import { textLookById } from '../contract/edit.styles';
import { SlotDecision, SlotDropCode } from './edit.decisions';
import { GeometryContext, OVERLAY_SIZE, overlayFits, placeOverlay, textLines, titleCase, wordCount } from './edit.geometry';
import {
  capText,
  concurrencyConflict,
  cooldownConflict,
  durationBounds,
  pacingFill,
  visiblePoints,
} from './edit.rules';
import { HOOK_LATEST_START_MS, Slot } from './edit.slots';
import { TextStyle, chooseTextStyle, textStyleCandidates, tiltFromId } from './edit.textstyle';
import { Span } from './edit.windows';

// The kinds of effect the assembler picks per slot; `none` (from perception) skips the slot.
export type Family = 'text' | 'camera' | 'look' | 'icon' | 'layout' | 'facecam';
export type FamilyChoice = Family | 'none';

// A slot's decision so far, with the item that was placed on it (its id is only known after the final sort).
type Pending = Omit<SlotDecision, 'slot_id'> & { item?: PlanItem };

// Why one try could not place an effect: a drop code and a short detail naming the check that failed.
interface Note {
  code: SlotDropCode;
  detail: string;
}

// What perception (Clef-omni) answered per slot or word; every field is optional, a missing one is "no opinion".
export interface SlotScores {
  mood?: string;
  energy?: number;
  // The probability (0 to 1) that the screen is busy; the activity map decides today, this is kept for imported videos.
  screen_busy?: number;
  // Word index to the probability (0 to 1) that the word is emphasised.
  emphasis?: Record<number, number>;
  // Slot id to a phrase id of the closed library, or `none`.
  commentary?: Record<string, string>;
  // Slot id to the effect family perception chose.
  family?: Record<string, FamilyChoice>;
}

// What the writer (Heavy) wrote: the hook title and the complementary phrase per slot id.
export interface SlotTexts {
  hook?: string;
  complementary?: Record<string, string>;
}

// One icon or mp4 clip the asset resolver found for a slot.
export interface IconChoice {
  asset_id: string;
  kind: 'icon_video' | 'icon_image';
  native_duration_ms?: number;
}

// The resolved assets: the sound ids the server can serve and the icon per slot id.
export interface AssembleAssets {
  sounds?: string[];
  icons?: Record<string, IconChoice>;
}

export interface AssembleInput {
  level: EditLevel;
  // Words, windows, cut points and facecam are all on the output timeline.
  words: EditWord[];
  windows: Span[];
  slots: Slot[];
  outputs: EditRequestOutput[];
  facecam: PlanFacecamKey[];
  durationMs: number;
  video?: { width: number; height: number };
  cutPoints?: number[];
  language?: string;
  // How many colours the plan's palette has (5 for multi colour, 1 for the brand colour).
  paletteSize?: number;
  capabilities?: {
    effects: string[];
    text_styles: string[];
    text_motions?: string[] | null;
    text_features?: string[] | null;
  };
  // The look table the chooser reads; the shipped `TEXT_LOOKS` unless a spec brings its own.
  looks?: TextLook[];
  soundEffects?: boolean;
  scores?: SlotScores;
  texts?: SlotTexts;
  assets?: AssembleAssets;
}

export interface AssembleResult {
  items: PlanItem[];
  captions: PlanCaptions;
  // What became of every candidate slot, in the slots' order: kept (with the item and effect) or dropped (with the
  // reason code and the inputs that decided it).
  decisions?: SlotDecision[];
}

const DEFAULT_VIDEO = { width: 1080, height: 2400 };

// The family of each chosen slot in turn (the hook slot is always text), per level, when perception gave none.
const FAMILY_CYCLE: Record<EditLevel, Family[]> = {
  basic: ['text', 'camera'],
  standard: ['text', 'camera', 'look', 'text', 'icon', 'camera', 'text', 'layout'],
  heavy: ['text', 'camera', 'look', 'text', 'icon', 'layout', 'text', 'camera', 'facecam', 'icon', 'look'],
};

// Tried in this order when the preferred family cannot be placed on a slot.
const FALLBACK_FAMILIES: Family[] = ['text', 'camera', 'look'];

// The effects of each non-text family, rotated for variety (the registry's min_level keeps Basic to the punch in).
const FAMILY_EFFECTS: Record<'camera' | 'look' | 'layout' | 'facecam', string[]> = {
  camera: ['v_punch_in', 'v_push_in', 'v_alt_crop', 'v_pull_out', 'v_bounce_scale', 'v_beat_rotate', 'v_pan_bounce', 'v_shake'],
  look: ['l_flash', 'l_rgb_glitch', 'l_color_pop', 'l_vignette_pulse', 'l_bloom'],
  layout: ['y_face_grow_slide_shrink', 'y_slide_grow_face_shrink'],
  facecam: ['f_pulse', 'f_pop_in', 'f_bounce_entry', 'f_glow_ring'],
};

const ICON_EFFECTS = ['i_scale_pop', 'i_wipe_reveal', 'i_stamp', 'i_wiggle', 'i_float_fade', 'i_spin_in', 'i_slide_in'];

// The transitions put on cut points, per level (Standard: flash or whip, Heavy: more).
const TRANSITIONS: Record<EditLevel, string[]> = {
  basic: [],
  standard: ['tr_flash_cut', 'tr_whip'],
  heavy: ['tr_whip', 'tr_flash_cut', 'tr_push', 'tr_zoom_blur', 'tr_glitch_cut', 'tr_dip_color'],
};

// The zones a text rotates through, and the ones an icon prefers (away from the text).
const TEXT_ZONES: ZoneId[] = ['upper_center', 'upper_left', 'upper_right'];
const ICON_ZONES: ZoneId[] = ['upper_right', 'upper_left'];

// A text or icon overlay starts this long before its word; a text is held this much longer than the minimum.
const ENTRY_LEAD_MS = 80;
const TEXT_EXTRA_MS = 150;

// No pick lasts longer than this unless the effect needs it.
const MAX_PICK_MS = 3000;

// Two transitions start at least this far apart.
const TRANSITION_SPACING_MS = 4000;

// An emphasis probability at or above this makes the word an emphasis word.
const EMPHASIS_MIN = 0.6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round10 = (v: number) => Math.round(v / 10) * 10;

// A typical duration of an effect: 40 % of the way from its minimum to its maximum (at most 3 s), in tens of ms.
const pickDuration = (entry: RegistryEntry) =>
  clamp(
    round10(
      entry.min_duration_ms +
        0.4 * (Math.min(entry.max_duration_ms, MAX_PICK_MS) - entry.min_duration_ms)
    ),
    entry.min_duration_ms,
    entry.max_duration_ms
  );

// Fits an item of `dur` ms into a free window as close to `wantStart` as it goes; null when the window is shorter
// than the item's `minDur`.
const placeInWindow = (
  win: Span,
  wantStart: number,
  dur: number,
  minDur: number
): Span | null => {
  const len = win.end_ms - win.start_ms;
  if (len < minDur) return null;
  const d = Math.min(dur, len);
  let start = Math.max(win.start_ms, wantStart);
  if (start + d > win.end_ms) start = win.end_ms - d;
  return { start_ms: start, end_ms: start + d };
};

// The key of the text language the closed phrases are written in, or null when the video's language has none.
const languageKey = (language?: string): string | null => {
  const l = (language || '').toLowerCase();
  if (l === 'en' || l === 'eng') return 'en';
  if (l === 'bn' || l === 'ben') return 'bn';
  return null;
};

// Plans the items of a video; see the header. The same inputs always give the same items.
export const assemble = (input: AssembleInput): AssembleResult => {
  const { level, words, windows, outputs, facecam } = input;
  const rules = LEVEL_RULES[level];
  const caps = input.capabilities;
  const allowed = new Set(effectsForLevel(level, caps).map((e) => e.id));
  const geo: GeometryContext = {
    video: input.video || DEFAULT_VIDEO,
    outputs,
    facecam,
  };
  const paletteSize = Math.max(1, input.paletteSize || 5);
  const soundsOn = rules.sounds && input.soundEffects !== false;
  const lang = languageKey(input.language);
  const placed: PlanItem[] = [];
  const cursor: Record<string, number> = {};
  // The style chosen for each text item (the made item and the one stored on the plan), for its tilt and its trace.
  const styleOf = new Map<PlanItem, TextStyle>();
  // The item a try made to the one on the plan (with its sound), to name the item a slot got.
  const storedOf = new Map<PlanItem, PlanItem>();
  let textCount = 0;
  let soundCount = 0;
  let iconCount = 0;

  // The starts of the items already placed for one effect.
  const startsOf = (id: string) =>
    placed.filter((p) => p.effect === id).map((p) => p.start_ms);

  // The indexes of a list of `n` candidates in rotation order, starting after the last one used for `key`.
  const order = (key: string, n: number) =>
    Array.from({ length: n }, (_, i) => ((cursor[key] || 0) + i) % n);

  // Why an item may not join the placed ones (cooldown, count per video, concurrency), or null when it may.
  const conflictOf = (item: PlanItem): Note | null => {
    const entry = effectById(item.effect);
    const cool = cooldownConflict(entry, startsOf(item.effect), item.start_ms);
    if (cool) return { code: cool === 'max_per_video' ? 'budget' : 'overlap', detail: cool };
    const busy = concurrencyConflict(placed, item);
    return busy ? { code: 'overlap', detail: busy } : null;
  };

  // Whether an item may join the placed ones.
  const accept = (item: PlanItem) => !conflictOf(item);

  // The reasons a try gave up on its candidates, for the decision of the slot; `notes` is the list of the try running.
  let notes: Note[] = [];
  const note = (code: SlotDropCode, detail: string) => notes.push({ code, detail });

  // Why no zone took an overlay: the facecam circle (a zone fits without it), a text too wide for the frame, or no room.
  const zoneMiss = (shape: Parameters<typeof placeOverlay>[0], zones: ZoneId[], start: number, end: number): Note => {
    if (placeOverlay(shape, zones, start, end, { ...geo, facecam: [] })) {
      return { code: 'facecam_collision', detail: 'facecam_in_zone' };
    }
    if (shape.type === 'text' && textLines(shape.text, shape.language) > OVERLAY_SIZE.max_lines) {
      return { code: 'text_too_long', detail: 'text_wider_than_frame' };
    }
    return { code: 'no_zone', detail: 'no_zone_fits' };
  };

  // A sound of the effect's list that the server can serve, rotating; undefined when sounds are off.
  const soundFor = (entry: RegistryEntry) => {
    if (!soundsOn) return undefined;
    const usable = entry.sound.filter(
      (id) => !input.assets?.sounds || input.assets.sounds.includes(id)
    );
    if (!usable.length) return undefined;
    return { id: usable[soundCount++ % usable.length], offset_ms: 0 };
  };

  // Puts an item on the plan: its sound is chosen now, so a refused item never uses up a sound.
  const commit = (item: PlanItem, entry: RegistryEntry) => {
    const sound = soundFor(entry);
    const stored = sound ? { ...item, sound } : item;
    placed.push(stored);
    storedOf.set(item, stored);
  };

  // An item of the registry's effect on a span, anchored on a word (offset = start - word start) when it has one.
  const makeItem = (
    entry: RegistryEntry,
    span: Span,
    word: EditWord | undefined,
    extra: Partial<PlanItem>,
    reason: string
  ): PlanItem => ({
    id: '',
    effect: entry.id,
    layer: entry.layer,
    target: entry.target,
    start_ms: span.start_ms,
    end_ms: span.end_ms,
    ...(word
      ? { anchor: { word_index: word.i, offset_ms: span.start_ms - word.start_ms } }
      : {}),
    ...extra,
    params: { ...entry.default_params },
    reason,
  });

  // The zones a text tries, rotating the first choice.
  const textZones = () =>
    TEXT_ZONES.map((_, i) => TEXT_ZONES[(textCount + i) % TEXT_ZONES.length]);

  // The texts a slot may carry, best first; keyword echo is always the last resort.
  const textOptions = (slot: Slot, hook: boolean): { kind: TextKind; text: string }[] => {
    const keyword = {
      kind: (hook ? 'hook' : 'keyword_echo') as TextKind,
      text: capText(titleCase(slot.keyword, input.language), input.language),
    };
    if (hook) {
      const written = capText(input.texts?.hook || '', input.language);
      return written ? [{ kind: 'hook', text: written }, keyword] : [keyword];
    }
    const options: { kind: TextKind; text: string }[] = [];
    const complementary = capText(input.texts?.complementary?.[slot.id] || '', input.language);
    if (complementary && rules.text_kinds.includes('complementary')) {
      options.push({ kind: 'complementary', text: complementary });
    }
    const phrase = phraseById(input.scores?.commentary?.[slot.id] || '');
    if (phrase && lang && phrase.text[lang] && rules.text_kinds.includes('commentary')) {
      options.push({ kind: 'commentary', text: capText(phrase.text[lang], input.language) });
    }
    options.push(keyword);
    return options;
  };

  // A styled text overlay on a slot, or null when no text, window, zone, style or cooldown allows one. The zone is found
  // first; the style (effect, look, motions) is then chosen for it.
  const tryText = (slot: Slot, hook: boolean): PlanItem | null => {
    const mood = input.scores?.mood;
    if (!textStyleCandidates('keyword_echo', undefined, level, caps, input.looks).length) note('level_limit', 'no_text_style');
    for (const opt of textOptions(slot, hook)) {
      if (!rules.text_kinds.includes(opt.kind)) {
        note('level_limit', 'text_kind_not_at_level');
        continue;
      }
      const candidates = textStyleCandidates(opt.kind, mood, level, caps, input.looks);
      if (!candidates.length) continue;
      // one span for every candidate: the hold time of the text inside the limits all of their effects share
      const probe: PlanComponent = {
        type: 'styled_text',
        kind: opt.kind,
        text: opt.text,
        style_preset: candidates[0].look,
        color_slot: textCount % paletteSize,
      };
      const limits = candidates.map((c) => durationBounds(effectById(c.effect), probe, input.language));
      const min = Math.max(...limits.map((l) => l[0]));
      const max = Math.max(min, Math.min(...limits.map((l) => l[1])));
      const dur = clamp(textHoldMs(wordCount(opt.text, input.language)) + TEXT_EXTRA_MS, min, max);
      const span = placeInWindow(windows[slot.window], slot.start_ms - ENTRY_LEAD_MS, dur, min);
      if (!span) {
        note('overlap', 'window_too_short');
        continue;
      }
      const shape = { type: 'text' as const, text: opt.text, language: input.language };
      const zone = placeOverlay(shape, textZones(), span.start_ms, span.end_ms, geo);
      if (!zone) {
        notes.push(zoneMiss(shape, textZones(), span.start_ms, span.end_ms));
        continue;
      }
      for (let i = 0; i < candidates.length; i++) {
        const pick = (at: ZoneId) =>
          chooseTextStyle(opt.kind, mood, at, { pair: (cursor.text || 0) + i, motion: textCount }, level, caps, input.looks);
        let at = zone;
        let style = pick(at);
        if (!style) break;
        // the zone was found for the text alone; the look's box and border make the overlay larger, so a zone that holds
        // it is looked for (the motions follow the new zone), and the next look is tried when none does
        const sized = { ...shape, look: textLookById(style.look, input.looks) };
        if (!overlayFits(sized, at, span.start_ms, span.end_ms, geo)) {
          const moved = placeOverlay(sized, textZones(), span.start_ms, span.end_ms, geo);
          if (!moved) {
            note('no_zone', 'look_too_large_for_zone');
            continue;
          }
          at = moved;
          style = pick(at) as TextStyle;
        }
        const entry = effectById(style.effect);
        const component: PlanComponent = { ...probe, style_preset: style.look };
        const item = makeItem(
          entry,
          span,
          words[slot.word_index],
          { position: { zone: at }, component },
          opt.kind
        );
        item.params = { ...item.params, ...style.params };
        const conflict = conflictOf(item);
        if (conflict) {
          notes.push(conflict);
          continue;
        }
        commit(item, entry);
        styleOf.set(item, style);
        styleOf.set(storedOf.get(item) as PlanItem, style);
        cursor.text = style.index + 1;
        textCount++;
        return item;
      }
    }
    return null;
  };

  // A camera, look, layout or facecam effect on a slot's word.
  const tryVideo = (
    family: 'camera' | 'look' | 'layout' | 'facecam',
    slot: Slot
  ): PlanItem | null => {
    if ((family === 'layout' || family === 'facecam') && !facecam.length) {
      note('no_asset', 'no_facecam_track');
      return null;
    }
    const ids = FAMILY_EFFECTS[family].filter((id) => allowed.has(id));
    if (!ids.length) note('level_limit', 'family_not_at_level');
    for (const idx of order(family, ids.length)) {
      const entry = effectById(ids[idx]);
      if (entry.requires.length) {
        note('no_asset', 'effect_requires_asset');
        continue;
      }
      const span = placeInWindow(
        windows[slot.window],
        slot.start_ms,
        pickDuration(entry),
        entry.min_duration_ms
      );
      if (!span) {
        note('overlap', 'window_too_short');
        continue;
      }
      const item = makeItem(entry, span, words[slot.word_index], {}, slot.reasons.join('+'));
      const conflict = conflictOf(item);
      if (conflict) {
        notes.push(conflict);
        continue;
      }
      commit(item, entry);
      cursor[family] = idx + 1;
      return item;
    }
    return null;
  };

  // The icon or mp4 clip the resolver found for a slot, as an overlay in an upper zone.
  const tryIcon = (slot: Slot): PlanItem | null => {
    const choice = input.assets?.icons?.[slot.id];
    if (!choice) {
      note('no_asset', 'no_icon_resolved');
      return null;
    }
    if (iconCount >= rules.max_icons) {
      note(rules.max_icons === 0 ? 'level_limit' : 'budget', rules.max_icons === 0 ? 'level_without_icons' : 'icon_budget');
      return null;
    }
    const ids = ICON_EFFECTS.filter((id) => allowed.has(id));
    if (!ids.length) note('level_limit', 'family_not_at_level');
    for (const idx of order('icon', ids.length)) {
      const entry = effectById(ids[idx]);
      const component: AssetComponent = {
        type: choice.kind,
        asset_id: choice.asset_id,
        ...(choice.native_duration_ms ? { native_duration_ms: choice.native_duration_ms } : {}),
      };
      const [min, max] = durationBounds(entry, component);
      const native = choice.native_duration_ms;
      const dur = clamp(native || 1000, min, max);
      if (choice.kind === 'icon_video' && native) {
        if (native / dur > SPEED_RULES.clip_max_factor) {
          note('no_asset', 'clip_too_long_for_slot');
          continue;
        }
        component.fit =
          native > dur
            ? { mode: 'speed_up', factor: Math.round((native / dur) * 100) / 100 }
            : { mode: 'native', factor: 1 };
      }
      const span = placeInWindow(windows[slot.window], slot.start_ms - ENTRY_LEAD_MS, dur, min);
      if (!span) {
        note('overlap', 'window_too_short');
        continue;
      }
      const zone = placeOverlay({ type: 'icon' }, ICON_ZONES, span.start_ms, span.end_ms, geo);
      if (!zone) {
        notes.push(zoneMiss({ type: 'icon' }, ICON_ZONES, span.start_ms, span.end_ms));
        continue;
      }
      const item = makeItem(
        entry,
        span,
        words[slot.word_index],
        { position: { zone }, component },
        slot.reasons.join('+')
      );
      const conflict = conflictOf(item);
      if (conflict) {
        notes.push(conflict);
        continue;
      }
      commit(item, entry);
      cursor.icon = idx + 1;
      iconCount++;
      return item;
    }
    return null;
  };

  // One item of a family on a slot, or null.
  const tryFamily = (family: Family, slot: Slot): PlanItem | null => {
    if (family === 'text') return tryText(slot, false);
    if (family === 'icon') return tryIcon(slot);
    return tryVideo(family, slot);
  };

  const budget = rules.max_feature_effects;
  const chosen: Slot[] = [];
  let feature = 0;

  // The hook: the best slot of the first seconds that takes a hook text (the hook slot first).
  const earlySlots = input.slots
    .filter((s) => s.start_ms <= HOOK_LATEST_START_MS)
    .sort(
      (a, b) =>
        Number(b.reasons.includes('hook')) - Number(a.reasons.includes('hook')) ||
        b.score - a.score ||
        a.start_ms - b.start_ms
    );
  let hookSlot: Slot | null = null;
  // What became of each slot, by slot id; a slot the hook loop passed over is decided again in the loop after it.
  const decided = new Map<string, Pending>();
  const base = (s: Slot) => ({ score: s.score, reasons: s.reasons, window: s.window, start_ms: s.start_ms });
  let hookItem: PlanItem | null = null;
  if (budget > 0) {
    for (const s of earlySlots) {
      notes = [];
      hookItem = tryText(s, true);
      if (hookItem) {
        hookSlot = s;
        chosen.push(s);
        feature++;
        break;
      }
    }
  }
  // What a placed item says about itself in its slot's decision (ids, codes and counts only), with the style a text got.
  const placedAs = (item: PlanItem) => {
    const style = styleOf.get(item);
    return {
      effect_id: item.effect,
      ...(item.position ? { zone_id: item.position.zone } : {}),
      ...(item.component && item.component.type === 'styled_text'
        ? { text_kind: item.component.kind, text_words: wordCount(item.component.text, input.language) }
        : {}),
      ...(style
        ? {
            text_style: {
              look: style.look,
              entry: style.entry,
              hold: style.hold,
              exit: style.exit,
              energy: style.why.energy,
              energy_from: style.why.energy_from,
              side: style.why.side,
              entry_why: style.why.entry,
              hold_why: style.why.hold,
              exit_why: style.why.exit,
            },
          }
        : {}),
    };
  };
  if (hookSlot && hookItem) {
    decided.set(hookSlot.id, {
      decision: 'kept',
      reason_code: 'hook',
      inputs: { ...base(hookSlot), role: 'hook', ...placedAs(hookItem) },
      item: hookItem,
    });
  }

  // The other slots, best first, spread over the video and cycling through the level's families.
  const priority = (s: Slot) =>
    s.score + 2 * (input.scores?.emphasis?.[s.word_index] || 0);
  const rest = input.slots
    .filter((s) => !hookSlot || s.word_index !== hookSlot.word_index)
    .sort((a, b) => priority(b) - priority(a) || a.start_ms - b.start_ms);
  const spacing = clamp((input.durationMs / (budget + 1)) * 0.6, 1800, 8000);
  const cycle = FAMILY_CYCLE[level];
  let turn = 0;
  for (let at = 0; at < rest.length; at++) {
    const slot = rest[at];
    if (feature >= budget) {
      // the level's count is used up: this slot and every one after it get nothing
      for (const left of rest.slice(at)) {
        decided.set(left.id, {
          decision: 'dropped',
          reason_code: 'level_limit',
          inputs: { ...base(left), feature_effects: feature, max_feature_effects: budget },
        });
      }
      break;
    }
    const near = chosen.find((c) => Math.abs(c.start_ms - slot.start_ms) < spacing);
    if (near) {
      decided.set(slot.id, {
        decision: 'dropped',
        reason_code: 'budget',
        inputs: { ...base(slot), detail: 'too_close_to_chosen', spacing_ms: Math.round(spacing), nearest_start_ms: near.start_ms },
      });
      continue;
    }
    const told = input.scores?.family?.[slot.id];
    if (told === 'none') {
      decided.set(slot.id, {
        decision: 'dropped',
        reason_code: 'low_score',
        inputs: { ...base(slot), detail: 'perception_family_none' },
      });
      continue;
    }
    const preferred: Family = told || cycle[turn % cycle.length];
    const families = [preferred, ...FALLBACK_FAMILIES.filter((f) => f !== preferred)];
    let item: PlanItem | null = null;
    let family: Family | null = null;
    const attempts: { family: Family; code: SlotDropCode; detail: string }[] = [];
    for (const f of families) {
      notes = [];
      item = tryFamily(f, slot);
      if (item) {
        family = f;
        break;
      }
      // the most frequent reason of the try (the first seen on a tie); a try that noted none had no effect to try
      const counts = new Map<string, { note: Note; n: number }>();
      for (const n of notes) {
        const key = `${n.code}:${n.detail}`;
        counts.set(key, { note: n, n: (counts.get(key)?.n || 0) + 1 });
      }
      const top = Array.from(counts.values()).reduce<{ note: Note; n: number } | null>(
        (best, c) => (!best || c.n > best.n ? c : best),
        null
      );
      attempts.push({ family: f, ...(top ? top.note : { code: 'level_limit' as const, detail: 'nothing_to_try' }) });
    }
    if (item && family) {
      chosen.push(slot);
      feature++;
      turn++;
      decided.set(slot.id, {
        decision: 'kept',
        reason_code: 'placed',
        inputs: { ...base(slot), preferred, family, ...placedAs(item) },
        item,
      });
    } else {
      // the code of the family the slot was meant for; every family's reason is in `attempts`
      decided.set(slot.id, {
        decision: 'dropped',
        reason_code: attempts[0].code,
        inputs: { ...base(slot), preferred, attempts },
      });
    }
  }

  // Transitions on cut points (not counted in the budget), a few seconds apart.
  if (rules.transitions) {
    const ids = TRANSITIONS[level].filter((id) => allowed.has(id));
    let last = -Infinity;
    for (const t of input.cutPoints || []) {
      if (!ids.length) break;
      if (t - last < TRANSITION_SPACING_MS) continue;
      for (const idx of order('transition', ids.length)) {
        const entry = effectById(ids[idx]);
        const dur = pickDuration(entry);
        const start = t - Math.round(dur / 2);
        const win = windows.find((w) => w.start_ms <= start && start + dur <= w.end_ms);
        if (!win) continue;
        const item = makeItem(entry, { start_ms: start, end_ms: start + dur }, undefined, {}, 'cut');
        if (!accept(item)) continue;
        commit(item, entry);
        cursor.transition = idx + 1;
        last = start;
        break;
      }
    }
  }

  // Caption emphasis: the anchored words, the words perception stressed, then enough more to keep the pacing.
  const emphasis = new Set<number>(chosen.map((s) => s.word_index));
  for (const [idx, p] of Object.entries(input.scores?.emphasis || {})) {
    if (p >= EMPHASIS_MIN && words[Number(idx)]) emphasis.add(Number(idx));
  }
  const points = visiblePoints({
    durationMs: input.durationMs,
    cutPoints: input.cutPoints || [],
    items: placed,
    words,
    emphasis: Array.from(emphasis),
  });
  pacingFill(points, words, Array.from(emphasis)).forEach((i) => emphasis.add(i));

  const captionEffect =
    ['c_word_highlight', 'c_active_pop', 'c_karaoke', 'c_emphasis_big'].find((id) =>
      allowed.has(id)
    ) || 'c_word_highlight';
  const sorted = placed.sort((a, b) => a.start_ms - b.start_ms || a.effect.localeCompare(b.effect));
  // a tilting look gets its signed tilt from a hash of the id the item was given
  const items = sorted.map((item, k) => {
    const id = `e${k + 1}`;
    const tilt = styleOf.get(item)?.tilt;
    return { ...item, id, ...(tilt ? { params: { ...item.params, tilt_deg: tiltFromId(id, tilt) } } : {}) };
  });
  // the id each placed item got, for the slots that name it
  const idOf = new Map<PlanItem, string>(sorted.map((item, k) => [item, `e${k + 1}`]));
  const decisions: SlotDecision[] = input.slots.map((s): SlotDecision => {
    const d = decided.get(s.id);
    if (!d) {
      return { slot_id: s.id, decision: 'dropped', reason_code: 'level_limit', inputs: base(s) };
    }
    const stored = d.item ? storedOf.get(d.item) : undefined;
    const itemId = stored ? idOf.get(stored) : undefined;
    return {
      slot_id: s.id,
      decision: d.decision,
      reason_code: d.reason_code,
      inputs: itemId ? { ...d.inputs, item_id: itemId } : d.inputs,
    };
  });
  return {
    decisions,
    items,
    captions: {
      effect: captionEffect,
      emphasis_words: Array.from(emphasis).sort((a, b) => a - b),
    },
  };
};
