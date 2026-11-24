// AI video editing (ai.video-editing), tracing: one append-only record of every step and decision of an edit job.
// Best effort by design: nothing here throws into the job, and a trace row is never worth a failed edit.
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  AiVideoEditTraceFilter,
  AiVideoEditTraceRepository,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.repository';

// The steps and kinds a row can carry.
export type TraceStep =
  | 'create'
  | 'transcribe'
  | 'structure'
  | 'perceive'
  | 'write'
  | 'assets'
  | 'assemble'
  | 'validate'
  | 'client_check'
  | 'deliver'
  | 'settle'
  | 'fail'
  | 'render_report'
  | 'usage';
export type TraceKind = 'input' | 'output' | 'decision' | 'error' | 'metric';

// `off` writes nothing, `meta` keeps counts, codes, sizes and hashes, `full` keeps the whole redacted JSON.
export type TraceMode = 'off' | 'meta' | 'full';

// One row to record; `attempt` is the Temporal activity attempt.
export interface TraceEntry {
  step: TraceStep;
  kind: TraceKind;
  attempt?: number;
  durationMs?: number;
  ok?: boolean;
  payload?: unknown;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 524288;
const DEFAULT_DAYS = 365;
const MAX_DAYS = 36500;
const MAX_DEPTH = 24;
const MAX_REMEMBERED = 200;
const REDACTED = '[redacted]';

// The mode from the environment value; anything but `off` or `full` is `meta`, so a typo never writes more than counts.
export const traceMode = (raw: string | undefined): TraceMode => {
  const text = (raw || '').trim().toLowerCase();
  return text === 'off' || text === 'full' ? text : 'meta';
};

// The row size cap in bytes from the environment value: a whole number of at least 1, else the default.
export const traceMaxBytes = (raw: string | undefined) => {
  const text = (raw || '').trim();
  const value = /^\d+$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_MAX_BYTES;
};

// The retention in days from the environment value: a whole number from 1 to 36500, else 365 (a typo never turns the
// purge off or makes it immediate).
export const traceDays = (raw: string | undefined) => {
  const text = (raw || '').trim();
  const value = /^\d+$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DAYS ? value : DEFAULT_DAYS;
};

// A key whose value is a credential: api keys, auth headers, cookies, secrets, passwords, tokens (`prompt_tokens` is a
// count, not a token, and stays).
const SENSITIVE_KEY = /(api[_-]?key|authorization|cookie|secret|passwd|password|token|bearer)$/i;
// A URL with a query string (signed URLs carry their signature there).
const URL_QUERY = /(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/gi;
// An auth scheme with its credential.
const AUTH_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// The shape of a provider key (OpenAI, GitHub, Slack, Google, AWS).
const KEY_SHAPE = /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})/g;
// The environment variables that hold a credential; their values are removed wherever they appear in a string.
const SECRET_ENV = /(API_KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID)$/;

// The values of the credential variables of this process (short values are not credentials).
const secretValues = () =>
  Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV.test(name) && (value || '').length >= 8)
    .map(([, value]) => value as string);

// A string without signed-URL queries, auth values, provider keys and the process's own credentials.
const redactString = (text: string, secrets: string[]) => {
  let out = text.replace(URL_QUERY, '$1?' + REDACTED).replace(AUTH_VALUE, '$1 ' + REDACTED).replace(KEY_SHAPE, REDACTED);
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
};

// A value as plain JSON with every credential removed: sensitive keys, signed-URL queries, keys inside strings. Dates
// become ISO strings, errors their name and message, what JSON cannot hold is dropped.
export const redact = (value: unknown, secrets: string[] = secretValues(), depth = 0): unknown => {
  if (depth > MAX_DEPTH) {
    return '[depth]';
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value, secrets);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message, secrets) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, secrets, depth + 1) ?? null);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const clean = SENSITIVE_KEY.test(key) && item != null ? REDACTED : redact(item, secrets, depth + 1);
      if (clean !== undefined) {
        out[key] = clean;
      }
    }
    return out;
  }
  return undefined;
};

// A string under such a key is a code or an id, not content, and `meta` keeps it (up to 64 characters). `work` is the
// usage ledger's label of what a call did, built from ids and counts only.
const KEEP_KEY = /(id|code|sha256|hash|version|kind|status|provider|model|language|ratio|level|step|rule|class|type|decision)$|^work$/i;
const KEEP_MAX_CHARS = 64;
const KEEP_MAX_ITEMS = 50;

// The `meta` form of redacted JSON: numbers, booleans and codes stay; text is cut to its length (`<key>_chars`); an array
// is cut to its count, unless it is a list of codes.
const summarise = (value: unknown, key = ''): unknown => {
  if (Array.isArray(value)) {
    const codes =
      KEEP_KEY.test(key) &&
      value.length <= KEEP_MAX_ITEMS &&
      value.every((item) => typeof item === 'string' && item.length <= KEEP_MAX_CHARS);
    return codes ? value : { count: value.length };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && !(KEEP_KEY.test(name) && item.length <= KEEP_MAX_CHARS)) {
        out[`${name}_chars`] = item.length;
      } else {
        out[name] = summarise(item, name);
      }
    }
    return out;
  }
  return value;
};

// The error class and code of a thrown value; never its message in `meta`.
const errorPayload = (err: unknown) => {
  const error = err as { name?: string; code?: unknown; status?: unknown; message?: unknown };
  const code = error?.code ?? error?.status;
  return {
    error_class: typeof error?.name === 'string' ? error.name : typeof err,
    error_code: typeof code === 'string' || typeof code === 'number' ? code : null,
    message: typeof error?.message === 'string' ? error.message : '',
  };
};

// What a row stores for a payload in a mode: the payload as the mode allows it (always an object; a bare value is
// kept as `{value}`, none as `{}`), and the size and hash of the whole redacted JSON. Over the size cap the payload
// becomes `{truncated, bytes, sha256}`.
export const traceRow = (payload: unknown, mode: Exclude<TraceMode, 'off'>, maxBytes: number) => {
  const clean = payload === undefined ? {} : redact(payload);
  const whole = clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : { value: clean ?? null };
  const wholeJson = JSON.stringify(whole);
  const payloadBytes = Buffer.byteLength(wholeJson);
  const payloadSha256 = createHash('sha256').update(wholeJson).digest('hex');
  const kept = mode === 'full' ? whole : summarise(whole);
  const keptBytes = mode === 'full' ? payloadBytes : Buffer.byteLength(JSON.stringify(kept));
  return {
    payload: keptBytes > maxBytes ? { truncated: true, bytes: payloadBytes, sha256: payloadSha256 } : kept,
    payloadBytes,
    payloadSha256,
  };
};

@Injectable()
export class TraceService {
  private readonly _logger = new Logger(TraceService.name);

  // The workspace of an edit, remembered (an edit never changes workspace); bounded, the oldest forgotten first.
  private readonly _organizations = new Map<string, string>();

  // Receives the repository of the trace rows.
  constructor(private _repository: AiVideoEditTraceRepository) {}

  // Appends a row to the trace of an edit in the mode of AI_EDIT_TRACE. Never throws: a failed write is logged by its
  // error name only. Safe to await (one insert) or to leave running.
  async record(editId: string, entry: TraceEntry): Promise<void> {
    try {
      const mode = traceMode(process.env.AI_EDIT_TRACE);
      if (mode === 'off') {
        return;
      }
      const organizationId = await this.organizationOf(editId);
      if (!organizationId) {
        return;
      }
      const row = traceRow(entry.payload, mode, traceMaxBytes(process.env.AI_EDIT_TRACE_MAX_BYTES));
      await this._repository.append({
        editId,
        organizationId,
        step: entry.step,
        kind: entry.kind,
        attempt: entry.attempt,
        durationMs: entry.durationMs === undefined ? undefined : Math.max(0, Math.round(entry.durationMs)),
        ok: entry.ok,
        payload: row.payload as Prisma.InputJsonValue,
        payloadBytes: row.payloadBytes,
        payloadSha256: row.payloadSha256,
      });
    } catch (err) {
      this._logger.warn(`A trace row could not be written: ${(err as Error)?.name}`);
    }
  }

  // Runs `fn`, records its duration as a `metric` row (or an `error` row with the error class and code when it throws),
  // answers its result and rethrows its error.
  async time<T>(editId: string, step: TraceStep, fn: () => T | Promise<T>, attempt?: number): Promise<T> {
    const started = Date.now();
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      await this.record(editId, { step, kind: 'error', attempt, durationMs: Date.now() - started, ok: false, payload: errorPayload(err) });
      throw err;
    }
    await this.record(editId, { step, kind: 'metric', attempt, durationMs: Date.now() - started, ok: true });
    return result;
  }

  // The rows of the workspace's edit in `seq` order, narrowed by step and kind; empty for another workspace's edit.
  list(organizationId: string, editId: string, filter: AiVideoEditTraceFilter = {}) {
    return this._repository.list(organizationId, editId, filter);
  }

  // Deletes the rows older than AI_EDIT_TRACE_DAYS days; answers how many went. Never throws.
  async deleteExpired(now: Date = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - traceDays(process.env.AI_EDIT_TRACE_DAYS) * DAY_MS);
    try {
      return { deleted: await this._repository.deleteCreatedBefore(cutoff) };
    } catch (err) {
      this._logger.warn(`The old trace rows could not be purged: ${(err as Error)?.name}`);
      return { deleted: 0 };
    }
  }

  // The workspace of an edit; null when there is no such edit.
  private async organizationOf(editId: string) {
    const known = this._organizations.get(editId);
    if (known) {
      return known;
    }
    const found = await this._repository.organizationOf(editId);
    if (found) {
      if (this._organizations.size >= MAX_REMEMBERED) {
        this._organizations.delete(this._organizations.keys().next().value as string);
      }
      this._organizations.set(editId, found);
    }
    return found;
  }
}
