// AI video editing (ai.video-editing), planner core: the pure steps of the planning pipeline chained in order (spec
// section 11, steps 2, 3, 4, 7 and 9): protected spans, silence cuts, the output timeline, remap, free windows,
// candidate slots, assembly and validation. The workflow only fetches the transcript and the scores and calls this.
import {
  CONTRACT_VERSION,
  EditLevel,
  EditRequest,
  EditWord,
  Palette,
  Plan,
  PlanAsset,
} from '../contract/edit.contract';
import { AssembleAssets, SlotScores, SlotTexts, assemble } from './edit.assembler';
import { PlanDecisions, cutDecisions, slotCandidates, spanDecisions } from './edit.decisions';
import { cutPoints } from './edit.rules';
import { candidateSlots } from './edit.slots';
import {
  buildMap,
  remapEntries,
  remapFacecam,
  remapWords,
  silenceCuts,
} from './edit.timeline';
import { ValidationContext, ValidationResult, validatePlan } from './edit.validator';
import { freeWindows, protectedSpans } from './edit.windows';

export interface PlanEditInput {
  sessionId: string;
  level: EditLevel;
  request: EditRequest;
  // The transcript words on the source timeline (`toEditWords`).
  words: EditWord[];
  // The palette the server resolved (multi colours, or the workspace colour).
  palette: Palette;
  scores?: SlotScores;
  texts?: SlotTexts;
  assets?: AssembleAssets;
  // The asset list the plan carries, when assets were resolved.
  planAssets?: PlanAsset[];
  bannedWords?: string[];
}

// The planner's timing half: the output timeline and the candidate slots on it. Perception asks about the same
// slots the assembler then plans on, so both read them from here.
const structure = (request: EditRequest, words: EditWord[]) => {
  const duration = request.video.duration_ms;
  const spans = protectedSpans(request.activity_map, duration);
  const cuts = silenceCuts(words, spans, { durationMs: duration });
  const map = buildMap(duration, cuts, []);
  const outWords = remapWords(words, map);
  const outActivity = remapEntries(request.activity_map, map);
  const outSpans = protectedSpans(outActivity, map.output_duration_ms);
  const windows = freeWindows(map.output_duration_ms, outSpans);
  const markers = outActivity
    .filter((a) => a.type === 'slide_change')
    .map((a) => a.start_ms);
  const facecam = remapFacecam(request.facecam_track, map);
  const slots = candidateSlots(outWords, windows, { markers });
  // what the planner decided here and why, for the trace: the activity behind each protected span, the silence of
  // each cut and the threshold, the free windows and why each slot is eligible
  const decisions = {
    source_duration_ms: duration,
    output_duration_ms: map.output_duration_ms,
    protected_spans: spanDecisions(request.activity_map, spans, duration),
    cuts: cutDecisions(cuts, duration),
    windows,
    slots: slotCandidates(slots, windows),
  };
  return { spans, cuts, map, outWords, windows, facecam, slots, decisions };
};

// What perception asks about: the output words (indexed like the plan's), the candidate slots on them, and the
// source start of each output word (the proxy pieces are cut from the source).
export const perceptionTargets = (request: EditRequest, words: EditWord[]) => {
  const { map, outWords, slots } = structure(request, words);
  // an output word is a kept source word, in the same order
  const sourceMs = words
    .filter((w) => remapWords([w], map).length === 1)
    .map((w) => w.start_ms);
  return { words: outWords, slots, sourceMs };
};

// Builds the plan before validation and the context the validator needs for it; `decisions` is what the structure and
// the assembler decided and why (the trace writes it, nothing in the plan reads it).
export const planEdit = (
  input: PlanEditInput
): { plan: Plan; context: ValidationContext; decisions?: PlanDecisions } => {
  const { request, words, level } = input;
  const duration = request.video.duration_ms;
  const { spans, cuts, map, outWords, windows, facecam, slots, decisions: structured } = structure(
    request,
    words
  );
  const { items, captions, decisions: assembled } = assemble({
    level,
    words: outWords,
    windows,
    slots,
    outputs: request.outputs,
    facecam,
    durationMs: map.output_duration_ms,
    video: request.video,
    cutPoints: cutPoints(map),
    language: request.language,
    paletteSize: input.palette.colors.length,
    capabilities: request.capabilities,
    soundEffects: request.options.sound_effects,
    scores: input.scores,
    texts: input.texts,
    assets: input.assets,
  });
  const plan: Plan = {
    contract_version: CONTRACT_VERSION,
    plan_version: 1,
    session_id: input.sessionId,
    level,
    video: { output_duration_ms: map.output_duration_ms },
    structure: { cuts, speed_segments: [] },
    facecam_track: facecam,
    palette: input.palette,
    items,
    captions,
    warnings: [],
  };
  return {
    plan,
    decisions: { structure: structured, assemble: assembled || [] },
    context: {
      request,
      words: outWords,
      windows,
      protected_src: spans,
      source_duration_ms: duration,
      assets: input.planAssets,
      banned_words: input.bannedWords,
    },
  };
};

// What `planAndValidate` answers: the validator's result (its `decisions` are the repair log with what each repair
// changed) and, in `planner`, the decisions of the steps before it (structure and assembler).
export interface PlanAndValidateResult extends ValidationResult {
  planner?: PlanDecisions;
}

// Plans and validates in one go: the validated plan, its warnings and the log of repairs, and the planner's decisions.
export const planAndValidate = (input: PlanEditInput): PlanAndValidateResult => {
  const { plan, context, decisions } = planEdit(input);
  return { ...validatePlan(plan, context), planner: decisions };
};
