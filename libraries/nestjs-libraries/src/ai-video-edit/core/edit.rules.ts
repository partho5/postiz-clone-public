// AI video editing (ai.video-editing), planner core: the small rule checks the assembler places items with and the
// validator checks them with (spec sections 12 and 17): overlap and concurrency, cooldowns, duration bounds, and the
// visible changes of the timeline the pacing rule counts. Pure functions, no Nest or Prisma import.
import {
  EditWord,
  PlanComponent,
  PlanItem,
  RegistryEntry,
  SPEED_RULES,
  textHoldMs,
} from '../contract/edit.contract';
import { effectById } from '../contract/edit.registry';
import { OVERLAY_SIZE, graphemes, textLines, wordCount, wordSegments } from './edit.geometry';
import { TimeMap } from './edit.timeline';
import { Span } from './edit.windows';

// The pacing rule: a visible change at least every `max_gap_ms`; the planner aims for `target_gap_ms` and never
// adds a change closer than `min_step_ms` to the previous one.
export const PACING = { target_gap_ms: 2500, max_gap_ms: 3000, min_step_ms: 600 };

// The hook rule: a strong effect must start inside the first `HOOK_MS`.
export const HOOK_MS = 3000;

// At most this many effects are active at the same moment.
export const MAX_ACTIVE = 2;

// An overlay text has 1 to this many words.
export const MAX_TEXT_WORDS = 4;

// An overlay text has at most this many graphemes (a letter with its marks, a conjunct or an emoji counts once), so
// that the longest allowed text of the normal width class lays out on 2 lines; a text of a wider script is also held
// to the estimate of the geometry (`textLines`).
export const MAX_TEXT_GRAPHEMES = 28;

// A text cut to what the phone can lay out: at most `MAX_TEXT_WORDS` words, `MAX_TEXT_GRAPHEMES` graphemes and the
// lines the geometry's estimate allows, in one line of single spaces. It keeps whole words; a first word too long on its
// own (a script the dictionary does not divide) is cut at a grapheme.
export const capText = (text: string, language?: string) => {
  const clean = text.trim().replace(/\s+/g, ' ');
  const fits = (candidate: string) =>
    wordCount(candidate, language) <= MAX_TEXT_WORDS &&
    graphemes(candidate).length <= MAX_TEXT_GRAPHEMES &&
    textLines(candidate, language) <= OVERLAY_SIZE.max_lines;
  if (fits(clean)) return clean;
  let kept = '';
  for (const part of wordSegments(clean, language)) {
    if (!fits((kept + part.segment).trim())) break;
    kept += part.segment;
  }
  if (kept.trim()) return kept.trim();
  let cut = '';
  for (const g of graphemes(clean)) {
    if (!fits(cut + g)) break;
    cut += g;
  }
  return cut.trim();
};

// Whether two stretches share time (start included, end excluded).
export const overlaps = (a: Span, b: Span) =>
  a.start_ms < b.end_ms && b.start_ms < a.end_ms;

// Whether an item counts against the level's feature budget: captions and transitions do not.
export const isFeature = (item: Pick<PlanItem, 'layer'>) =>
  item.layer !== 'caption' && item.layer !== 'transition';

// Whether an item is drawn over the picture as text or an icon; only one of these shows at a time.
export const isOverlay = (item: Pick<PlanItem, 'layer'>) =>
  item.layer === 'text' || item.layer === 'icon';

// Why `cand` cannot join the items already placed, or null when it can (rule 9): one overlay at a time, no two
// cost H effects together, at most `MAX_ACTIVE` effects at any moment.
export const concurrencyConflict = (
  placed: PlanItem[],
  cand: PlanItem
): string | null => {
  const touching = placed.filter((p) => overlaps(p, cand));
  if (isOverlay(cand) && touching.some(isOverlay)) return 'overlay_overlap';
  if (
    effectById(cand.effect)?.cost === 'H' &&
    touching.some((p) => effectById(p.effect)?.cost === 'H')
  ) {
    return 'high_cost_overlap';
  }
  const moments = [cand.start_ms, ...touching.map((p) => p.start_ms)].filter(
    (t) => t >= cand.start_ms && t < cand.end_ms
  );
  for (const t of moments) {
    const active = touching.filter((p) => p.start_ms <= t && t < p.end_ms);
    if (active.length + 1 > MAX_ACTIVE) return 'too_many_active';
  }
  return null;
};

// Why an effect may not start at `startMs` given the starts of the same effect already placed, or null (rule 8):
// not again within its cooldown, and at most `max_per_video` times.
export const cooldownConflict = (
  entry: RegistryEntry,
  sameEffectStarts: number[],
  startMs: number
): string | null => {
  if (sameEffectStarts.length >= entry.max_per_video) return 'max_per_video';
  if (sameEffectStarts.some((s) => Math.abs(startMs - s) < entry.cooldown_ms)) {
    return 'cooldown';
  }
  return null;
};

// The shortest and longest an item of this effect may last (rules 4, 12 and 13): the registry's range, narrowed
// by the hold time of its text (500 ms + 150 ms a word, at most 2500 ms) or the hold time of its icon.
export const durationBounds = (
  entry: RegistryEntry,
  component?: PlanComponent,
  language?: string
): [number, number] => {
  let min = entry.min_duration_ms;
  let max = entry.max_duration_ms;
  if (component && component.type === 'styled_text') {
    min = Math.max(min, textHoldMs(wordCount(component.text, language)));
    max = Math.min(max, SPEED_RULES.text_hold.max_ms);
  } else if (component) {
    min = Math.max(min, SPEED_RULES.icon_hold_ms[0]);
    max = Math.min(max, SPEED_RULES.icon_hold_ms[1]);
  }
  return [min, Math.max(min, max)];
};

// The output times where a cut joins two pieces of the source (the splice the viewer sees). The lead-in cut at the
// very start and the tail at the end are not splices.
export const cutPoints = (map: TimeMap): number[] => {
  const points: number[] = [];
  for (let k = 1; k < map.pieces.length; k++) {
    if (map.pieces[k].src_start_ms > map.pieces[k - 1].src_end_ms) {
      points.push(Math.round(map.pieces[k].out_start_ms));
    }
  }
  return points;
};

// The moments a viewer sees something change (rule 11): the start, every cut, every effect start, every emphasised
// caption word and the end; sorted and unique.
export const visiblePoints = (args: {
  durationMs: number;
  cutPoints: number[];
  items: PlanItem[];
  words: EditWord[];
  emphasis: number[];
}): number[] => {
  const points = new Set<number>([0, args.durationMs]);
  args.cutPoints.forEach((t) => points.add(t));
  args.items.forEach((i) => points.add(i.start_ms));
  for (const idx of args.emphasis) {
    const w = args.words[idx];
    if (w) points.add(w.start_ms);
  }
  return Array.from(points).sort((a, b) => a - b);
};

// The stretches between two visible changes longer than `maxGapMs`.
export const pacingGaps = (
  points: number[],
  maxGapMs: number = PACING.max_gap_ms
): Span[] => {
  const gaps: Span[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    if (points[k + 1] - points[k] > maxGapMs) {
      gaps.push({ start_ms: points[k], end_ms: points[k + 1] });
    }
  }
  return gaps;
};

// The words to emphasise so that no stretch between visible changes passes `target_gap_ms`: in each long gap the
// latest word that still keeps the gap short, repeated until the gap is closed or no word is left in it.
export const pacingFill = (
  points: number[],
  words: EditWord[],
  taken: number[]
): number[] => {
  const used = new Set<number>(taken);
  const added: number[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    let p = points[k];
    const q = points[k + 1];
    while (q - p > PACING.target_gap_ms) {
      let best: EditWord | null = null;
      for (const w of words) {
        if (used.has(w.i)) continue;
        if (w.start_ms < p + PACING.min_step_ms) continue;
        if (w.start_ms > p + PACING.target_gap_ms || w.start_ms >= q) continue;
        if (!best || w.start_ms > best.start_ms) best = w;
      }
      if (!best) break;
      used.add(best.i);
      added.push(best.i);
      p = best.start_ms;
    }
  }
  return added;
};
