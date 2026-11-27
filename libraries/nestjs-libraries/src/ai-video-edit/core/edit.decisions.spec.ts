// AI video editing (ai.video-editing), tracing card L3: the planner core returns its decisions as data. Every candidate
// slot of the golden plans has exactly one decision, the structure says why spans, cuts and slots exist, and the
// validator says what each repair changed. Needs no database and no Nest; the existing goldens stay unchanged.
import { EDIT_LEVELS, EditLevel, Plan } from '../contract/edit.contract';
import { AssembleInput, assemble } from './edit.assembler';
import { SlotDropCode } from './edit.decisions';
import { PlanEditInput, planAndValidate, planEdit } from './edit.pipeline';
import { Slot } from './edit.slots';
import { validatePlan } from './edit.validator';
import { toEditWords } from './edit.words';
import {
  ALL_OUTPUTS,
  FULL_CAPABILITIES,
  GOLDEN_FIXTURES,
  GoldenFixture,
  MULTI_PALETTE,
  goldenRequest,
} from './fixtures/edit.golden.fixtures';

const DROP_CODES: SlotDropCode[] = [
  'level_limit',
  'overlap',
  'budget',
  'low_score',
  'no_zone',
  'facecam_collision',
  'text_too_long',
  'no_asset',
];

const levelInput = (f: GoldenFixture, level: EditLevel): PlanEditInput => ({
  sessionId: 'decisions',
  level,
  request: goldenRequest(f),
  words: toEditWords(f.words),
  palette: MULTI_PALETTE,
});

const isFeature = (i: Plan['items'][number]) => i.layer !== 'transition' && i.layer !== 'caption';

describe('ai.video-editing: planner decisions, structure', () => {
  const f = GOLDEN_FIXTURES[0];
  const result = planAndValidate(levelInput(f, 'standard'));
  const structure = result.planner!.structure;

  it('names the busy stretches of the activity map behind each protected span', () => {
    expect(structure.protected_spans.length).toBeGreaterThan(0);
    for (const span of structure.protected_spans) {
      expect(span.activities.length).toBeGreaterThan(0);
      for (const a of span.activities) {
        expect(['brush', 'motion']).toContain(a.type);
        expect(a.start_ms - 300).toBeLessThanOrEqual(span.end_ms);
        expect(a.end_ms + 300).toBeGreaterThanOrEqual(span.start_ms);
      }
    }
    const activityIds = goldenRequest(f)
      .activity_map.filter((a) => a.type === 'brush' || a.type === 'motion')
      .map((a) => a.id)
      .sort();
    expect(structure.protected_spans.flatMap((s) => s.activities.map((a) => a.id)).sort()).toEqual(activityIds);
  });

  it('gives every silence cut its length, the threshold and where it lies', () => {
    expect(structure.cuts.length).toBe(result.plan.structure.cuts.length);
    expect(structure.cuts.length).toBeGreaterThan(0);
    structure.cuts.forEach((c, k) => {
      const planned = result.plan.structure.cuts[k];
      expect([c.src_start_ms, c.src_end_ms]).toEqual([planned.src_start_ms, planned.src_end_ms]);
      expect(c.silence_ms).toBe(c.src_end_ms - c.src_start_ms);
      expect(c.silence_ms).toBeGreaterThanOrEqual(200);
      expect(c.threshold_ms).toBe(600);
      expect(['lead_in', 'gap', 'tail']).toContain(c.where);
    });
  });

  it('lists the output length, the windows the validator uses and one candidate per slot', () => {
    const { context } = planEdit(levelInput(f, 'standard'));
    expect(structure.output_duration_ms).toBe(result.plan.video.output_duration_ms);
    expect(structure.source_duration_ms).toBe(context.source_duration_ms);
    expect(structure.windows).toEqual(context.windows);
    expect(structure.slots.filter((s) => s.kind === 'hook').length).toBeLessThanOrEqual(1);
    for (const slot of structure.slots) {
      expect(slot.why.length).toBeGreaterThan(0);
      expect(slot.window_span).toEqual(structure.windows[slot.window]);
      expect(slot.kind === 'hook').toBe(slot.why.includes('hook'));
      // the transcript's words are not in the decisions
      expect(Object.keys(slot).sort()).toEqual(
        ['end_ms', 'kind', 'score', 'slot_id', 'start_ms', 'why', 'window', 'window_span', 'word_index'].sort()
      );
    }
  });
});

describe('ai.video-editing: planner decisions, assembler, golden plans', () => {
  for (const f of GOLDEN_FIXTURES) {
    for (const level of EDIT_LEVELS) {
      it(`${f.name}, ${level}: one decision per slot, and the kept ones are the plan's feature items`, () => {
        const result = planAndValidate(levelInput(f, level));
        const { structure, assemble: decisions } = result.planner!;
        expect(decisions.map((d) => d.slot_id)).toEqual(structure.slots.map((s) => s.slot_id));
        expect(new Set(decisions.map((d) => d.slot_id)).size).toBe(decisions.length);
        const kept = decisions.filter((d) => d.decision === 'kept');
        for (const d of decisions) {
          if (d.decision === 'dropped') {
            expect(DROP_CODES).toContain(d.reason_code);
          } else {
            expect(['hook', 'placed']).toContain(d.reason_code);
          }
          expect(d.inputs.score).toBeDefined();
        }
        // the goldens have no rejection, so every kept slot is an item of the plan under the id the decision names
        expect(result.rejections).toEqual([]);
        expect(kept.length).toBe(result.plan.items.filter(isFeature).length);
        for (const d of kept) {
          const item = result.plan.items.find((i) => i.id === d.inputs.item_id);
          expect(item).toBeDefined();
          expect(item!.effect).toBe(d.inputs.effect_id);
        }
        expect(kept.filter((d) => d.reason_code === 'hook').length).toBeLessThanOrEqual(1);
      });
    }
  }

  it('answers the same decisions every time', () => {
    const f = GOLDEN_FIXTURES[0];
    expect(planAndValidate(levelInput(f, 'heavy')).planner).toEqual(planAndValidate(levelInput(f, 'heavy')).planner);
  });
});

// The assembler on hand-built slots in one long window (the same shape as the assembler's own spec).
describe('ai.video-editing: planner decisions, assembler reason codes', () => {
  const WORDS = Array.from({ length: 50 }, (_, i) => ({ i, w: `word${i}`, start_ms: 100 + 400 * i, end_ms: 400 + 400 * i }));
  const slot = (id: string, wi: number, score: number, keyword: string, hook = false): Slot => ({
    id,
    word_index: wi,
    start_ms: WORDS[wi].start_ms,
    end_ms: WORDS[wi].end_ms,
    window: 0,
    reasons: hook ? ['hook'] : ['long_word'],
    score,
    keyword,
  });
  const SLOTS = [slot('h1', 2, 0, 'alpha', true), slot('s1', 12, 3, 'beta'), slot('s2', 25, 2, 'gamma'), slot('s3', 38, 1, 'delta')];
  const input = (level: EditLevel, extra: Partial<AssembleInput> = {}): AssembleInput => ({
    level,
    words: WORDS,
    windows: [{ start_ms: 0, end_ms: 20000 }],
    slots: SLOTS,
    outputs: [ALL_OUTPUTS[0]],
    facecam: [],
    durationMs: 20000,
    ...extra,
  });
  const byId = (level: EditLevel, extra: Partial<AssembleInput> = {}) => {
    const { decisions, items } = assemble(input(level, extra));
    return { decisions: Object.fromEntries(decisions!.map((d) => [d.slot_id, d])), items };
  };
  // only text effects, so a slot that cannot take a text has nowhere else to go
  const TEXT_ONLY = { effects: ['x_sticker', 'x_label_tag', 'c_word_highlight'], text_styles: FULL_CAPABILITIES.text_styles };

  it('keeps the hook and two slots of Basic and drops the fourth for the level limit', () => {
    const { decisions, items } = byId('basic');
    expect(decisions.h1).toMatchObject({ decision: 'kept', reason_code: 'hook', inputs: { item_id: 'e1', effect_id: 'x_sticker' } });
    expect(decisions.s1).toMatchObject({ decision: 'kept', reason_code: 'placed', inputs: { item_id: 'e2', effect_id: 'x_label_tag', family: 'text' } });
    expect(decisions.s2).toMatchObject({ decision: 'kept', reason_code: 'placed', inputs: { item_id: 'e3', effect_id: 'v_punch_in', family: 'camera' } });
    expect(decisions.s3).toMatchObject({
      decision: 'dropped',
      reason_code: 'level_limit',
      inputs: { feature_effects: 3, max_feature_effects: 3 },
    });
    expect(items).toHaveLength(3);
  });

  it('drops a slot perception gave no family as low_score', () => {
    const { decisions } = byId('standard', { scores: { family: { s1: 'none' } } });
    expect(decisions.s1).toMatchObject({ decision: 'dropped', reason_code: 'low_score' });
    expect(decisions.s2.decision).toBe('kept');
  });

  it('records the family a slot was meant for and the one it got when a clip is too long for it', () => {
    const { decisions } = byId('heavy', {
      scores: { family: { s2: 'icon' } },
      assets: { icons: { s2: { asset_id: 'x', kind: 'icon_video', native_duration_ms: 9000 } } },
    });
    expect(decisions.s2.inputs.preferred).toBe('icon');
    expect(decisions.s2.inputs.family).not.toBe('icon');
  });

  it('says no_asset when the icon a slot asked for was not resolved and nothing else could take the slot', () => {
    const covered = { ...ALL_OUTPUTS[0], caption_band: { y0: 0, y1: 1 } };
    const { decisions } = byId('heavy', { outputs: [covered], capabilities: TEXT_ONLY, scores: { family: { s1: 'icon' } } });
    expect(decisions.s1).toMatchObject({ decision: 'dropped', reason_code: 'no_asset', inputs: { preferred: 'icon' } });
    const attempts = decisions.s1.inputs.attempts as { family: string; code: string }[];
    expect(attempts.map((a) => a.family)).toEqual(['icon', 'text', 'camera', 'look']);
    expect(attempts[1].code).toBe('no_zone');
  });

  it('says no_zone when no zone of any output takes the text and no other effect is allowed', () => {
    const covered = { ...ALL_OUTPUTS[0], caption_band: { y0: 0, y1: 1 } };
    const { decisions, items } = byId('basic', { outputs: [covered], capabilities: TEXT_ONLY });
    expect(items.filter(isFeature)).toEqual([]);
    expect(decisions.s1).toMatchObject({ decision: 'dropped', reason_code: 'no_zone' });
    const attempts = decisions.s1.inputs.attempts as { family: string; code: string }[];
    expect(attempts[0]).toMatchObject({ family: 'text', code: 'no_zone' });
  });

  it('says facecam_collision when a zone would fit but for the facecam circle', () => {
    const facecam = [{ t_ms: 0, cx: 0.5, cy: 0.3, radius: 2 }];
    const { decisions, items } = byId('basic', { facecam, capabilities: TEXT_ONLY });
    expect(items.filter(isFeature)).toEqual([]);
    expect(decisions.s1).toMatchObject({ decision: 'dropped', reason_code: 'facecam_collision' });
  });

  it('answers a decision for every slot even when nothing at all can be planned', () => {
    const { decisions } = byId('heavy', { capabilities: { effects: ['c_word_highlight', 't_jump_cut'], text_styles: [] } });
    expect(Object.keys(decisions).sort()).toEqual(['h1', 's1', 's2', 's3']);
    for (const d of Object.values(decisions)) expect(d.decision).toBe('dropped');
  });
});

describe('ai.video-editing: planner decisions, validator', () => {
  const f = GOLDEN_FIXTURES[0];
  const draft = () => planEdit(levelInput(f, 'standard'));

  it('answers one decision per log line, in the same order, and `rejections` keeps its shape', () => {
    const { plan, context } = draft();
    const first = plan.items.find((i) => i.component && i.component.type === 'styled_text')!;
    (first.component as { text: string }).text = 'one two three four five six';
    const result = validatePlan(plan, context);
    expect(result.rejections.length).toBeGreaterThan(0);
    expect(result.decisions!.map(({ changed, ...line }) => line)).toEqual(result.rejections);
    for (const r of result.rejections) {
      expect(Object.keys(r).sort()).toEqual(['action', 'code', 'effect', 'id', 'rule']);
    }
  });

  it('says what a repair changed, as before and after, without the text', () => {
    const { plan, context } = draft();
    const first = plan.items.find((i) => i.component && i.component.type === 'styled_text')!;
    (first.component as { text: string }).text = 'one two three four five six';
    const result = validatePlan(plan, context);
    const cut = result.decisions!.find((d) => d.code === 'text_truncated')!;
    expect(cut).toMatchObject({ id: first.id, rule: 13, action: 'repaired' });
    expect(cut.changed.text_words).toEqual([6, 4]);
    expect(JSON.stringify(cut)).not.toContain('three');
  });

  it('records a drop with its rule, item and an empty change', () => {
    const { plan, context } = draft();
    const target = plan.items[plan.items.length - 1];
    target.effect = 'x_nope';
    const result = validatePlan(plan, context);
    const dropped = result.decisions!.find((d) => d.code === 'unknown_effect')!;
    expect(dropped).toEqual({ id: target.id, effect: 'x_nope', rule: 1, code: 'unknown_effect', action: 'dropped', changed: {} });
  });

  it('records the new time of an item the validator moved to fit its window', () => {
    const { plan, context } = draft();
    const target = plan.items.find((i) => i.layer === 'video' && !i.anchor) ?? plan.items.find((i) => i.layer === 'video')!;
    const before = target.end_ms - target.start_ms;
    // past the end of the video and out of every window
    target.start_ms = context.windows[context.windows.length - 1].end_ms + 5000;
    target.end_ms = target.start_ms + before;
    delete target.anchor;
    const result = validatePlan(plan, context);
    const moved = result.decisions!.find((d) => d.id === target.id && d.rule === 3);
    expect(moved).toBeDefined();
    expect(moved!.changed.start_ms![0]).toBe(target.start_ms);
    expect(moved!.changed.start_ms![1]).not.toBe(target.start_ms);
  });

  it('answers no decision for a plan that needs no repair', () => {
    const { plan, context } = draft();
    const result = validatePlan(plan, context);
    expect(result.decisions).toEqual([]);
    expect(result.rejections).toEqual([]);
  });
});
