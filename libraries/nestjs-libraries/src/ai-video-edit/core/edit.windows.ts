// AI video editing (ai.video-editing), planner core: protected spans and free windows (spec section 10). A protected
// span is a stretch where something important changes on screen (brush, motion): the planner adds nothing there.
// Pure functions; times are whole milliseconds on one timeline.
import { ActivityEntry, PROTECTION, Protection } from '../contract/edit.contract';

// A stretch of time, start included, end excluded.
export interface Span {
  start_ms: number;
  end_ms: number;
}

// Only these entry types are busy; the rest are markers and are never protected.
const BUSY_TYPES: string[] = ['brush', 'motion'];

// Sorted spans where those that overlap, touch or lie closer than `gapMs` are joined into one.
export const mergeSpans = (spans: Span[], gapMs = 0): Span[] => {
  const sorted = spans
    .map((s) => ({
      start_ms: Math.min(s.start_ms, s.end_ms),
      end_ms: Math.max(s.start_ms, s.end_ms),
    }))
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const merged: Span[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && (s.start_ms <= last.end_ms || s.start_ms - last.end_ms < gapMs)) {
      last.end_ms = Math.max(last.end_ms, s.end_ms);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
};

// The parts of [startMs, endMs) that lie outside every span, in order; nothing when it is covered.
export const subtractSpans = (
  startMs: number,
  endMs: number,
  spans: Span[]
): Span[] => {
  const pieces: Span[] = [];
  let cursor = startMs;
  for (const s of mergeSpans(spans)) {
    if (s.end_ms <= cursor) continue;
    if (s.start_ms >= endMs) break;
    if (s.start_ms > cursor) pieces.push({ start_ms: cursor, end_ms: s.start_ms });
    cursor = Math.max(cursor, s.end_ms);
  }
  if (cursor < endMs) pieces.push({ start_ms: cursor, end_ms: endMs });
  return pieces;
};

// Protected spans: brush and motion entries closer than `merge_gap_ms` become one, each side is padded by
// `padding_ms`, everything is held inside [0, durationMs] and overlapping spans are joined. Markers never count.
export const protectedSpans = (
  activity: ActivityEntry[],
  durationMs: number,
  protection: Protection = PROTECTION
): Span[] => {
  const busy: Span[] = activity
    .filter((a) => BUSY_TYPES.includes(a.type))
    .map((a) => ({
      start_ms: Math.round(Math.min(a.start_ms, a.end_ms)),
      end_ms: Math.round(Math.max(a.start_ms, a.end_ms)),
    }))
    .filter((s) => s.end_ms >= 0 && s.start_ms <= durationMs)
    .map((s) => ({
      start_ms: Math.max(0, s.start_ms),
      end_ms: Math.min(durationMs, s.end_ms),
    }));
  const padded = mergeSpans(busy, protection.merge_gap_ms)
    .map((s) => ({
      start_ms: Math.max(0, s.start_ms - protection.padding_ms),
      end_ms: Math.min(durationMs, s.end_ms + protection.padding_ms),
    }))
    .filter((s) => s.end_ms > s.start_ms);
  return mergeSpans(padded);
};

// The timeline minus the protected spans; windows shorter than `minWindowMs` are dropped.
export const freeWindows = (
  durationMs: number,
  spans: Span[],
  minWindowMs: number = PROTECTION.min_window_ms
): Span[] =>
  subtractSpans(0, durationMs, spans).filter(
    (w) => w.end_ms - w.start_ms >= minWindowMs
  );
