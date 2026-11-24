// ai.video-editing (L5): the trace bundle and the render receipt. The service runs on in-memory stand-ins for the edits and
// the trace rows, with the real TraceService; needs no database, no network and no Temporal. Covers the receipt (own workspace
// only, idempotent per attempt, hash match, never failing for the trace, the DTO refusing free text), the bundle (ordered,
// filtered, the served body only in `full` mode) and the admin route's gate.
import 'reflect-metadata';
import { createHash } from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminAiEditsController } from '@gitroom/backend/api/routes/admin.ai.edits.controller';
import { planAndValidate } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.pipeline';
import { toEditWords } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.words';
import {
  GOLDEN_FIXTURES,
  MULTI_PALETTE,
  goldenRequest,
} from '@gitroom/nestjs-libraries/ai-video-edit/core/fixtures/edit.golden.fixtures';
import { AiVideoEditsService } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.service';
import { TraceService } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.service';
import { plannerInputTrace } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.helpers';
import { AiVideoEditRenderReportDto, RENDER_WARNING_CODES } from '@gitroom/nestjs-libraries/dtos/ai-video-edits/ai.video.edit.render.report.dto';

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: jest.fn() },
  R2_BUCKET: 'test-bucket',
  deleteObject: jest.fn(),
  readObject: jest.fn(),
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.repository',
  () => ({ AiVideoEditsRepository: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.repository',
  () => ({ AiVideoEditTraceRepository: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service',
  () => ({ AiChargingService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service',
  () => ({ AiCaptionsService: class {} })
);
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const EDIT = 'edit-1';
const SESSION = '2f1d1c9e-6f0a-4c55-9a39-0d3c6f1f8a11';

const fixture = GOLDEN_FIXTURES[0];
const input = {
  sessionId: SESSION,
  level: 'heavy' as const,
  request: goldenRequest(fixture),
  words: toEditWords(fixture.words),
  palette: MULTI_PALETTE,
};
const plan = planAndValidate(input).plan;
const delivered = JSON.parse(JSON.stringify({ id: EDIT, status: 'READY', cost: 3, plan, assets: [] }));
const deliveredSha = createHash('sha256').update(JSON.stringify(delivered)).digest('hex');

// The edits as the service reads them.
class FakeEdits {
  edits: any[] = [
    {
      id: EDIT,
      organizationId: ORG,
      sessionId: SESSION,
      level: 'heavy',
      status: 'READY',
      error: null,
      language: 'eng',
      sourceSeconds: 40,
      cost: 3,
      request: input.request,
      plan,
      assets: [],
      delivered,
      log: null,
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ];
  getEditById = async (id: string) => this.edits.find((e) => e.id === id) || null;
  getEdit = async (organizationId: string, id: string) =>
    this.edits.find((e) => e.id === id && e.organizationId === organizationId && !e.deletedAt) || null;
}

// The trace rows as the trace service writes and reads them.
class FakeTraceRepository {
  rows: any[] = [];
  failAppend: Error | null = null;
  constructor(private _edits: FakeEdits) {}
  async organizationOf(editId: string) {
    return this._edits.edits.find((e) => e.id === editId)?.organizationId ?? null;
  }
  async append(row: any) {
    if (this.failAppend) {
      throw this.failAppend;
    }
    this.rows.push({ ...row, id: `row-${this.rows.length + 1}`, seq: this.rows.length + 1, createdAt: new Date(1700000000000 + this.rows.length * 1000) });
  }
  async list(organizationId: string, editId: string, filter: { step?: string; kind?: string } = {}) {
    return this.rows.filter(
      (r) => r.editId === editId && r.organizationId === organizationId && (!filter.step || r.step === filter.step) && (!filter.kind || r.kind === filter.kind)
    );
  }
}

const build = () => {
  const edits = new FakeEdits();
  const repository = new FakeTraceRepository(edits);
  const trace = new TraceService(repository as any);
  const service = new AiVideoEditsService(edits as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, trace);
  return { edits, repository, trace, service };
};

const report = (over: Record<string, unknown> = {}) =>
  plainToInstance(AiVideoEditRenderReportDto, {
    attemptId: 'attempt-1',
    served_sha256: deliveredSha,
    parse_ok: true,
    app_version: '1.4.2',
    device: 'Pixel 7',
    outputs: [
      { ratio: '9:16', ok: true, duration_ms: 31000, bytes: 9000000 },
      { ratio: '4:5', ok: false, error_code: 'encoder_failed' },
    ],
    warnings: [{ code: 'text_shrunk', item_id: 'i3' }],
    ...over,
  });

let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.AI_EDIT_TRACE;
  process.env.AI_EDIT_TRACE = 'full';
});
afterEach(() => {
  if (savedMode === undefined) {
    delete process.env.AI_EDIT_TRACE;
  } else {
    process.env.AI_EDIT_TRACE = savedMode;
  }
});

describe('ai.video-editing: render report', () => {
  it('answers 404 EDIT_NOT_FOUND for another workspace and writes nothing', async () => {
    const h = build();

    await expect(h.service.renderReport(OTHER_ORG, EDIT, report())).rejects.toMatchObject({ status: 404 });
    await expect(h.service.renderReport(ORG, 'nope', report())).rejects.toMatchObject({ status: 404 });

    expect(h.repository.rows).toEqual([]);
  });

  it('stores a render_report row with the ids, the codes and whether the served body is the delivered one', async () => {
    const h = build();

    await expect(h.service.renderReport(ORG, EDIT, report(), 'req-9')).resolves.toEqual({ ok: true, duplicate: false });

    const [row] = h.repository.rows;
    expect(row).toMatchObject({ editId: EDIT, organizationId: ORG, step: 'render_report', kind: 'metric', ok: false });
    expect(row.payload).toMatchObject({
      editId: EDIT,
      sessionId: SESSION,
      requestId: 'req-9',
      attempt_id: 'attempt-1',
      hash_match: true,
      delivered_sha256: deliveredSha,
      app_version: '1.4.2',
      outputs_failed: 1,
      outputs_by_ratio: { '4:5': { ok: false, error_code: 'encoder_failed' } },
      warnings: { w1: { code: 'text_shrunk', item_id: 'i3' } },
    });
  });

  it('records a hash that does not match the delivered body', async () => {
    const h = build();

    await h.service.renderReport(ORG, EDIT, report({ served_sha256: 'a'.repeat(64) }));

    expect(h.repository.rows[0].payload).toMatchObject({ hash_match: false, delivered_sha256: deliveredSha });
  });

  it('is idempotent per attempt: a repeat writes nothing, a new attempt writes a row', async () => {
    const h = build();

    await h.service.renderReport(ORG, EDIT, report());
    await expect(h.service.renderReport(ORG, EDIT, report())).resolves.toEqual({ ok: true, duplicate: true });
    expect(h.repository.rows).toHaveLength(1);

    // a restarted process knows the attempt from the stored row
    const again = new AiVideoEditsService(h.edits as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, h.trace);
    await expect(again.renderReport(ORG, EDIT, report())).resolves.toEqual({ ok: true, duplicate: true });
    expect(h.repository.rows).toHaveLength(1);

    await expect(h.service.renderReport(ORG, EDIT, report({ attemptId: 'attempt-2' }))).resolves.toEqual({ ok: true, duplicate: false });
    expect(h.repository.rows).toHaveLength(2);
  });

  it('answers the phone even when the trace cannot be written', async () => {
    const h = build();
    h.repository.failAppend = new Error('db down');

    await expect(h.service.renderReport(ORG, EDIT, report())).resolves.toEqual({ ok: true, duplicate: false });
  });

  it('keeps the codes of the receipt in meta mode', async () => {
    process.env.AI_EDIT_TRACE = 'meta';
    const h = build();

    await h.service.renderReport(ORG, EDIT, report());

    expect(h.repository.rows[0].payload).toMatchObject({
      attempt_id: 'attempt-1',
      hash_match: true,
      device_model: 'Pixel 7',
      outputs_by_ratio: { '4:5': { ok: false, error_code: 'encoder_failed' } },
      warnings: { w1: { code: 'text_shrunk', item_id: 'i3' } },
    });
  });
});

describe('ai.video-editing: render report body', () => {
  const check = (body: Record<string, unknown>) =>
    validate(plainToInstance(AiVideoEditRenderReportDto, body), { whitelist: true, forbidNonWhitelisted: true });
  const valid = { ...report() } as unknown as Record<string, unknown>;

  it('accepts a receipt of codes, ids and numbers', async () => {
    expect(await check(valid)).toEqual([]);
  });

  it.each(['property_not_drawn', 'text_wrapped', 'layer_clipped'])('accepts the warning code %s with an item id', async (code) => {
    expect(RENDER_WARNING_CODES).toContain(code);
    expect(await check({ ...valid, warnings: [{ code, item_id: 'i3' }] })).toEqual([]);
  });

  it('refuses a warning code the list does not name', async () => {
    expect((await check({ ...valid, warnings: [{ code: 'layer_cropped', item_id: 'i3' }] })).length).toBeGreaterThan(0);
  });

  it.each([
    ['a path in an error code', { outputs: [{ ratio: '9:16', ok: false, error_code: 'could not write /sdcard/DCIM/a.mp4' }] }],
    ['a sentence as the device', { device: 'my phone is slow, please fix it '.repeat(4) }],
    ['a free text field', { message: 'the text overlay was ugly' }],
    ['a free text warning', { warnings: [{ code: 'the text was cut' }] }],
    ['a free text item id', { warnings: [{ code: 'text_shrunk', item_id: 'Save two hours every week' }] }],
    ['an unknown ratio', { outputs: [{ ratio: '16:9', ok: true }] }],
    ['a hash that is not a sha256', { served_sha256: 'abc' }],
    ['too many outputs', { outputs: Array.from({ length: 4 }, () => ({ ratio: '9:16', ok: true })) }],
    ['too many warnings', { warnings: Array.from({ length: 51 }, () => ({ code: 'text_shrunk' })) }],
    ['no attempt id', { attemptId: undefined }],
  ])('rejects %s', async (_name, over) => {
    expect((await check({ ...valid, ...over })).length).toBeGreaterThan(0);
  });
});

describe('ai.video-editing: trace bundle', () => {
  // A few rows of an edit, across steps.
  const seeded = async () => {
    const h = build();
    await h.trace.record(EDIT, { step: 'create', kind: 'decision', payload: { decision: 'new_edit' } });
    await h.trace.record(EDIT, { step: 'structure', kind: 'input', payload: plannerInputTrace({ ...input }).payload });
    await h.trace.record(EDIT, { step: 'deliver', kind: 'output', ok: true, payload: { sha256: deliveredSha, delivered } });
    await h.service.renderReport(ORG, EDIT, report());
    return h;
  };

  it('answers the edit, its request, the steps by seq, the served body and the receipts', async () => {
    const h = await seeded();

    const bundle = await h.service.traceBundle(EDIT);

    expect(bundle.edit).toMatchObject({ id: EDIT, status: 'READY', level: 'heavy', sessionId: SESSION, language: 'eng', sourceSeconds: 40, cost: 3, error: null });
    expect(bundle.request).toEqual(input.request);
    expect(bundle.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(bundle.steps.map((s) => `${s.step}/${s.kind}`)).toEqual(['create/decision', 'structure/input', 'deliver/output', 'render_report/metric']);
    expect(bundle.delivered).toEqual(delivered);
    expect(bundle.receipts).toHaveLength(1);
    expect(bundle.receipts[0].payload).toMatchObject({ attempt_id: 'attempt-1' });
  });

  it('narrows the steps by step and kind, and keeps every receipt', async () => {
    const h = await seeded();

    expect((await h.service.traceBundle(EDIT, { step: 'structure' })).steps.map((s) => s.step)).toEqual(['structure']);
    expect((await h.service.traceBundle(EDIT, { kind: 'output' })).steps.map((s) => s.kind)).toEqual(['output']);
    expect((await h.service.traceBundle(EDIT, { step: 'create', kind: 'output' })).steps).toEqual([]);
    expect((await h.service.traceBundle(EDIT, { step: 'create' })).receipts).toHaveLength(1);
  });

  it('reads an edit of any workspace by id, and answers 404 for an id that does not exist', async () => {
    const h = await seeded();
    h.edits.edits[0].organizationId = OTHER_ORG;

    await expect(h.service.traceBundle(EDIT)).resolves.toMatchObject({ edit: { id: EDIT } });
    await expect(h.service.traceBundle('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('gives the served body only in full mode: in meta mode its hash, size and counts', async () => {
    process.env.AI_EDIT_TRACE = 'meta';
    const h = await seeded();

    const bundle = await h.service.traceBundle(EDIT);

    expect(bundle.delivered).toEqual({
      sha256: deliveredSha,
      bytes: Buffer.byteLength(JSON.stringify(delivered)),
      status: 'READY',
      plan_items: plan.items.length,
      assets_count: 0,
    });
    expect(JSON.stringify(bundle)).not.toContain('Save');
    // the meta rows hold no word of the transcript
    const structure = bundle.steps.find((s) => s.step === 'structure')!;
    expect(JSON.stringify(structure.payload)).not.toContain(fixture.words[0].text + '"');
  });
});

describe('ai.video-editing: the admin route', () => {
  const bundle = { edit: { id: EDIT } };
  const controller = (traceBundle: jest.Mock) => new AdminAiEditsController({ traceBundle } as any);

  it('answers 404 to a user who is not a super admin, and never reads the edit', async () => {
    const traceBundle = jest.fn().mockResolvedValue(bundle);

    await expect(controller(traceBundle).trace({ isSuperAdmin: false } as any, EDIT)).rejects.toMatchObject({ status: 404 });
    await expect(controller(traceBundle).trace(undefined as any, EDIT)).rejects.toMatchObject({ status: 404 });

    expect(traceBundle).not.toHaveBeenCalled();
  });

  it('gives a super admin the bundle, with the step and kind filters', async () => {
    const traceBundle = jest.fn().mockResolvedValue(bundle);

    await expect(controller(traceBundle).trace({ isSuperAdmin: true } as any, EDIT, 'assemble', 'decision')).resolves.toBe(bundle);

    expect(traceBundle).toHaveBeenCalledWith(EDIT, { step: 'assemble', kind: 'decision' });
  });
});
