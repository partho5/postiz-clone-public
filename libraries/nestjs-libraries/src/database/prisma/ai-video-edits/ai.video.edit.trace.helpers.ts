// AI video editing (ai.video-editing), tracing helpers of the service steps: the ids every trace row carries (edit,
// session, Temporal workflow and run, request), the failure cause kept next to the client-facing error, and the writer's
// per-text decisions. Pure apart from reading the Temporal activity context, which is absent outside an activity (then
// there is nothing to read and no error).
import { Context } from '@temporalio/activity';
import { WriterAnswer, WrittenTexts } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.texts';
import { hasBanned } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.validator';
import { HOOK_SLOT_ID } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.slots';
import type { LlmUsage } from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';
import type { CheckResult } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.clientcheck';
import type { PlanAndValidateResult, PlanEditInput } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.pipeline';
import type { TraceEntry, TraceStep } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.service';

// What the running Temporal activity says about itself: its attempt (1 for the first try) and its workflow and run ids.
export interface ActivityTrace {
  attempt?: number;
  workflowId?: string;
  runId?: string;
}

// The running activity's attempt, workflow id and run id; empty outside an activity (an API request, a spec).
export const activityTrace = (): ActivityTrace => {
  try {
    const info = Context.current().info;
    return {
      attempt: info.attempt,
      workflowId: info.workflowExecution?.workflowId,
      runId: info.workflowExecution?.runId,
    };
  } catch {
    return {};
  }
};

// The longest request id kept.
const MAX_REQUEST_ID = 64;

// The request id of an API call (the `x-request-id` header): the first value, only id characters, at most 64 of them;
// undefined when there is none or it is not an id.
export const requestIdOf = (raw: string | string[] | undefined) => {
  const first = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return first && first.length <= MAX_REQUEST_ID && /^[A-Za-z0-9._:-]+$/.test(first) ? first : undefined;
};

// The longest app version kept.
const MAX_APP_VERSION = 32;

// The app version of an API call (the `x-app-version` header): the first value, only version characters (letters,
// digits and `. _ + -`), at most 32 of them; undefined when there is none or it is not a version.
export const appVersionOf = (raw: string | string[] | undefined) => {
  const first = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return first && first.length <= MAX_APP_VERSION && /^[A-Za-z0-9._+-]+$/.test(first) ? first : undefined;
};

// The ids that tie a trace row to its edit, to the workflow run that made it and to the request that started it
// (`requestId` is only known to the API call that creates the edit).
export const correlation = (
  edit: { id: string; sessionId: string },
  requestId?: string,
  activity: ActivityTrace = activityTrace()
) => ({
  editId: edit.id,
  sessionId: edit.sessionId,
  ...(activity.workflowId ? { workflowId: activity.workflowId } : {}),
  ...(activity.runId ? { runId: activity.runId } : {}),
  ...(requestId ? { requestId } : {}),
});

// Why a step failed, as codes only (it is kept in the edit's `log`, which no API reads, so it carries no message).
export interface FailureCause {
  step: TraceStep;
  error_class: string;
  error_code: string | number | null;
  retryable: boolean;
  attempt?: number;
  at: string;
}

// The code of a thrown value: the code in an HTTP exception's body (its own `status` is only the HTTP status), else its
// `code` or `status`, else the type of a Temporal application failure (`ai_video_edit_stop`).
const codeOf = (err: any): string | number | null => {
  const body = typeof err?.getResponse === 'function' ? err.getResponse() : undefined;
  if (typeof body?.code === 'string') {
    return body.code;
  }
  const direct = err?.code ?? err?.status;
  if (typeof direct === 'string' || typeof direct === 'number') {
    return direct;
  }
  return typeof err?.type === 'string' ? err.type : null;
};

// The cause of a thrown value at a step. `retryable` is what the error says of itself (a Temporal failure's
// `nonRetryable`, a provider error's `retryable`); an error that says nothing is taken as retryable, as Temporal does.
export const failureCause = (err: unknown, step: TraceStep, attempt?: number, now: Date = new Date()): FailureCause => {
  const error = err as { name?: unknown; nonRetryable?: unknown; retryable?: unknown };
  const retryable =
    typeof error?.nonRetryable === 'boolean'
      ? !error.nonRetryable
      : typeof error?.retryable === 'boolean'
        ? error.retryable
        : true;
  return {
    step,
    error_class: typeof error?.name === 'string' && error.name ? error.name : typeof err,
    error_code: codeOf(err),
    retryable,
    ...(attempt === undefined ? {} : { attempt }),
    at: now.toISOString(),
  };
};

// What the writer did with each slot it was asked about: its text accepted, or rejected with the reason (`not_answered`,
// `empty_text`, `banned_word`, `cleaned_empty`), and whether its icon query was kept.
export const writerDecisions = (
  askedIds: string[],
  answer: WriterAnswer | null | undefined,
  texts: WrittenTexts | undefined,
  bannedWords: string[]
) => {
  const items = Array.isArray(answer?.slots) ? answer!.slots : [];
  return askedIds.map((id) => {
    const item = items.find((i) => i?.id === id);
    const kept = id === HOOK_SLOT_ID ? texts?.hook : texts?.complementary?.[id];
    let reason: string | undefined;
    if (!kept) {
      if (!item) {
        reason = 'not_answered';
      } else if (!(item.text || '').trim()) {
        reason = 'empty_text';
      } else if (hasBanned(item.text, bannedWords)) {
        reason = 'banned_word';
      } else {
        reason = 'cleaned_empty';
      }
    }
    return {
      slot_id: id,
      decision: kept ? 'accepted' : 'rejected',
      ...(reason ? { reason_code: reason } : {}),
      icon_query_kept: !!texts?.icon_queries?.[id],
    };
  });
};

// How many times each code occurs, as `{code: count}`.
const tally = (codes: (string | number)[]) =>
  codes.reduce<Record<string, number>>((out, code) => ({ ...out, [code]: (out[code] || 0) + 1 }), {});

// The `structure/input` row: what `planAndValidate` was called with (the transcript words, the request, the palette, the
// scores, the written texts, the assets, the banned words), so the plan can be made again from the trace alone (the golden
// replay). `full` mode keeps it whole; `meta` reduces it to counts, lengths and codes like any payload. Nothing secret is in
// it: the request is the phone's own, the rest is the edit's.
export const plannerInputTrace = (input: PlanEditInput): TraceEntry => ({
  step: 'structure',
  kind: 'input',
  payload: {
    session_id: input.sessionId,
    level: input.level,
    request: input.request,
    words: input.words,
    palette: input.palette,
    scores: input.scores,
    texts: input.texts,
    assets: input.assets,
    plan_assets: input.planAssets,
    banned_words: input.bannedWords,
  },
});

// The trace rows of the planner's decisions, in the order they are written: the structure (protected spans with the
// activity behind each, silence cuts, windows, slots), the assembler's output and one decision per slot (kept, or dropped
// with its reason code), then the validator's output and one decision per repair or drop (rule, item, what changed).
// Codes, ids, times and counts only: no word of the transcript and no text of the plan.
export const plannerTrace = (result: PlanAndValidateResult): TraceEntry[] => {
  const rows: TraceEntry[] = [];
  const planner = result.planner;
  if (planner) {
    const structure = planner.structure;
    rows.push({
      step: 'structure',
      kind: 'output',
      payload: {
        ...structure,
        counts: {
          protected_spans: structure.protected_spans.length,
          cuts: structure.cuts.length,
          windows: structure.windows.length,
          slots: structure.slots.length,
        },
      },
    });
    const dropped = planner.assemble.filter((d) => d.decision === 'dropped');
    rows.push({
      step: 'assemble',
      kind: 'output',
      payload: {
        slots: planner.assemble.length,
        kept: planner.assemble.length - dropped.length,
        dropped: dropped.length,
        reasons: tally(dropped.map((d) => d.reason_code)),
        plan_items: result.plan.items.length,
      },
    });
    for (const decision of planner.assemble) {
      rows.push({
        step: 'assemble',
        kind: 'decision',
        payload: {
          slot_id: decision.slot_id,
          decision: decision.decision,
          reason_code: decision.reason_code,
          inputs: decision.inputs,
        },
      });
    }
  }
  const lines = result.decisions ?? [];
  rows.push({
    step: 'validate',
    kind: 'output',
    payload: {
      plan_items: result.plan.items.length,
      warning_code: result.warnings,
      repaired: lines.filter((l) => l.action === 'repaired').length,
      dropped: lines.filter((l) => l.action === 'dropped').length,
      rules: tally(lines.map((l) => `rule_${l.rule}`)),
    },
  });
  for (const line of lines) {
    rows.push({
      step: 'validate',
      kind: 'decision',
      payload: {
        decision: line.action,
        item_id: line.id,
        effect_id: line.effect,
        rule: line.rule,
        reason_code: line.code,
        changed: line.changed,
      },
    });
  }
  return rows;
};

// The trace rows of a client check, in the order they are written: the summary (how many findings, by code, and whether
// the plan is unusable), then one decision per finding (code, item id, severity and the detail, which holds codes and
// counts only). No text of the plan. `blocking` says whether an unusable plan ends the job (`AI_EDIT_CLIENT_CHECK_BLOCK`).
export const clientCheckTrace = (results: CheckResult[], unusable: boolean, blocking = false): TraceEntry[] => [
  {
    step: 'client_check',
    kind: 'output',
    ok: !unusable,
    payload: {
      findings: results.length,
      errors: results.filter((r) => r.severity === 'error').length,
      warnings: results.filter((r) => r.severity === 'warning').length,
      by_code: tally(results.map((r) => r.code)),
      unusable,
      blocking,
    },
  },
  ...results.map(
    (r): TraceEntry => ({
      step: 'client_check',
      kind: 'decision',
      payload: { decision: 'lint', reason_code: r.code, item_id: r.item_id, severity_code: r.severity, detail: r.detail },
    })
  ),
];

// The steps whose LLM calls the ledger names.
export type UsageStep = 'transcribe' | 'perceive' | 'write' | 'assets';

// The payload of a `usage/metric` row.
export interface UsagePayload {
  step: UsageStep;
  work: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  images?: number;
  audio_seconds?: number;
  estimated: boolean;
  latency_ms: number;
  attempt?: number;
  ok: boolean;
}

// The `usage/metric` row of one call: the step, what it did (`work`: ids and counts), the model, its tokens (a
// speech-to-text call has `audio_seconds` instead), whether they are estimated, its latency, the activity attempt and
// whether it succeeded. Numbers and codes only.
export const usagePayload = (step: UsageStep, call: LlmUsage, attempt?: number): UsagePayload => ({
  step,
  work: call.work ?? `${step} call`,
  model: call.model,
  ...(call.audio_seconds === undefined
    ? {
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        total_tokens: call.input_tokens + call.output_tokens,
        ...(call.cached_tokens === undefined ? {} : { cached_tokens: call.cached_tokens }),
        ...(call.images === undefined ? {} : { images: call.images }),
      }
    : { audio_seconds: call.audio_seconds }),
  estimated: call.estimated,
  latency_ms: call.latency_ms,
  ...(attempt === undefined ? {} : { attempt }),
  ok: call.ok,
});

// The totals of the calls of one step or one model.
export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  audio_seconds?: number;
}

// An edit's ledger, as `AiVideoEdit.log.usage` keeps it: every call so far (failed and retried ones too), the tokens in
// all, and the totals by step and by model. `estimated_calls` is how many of the calls have estimated tokens. No price: the
// owner calculates the USD cost from the model ids and the tokens.
export interface UsageLedger {
  calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_audio_seconds?: number;
  estimated_calls?: number;
  by_step: Record<string, UsageTotals>;
  by_model: Record<string, UsageTotals>;
}

// A count read back from stored JSON: a finite number of at least 0, else 0.
const whole = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

// The totals read back from stored JSON.
const totalsOf = (value: unknown): UsageTotals => {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    calls: whole(raw.calls),
    input_tokens: whole(raw.input_tokens),
    output_tokens: whole(raw.output_tokens),
    ...(whole(raw.audio_seconds) ? { audio_seconds: whole(raw.audio_seconds) } : {}),
  };
};

// A totals record with one more call added.
const added = (totals: UsageTotals, payload: UsagePayload): UsageTotals => {
  const audio = payload.audio_seconds ?? 0;
  return {
    calls: totals.calls + 1,
    input_tokens: totals.input_tokens + (payload.input_tokens ?? 0),
    output_tokens: totals.output_tokens + (payload.output_tokens ?? 0),
    ...(totals.audio_seconds || audio ? { audio_seconds: (totals.audio_seconds ?? 0) + audio } : {}),
  };
};

// The ledger read back from an edit's stored `log` (what `log.usage` holds, an empty ledger when it holds nothing usable).
export const usageOfLog = (log: unknown): UsageLedger | undefined => {
  const usage = (log && typeof log === 'object' ? (log as Record<string, unknown>).usage : undefined) as
    | Record<string, unknown>
    | undefined;
  if (!usage || typeof usage !== 'object' || !whole(usage.calls)) {
    return undefined;
  }
  const group = (value: unknown) =>
    Object.fromEntries(
      Object.entries((value && typeof value === 'object' ? value : {}) as Record<string, unknown>).map(([k, v]) => [k, totalsOf(v)])
    );
  return {
    calls: whole(usage.calls),
    total_input_tokens: whole(usage.total_input_tokens),
    total_output_tokens: whole(usage.total_output_tokens),
    ...(whole(usage.total_audio_seconds) ? { total_audio_seconds: whole(usage.total_audio_seconds) } : {}),
    ...(whole(usage.estimated_calls) ? { estimated_calls: whole(usage.estimated_calls) } : {}),
    by_step: group(usage.by_step),
    by_model: group(usage.by_model),
  };
};

// The ledger with the calls (as their `usage` rows) added to what `before` holds (a ledger read back from `log.usage`, or
// none). Pure: `before` is not changed.
export const addUsage = (before: UsageLedger | undefined, payloads: UsagePayload[]): UsageLedger => {
  const ledger: UsageLedger = {
    calls: before?.calls ?? 0,
    total_input_tokens: before?.total_input_tokens ?? 0,
    total_output_tokens: before?.total_output_tokens ?? 0,
    ...(before?.total_audio_seconds ? { total_audio_seconds: before.total_audio_seconds } : {}),
    ...(before?.estimated_calls ? { estimated_calls: before.estimated_calls } : {}),
    by_step: { ...(before?.by_step ?? {}) },
    by_model: { ...(before?.by_model ?? {}) },
  };
  for (const payload of payloads) {
    const audio = payload.audio_seconds ?? 0;
    ledger.calls += 1;
    ledger.total_input_tokens += payload.input_tokens ?? 0;
    ledger.total_output_tokens += payload.output_tokens ?? 0;
    if (audio) {
      ledger.total_audio_seconds = (ledger.total_audio_seconds ?? 0) + audio;
    }
    if (payload.estimated) {
      ledger.estimated_calls = (ledger.estimated_calls ?? 0) + 1;
    }
    ledger.by_step[payload.step] = added(ledger.by_step[payload.step] ?? totalsOf(undefined), payload);
    ledger.by_model[payload.model] = added(ledger.by_model[payload.model] ?? totalsOf(undefined), payload);
  }
  return ledger;
};
