// AI video editing (ai.video-editing), planner core: phase 1 of the plan (spec sections 10 and 11, steps 2 and 3).
// Silence cuts from word gaps, the source to output time map through cuts and speed segments, and the remap of
// words, the activity map and the facecam track onto the output timeline. Pure functions, whole milliseconds out.
import {
  ActivityEntry,
  EditWord,
  FacecamKey,
  PlanCut,
  PlanFacecamKey,
  PlanSpeedSegment,
} from '../contract/edit.contract';
import { mergeSpans, Span, subtractSpans } from './edit.windows';

// How silence is cut: a gap of `gapMs` or more between two words is cut, leaving `keepMs` of it on each side of
// the cut; a cut shorter than `minCutMs` is not worth a jump. `durationMs` also lets the silence after the last word go.
export interface SilenceOptions {
  gapMs: number;
  keepMs: number;
  minCutMs: number;
  durationMs?: number;
}

export const SILENCE_DEFAULTS: SilenceOptions = {
  gapMs: 600,
  keepMs: 120,
  minCutMs: 200,
};

// The silences to cut, on the source timeline (the phone's cut list): the gaps between words, the lead-in before
// the first word and, with `durationMs`, the tail after the last one. Never inside a protected span: a cut that
// touches one is trimmed to the part outside it.
export const silenceCuts = (
  words: EditWord[],
  spans: Span[],
  options: Partial<SilenceOptions> = {}
): PlanCut[] => {
  const o = { ...SILENCE_DEFAULTS, ...options };
  if (!words.length) return [];
  const gaps: Span[] = [];
  const first = words[0].start_ms;
  if (first >= o.gapMs) gaps.push({ start_ms: 0, end_ms: first - o.keepMs });
  // Words may overlap, so a gap runs from the latest end seen so far
  let latestEnd = words[0].end_ms;
  for (const w of words.slice(1)) {
    if (w.start_ms - latestEnd >= o.gapMs) {
      gaps.push({
        start_ms: latestEnd + o.keepMs,
        end_ms: w.start_ms - o.keepMs,
      });
    }
    latestEnd = Math.max(latestEnd, w.end_ms);
  }
  if (o.durationMs !== undefined && o.durationMs - latestEnd >= o.gapMs) {
    gaps.push({ start_ms: latestEnd + o.keepMs, end_ms: o.durationMs });
  }
  const cuts: PlanCut[] = [];
  for (const g of gaps) {
    for (const piece of subtractSpans(g.start_ms, g.end_ms, spans)) {
      if (piece.end_ms - piece.start_ms >= o.minCutMs) {
        cuts.push({
          src_start_ms: piece.start_ms,
          src_end_ms: piece.end_ms,
          reason: 'silence',
        });
      }
    }
  }
  return cuts;
};

// A speed segment trimmed to the parts outside the protected spans: phase 1 never speeds up inside one.
export const speedAroundSpans = (
  segments: PlanSpeedSegment[],
  spans: Span[]
): PlanSpeedSegment[] =>
  segments.flatMap((s) =>
    subtractSpans(s.src_start_ms, s.src_end_ms, spans).map((p) => ({
      src_start_ms: p.start_ms,
      src_end_ms: p.end_ms,
      rate: s.rate,
    }))
  );

// One kept stretch of the source and where it lands on the output; output times are exact (maybe fractional),
// the mapping functions round them.
export interface MapPiece {
  src_start_ms: number;
  src_end_ms: number;
  out_start_ms: number;
  out_end_ms: number;
  rate: number;
}

// The source to output time map: the kept pieces in order, split wherever the speed changes.
export interface TimeMap {
  src_duration_ms: number;
  output_duration_ms: number;
  pieces: MapPiece[];
}

// Builds the map of a source of `durationMs`: cut ranges are removed, a speed segment plays its piece `rate` times
// faster (the first segment covering a moment wins; a cut wins over a speed segment).
export const buildMap = (
  durationMs: number,
  cuts: PlanCut[],
  speedSegments: PlanSpeedSegment[] = []
): TimeMap => {
  const dur = Math.max(0, Math.round(durationMs));
  const cutSpans = mergeSpans(
    cuts.map((c) => ({
      start_ms: Math.min(dur, Math.max(0, c.src_start_ms)),
      end_ms: Math.min(dur, Math.max(0, c.src_end_ms)),
    }))
  ).filter((s) => s.end_ms > s.start_ms);
  const segments = speedSegments
    .filter((s) => s.rate > 0 && s.src_end_ms > s.src_start_ms)
    .sort((a, b) => a.src_start_ms - b.src_start_ms);
  const pieces: MapPiece[] = [];
  let out = 0;
  for (const kept of subtractSpans(0, dur, cutSpans)) {
    const points = new Set<number>([kept.start_ms, kept.end_ms]);
    for (const s of segments) {
      for (const t of [s.src_start_ms, s.src_end_ms]) {
        if (t > kept.start_ms && t < kept.end_ms) points.add(t);
      }
    }
    const sorted = Array.from(points).sort((a, b) => a - b);
    for (let k = 0; k + 1 < sorted.length; k++) {
      const a = sorted[k];
      const b = sorted[k + 1];
      const mid = (a + b) / 2;
      const covering = segments.find(
        (s) => s.src_start_ms <= mid && mid < s.src_end_ms
      );
      const rate = covering ? covering.rate : 1;
      const end = out + (b - a) / rate;
      const last = pieces[pieces.length - 1];
      if (last && last.rate === rate && last.src_end_ms === a) {
        last.src_end_ms = b;
        last.out_end_ms = end;
      } else {
        pieces.push({
          src_start_ms: a,
          src_end_ms: b,
          out_start_ms: out,
          out_end_ms: end,
          rate,
        });
      }
      out = end;
    }
  }
  return {
    src_duration_ms: dur,
    output_duration_ms: Math.round(out),
    pieces,
  };
};

// Output time of a source instant. An instant inside a cut lands where the next kept piece starts (what the viewer
// sees right after the cut), one past the last piece lands on the end.
export const mapInstant = (map: TimeMap, srcMs: number): number => {
  for (const p of map.pieces) {
    if (srcMs < p.src_start_ms) return Math.round(p.out_start_ms);
    if (srcMs <= p.src_end_ms) {
      return Math.round(p.out_start_ms + (srcMs - p.src_start_ms) / p.rate);
    }
  }
  return map.output_duration_ms;
};

// Output times of a source stretch, clamped to what is kept; null when every part of it was cut.
export const mapInterval = (
  map: TimeMap,
  srcStartMs: number,
  srcEndMs: number
): Span | null => {
  let start: number | null = null;
  let end = 0;
  for (const p of map.pieces) {
    const a = Math.max(srcStartMs, p.src_start_ms);
    const b = Math.min(srcEndMs, p.src_end_ms);
    if (b <= a) continue;
    if (start === null) start = p.out_start_ms + (a - p.src_start_ms) / p.rate;
    end = p.out_start_ms + (b - p.src_start_ms) / p.rate;
  }
  return start === null
    ? null
    : { start_ms: Math.round(start), end_ms: Math.round(end) };
};

// Whether a source instant is played (inside a kept piece).
const isKept = (map: TimeMap, srcMs: number): boolean =>
  map.pieces.some((p) => srcMs >= p.src_start_ms && srcMs <= p.src_end_ms);

// The words on the output timeline, numbered again from 0; a word that was cut away is dropped.
export const remapWords = (words: EditWord[], map: TimeMap): EditWord[] => {
  const out: EditWord[] = [];
  for (const w of words) {
    const span =
      w.end_ms > w.start_ms
        ? mapInterval(map, w.start_ms, w.end_ms)
        : isKept(map, w.start_ms)
          ? {
              start_ms: mapInstant(map, w.start_ms),
              end_ms: mapInstant(map, w.start_ms),
            }
          : null;
    if (span) {
      out.push({ ...w, i: out.length, start_ms: span.start_ms, end_ms: span.end_ms });
    }
  }
  return out;
};

// The activity map on the output timeline, sorted by start: a stretch is clamped to what is kept (dropped when
// all of it was cut); a marker (start == end) moves with forward snapping and is never dropped.
export const remapEntries = (
  entries: ActivityEntry[],
  map: TimeMap
): ActivityEntry[] => {
  const out: ActivityEntry[] = [];
  for (const e of entries) {
    if (e.end_ms > e.start_ms) {
      const span = mapInterval(map, e.start_ms, e.end_ms);
      if (span) out.push({ ...e, start_ms: span.start_ms, end_ms: span.end_ms });
    } else {
      const t = mapInstant(map, e.start_ms);
      out.push({ ...e, start_ms: t, end_ms: t });
    }
  }
  return out
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => a.e.start_ms - b.e.start_ms || a.idx - b.idx)
    .map((x) => x.e);
};

// The facecam track on the output timeline, in the plan's shape (`radius` for `r`). Each key moves with forward
// snapping, so a move made inside a cut shows at the first frame after it; keys landing on one moment keep the last.
export const remapFacecam = (
  track: FacecamKey[],
  map: TimeMap
): PlanFacecamKey[] => {
  const out: PlanFacecamKey[] = [];
  const sorted = track
    .map((k, idx) => ({ k, idx }))
    .sort((a, b) => a.k.t_ms - b.k.t_ms || a.idx - b.idx);
  for (const { k } of sorted) {
    const key = { t_ms: mapInstant(map, k.t_ms), cx: k.cx, cy: k.cy, radius: k.r };
    if (out.length && out[out.length - 1].t_ms === key.t_ms) {
      out[out.length - 1] = key;
    } else {
      out.push(key);
    }
  }
  return out;
};
