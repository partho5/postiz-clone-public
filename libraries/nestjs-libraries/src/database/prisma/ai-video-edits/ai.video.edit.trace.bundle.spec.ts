// ai.video-editing (L5): the pure bundle and the readable timeline made from it (the trace script prints it). No database,
// no Nest. The timeline prints only what the stored payloads hold, in `meta` and in `full` mode.
import {
  BundleRowInput,
  bundleOf,
  timelineOf,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.bundle';

const EDIT = {
  id: 'e1',
  status: 'READY',
  level: 'heavy',
  sessionId: 's1',
  language: null,
  sourceSeconds: 61,
  cost: 3,
  error: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  request: { video: { duration_ms: 61000 } },
  delivered: { id: 'e1', status: 'READY', cost: 3, plan: { items: [{ id: 'i1' }, { id: 'i2' }] }, assets: [] },
};

const row = (seq: number, step: string, kind: string, payload: unknown, over: Partial<BundleRowInput> = {}): BundleRowInput => ({
  seq,
  step,
  kind,
  attempt: 1,
  durationMs: 12,
  ok: true,
  payload,
  payloadBytes: 10,
  payloadSha256: 'f'.repeat(64),
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
  ...over,
});

const ROWS = [
  row(3, 'deliver', 'output', { editId: 'e1', requestId: 'r1', sha256: 'abc', bytes: 99, delivered: { id: 'e1' } }),
  row(1, 'create', 'decision', { editId: 'e1', sessionId: 's1', decision: 'new_edit' }),
  row(2, 'structure', 'input', { editId: 'e1', words: [{ w: 'secret' }, { w: 'words' }], level: 'heavy', hook: 'x'.repeat(100) }),
  row(4, 'render_report', 'metric', { attempt_id: 'a1', hash_match: true }, { ok: false, attempt: null, durationMs: null }),
];

describe('ai.video-editing: trace bundle (pure)', () => {
  it('orders the steps by seq and lists the receipts apart', () => {
    const bundle = bundleOf(EDIT, ROWS, { full: true });

    expect(bundle.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(bundle.receipts.map((s) => s.seq)).toEqual([4]);
    expect(bundle.edit).toMatchObject({ id: 'e1', status: 'READY', level: 'heavy', language: null, sourceSeconds: 61, cost: 3, error: null });
    expect(bundle.edit.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('narrows the steps by step and kind', () => {
    expect(bundleOf(EDIT, ROWS, { full: true, step: 'create' }).steps.map((s) => s.seq)).toEqual([1]);
    expect(bundleOf(EDIT, ROWS, { full: true, kind: 'output' }).steps.map((s) => s.seq)).toEqual([3]);
  });

  it('keeps the served body in full mode and reduces it to a summary in meta mode', () => {
    expect(bundleOf(EDIT, ROWS, { full: true }).delivered).toBe(EDIT.delivered);
    const summary = bundleOf(EDIT, ROWS, { full: false }).delivered as Record<string, unknown>;
    expect(summary).toMatchObject({ status: 'READY', plan_items: 2, assets_count: 0 });
    expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundleOf({ ...EDIT, delivered: null }, ROWS, { full: false }).delivered).toBeNull();
  });
});

describe('ai.video-editing: trace timeline', () => {
  const lines = timelineOf(bundleOf(EDIT, ROWS, { full: false }));
  const text = lines.join('\n');

  it('starts with the edit and the ids, then lists every step in order with its outcome', () => {
    expect(lines[0]).toContain('edit e1  READY  level=heavy');
    expect(text).toContain('editId=e1 sessionId=s1 requestId=r1');
    const steps = lines.filter((l) => /^#/.test(l));
    expect(steps.map((l) => l.match(/\d+\.\d+s\s+(\S+)/)![1])).toEqual([
      'create/decision',
      'structure/input',
      'deliver/output',
      'render_report/metric',
    ]);
    expect(steps[3]).toContain('FAIL');
    expect(text).toContain('receipts (1)');
  });

  it('prints a list or an object as its size and cuts a long text, never printing more than the payload holds', () => {
    expect(text).toContain('words=[2]');
    expect(text).not.toContain('secret');
    expect(text).toContain('hook="' + 'x'.repeat(48) + '"...');
    expect(text).not.toContain('x'.repeat(49));
    expect(text).toContain('delivered={1}');
  });

  it('works the same on a bundle with no steps', () => {
    expect(() => timelineOf(bundleOf(EDIT, [], { full: true }))).not.toThrow();
  });
});
