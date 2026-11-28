// AI video editing (ai.video-editing), golden replay: re-runs the pure planner from the inputs a `full` trace bundle holds
// (`structure/input`) and compares the plan it makes with the plan that was delivered. A plan that no longer matches says
// the planner changed, or that something other than the traced inputs shaped it. Pure: no database, no Nest.
import { isDeepStrictEqual } from 'util';
import { EditLevel, EditRequest, EditWord, Palette, Plan, PlanAsset } from '../contract/edit.contract';
import { AssembleAssets, SlotScores, SlotTexts } from './edit.assembler';
import { Direction } from './edit.moments';
import { PlanEditInput, planAndValidate } from './edit.pipeline';

// The part of a bundle the replay reads: its edit, its steps and the served body.
export interface ReplayBundle {
  edit?: { sessionId?: string; level?: string };
  steps: { seq?: number; step: string; kind: string; payload: unknown }[];
  delivered?: unknown;
}

// Why a bundle cannot be replayed: `no_structure_input` (the step was not traced), `needs_full_trace` (a `meta` trace keeps
// counts, not the words), `input_truncated` (the row was over the size cap), `no_delivered_plan` (nothing to compare with).
export class ReplayError extends Error {
  constructor(public readonly code: string) {
    super(code);
    Object.setPrototypeOf(this, ReplayError.prototype);
    this.name = 'ReplayError';
  }
}

// What a replay found.
export interface ReplayResult {
  equal: boolean;
  plan: Plan;
  expected: Plan;
  // the path of the first difference (`$.items[3].start_ms`), when the plans differ
  difference?: string;
  // the traced inputs hold the redaction marker, so the trace may not be the words that were planned: a difference may be
  // the redaction's, not the planner's (`redacted_input_possible`, set only when the plans differ)
  reason?: 'redacted_input_possible';
}

// What the trace writes in place of a credential (a signed-URL query, a provider key, a secret value) or of a too deep value.
const REDACTION_MARKERS = ['[redacted]', '[depth]'];

// Whether a traced value holds a redaction marker anywhere (in a string or a key).
const hasRedaction = (value: unknown, depth = 0): boolean => {
  if (depth > 32) {
    return false;
  }
  if (typeof value === 'string') {
    return REDACTION_MARKERS.some((m) => value.includes(m));
  }
  if (Array.isArray(value)) {
    return value.some((v) => hasRedaction(v, depth + 1));
  }
  if (isObject(value)) {
    return Object.values(value).some((v) => hasRedaction(v, depth + 1));
  }
  return false;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// The planner's inputs from the last `structure/input` row of a bundle (a retried step traces it again; the last one made
// the kept plan).
export const replayInput = (bundle: ReplayBundle): PlanEditInput => {
  const row = [...bundle.steps].reverse().find((s) => s.step === 'structure' && s.kind === 'input');
  if (!row || !isObject(row.payload)) {
    throw new ReplayError('no_structure_input');
  }
  const p = row.payload;
  if (p.truncated === true) {
    throw new ReplayError('input_truncated');
  }
  if (!Array.isArray(p.words) || !isObject(p.request) || !isObject(p.palette)) {
    throw new ReplayError('needs_full_trace');
  }
  const sessionId = typeof p.session_id === 'string' ? p.session_id : bundle.edit?.sessionId;
  const level = typeof p.level === 'string' ? p.level : bundle.edit?.level;
  if (!sessionId || !level) {
    throw new ReplayError('needs_full_trace');
  }
  return {
    sessionId,
    level: level as EditLevel,
    request: p.request as unknown as EditRequest,
    words: p.words as EditWord[],
    palette: p.palette as unknown as Palette,
    scores: (p.scores as SlotScores | undefined) ?? undefined,
    direction: (p.direction as Direction | undefined) ?? undefined,
    texts: (p.texts as SlotTexts | undefined) ?? undefined,
    assets: (p.assets as AssembleAssets | undefined) ?? undefined,
    planAssets: (p.plan_assets as PlanAsset[] | undefined) ?? undefined,
    bannedWords: (p.banned_words as string[] | undefined) ?? undefined,
  };
};

// The plan the phone was served: the bundle's `delivered.plan`, else the one in the `deliver/output` row (last one).
const deliveredPlan = (bundle: ReplayBundle): Plan | undefined => {
  const direct = (bundle.delivered as { plan?: Plan } | null | undefined)?.plan;
  if (isObject(direct)) {
    return direct as unknown as Plan;
  }
  const row = [...bundle.steps].reverse().find((s) => s.step === 'deliver' && s.kind === 'output');
  const traced = isObject(row?.payload) ? (row!.payload.delivered as { plan?: Plan } | undefined)?.plan : undefined;
  return isObject(traced) ? (traced as unknown as Plan) : undefined;
};

// The path of the first difference between two JSON values, or undefined when they are equal.
export const firstDifference = (a: unknown, b: unknown, path = '$'): string | undefined => {
  if (isDeepStrictEqual(a, b)) {
    return undefined;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const at = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (at) {
        return at;
      }
    }
  } else if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const at = firstDifference(a[key], b[key], `${path}.${key}`);
      if (at) {
        return at;
      }
    }
  }
  return path;
};

// Plans again from a bundle's traced inputs and compares with the delivered plan (both as JSON, the way the database keeps
// them).
export const replayBundle = (bundle: ReplayBundle): ReplayResult => {
  const expected = deliveredPlan(bundle);
  if (!expected) {
    throw new ReplayError('no_delivered_plan');
  }
  const input = replayInput(bundle);
  const plan = JSON.parse(JSON.stringify(planAndValidate(input).plan)) as Plan;
  const difference = firstDifference(plan, expected);
  // the traced input went through the trace's redaction: a difference then may be a word or text it altered, so it is said
  const redacted = !!difference && hasRedaction(input);
  return {
    equal: difference === undefined,
    plan,
    expected,
    ...(difference ? { difference } : {}),
    ...(redacted ? { reason: 'redacted_input_possible' as const } : {}),
  };
};
