// ai.video-editing (L2): the trace helpers of the service steps. The ids a row carries (from the Temporal activity
// context when there is one), the request id, the cause of a failure as codes, and the writer's per-text decisions.
// No database, no Temporal: the activity context is a stand-in.
import { HttpException } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import {
  activityTrace,
  correlation,
  failureCause,
  iconsTrace,
  plannerInputTrace,
  plannerTrace,
  requestIdOf,
  writerDecisions,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.helpers';
import {
  addUsage,
  appVersionOf,
  clientCheckTrace,
  usageOfLog,
  usagePayload,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.helpers';
import type { CheckResult } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.clientcheck';
import { planAndValidate } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.pipeline';
import { toEditWords } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.words';
import {
  GOLDEN_FIXTURES,
  MULTI_PALETTE,
  goldenRequest,
} from '@gitroom/nestjs-libraries/ai-video-edit/core/fixtures/edit.golden.fixtures';

const mockCurrent = jest.fn();
jest.mock('@temporalio/activity', () => ({ Context: { current: () => mockCurrent() } }));

describe('ai.video-editing: trace helpers', () => {
  beforeEach(() => mockCurrent.mockReset());

  describe('activityTrace and correlation', () => {
    it('is empty outside an activity', () => {
      mockCurrent.mockImplementation(() => {
        throw new Error('Activity context not initialized');
      });
      expect(activityTrace()).toEqual({});
      expect(correlation({ id: 'e1', sessionId: 's1' })).toEqual({ editId: 'e1', sessionId: 's1' });
    });

    it('reads the attempt and the workflow and run ids inside an activity', () => {
      mockCurrent.mockReturnValue({
        info: { attempt: 2, workflowExecution: { workflowId: 'ai_video_edit_e1', runId: 'run-9' } },
      });
      expect(activityTrace()).toEqual({ attempt: 2, workflowId: 'ai_video_edit_e1', runId: 'run-9' });
      expect(correlation({ id: 'e1', sessionId: 's1' })).toEqual({
        editId: 'e1',
        sessionId: 's1',
        workflowId: 'ai_video_edit_e1',
        runId: 'run-9',
      });
    });

    it('adds the request id when there is one', () => {
      mockCurrent.mockImplementation(() => {
        throw new Error('none');
      });
      expect(correlation({ id: 'e1', sessionId: 's1' }, 'req-1')).toMatchObject({ requestId: 'req-1' });
    });
  });

  describe('requestIdOf', () => {
    it('keeps an id, the first of a list, and drops what is not an id or is too long', () => {
      expect(requestIdOf('abc-123_x.y:z')).toBe('abc-123_x.y:z');
      expect(requestIdOf(['first', 'second'])).toBe('first');
      expect(requestIdOf(undefined)).toBeUndefined();
      expect(requestIdOf('')).toBeUndefined();
      expect(requestIdOf('has space')).toBeUndefined();
      expect(requestIdOf('x'.repeat(65))).toBeUndefined();
      expect(requestIdOf('x'.repeat(64))).toBe('x'.repeat(64));
    });
  });

  describe('failureCause', () => {
    const at = new Date('2026-11-19T10:00:00Z');

    it('takes the class, the code and the attempt of an error, retryable unless it says otherwise', () => {
      const err = Object.assign(new TypeError('x'), { code: 'E_TIMEOUT' });
      expect(failureCause(err, 'transcribe', 2, at)).toEqual({
        step: 'transcribe',
        error_class: 'TypeError',
        error_code: 'E_TIMEOUT',
        retryable: true,
        attempt: 2,
        at: '2026-11-19T10:00:00.000Z',
      });
    });

    it('reads the code of an HTTP exception body and the status of a provider error', () => {
      expect(failureCause(new HttpException({ code: 'INSUFFICIENT_CREDITS' }, 402), 'create').error_code).toBe(
        'INSUFFICIENT_CREDITS'
      );
      expect(failureCause(Object.assign(new Error('x'), { status: 503 }), 'write').error_code).toBe(503);
    });

    it('says a non-retryable Temporal failure and a provider error that says so are not retryable', () => {
      const stop = new ApplicationFailure('x', 'ai_video_edit_stop', true);
      expect(failureCause(stop, 'transcribe')).toMatchObject({ error_code: 'ai_video_edit_stop', retryable: false });
      expect(failureCause(Object.assign(new Error('x'), { retryable: false }), 'transcribe').retryable).toBe(false);
      expect(failureCause(Object.assign(new Error('x'), { retryable: true }), 'transcribe').retryable).toBe(true);
    });

    it('copes with a thrown value that is not an error, and carries no message', () => {
      const cause = failureCause('a plain string', 'perceive', undefined, at);
      expect(cause).toMatchObject({ error_class: 'string', error_code: null, retryable: true });
      expect('attempt' in cause).toBe(false);
      expect(JSON.stringify(failureCause(new Error('secret words'), 'write'))).not.toContain('secret words');
    });
  });

  describe('writerDecisions', () => {
    const answer = {
      slots: [
        { id: 'h1', text: 'Stop wasting hours', icon_query: 'clock' },
        { id: 's1', text: 'Cheap hacks', icon_query: null },
        { id: 's2', text: '   ' },
      ],
    };
    const texts = { hook: 'Stop wasting hours', icon_queries: { h1: 'clock' } };

    it('accepts a kept text and rejects the others with a reason', () => {
      expect(writerDecisions(['h1', 's1', 's2', 's3'], answer, texts, ['Cheap'])).toEqual([
        { slot_id: 'h1', decision: 'accepted', icon_query_kept: true },
        { slot_id: 's1', decision: 'rejected', reason_code: 'banned_word', icon_query_kept: false },
        { slot_id: 's2', decision: 'rejected', reason_code: 'empty_text', icon_query_kept: false },
        { slot_id: 's3', decision: 'rejected', reason_code: 'not_answered', icon_query_kept: false },
      ]);
    });

    it('rejects every slot as not answered when the writer gave nothing', () => {
      expect(writerDecisions(['h1'], null, undefined, []).map((d) => d.reason_code)).toEqual(['not_answered']);
    });
  });

  // L3: the planner's decisions as trace rows.
  describe('plannerTrace', () => {
    const f = GOLDEN_FIXTURES[0];
    const result = planAndValidate({
      sessionId: 's1',
      level: 'heavy',
      request: goldenRequest(f),
      words: toEditWords(f.words),
      palette: MULTI_PALETTE,
    });
    const rows = plannerTrace(result);

    it('writes the structure, then the assembler and one decision per slot, then the validator', () => {
      expect(rows.map((r) => `${r.step}/${r.kind}`).filter((k, i, all) => all.indexOf(k) === i)).toEqual([
        'structure/output',
        'assemble/output',
        'assemble/decision',
        'validate/output',
      ]);
      expect(rows.filter((r) => r.step === 'assemble' && r.kind === 'decision')).toHaveLength(result.planner!.structure.slots.length);
      expect(rows[0].payload).toMatchObject({
        counts: { slots: result.planner!.structure.slots.length, cuts: result.plan.structure.cuts.length },
      });
    });

    it('counts the kept and dropped slots and the reasons of the dropped', () => {
      const out = rows.find((r) => r.step === 'assemble' && r.kind === 'output')!.payload as any;
      const decisions = result.planner!.assemble;
      expect(out.slots).toBe(decisions.length);
      expect(out.kept + out.dropped).toBe(decisions.length);
      expect((Object.values(out.reasons) as number[]).reduce((a, b) => a + b, 0)).toBe(out.dropped);
    });

    it('writes one validate decision per repair, with the rule, the item and what changed', () => {
      const lines = rows.filter((r) => r.step === 'validate' && r.kind === 'decision');
      expect(lines).toHaveLength(result.decisions!.length);
      const out = rows.find((r) => r.step === 'validate' && r.kind === 'output')!.payload as any;
      expect(out).toMatchObject({ repaired: 0, dropped: 0, warning_code: result.warnings });
    });

    it('holds no word of the transcript and no text of the plan', () => {
      const json = JSON.stringify(rows);
      for (const item of result.plan.items) {
        const text = item.component && item.component.type === 'styled_text' ? item.component.text : '';
        if (text.length >= 4) expect(json).not.toContain(text);
      }
    });

    it('still answers the validator rows when the planner gave no decisions', () => {
      const bare = plannerTrace({ ...result, planner: undefined, decisions: undefined });
      expect(bare.map((r) => `${r.step}/${r.kind}`)).toEqual(['validate/output']);
    });
  });
});

// L4: the app version of a request and the trace rows of a client check.
// TS2: the planner input row holds the request, with its chapters reduced to counts.
describe('ai.video-editing: plannerInputTrace chapters', () => {
  const f = GOLDEN_FIXTURES[0];
  const chapters = [
    { start_ms: 0, kind: 'text' as const, title: 'Synthetic title', note: 'Synthetic note' },
    { start_ms: 4000, kind: 'image' as const },
  ];
  const input = (withChapters: boolean) => ({
    sessionId: 's1',
    level: 'heavy' as const,
    request: { ...goldenRequest(f), ...(withChapters ? { chapters } : {}) },
    words: toEditWords(f.words),
    palette: MULTI_PALETTE,
  });

  it('replaces the chapters by their counts and holds no title or note', () => {
    const payload = plannerInputTrace(input(true)).payload as any;
    expect(payload.request.chapters).toEqual({ count: 2, with_title: 1, with_note: 1 });
    expect(JSON.stringify(payload)).not.toContain('Synthetic');
  });

  it('leaves a request without chapters as it is', () => {
    const payload = plannerInputTrace(input(false)).payload as any;
    expect(payload.request).toEqual(goldenRequest(f));
    expect('chapters' in payload.request).toBe(false);
  });
});

// TS6a: the planner input row keeps the direction (times, word indexes and labels only), so a golden replay can plan it again.
describe('ai.video-editing: plannerInputTrace direction', () => {
  it('holds the direction as kept and carries the style budget of the planner in the assemble output', () => {
    const f = GOLDEN_FIXTURES[0];
    const direction = {
      style: 'calm' as const,
      source: 'director' as const,
      moments: [{ id: 's1', kind: 'sentence' as const, start_ms: 0, end_ms: 900, word_from: 0, word_to: 2, label: 'hook' as const }],
    };
    const input = { sessionId: 's1', level: 'heavy' as const, request: goldenRequest(f), words: toEditWords(f.words), palette: MULTI_PALETTE, direction };
    expect((plannerInputTrace(input).payload as any).direction).toEqual(direction);
    const rows = plannerTrace(planAndValidate(input));
    const output = rows.find((r) => r.step === 'assemble' && r.kind === 'output')!.payload as any;
    expect(output.direction).toMatchObject({ style: 'calm', cut_transitions: { code: 'style_calm', placed: 0 } });
  });

  // TS6b: the moment pass's decisions follow the slots' decisions and are not counted as slots
  it('counts only the slots in the assemble output, and writes a decision row for a moment pick', () => {
    const f = GOLDEN_FIXTURES[0];
    const direction = {
      style: 'calm' as const,
      source: 'director' as const,
      moments: [{ id: 's1', kind: 'sentence' as const, start_ms: 0, end_ms: 900, word_from: 0, word_to: 2, label: 'claim' as const }],
    };
    const input = {
      sessionId: 's1',
      level: 'heavy' as const,
      request: goldenRequest(f),
      words: toEditWords(f.words),
      palette: MULTI_PALETTE,
      direction,
      scores: { picks: { s1: 'v_push_in' } },
    };
    const result = planAndValidate(input);
    const rows = plannerTrace(result);
    const output = rows.find((r) => r.step === 'assemble' && r.kind === 'output')!.payload as any;
    expect(output.slots).toBe(result.planner!.structure.slots.length);
    const lines = rows.filter((r) => r.step === 'assemble' && r.kind === 'decision').map((r) => (r.payload as any).slot_id);
    expect(lines.filter((id: string) => id === 'moment:s1')).toHaveLength(1);
  });
});

describe('ai.video-editing: trace helpers (L4)', () => {
  describe('appVersionOf', () => {
    it('keeps a version, the first of a list, and drops what is not a version or is too long', () => {
      expect(appVersionOf('1.4.2')).toBe('1.4.2');
      expect(appVersionOf(' 2.0.0-beta+7 ')).toBe('2.0.0-beta+7');
      expect(appVersionOf(['1.0', '2.0'])).toBe('1.0');
      expect(appVersionOf(undefined)).toBeUndefined();
      expect(appVersionOf('')).toBeUndefined();
      expect(appVersionOf('1.0 beta')).toBeUndefined();
      expect(appVersionOf('1.0;drop table')).toBeUndefined();
      expect(appVersionOf('9'.repeat(33))).toBeUndefined();
      expect(appVersionOf('9'.repeat(32))).toBe('9'.repeat(32));
    });
  });

  describe('clientCheckTrace', () => {
    const results: CheckResult[] = [
      { code: 'text_may_wrap', item_id: 'a', severity: 'warning', detail: 'chars=20' },
      { code: 'text_may_wrap', item_id: 'b', severity: 'warning', detail: 'chars=21' },
      { code: 'unknown_style', item_id: 'c', severity: 'error', detail: 'style_chars=4' },
    ];

    it('writes the summary then one decision per finding', () => {
      const rows = clientCheckTrace(results, true);

      expect(rows.map((r) => `${r.step}/${r.kind}`)).toEqual([
        'client_check/output',
        'client_check/decision',
        'client_check/decision',
        'client_check/decision',
      ]);
      expect(rows[0]).toMatchObject({
        ok: false,
        payload: { findings: 3, errors: 1, warnings: 2, by_code: { text_may_wrap: 2, unknown_style: 1 }, unusable: true },
      });
      expect(rows[1].payload).toEqual({ decision: 'lint', reason_code: 'text_may_wrap', item_id: 'a', severity_code: 'warning', detail: 'chars=20' });
    });

    it('writes only the summary when nothing was found', () => {
      const rows = clientCheckTrace([], false);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ok: true, payload: { findings: 0, unusable: false } });
    });
  });
});

// L7: the usage rows and the ledger kept in `log.usage`.
describe('ai.video-editing: usage ledger helpers (L7)', () => {
  const call = (extra: Record<string, unknown> = {}) => ({
    model: 'gpt-5.1',
    input_tokens: 100,
    output_tokens: 20,
    estimated: false,
    latency_ms: 80,
    ok: true,
    work: 'writer texts for 2 slots',
    ...extra,
  });

  describe('usagePayload', () => {
    it('names the step, the work, the model, the tokens with their total, and the attempt', () => {
      expect(usagePayload('write', call({ cached_tokens: 10 }), 2)).toEqual({
        step: 'write',
        work: 'writer texts for 2 slots',
        model: 'gpt-5.1',
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cached_tokens: 10,
        estimated: false,
        latency_ms: 80,
        attempt: 2,
        ok: true,
      });
    });

    it('gives a speech-to-text call its audio seconds and no tokens', () => {
      const row = usagePayload('transcribe', call({ model: 'scribe_v2', input_tokens: 0, output_tokens: 0, audio_seconds: 118, work: 'speech to text 118 s' }));

      expect(row).toEqual({
        step: 'transcribe',
        work: 'speech to text 118 s',
        model: 'scribe_v2',
        audio_seconds: 118,
        estimated: false,
        latency_ms: 80,
        ok: true,
      });
    });

    it('labels a call that names no work by its step', () => {
      expect(usagePayload('perceive', call({ work: undefined })).work).toBe('perceive call');
    });
  });

  describe('addUsage', () => {
    it('sums the calls by step and by model, counts the estimated ones, and does not change the ledger it is given', () => {
      const first = addUsage(undefined, [
        usagePayload('write', call()),
        usagePayload('perceive', call({ model: 'clef', input_tokens: 40, output_tokens: 4, estimated: true })),
      ]);
      const frozen = JSON.stringify(first);

      const second = addUsage(first, [
        usagePayload('perceive', call({ model: 'clef', input_tokens: 60, output_tokens: 6, estimated: true })),
        usagePayload('transcribe', call({ model: 'scribe_v2', input_tokens: 0, output_tokens: 0, audio_seconds: 30 })),
      ]);

      expect(JSON.stringify(first)).toBe(frozen);
      expect(second).toEqual({
        calls: 4,
        total_input_tokens: 200,
        total_output_tokens: 30,
        total_audio_seconds: 30,
        estimated_calls: 2,
        by_step: {
          write: { calls: 1, input_tokens: 100, output_tokens: 20 },
          perceive: { calls: 2, input_tokens: 100, output_tokens: 10 },
          transcribe: { calls: 1, input_tokens: 0, output_tokens: 0, audio_seconds: 30 },
        },
        by_model: {
          'gpt-5.1': { calls: 1, input_tokens: 100, output_tokens: 20 },
          clef: { calls: 2, input_tokens: 100, output_tokens: 10 },
          scribe_v2: { calls: 1, input_tokens: 0, output_tokens: 0, audio_seconds: 30 },
        },
      });
    });

    it('counts a failed call too, and adds no audio or estimate keys when there are none', () => {
      const ledger = addUsage(undefined, [usagePayload('write', call({ ok: false, input_tokens: 90, output_tokens: 0 }))]);

      expect(ledger).toEqual({
        calls: 1,
        total_input_tokens: 90,
        total_output_tokens: 0,
        by_step: { write: { calls: 1, input_tokens: 90, output_tokens: 0 } },
        by_model: { 'gpt-5.1': { calls: 1, input_tokens: 90, output_tokens: 0 } },
      });
    });
  });

  describe('usageOfLog', () => {
    it('reads the ledger back from a stored log', () => {
      const ledger = addUsage(undefined, [usagePayload('write', call()), usagePayload('transcribe', call({ audio_seconds: 5, model: 's' }))]);

      expect(usageOfLog({ warnings: [], usage: JSON.parse(JSON.stringify(ledger)) })).toEqual(ledger);
    });

    it('answers nothing for a log without a ledger or with one that holds nothing usable', () => {
      expect(usageOfLog(null)).toBeUndefined();
      expect(usageOfLog({ warnings: [] })).toBeUndefined();
      expect(usageOfLog({ usage: 'x' })).toBeUndefined();
      expect(usageOfLog({ usage: { calls: 0 } })).toBeUndefined();
      expect(usageOfLog([])).toBeUndefined();
    });

    it('ignores numbers in the stored ledger that are not plain counts', () => {
      const read = usageOfLog({ usage: { calls: 2, total_input_tokens: 'x', total_output_tokens: -5, by_step: { write: { calls: 2, input_tokens: null } } } });

      expect(read).toMatchObject({ calls: 2, total_input_tokens: 0, total_output_tokens: 0, by_step: { write: { calls: 2, input_tokens: 0, output_tokens: 0 } } });
    });
  });
});

// TS11: the decision that says why a video got the icons it got.
describe('ai.video-editing: iconsTrace', () => {
  const f = GOLDEN_FIXTURES[0];
  const planned = planAndValidate({
    sessionId: 's1',
    level: 'heavy',
    request: goldenRequest(f),
    words: toEditWords(f.words),
    palette: MULTI_PALETTE,
  });
  // a 3-minute Heavy plan with two icons, and an assembler that could not place three more, for two reasons
  const icon = { ...planned.plan.items[0], layer: 'icon' as const };
  const result = {
    ...planned,
    plan: { ...planned.plan, level: 'heavy' as const, video: { output_duration_ms: 3 * 60_000 }, items: [icon, icon] },
    planner: { ...planned.planner!, icon_misses: { icon_budget: 1, clip_too_long_for_slot: 2 } },
  };
  const written = { icon_queries: { s1: 'synthetic scene one', s2: 'synthetic scene two', s3: 'synthetic scene three' } };

  it('holds the budget, the counts and the misses by code, on the plan step', () => {
    expect(iconsTrace(result, written, 6, 4)).toEqual({
      step: 'plan',
      kind: 'decision',
      payload: {
        decision: 'icons',
        budget: 12,
        written_queries: 3,
        searched: 6,
        found: 4,
        placed: 2,
        misses: { icon_budget: 1, clip_too_long_for_slot: 2, no_icon_for_slot: 2 },
      },
    });
  });

  it('counts a writer that did not run as no queries, and notes no search miss when every search found a file', () => {
    const row = iconsTrace(result, undefined, 4, 4).payload as any;
    expect(row.written_queries).toBe(0);
    expect(row.misses).not.toHaveProperty('no_icon_for_slot');
  });

  it('holds no query text', () => {
    const json = JSON.stringify(iconsTrace(result, written, 6, 4));
    expect(json).not.toContain('synthetic');
  });
});
