// AI video editing (ai.video-editing), tracing: the debug bundle of an edit job (the edit, its request, every step in
// order, the JSON the phone was served and the phone's receipts) and the readable timeline made from it. Pure: no Nest, no
// database and no import but types, so the trace script runs it on its own.
import { createHash } from 'crypto';

// The edit as the bundle reads it (the Prisma row has more).
export interface BundleEditInput {
  id: string;
  status: string;
  level: string;
  sessionId: string;
  language: string | null;
  sourceSeconds: number;
  cost: number;
  error: string | null;
  createdAt: Date | string;
  request: unknown;
  delivered: unknown;
}

// A trace row as the bundle reads it.
export interface BundleRowInput {
  seq: number;
  step: string;
  kind: string;
  attempt?: number | null;
  durationMs?: number | null;
  ok?: boolean | null;
  payload: unknown;
  payloadBytes: number;
  payloadSha256: string;
  createdAt: Date | string;
}

// One step row of the bundle.
export interface BundleStep {
  seq: number;
  step: string;
  kind: string;
  attempt: number | null;
  duration_ms: number | null;
  ok: boolean | null;
  payload_bytes: number;
  payload_sha256: string;
  created_at: string;
  payload: unknown;
}

// What the bundle says of the edit.
export interface BundleEdit {
  id: string;
  status: string;
  level: string;
  sessionId: string;
  language: string | null;
  sourceSeconds: number;
  cost: number;
  error: string | null;
  createdAt: string;
}

// The whole story of an edit job.
export interface TraceBundle {
  edit: BundleEdit;
  request: unknown;
  steps: BundleStep[];
  // the exact body the phone was served; in `meta` mode only its hash, size and counts (the body holds the plan's texts)
  delivered: unknown;
  // the phone's `render_report` rows (all of them, whatever the filter)
  receipts: BundleStep[];
}

// Which steps the bundle lists, and whether the plan's texts may leave (`full` trace mode).
export interface BundleOptions {
  step?: string;
  kind?: string;
  full: boolean;
}

const iso = (value: Date | string) => new Date(value).toISOString();

const stepOf = (row: BundleRowInput): BundleStep => ({
  seq: row.seq,
  step: row.step,
  kind: row.kind,
  attempt: row.attempt ?? null,
  duration_ms: row.durationMs ?? null,
  ok: row.ok ?? null,
  payload_bytes: row.payloadBytes,
  payload_sha256: row.payloadSha256,
  created_at: iso(row.createdAt),
  payload: row.payload,
});

// What the bundle says of the stored body in `meta` mode: its hash, size and counts, never the plan.
const deliveredSummary = (delivered: unknown) => {
  if (delivered === null || delivered === undefined) {
    return null;
  }
  const json = JSON.stringify(delivered);
  const body = delivered as { status?: unknown; plan?: { items?: unknown[] }; assets?: unknown[] };
  return {
    sha256: createHash('sha256').update(json).digest('hex'),
    bytes: Buffer.byteLength(json),
    status: typeof body?.status === 'string' ? body.status : null,
    plan_items: Array.isArray(body?.plan?.items) ? body.plan!.items!.length : 0,
    assets_count: Array.isArray(body?.assets) ? body.assets!.length : 0,
  };
};

// The bundle of an edit from its row and its trace rows (any order; the steps come out by `seq`), narrowed by step and kind.
export const bundleOf = (edit: BundleEditInput, rows: BundleRowInput[], options: BundleOptions): TraceBundle => {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  return {
    edit: {
      id: edit.id,
      status: edit.status,
      level: edit.level,
      sessionId: edit.sessionId,
      language: edit.language ?? null,
      sourceSeconds: edit.sourceSeconds,
      cost: edit.cost,
      error: edit.error ?? null,
      createdAt: iso(edit.createdAt),
    },
    request: edit.request ?? null,
    steps: ordered
      .filter((r) => (!options.step || r.step === options.step) && (!options.kind || r.kind === options.kind))
      .map(stepOf),
    delivered: options.full ? edit.delivered ?? null : deliveredSummary(edit.delivered),
    receipts: ordered.filter((r) => r.step === 'render_report').map(stepOf),
  };
};

// The ids every row carries; the timeline prints them once, in its header.
const CORRELATION_KEYS = ['editId', 'sessionId', 'workflowId', 'runId', 'requestId'];

// The longest text of a payload value the timeline prints, and the most values on a line.
const MAX_TEXT = 48;
const MAX_VALUES = 8;

// One value of a payload as the timeline prints it: a number or a flag as it is, a short text cut, a list or an object by
// its size. Never more than the payload holds.
const brief = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.length > MAX_TEXT ? JSON.stringify(value.slice(0, MAX_TEXT)) + '...' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).length}}`;
  }
  return String(value);
};

// A payload as one short line of `key=value` pairs, without the correlation ids.
const summaryOf = (payload: unknown) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload === undefined || payload === null ? '' : brief(payload);
  }
  const entries = Object.entries(payload as Record<string, unknown>).filter(([key]) => !CORRELATION_KEYS.includes(key));
  const shown = entries.slice(0, MAX_VALUES).map(([key, value]) => `${key}=${brief(value)}`);
  return shown.join(' ') + (entries.length > MAX_VALUES ? ` +${entries.length - MAX_VALUES} more` : '');
};

// The ids of the first row that has them (`editId`, `workflowId`, `runId`, `requestId`), as a header line.
const idsLine = (steps: BundleStep[]) => {
  const found: Record<string, string> = {};
  for (const step of steps) {
    const payload = step.payload as Record<string, unknown> | null;
    for (const key of CORRELATION_KEYS) {
      if (!found[key] && typeof payload?.[key] === 'string') {
        found[key] = payload[key] as string;
      }
    }
  }
  return CORRELATION_KEYS.filter((key) => found[key])
    .map((key) => `${key}=${found[key]}`)
    .join(' ');
};

// One timeline line of a row: its number, the time since the first row, step and kind, outcome, attempt, duration and the
// payload's values.
const lineOf = (row: BundleStep, startMs: number) => {
  const offset = new Date(row.created_at).getTime() - startMs;
  const flag = row.ok === null ? '-' : row.ok ? 'ok' : 'FAIL';
  const parts = [
    `#${String(row.seq).padStart(3, ' ')}`,
    `+${(offset / 1000).toFixed(2)}s`,
    `${row.step}/${row.kind}`,
    flag,
    row.attempt === null ? '' : `try ${row.attempt}`,
    row.duration_ms === null ? '' : `${row.duration_ms}ms`,
    summaryOf(row.payload),
  ];
  return parts.filter((p) => p !== '').join('  ');
};

// A readable timeline of a bundle: the edit, then every step in order with its values, then the phone's receipts. Only
// what the stored payloads hold is printed (in `meta` mode that is counts and codes).
export const timelineOf = (bundle: TraceBundle): string[] => {
  const { edit } = bundle;
  const lines = [
    `edit ${edit.id}  ${edit.status}  level=${edit.level}  language=${edit.language ?? '-'}  seconds=${edit.sourceSeconds}  cost=${edit.cost}`,
    `session ${edit.sessionId}  created ${edit.createdAt}`,
  ];
  const ids = idsLine([...bundle.steps, ...bundle.receipts]);
  if (ids) {
    lines.push(ids);
  }
  if (edit.error) {
    lines.push(`error shown to the customer: ${edit.error}`);
  }
  const startMs = new Date((bundle.steps[0] ?? bundle.receipts[0])?.created_at ?? edit.createdAt).getTime();
  lines.push('', `steps (${bundle.steps.length})`);
  for (const row of bundle.steps) {
    lines.push(lineOf(row, startMs));
  }
  const delivered = bundle.delivered as { sha256?: unknown; bytes?: unknown } | null;
  if (delivered && typeof delivered === 'object' && typeof delivered.sha256 === 'string') {
    lines.push('', `delivered sha256=${delivered.sha256} bytes=${String(delivered.bytes)}`);
  }
  lines.push('', `receipts (${bundle.receipts.length})`);
  for (const row of bundle.receipts) {
    lines.push(lineOf(row, startMs));
  }
  return lines;
};
