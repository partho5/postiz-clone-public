// AI video editing (ai.video-editing), planner core: the decisions of the planner as data (tracing card L3). The core
// stays pure: it only returns what it decided and why (protected spans and the activity behind each, silence cuts
// with their length and threshold, free windows, candidate slots, the fate of every slot in the assembler, the change
// every validator repair made); the service writes them to the trace. Codes, ids, times and counts only, never a text
// of the plan or a word of the transcript. No Nest or Prisma import.
import { ActivityEntry, PROTECTION, PlanCut, Protection } from '../contract/edit.contract';
import { Slot, SlotReason } from './edit.slots';
import { SILENCE_DEFAULTS } from './edit.timeline';
import { Span } from './edit.windows';

// Why the assembler did not plan an effect on a slot. `level_limit`: the level allows no more (or no such) effects;
// `overlap`: no free time (window too short, another overlay or too many effects at once, a cooldown);
// `budget`: a count is used up (the same effect's per-video count, icons, the spacing the level's budget spreads
// effects by); `low_score`: perception said the slot gets nothing; `no_zone`: no zone of the frame fits every
// output; `facecam_collision`: a zone would fit but for the facecam circle; `text_too_long`: the text is too wide
// for any zone; `no_asset`: an icon, a clip or a facecam track the effect needs is missing.
export type SlotDropCode =
  | 'level_limit'
  | 'overlap'
  | 'budget'
  | 'low_score'
  | 'no_zone'
  | 'facecam_collision'
  | 'text_too_long'
  | 'no_asset';

// What the assembler decided about one candidate slot. A kept slot has `hook` (the hook text went on it) or `placed`
// as its code; `inputs` holds what decided it (score, reasons, window, the families tried and how each ended, the
// effect and item that were placed).
export interface SlotDecision {
  slot_id: string;
  decision: 'kept' | 'dropped';
  reason_code: SlotDropCode | 'hook' | 'placed';
  inputs: Record<string, unknown>;
}

// One protected span of the source timeline and the busy stretches of the activity map behind it.
export interface SpanDecision {
  start_ms: number;
  end_ms: number;
  activities: { id: string; type: string; start_ms: number; end_ms: number }[];
}

// One silence cut: where it lies on the source, how long the silence it removes is, and the rule it came from.
export interface CutDecision {
  src_start_ms: number;
  src_end_ms: number;
  silence_ms: number;
  threshold_ms: number;
  keep_ms: number;
  where: 'lead_in' | 'gap' | 'tail';
}

// One candidate slot: its kind (the hook slot or an ordinary one), its free window and why it is eligible.
export interface SlotCandidate {
  slot_id: string;
  kind: 'hook' | 'candidate';
  word_index: number;
  start_ms: number;
  end_ms: number;
  window: number;
  window_span: Span;
  why: SlotReason[];
  score: number;
}

// What `structure()` decided: the protected spans with their causes, the silence cuts, the output timeline's length,
// the free windows and the candidate slots.
export interface StructureDecisions {
  source_duration_ms: number;
  output_duration_ms: number;
  protected_spans: SpanDecision[];
  cuts: CutDecision[];
  windows: Span[];
  slots: SlotCandidate[];
}

// What the validator changed in an item by one repair: the changed fields as `[before, after]` (times, zone, effect,
// sound id, text word count); empty for a drop.
export type ValidationChange = Record<string, [unknown, unknown]>;

// One validator log line with what it changed; same order as `rejections`.
export interface ValidationDecision {
  id: string;
  effect: string;
  rule: number;
  code: string;
  action: 'repaired' | 'dropped';
  changed: ValidationChange;
}

// The decisions of the whole pipeline besides the validator's.
export interface PlanDecisions {
  structure: StructureDecisions;
  assemble: SlotDecision[];
}

// The protected spans, each with the busy entries (brush, motion) of the activity map that made it. An entry belongs to
// the span it overlaps: spans that padding made touch are one span, so an entry never overlaps two.
export const spanDecisions = (
  activity: ActivityEntry[],
  spans: Span[],
  durationMs: number,
  protection: Protection = PROTECTION
): SpanDecision[] => {
  const busy = activity
    .filter((a) => a.type === 'brush' || a.type === 'motion')
    .map((a) => ({
      id: a.id,
      type: a.type as string,
      start_ms: Math.max(0, Math.round(Math.min(a.start_ms, a.end_ms))),
      end_ms: Math.min(durationMs, Math.round(Math.max(a.start_ms, a.end_ms))),
    }))
    .filter((a) => a.end_ms >= 0 && a.start_ms <= durationMs);
  return spans.map((s) => ({
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    activities: busy
      .filter(
        (a) =>
          a.start_ms - protection.padding_ms <= s.end_ms &&
          a.end_ms + protection.padding_ms >= s.start_ms
      )
      .sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id)),
  }));
};

// The silence cuts with the length of silence each removes and the threshold that made it a cut. The lead-in starts at
// 0 and the tail ends at the source's end; the rest are gaps between words.
export const cutDecisions = (cuts: PlanCut[], durationMs: number): CutDecision[] =>
  cuts.map((c) => ({
    src_start_ms: c.src_start_ms,
    src_end_ms: c.src_end_ms,
    silence_ms: c.src_end_ms - c.src_start_ms,
    threshold_ms: SILENCE_DEFAULTS.gapMs,
    keep_ms: SILENCE_DEFAULTS.keepMs,
    where: c.src_start_ms === 0 ? 'lead_in' : c.src_end_ms >= durationMs ? 'tail' : 'gap',
  }));

// The candidate slots as the trace shows them (no keyword: that is a word of the transcript).
export const slotCandidates = (slots: Slot[], windows: Span[]): SlotCandidate[] =>
  slots.map((s) => ({
    slot_id: s.id,
    kind: s.reasons.includes('hook') ? 'hook' : 'candidate',
    word_index: s.word_index,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    window: s.window,
    window_span: windows[s.window],
    why: s.reasons,
    score: s.score,
  }));
