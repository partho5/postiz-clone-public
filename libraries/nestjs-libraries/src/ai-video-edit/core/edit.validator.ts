// AI video editing (ai.video-editing), planner core: the validator (spec section 17). Checks every plan item against
// the 19 rules and repairs it in this order: shift inside the same free window, shorten, swap to a cheaper effect of
// the same kind, drop. Answers `{ plan, warnings, rejections }`: the plan sorted by start with unique ids, the soft
// findings (hook, pacing, structure) and a log of every repair and drop for tuning. The log holds rule numbers and
// codes only, never a text of the plan. Pure functions, no Nest or Prisma import.
import {
  AssetComponent,
  CONTRACT_VERSION,
  EDIT_LEVELS,
  EditRequest,
  EditWord,
  EffectCost,
  LEVEL_RULES,
  Plan,
  PlanAsset,
  PlanItem,
  RegistryEntry,
  SPEED_RULES,
  StyledTextComponent,
  TextLook,
  ZoneId,
} from '../contract/edit.contract';
import { EFFECTS, effectById } from '../contract/edit.registry';
import {
  MOTION_PARAM_KEYS,
  repairMotionParams,
  swapUnusableMotions,
  takesMotion,
  textMotionsOf,
} from '../contract/edit.motions';
import { isSoundId } from '../contract/edit.sounds';
import { TEXT_LOOKS, hasBackground, lookUsable, textLookById } from '../contract/edit.styles';
import { ContentKeepOut, GeometryContext, placeOverlay, wordCount } from './edit.geometry';
import {
  BREATHING_GAP_MS,
  BREATHING_LAYERS,
  FLASH_GAP_MS,
  HEX_COLOR,
  HOOK_MS,
  budgetFor,
  capText,
  concurrencyConflict,
  cooldownConflict,
  crowding,
  cutPoints,
  durationBounds,
  isFeature,
  isFlash,
  overlaps,
  pacingGaps,
  visiblePoints,
} from './edit.rules';
import { cleanWord } from './edit.slots';
import { isFaceMove, momentOnly, movesFace } from './edit.assembler';
import { SENTENCE_END, SENTENCE_LABELS } from './edit.moments';
import { buildMap } from './edit.timeline';
import { Span } from './edit.windows';
import { ValidationChange, ValidationDecision } from './edit.decisions';

// One repair or drop: which item, which rule of spec section 17, a code for what happened. No text of the plan.
export interface Rejection {
  id: string;
  effect: string;
  rule: number;
  code: string;
  action: 'repaired' | 'dropped';
}

// What the validator needs besides the plan; words and windows are on the output timeline, the protected spans on
// the source timeline (the cuts are checked against them).
export interface ValidationContext {
  request: Pick<EditRequest, 'contract_version' | 'video' | 'outputs' | 'capabilities' | 'options' | 'language'>;
  words: EditWord[];
  windows: Span[];
  protected_src: Span[];
  source_duration_ms: number;
  assets?: PlanAsset[];
  banned_words?: string[];
  // The look table the checks read; the shipped `TEXT_LOOKS` unless a spec brings its own.
  looks?: TextLook[];
  // The ids of the facecam item and the video item of one drawing moment (the assembler places both for the same moment);
  // rule 18 lets such a pair share time. Absent: no pair is exempt.
  drawing_pairs?: [string, string][];
  // The content a text or an icon keeps off (ink, the slide title) on the OUTPUT timeline, the same list the assembler
  // placed with: rule 6 never moves an item onto it. Absent: nothing to keep off.
  keepouts?: ContentKeepOut[];
}

export interface ValidationResult {
  plan: Plan;
  warnings: string[];
  rejections: Rejection[];
  // The same log lines with what each one changed (`changed`: field to `[before, after]`), in the same order; `rejections`
  // keeps its shape, this is what the trace reads.
  decisions?: ValidationDecision[];
}

// A log line with what it changed, while the validator runs.
type Logged = Rejection & { changed: ValidationChange };

// The fields of an item a repair can change, for the `changed` of a log line (no text: only its word count).
const snapshot = (item: PlanItem, language?: string): Record<string, unknown> => {
  const comp = item.component;
  const text = comp && comp.type === 'styled_text' ? comp : undefined;
  return {
    effect: item.effect,
    layer: item.layer,
    target: item.target,
    start_ms: item.start_ms,
    end_ms: item.end_ms,
    zone: item.position?.zone,
    sound: item.sound?.id,
    text_words: text ? wordCount(text.text || '', language) : undefined,
    style_preset: text?.style_preset,
    color_slot: text?.color_slot,
    fit_factor: comp && comp.type === 'icon_video' ? comp.fit?.factor : undefined,
    params: JSON.stringify(item.params || {}),
  };
};

// What differs between two snapshots, as `[before, after]` per field.
const changeBetween = (before: Record<string, unknown>, after: Record<string, unknown>): ValidationChange => {
  const out: ValidationChange = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      out[key] = key === 'params' ? [JSON.parse(String(before[key])), JSON.parse(String(after[key]))] : [before[key], after[key]];
    }
  }
  return out;
};

const COST_RANK: Record<EffectCost, number> = { L: 0, M: 1, H: 2 };
const CAPTION_EFFECTS = ['c_word_highlight', 'c_active_pop', 'c_karaoke', 'c_emphasis_big'];

const round2 = (v: number) => Math.round(v * 100) / 100;

// Rule 5: the colour a face move fills with (what shows where the face has left), and the one a bad value falls back to.
const FILL_COLOR_DEFAULT = '#000000';

// Rule 17: a face move for a sentence starts within `FACE_NEAR_MS` of a pause (a word gap of `FACE_PAUSE_MS` or more, or the
// start of a sentence); a move that does not is shifted to the nearest pause, at most `FACE_SHIFT_MAX_MS` away, else dropped.
const FACE_PAUSE_MS = 200;
const FACE_NEAR_MS = 600;
const FACE_SHIFT_MAX_MS = 1500;

// A copy of an item that can be changed without touching the plan it came from.
const cloneItem = (item: PlanItem): PlanItem => ({
  ...item,
  params: { ...(item.params || {}) },
  ...(item.anchor ? { anchor: { ...item.anchor } } : {}),
  ...(item.position ? { position: { ...item.position } } : {}),
  ...(item.sound ? { sound: { ...item.sound } } : {}),
  ...(item.component
    ? { component: JSON.parse(JSON.stringify(item.component)) }
    : {}),
});

// Whether a text contains a banned word or phrase of the brand profile (whole words, any case).
export const hasBanned = (text: string, banned: string[]) => {
  const tokens = text.split(/\s+/).map(cleanWord).filter(Boolean);
  return banned.some((b) => {
    const parts = b.split(/\s+/).map(cleanWord).filter(Boolean);
    if (!parts.length) return false;
    for (let k = 0; k + parts.length <= tokens.length; k++) {
      if (parts.every((p, j) => tokens[k + j] === p)) return true;
    }
    return false;
  });
};

// Checks and repairs a plan; see the header. The input plan is not changed.
export const validatePlan = (plan: Plan, ctx: ValidationContext): ValidationResult => {
  const logged: Logged[] = [];
  const warnings: string[] = [];
  const caps = ctx.request.capabilities;
  const looks = ctx.looks ?? TEXT_LOOKS;
  const rules = LEVEL_RULES[plan.level];
  const budget = budgetFor(plan.level, plan.video.output_duration_ms);
  const levelIdx = EDIT_LEVELS.indexOf(plan.level);
  const geo: GeometryContext = {
    video: ctx.request.video,
    outputs: ctx.request.outputs,
    facecam: plan.facecam_track,
    keepouts: ctx.keepouts,
  };
  const canRender = (id: string) => !caps || caps.effects.includes(id);
  const soundsOn = rules.sounds && ctx.request.options?.sound_effects !== false;

  // Rule 1: a plan of another contract version is not trusted at all.
  if (
    plan.contract_version !== CONTRACT_VERSION ||
    ctx.request.contract_version !== CONTRACT_VERSION
  ) {
    return {
      plan: { ...plan, contract_version: CONTRACT_VERSION, items: [], warnings: [...plan.warnings, 'contract_version_mismatch'] },
      warnings: ['contract_version_mismatch'],
      rejections: [{ id: '*', effect: '*', rule: 1, code: 'contract_version', action: 'dropped' }],
      decisions: [{ id: '*', effect: '*', rule: 1, code: 'contract_version', action: 'dropped', changed: {} }],
    };
  }

  // Rule 15: cuts and speed changes never touch a protected span. They cannot be repaired here (every item time
  // depends on them), so a plan that does is reported.
  for (const c of plan.structure.cuts) {
    const s = { start_ms: c.src_start_ms, end_ms: c.src_end_ms };
    if (ctx.protected_src.some((p) => overlaps(p, s))) {
      warnings.push(`cut_in_protected_span:${c.src_start_ms}-${c.src_end_ms}`);
    }
  }
  for (const c of plan.structure.speed_segments) {
    const s = { start_ms: c.src_start_ms, end_ms: c.src_end_ms };
    if (ctx.protected_src.some((p) => overlaps(p, s))) {
      warnings.push(`speed_in_protected_span:${c.src_start_ms}-${c.src_end_ms}`);
    }
  }
  const map = buildMap(
    ctx.source_duration_ms,
    plan.structure.cuts,
    plan.structure.speed_segments
  );
  if (Math.abs(map.output_duration_ms - plan.video.output_duration_ms) > 1) {
    warnings.push('duration_mismatch');
  }

  // The nearest free window to a stretch (0 apart when they touch), or undefined with no windows.
  const nearestWindow = (start: number, end: number): Span | undefined => {
    const dist = (w: Span) =>
      overlaps(w, { start_ms: start, end_ms: end })
        ? 0
        : Math.min(Math.abs(w.start_ms - end), Math.abs(start - w.end_ms));
    return [...ctx.windows].sort((a, b) => dist(a) - dist(b))[0];
  };

  // Rule 17: where a face move for a sentence may start: the stretch of each word gap of `FACE_PAUSE_MS` or more (the pause
  // itself), and the start of each sentence (the first word, a word after sentence-final punctuation).
  const pauses: Span[] = [];
  ctx.words.forEach((w, k) => {
    const prev = ctx.words[k - 1];
    if (!prev || SENTENCE_END.test(prev.w.trim()) || w.start_ms - prev.end_ms >= FACE_PAUSE_MS) {
      const gap = prev && w.start_ms - prev.end_ms >= FACE_PAUSE_MS;
      pauses.push({ start_ms: gap ? prev.end_ms : w.start_ms, end_ms: w.start_ms });
    }
  });
  const pauseDistance = (p: Span, t: number) => (t < p.start_ms ? p.start_ms - t : t > p.end_ms ? t - p.end_ms : 0);

  // Moves an item to new times; an anchored item keeps its anchor word and gets the matching offset (rule 14).
  const retime = (it: PlanItem, start: number, end: number) => {
    it.start_ms = start;
    it.end_ms = end;
    const w = it.anchor ? ctx.words[it.anchor.word_index] : undefined;
    if (it.anchor && w) it.anchor = { ...it.anchor, offset_ms: start - w.start_ms };
  };

  // Rule 3: the item inside one free window; shifted, then shortened, else null.
  const fitWindow = (it: PlanItem, min: number): 'ok' | 'shifted' | 'shortened' | null => {
    if (ctx.windows.some((w) => w.start_ms <= it.start_ms && it.end_ms <= w.end_ms)) return 'ok';
    const w = nearestWindow(it.start_ms, it.end_ms);
    if (!w) return null;
    const dur = it.end_ms - it.start_ms;
    const len = w.end_ms - w.start_ms;
    if (dur <= len) {
      const start = Math.min(Math.max(it.start_ms, w.start_ms), w.end_ms - dur);
      retime(it, start, start + dur);
      return 'shifted';
    }
    if (len >= min) {
      retime(it, w.start_ms, w.end_ms);
      return 'shortened';
    }
    return null;
  };

  // Rule 6: the overlay in a zone that fits every output (its own zone first); null when none does, or
  // `content_collision` when one would fit but for the content it covers.
  const placeZone = (it: PlanItem): 'ok' | 'moved' | 'content_collision' | null => {
    const comp = it.component;
    const shape =
      comp && comp.type === 'styled_text'
        ? {
            type: 'text' as const,
            text: comp.text,
            language: ctx.request.language,
            look: textLookById(comp.style_preset, looks),
          }
        : { type: 'icon' as const };
    const own = it.position?.zone;
    const prefs: ZoneId[] = own ? [own] : ['upper_center'];
    const zone = placeOverlay(shape, prefs, it.start_ms, it.end_ms, geo);
    if (!zone) {
      const clear = ctx.keepouts?.length && placeOverlay(shape, prefs, it.start_ms, it.end_ms, { ...geo, keepouts: [] });
      return clear ? 'content_collision' : null;
    }
    if (zone === own) return 'ok';
    it.position = { zone };
    return 'moved';
  };

  // Checks one item against every rule, repairing what can be repaired. `kept` are the items accepted so far.
  // Returns the repaired item, or null when it is dropped. `canSwap` lets a cooldown or concurrency failure try
  // a cheaper effect of the same kind; `sink` collects the log of this attempt.
  const repair = (
    raw: PlanItem,
    kept: PlanItem[],
    canSwap: boolean,
    sink: Logged[]
  ): PlanItem | null => {
    const it = cloneItem(raw);
    // what the item looked like at the last log line, so each line says what it changed
    let last = snapshot(it, ctx.request.language);
    const log = (rule: number, code: string, action: 'repaired' | 'dropped', now: PlanItem = it) => {
      const after = snapshot(now, ctx.request.language);
      sink.push({ id: raw.id, effect: raw.effect, rule, code, action, changed: changeBetween(last, after) });
      last = after;
    };
    const drop = (rule: number, code: string): null => {
      log(rule, code, 'dropped');
      return null;
    };

    // Rules 1 and 2: known effect, one the phone renders, allowed at this level.
    const entry = effectById(it.effect);
    if (!entry) return drop(1, 'unknown_effect');
    if (!canRender(it.effect)) return drop(1, 'not_in_capabilities');
    if (entry.layer === 'caption') return drop(1, 'caption_as_item');
    if (EDIT_LEVELS.indexOf(entry.min_level) > levelIdx) return drop(2, 'level_too_low');
    if (entry.layer === 'transition' && !rules.transitions) return drop(2, 'transitions_off');
    if (it.layer !== entry.layer || it.target !== entry.target) {
      it.layer = entry.layer;
      it.target = entry.target;
      log(1, 'layer_target_fixed', 'repaired');
    }

    // The component: text and icon effects need theirs, and it must be one the effect allows.
    const comp = it.component;
    if ((entry.layer === 'text' || entry.layer === 'icon') && !comp) {
      return drop(1, 'component_missing');
    }
    if (comp && !entry.allowed_components.includes(comp.type)) {
      return drop(1, 'component_not_allowed');
    }

    // Rule 13: the text has 1 to 4 words and the graphemes the phone can lay out, no banned word, a known look and a
    // palette colour (a look the phone lists but lacks a feature of counts as unknown to it).
    if (comp && comp.type === 'styled_text') {
      const text: StyledTextComponent = comp;
      text.text = (text.text || '').trim();
      if (wordCount(text.text, ctx.request.language) === 0) return drop(13, 'text_empty');
      const capped = capText(text.text, ctx.request.language);
      if (!capped) return drop(13, 'text_empty');
      if (capped !== text.text) {
        text.text = capped;
        log(13, 'text_truncated', 'repaired');
      }
      if (ctx.banned_words?.length && hasBanned(text.text, ctx.banned_words)) {
        return drop(13, 'banned_word');
      }
      if (!rules.text_kinds.includes(text.kind)) return drop(2, 'kind_not_allowed');
      const bound = entry.default_params.style_preset;
      const usable = (id: string) => lookUsable(textLookById(id, looks), caps);
      if (typeof bound === 'string') {
        if (!usable(bound)) return drop(13, 'style_not_in_capabilities');
        if (text.style_preset !== bound) {
          text.style_preset = bound;
          log(13, 'style_fixed', 'repaired');
        }
      } else if (!usable(text.style_preset)) {
        // the look an effect with no bound look takes in its place has a background, as every text overlay has
        const other = looks.find((l) => usable(l.id) && hasBackground(l)) ?? looks.find((l) => usable(l.id));
        if (!other) return drop(13, 'style_not_in_capabilities');
        text.style_preset = other.id;
        log(13, 'style_fixed', 'repaired');
      }
      const colors = Math.max(1, plan.palette.colors.length);
      if (!Number.isInteger(text.color_slot) || text.color_slot < 0 || text.color_slot >= colors) {
        text.color_slot = Math.abs(Math.trunc(Number(text.color_slot) || 0)) % colors;
        log(13, 'color_slot_fixed', 'repaired');
      }
    }

    // The asset of an mp4 clip or icon exists in the plan's asset list.
    let native: number | undefined;
    if (comp && comp.type !== 'styled_text') {
      const asset = ctx.assets?.find((a) => a.id === comp.asset_id);
      if (ctx.assets && !asset) return drop(1, 'asset_missing');
      native = comp.native_duration_ms || asset?.native_duration_ms;
    }

    // Rule 14: the anchor word exists; where times and anchor disagree, the anchor wins.
    if (it.anchor) {
      const w = ctx.words[it.anchor.word_index];
      if (!w) return drop(14, 'anchor_missing');
      const expected = w.start_ms + it.anchor.offset_ms;
      if (it.start_ms !== expected) {
        retime(it, expected, expected + (it.end_ms - it.start_ms));
        log(14, 'anchor_retimed', 'repaired');
      }
    }

    // Rules 4, 12 and 13: the duration inside the effect's range, its text or icon hold time, and long enough
    // for a clip not to be sped up past the factor limit.
    const [min, max] = durationBounds(entry, it.component, ctx.request.language);
    let dur = it.end_ms - it.start_ms;
    let want = dur;
    if (dur > max) want = max;
    if (dur < min) want = min;
    if (comp && comp.type === 'icon_video' && native) {
      const needed = Math.ceil(native / SPEED_RULES.clip_max_factor);
      if (needed > max) return drop(12, 'clip_too_long');
      want = Math.max(want, needed);
    }
    if (want !== dur) {
      retime(it, it.start_ms, it.start_ms + want);
      log(4, want > dur ? 'lengthened' : 'shortened', 'repaired');
    }

    // Rule 3: inside one free window; an effect that may sit in a drawing (`in_drawing`) goes over the strokes, so it needs none.
    const fit = entry.in_drawing ? 'ok' : fitWindow(it, min);
    if (!fit) return drop(3, 'no_window');
    if (fit !== 'ok') log(3, fit, 'repaired');
    dur = it.end_ms - it.start_ms;

    // Rule 17: a face move for a sentence (a facecam effect that serves sentence moments, outside drawings) starts near a pause,
    // not in the middle of a phrase: else it moves to the nearest pause that keeps its free window, else it is dropped.
    if (entry.layer === 'facecam' && !entry.in_drawing && entry.moments?.some((m) => SENTENCE_LABELS.includes(m))) {
      if (!pauses.some((p) => pauseDistance(p, it.start_ms) <= FACE_NEAR_MS)) {
        const to = pauses
          .map((p) => Math.min(Math.max(it.start_ms, p.start_ms), p.end_ms))
          .filter(
            (start) =>
              Math.abs(start - it.start_ms) <= FACE_SHIFT_MAX_MS &&
              ctx.windows.some((w) => w.start_ms <= start && start + dur <= w.end_ms)
          )
          .sort((a, b) => Math.abs(a - it.start_ms) - Math.abs(b - it.start_ms))[0];
        if (to === undefined) return drop(17, 'face_move_mid_phrase');
        retime(it, to, to + dur);
        log(17, 'face_move_mid_phrase', 'repaired');
      }
    }

    // Rule 12: the clip fit factor from the final duration, between 1.0 and 3.0.
    if (comp && comp.type === 'icon_video') {
      const asset = comp as AssetComponent;
      if (native) {
        const f = native / dur;
        if (f > SPEED_RULES.clip_max_factor + 1e-9) return drop(12, 'clip_fit');
        const want2: AssetComponent['fit'] =
          f > 1 ? { mode: 'speed_up', factor: round2(f) } : { mode: 'native', factor: 1 };
        if (!asset.fit || asset.fit.mode !== want2.mode || Math.abs(asset.fit.factor - want2.factor) > 0.01) {
          asset.fit = want2;
          log(12, 'fit_recomputed', 'repaired');
        }
      } else if (asset.fit && (asset.fit.factor > SPEED_RULES.clip_max_factor || asset.fit.factor < 1)) {
        asset.fit = { mode: 'native', factor: 1 };
        log(12, 'fit_recomputed', 'repaired');
      }
    }

    // Rule 5: params are the effect's own keys (a text effect with motions also takes the motion keys), numbers inside
    // their limits, and a motion is one of the motion tables with its duration inside the table's limits.
    const motions = takesMotion(entry);
    for (const key of Object.keys(it.params)) {
      if (!(key in entry.default_params) && !(motions && MOTION_PARAM_KEYS.includes(key))) {
        delete it.params[key];
        log(5, 'param_unknown', 'repaired');
      }
    }
    it.params = { ...entry.default_params, ...it.params };
    for (const [key, [lo, hi]] of Object.entries(entry.param_limits)) {
      const v = it.params[key];
      if (typeof v !== 'number') {
        it.params[key] = entry.default_params[key];
        log(5, 'param_reset', 'repaired');
      } else if (v < lo || v > hi) {
        it.params[key] = Math.min(hi, Math.max(lo, v));
        log(5, 'param_clamped', 'repaired');
      }
    }
    // a string param is one of the effect's own values (else the first), a fill colour is `#RRGGBB`, and a box of the master
    // frame (`x`, `w` and `y`, `h`) stays inside it
    for (const [key, values] of Object.entries(entry.param_enums || {})) {
      const v = it.params[key];
      if (typeof v !== 'string' || !values.includes(v)) {
        it.params[key] = values[0];
        log(5, 'param_enum_reset', 'repaired');
      }
    }
    if ('fill_color' in it.params) {
      const v = it.params.fill_color;
      if (typeof v !== 'string' || !HEX_COLOR.test(v)) {
        it.params.fill_color = FILL_COLOR_DEFAULT;
        log(5, 'fill_color_reset', 'repaired');
      }
    }
    for (const [pos, size] of [['x', 'w'], ['y', 'h']]) {
      const at = it.params[pos];
      const len = it.params[size];
      if (typeof at === 'number' && typeof len === 'number' && at + len > 1 + 1e-9) {
        it.params[pos] = Math.floor((1 - len) * 1000) / 1000;
        log(5, 'param_box_fixed', 'repaired');
      }
    }
    if (motions) {
      for (const code of repairMotionParams(it.params, entry.default_params)) log(5, code, 'repaired');
      // a motion the phone did not list (the legacy five when it listed none) is swapped for one it draws
      if (caps) {
        for (const code of swapUnusableMotions(it.params, entry.default_params, textMotionsOf(caps))) {
          log(5, code, 'repaired');
        }
      }
      // the tilt the chooser wrote stays inside its look's range; a look with no tilt takes none (an effect with its own
      // `tilt_deg` limits was checked above)
      const tilt = it.params.tilt_deg;
      if (tilt !== undefined && !('tilt_deg' in entry.param_limits)) {
        const range = comp && comp.type === 'styled_text' ? textLookById(comp.style_preset, looks)?.tilt_deg : null;
        if (!range || typeof tilt !== 'number' || !Number.isFinite(tilt)) {
          delete it.params.tilt_deg;
          log(5, 'param_unknown', 'repaired');
        } else if (tilt < range[0] || tilt > range[1]) {
          it.params.tilt_deg = Math.min(range[1], Math.max(range[0], tilt));
          log(5, 'param_clamped', 'repaired');
        }
      }
    }

    // Rule 6: an overlay stays inside every output's safe rectangle, off the caption band, the facecam and the content.
    if (it.target === 'overlay') {
      const placed = placeZone(it);
      if (!placed) return drop(6, 'no_zone');
      if (placed === 'content_collision') return drop(6, 'content_collision');
      if (placed === 'moved') log(6, 'zone_moved', 'repaired');
    }

    // Rule 7: the level's budget of feature effects and icons for the video's duration (captions and transitions do
    // not count).
    if (isFeature(it) && kept.filter(isFeature).length >= budget.features) {
      return drop(7, 'over_budget');
    }
    if (it.layer === 'icon' && kept.filter((k) => k.layer === 'icon').length >= budget.icons) {
      return drop(7, 'over_icon_budget');
    }

    // Sound: only where the level and the user allow it, a known sound the server serves, one of the effect's own.
    if (it.sound) {
      const serves = (id: string) =>
        isSoundId(id) && (!ctx.assets || ctx.assets.some((a) => a.kind === 'sound' && a.id === id));
      if (!soundsOn) {
        delete it.sound;
        log(2, 'sound_removed', 'repaired');
      } else if (!serves(it.sound.id) || (entry.sound.length && !(entry.sound as string[]).includes(it.sound.id))) {
        const other = entry.sound.find(serves);
        if (other) {
          it.sound = { id: other, offset_ms: it.sound.offset_ms };
          log(2, 'sound_swapped', 'repaired');
        } else {
          delete it.sound;
          log(2, 'sound_removed', 'repaired');
        }
      }
    }

    // Rules 8 and 9: cooldown and count per minute of video, then at most 2 active, one overlay, no two cost H together.
    const same = kept.filter((k) => k.effect === it.effect).map((k) => k.start_ms);
    const cool = cooldownConflict(entry, same, it.start_ms, plan.video.output_duration_ms);
    if (cool) return swapOrDrop(raw, kept, entry, canSwap, sink, 8, cool);
    const busy = concurrencyConflict(kept, it);
    if (busy) {
      const dur2 = it.end_ms - it.start_ms;
      const next = Math.max(...kept.filter((k) => overlaps(k, it)).map((k) => k.end_ms));
      const moved = cloneItem(it);
      retime(moved, next, next + dur2);
      const holds =
        !!entry.in_drawing || ctx.windows.some((w) => w.start_ms <= moved.start_ms && moved.end_ms <= w.end_ms);
      const zoned = moved.target === 'overlay' ? placeZone(moved) : 'ok';
      const zoneOk = zoned === 'ok' || zoned === 'moved';
      if (holds && zoneOk && !concurrencyConflict(kept, moved)) {
        log(9, 'shifted', 'repaired', moved);
        return moved;
      }
      return swapOrDrop(raw, kept, entry, canSwap, sink, 9, busy);
    }
    return it;
  };

  // Last repairs of rules 8 and 9: a cheaper effect of the same layer and target (never a time effect, which changes
  // the length) that passes every rule, else drop.
  const swapOrDrop = (
    raw: PlanItem,
    kept: PlanItem[],
    entry: RegistryEntry,
    canSwap: boolean,
    sink: Logged[],
    rule: number,
    code: string
  ): PlanItem | null => {
    // an effect only a director's pick places is never swapped for, nor swapped away from: its params and its moment would be lost
    if (canSwap && !momentOnly(entry)) {
      const options = EFFECTS.filter(
        (e: RegistryEntry) =>
          e.id !== entry.id &&
          !momentOnly(e) &&
          e.layer === entry.layer &&
          e.target === entry.target &&
          e.requires.length === 0 &&
          !e.id.startsWith('t_') &&
          COST_RANK[e.cost] <= COST_RANK[entry.cost] &&
          e.allowed_components.some((c) => entry.allowed_components.includes(c))
      );
      for (const e of options) {
        const trial = { ...raw, effect: e.id, params: { ...e.default_params } };
        const done = repair(trial, kept, false, []);
        if (done) {
          sink.push({
            id: raw.id,
            effect: raw.effect,
            rule,
            code: 'swapped',
            action: 'repaired',
            changed: changeBetween(snapshot(raw, ctx.request.language), snapshot(done, ctx.request.language)),
          });
          return done;
        }
      }
    }
    sink.push({ id: raw.id, effect: raw.effect, rule, code, action: 'dropped', changed: {} });
    return null;
  };

  // Items in time order; each one is checked against the ones accepted before it.
  const ordered = plan.items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => a.item.start_ms - b.item.start_ms || a.idx - b.idx)
    .map((x) => x.item);
  let kept: PlanItem[] = [];
  for (const raw of ordered) {
    const done = repair(raw, kept, true, logged);
    if (done) kept.push(done);
  }

  // Rule 17: a facecam move of a moment shares no time with another facecam move, a facecam effect or a layout effect that
  // moves the face: it is shortened to end where the other one starts, else dropped (the later one of two moves stays).
  for (const move of kept.filter(isFaceMove).sort((a, b) => a.start_ms - b.start_ms)) {
    const clash = kept.filter((o) => o !== move && overlaps(o, move) && movesFace(o));
    if (!clash.length) continue;
    const before = snapshot(move, ctx.request.language);
    const end = Math.min(...clash.map((o) => o.start_ms));
    const [min] = durationBounds(effectById(move.effect) as RegistryEntry, move.component, ctx.request.language);
    if (end - move.start_ms >= min) {
      move.end_ms = end;
      logged.push({
        id: move.id,
        effect: move.effect,
        rule: 17,
        code: 'face_move_overlap',
        action: 'repaired',
        changed: changeBetween(before, snapshot(move, ctx.request.language)),
      });
    } else {
      kept = kept.filter((k) => k !== move);
      logged.push({ id: move.id, effect: move.effect, rule: 17, code: 'face_move_overlap', action: 'dropped', changed: {} });
    }
  }

  // Rule 18: video, facecam and transition items are `BREATHING_GAP_MS` apart (end to start), except the two items of one
  // drawing moment. The later one moves to start that long after the one it crowds, when it keeps every other rule there
  // (`repair` checks them again); a transition stays at its cut, so it is dropped, like an item that cannot move.
  const pairs = new Set((ctx.drawing_pairs || []).flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const crowdedBy = (settled: PlanItem[], item: PlanItem) => crowding(settled, item, (p) => pairs.has(`${p.id}|${item.id}`));
  const settled: PlanItem[] = [];
  for (const item of kept.filter((k) => BREATHING_LAYERS.includes(k.layer)).sort((a, b) => a.start_ms - b.start_ms)) {
    const crowded = crowdedBy(settled, item);
    if (!crowded.length) {
      settled.push(item);
      continue;
    }
    const dur = item.end_ms - item.start_ms;
    const start = Math.max(...crowded.map((s) => s.end_ms)) + BREATHING_GAP_MS;
    const moved = cloneItem(item);
    retime(moved, start, start + dur);
    const done =
      item.layer !== 'transition' && start + dur <= plan.video.output_duration_ms
        ? repair(
            moved,
            kept.filter((k) => k !== item),
            false,
            []
          )
        : null;
    if (done && !crowdedBy(settled, done).length) {
      logged.push({
        id: item.id,
        effect: item.effect,
        rule: 18,
        code: 'breathing_gap',
        action: 'repaired',
        changed: changeBetween(snapshot(item, ctx.request.language), snapshot(done, ctx.request.language)),
      });
      kept = kept.map((k) => (k === item ? done : k));
      settled.push(done);
    } else {
      kept = kept.filter((k) => k !== item);
      logged.push({ id: item.id, effect: item.effect, rule: 18, code: 'breathing_gap', action: 'dropped', changed: {} });
    }
  }

  // Rule 19: two flashes (`isFlash`) start `FLASH_GAP_MS` apart at least; the later one is dropped. After rule 18, so that its
  // shifts cannot bring two flashes closer.
  let lastFlash: PlanItem | undefined;
  for (const item of kept.filter(isFlash).sort((a, b) => a.start_ms - b.start_ms)) {
    if (lastFlash && item.start_ms - lastFlash.start_ms < FLASH_GAP_MS) {
      kept = kept.filter((k) => k !== item);
      logged.push({ id: item.id, effect: item.effect, rule: 19, code: 'flash_spacing', action: 'dropped', changed: {} });
    } else {
      lastFlash = item;
    }
  }

  // Rule 16: sorted by start, ids unique.
  kept = kept
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => a.item.start_ms - b.item.start_ms || a.idx - b.idx)
    .map((x) => x.item);
  const used = new Set<string>();
  let next = 1;
  kept = kept.map((item) => {
    if (item.id && !used.has(item.id)) {
      used.add(item.id);
      return item;
    }
    while (used.has(`e${next}`)) next++;
    const id = `e${next}`;
    used.add(id);
    logged.push({
      id: item.id || id,
      effect: item.effect,
      rule: 16,
      code: 'id_renamed',
      action: 'repaired',
      changed: { id: [item.id || '', id] },
    });
    return { ...item, id };
  });

  // Captions: a caption effect the level and the phone allow, and emphasis words that exist (rule 14).
  const captionOk = (id: string) => {
    const e = effectById(id);
    return !!e && e.layer === 'caption' && EDIT_LEVELS.indexOf(e.min_level) <= levelIdx && canRender(id);
  };
  let captionEffect = plan.captions.effect;
  if (!captionOk(captionEffect)) {
    const other = CAPTION_EFFECTS.find(captionOk);
    if (other) {
      logged.push({
        id: 'captions',
        effect: captionEffect,
        rule: 1,
        code: 'captions_effect_swapped',
        action: 'repaired',
        changed: { effect: [captionEffect, other] },
      });
      captionEffect = other;
    } else {
      warnings.push('captions_unavailable');
    }
  }
  const emphasis = Array.from(new Set(plan.captions.emphasis_words))
    .filter((i) => Number.isInteger(i) && !!ctx.words[i])
    .sort((a, b) => a - b);
  if (emphasis.length !== plan.captions.emphasis_words.length) {
    logged.push({
      id: 'captions',
      effect: captionEffect,
      rule: 14,
      code: 'emphasis_word_missing',
      action: 'repaired',
      changed: { emphasis_words: [plan.captions.emphasis_words.length, emphasis.length] },
    });
  }

  // Rule 10: a strong effect starts in the first 3 seconds (added by the assembler, reported here).
  if (!kept.some((i) => isFeature(i) && i.start_ms < HOOK_MS)) warnings.push('hook_missing');

  // Rule 11: a visible change at least every 3 seconds.
  const points = visiblePoints({
    durationMs: plan.video.output_duration_ms,
    cutPoints: cutPoints(map),
    items: kept,
    words: ctx.words,
    emphasis,
  });
  for (const gap of pacingGaps(points)) {
    warnings.push(`pacing_gap:${gap.start_ms}-${gap.end_ms}`);
  }

  return {
    plan: {
      ...plan,
      items: kept,
      captions: { effect: captionEffect, emphasis_words: emphasis },
      warnings: Array.from(new Set([...plan.warnings, ...warnings])),
    },
    warnings,
    rejections: logged.map(({ changed, ...line }) => line),
    decisions: logged.map((line) => ({ ...line })),
  };
};
