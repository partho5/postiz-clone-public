// AI video editing (ai.video-editing): golden plans. Three English and two Bengali fixture transcripts are planned at
// each level with the whole pure pipeline (protected spans, silence cuts, remap, slots, assembler) and must pass the
// validator with zero warnings and zero rejections (spec section 22). Needs no database and no Nest.
import { EDIT_LEVELS, EditLevel, LEVEL_RULES, Plan } from '../contract/edit.contract';
import { effectById } from '../contract/edit.registry';
import { SlotScores, SlotTexts } from './edit.assembler';
import { PlanEditInput, planAndValidate, planEdit } from './edit.pipeline';
import { titleCase } from './edit.geometry';
import { overlaps } from './edit.rules';
import { validatePlan } from './edit.validator';
import { toEditWords } from './edit.words';
import { LEGACY_TEXT_MOTIONS } from '../contract/edit.motions';
import {
  GOLDEN_FIXTURES,
  GoldenFixture,
  LEGACY_CAPABILITIES,
  MULTI_PALETTE,
  goldenRequest,
} from './fixtures/edit.golden.fixtures';

const levelInput = (f: GoldenFixture, level: EditLevel, extra: Partial<PlanEditInput> = {}): PlanEditInput => ({
  sessionId: 'golden',
  level,
  request: goldenRequest(f),
  words: toEditWords(f.words),
  palette: MULTI_PALETTE,
  ...extra,
});

// Perception that proposes a commentary phrase for every slot, and a writer that supplies a hook and phrases.
const slotIds = Array.from({ length: 40 }, (_, i) => `s${i + 1}`);
const PERCEPTION: { scores: SlotScores; texts: SlotTexts } = {
  scores: { commentary: Object.fromEntries(slotIds.map((id) => [id, 'did_you_know'])) },
  texts: {
    hook: 'Save hours every week',
    complementary: Object.fromEntries(slotIds.map((id) => [id, 'Save two hours'])),
  },
};

const isFeature = (i: Plan['items'][number]) => i.layer !== 'transition' && i.layer !== 'caption';

// What every valid plan of a level must satisfy, checked on the plan itself.
const checkPlan = (plan: Plan, f: GoldenFixture, level: EditLevel) => {
  const { context } = planEdit(levelInput(f, level));
  const rules = LEVEL_RULES[level];
  const items = plan.items;
  expect(items.filter(isFeature).length).toBeLessThanOrEqual(rules.max_feature_effects);
  expect(items.filter((i) => i.layer === 'icon').length).toBeLessThanOrEqual(rules.max_icons);
  expect(items.some((i) => isFeature(i) && i.start_ms < 3000)).toBe(true);
  expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  expect(items.map((i) => i.start_ms)).toEqual([...items.map((i) => i.start_ms)].sort((a, b) => a - b));
  for (const item of items) {
    expect(context.windows.some((w) => w.start_ms <= item.start_ms && item.end_ms <= w.end_ms)).toBe(true);
    expect(effectById(item.effect)).toBeDefined();
    if (item.anchor) {
      expect(item.start_ms).toBe(context.words[item.anchor.word_index].start_ms + item.anchor.offset_ms);
    }
    if (!rules.sounds) expect(item.sound).toBeUndefined();
    if (!rules.transitions) expect(item.layer).not.toBe('transition');
    if (item.component && item.component.type === 'styled_text') {
      expect(rules.text_kinds).toContain(item.component.kind);
      expect(item.component.text.trim().split(/\s+/).length).toBeLessThanOrEqual(4);
      expect(item.component.color_slot).toBeLessThan(plan.palette.colors.length);
    }
  }
  const overlays = items.filter((i) => i.layer === 'text' || i.layer === 'icon');
  for (let k = 0; k + 1 < overlays.length; k++) {
    expect(overlaps(overlays[k], overlays[k + 1])).toBe(false);
  }
  expect(plan.structure.cuts.some((c) => context.protected_src.some((p) => overlaps(p, { start_ms: c.src_start_ms, end_ms: c.src_end_ms })))).toBe(false);
  expect(plan.video.output_duration_ms).toBeLessThan(context.source_duration_ms);
  expect(plan.captions.emphasis_words.every((i) => !!context.words[i])).toBe(true);
};

describe('ai.video-editing: golden plans', () => {
  for (const f of GOLDEN_FIXTURES) {
    for (const level of EDIT_LEVELS) {
      it(`${f.name}, ${level}: no warning, no rejection, and every rule of the level holds`, () => {
        const { plan, context } = planEdit(levelInput(f, level));
        const result = validatePlan(plan, context);
        expect(result.warnings).toEqual([]);
        expect(result.rejections).toEqual([]);
        expect(result.plan.warnings).toEqual([]);
        expect(result.plan).toEqual(plan);
        checkPlan(result.plan, f, level);
      });
    }

    it(`${f.name}: plans the same every time`, () => {
      expect(planAndValidate(levelInput(f, 'heavy'))).toEqual(planAndValidate(levelInput(f, 'heavy')));
    });

    it(`${f.name}, heavy with perception scores and written texts: still no warning, no rejection`, () => {
      const input = levelInput(f, 'heavy', PERCEPTION);
      const result = planAndValidate(input);
      expect(result.warnings).toEqual([]);
      expect(result.rejections).toEqual([]);
      checkPlan(result.plan, f, 'heavy');
      const kinds = result.plan.items
        .filter((i) => i.component && i.component.type === 'styled_text')
        .map((i) => (i.component as { kind: string }).kind);
      expect(kinds).toContain('hook');
    });
  }

  for (const f of GOLDEN_FIXTURES) {
    for (const mood of ['excited', 'calm']) {
      it(`${f.name}, heavy, ${mood}: the motions of the mood pass the validator unchanged`, () => {
        const result = planAndValidate(levelInput(f, 'heavy', { scores: { ...PERCEPTION.scores, mood }, texts: PERCEPTION.texts }));
        expect(result.warnings).toEqual([]);
        expect(result.rejections).toEqual([]);
        checkPlan(result.plan, f, 'heavy');
        const texts = result.plan.items.filter((i) => i.layer === 'text');
        expect(texts.some((i) => i.params.hold !== undefined || i.params.exit !== undefined)).toBe(true);
        if (mood === 'excited') {
          for (const i of texts) expect([i.params.entry, i.params.exit]).not.toContain('fade');
        }
      });
    }

    it(`${f.name}: a phone that listed no motions gets the legacy five only, and still passes the validator unchanged`, () => {
      for (const level of EDIT_LEVELS) {
        const request = { ...goldenRequest(f), capabilities: LEGACY_CAPABILITIES };
        const result = planAndValidate({ ...levelInput(f, level, { scores: { mood: 'calm' } }), request });
        expect(result.rejections).toEqual([]);
        for (const i of result.plan.items.filter((x) => x.layer === 'text')) {
          expect(LEGACY_TEXT_MOTIONS).toContain(i.params.entry);
          expect(i.params).not.toHaveProperty('hold');
          expect(i.params).not.toHaveProperty('exit');
        }
      }
    });
  }

  it('basic is keyword echoes in sticker or label pill, a punch in and caption emphasis, nothing else', () => {
    for (const f of GOLDEN_FIXTURES) {
      const { plan } = planAndValidate(levelInput(f, 'basic'));
      for (const item of plan.items) {
        expect(['x_sticker', 'x_label_tag', 'v_punch_in']).toContain(item.effect);
        if (item.component && item.component.type === 'styled_text') {
          expect(['hook', 'keyword_echo']).toContain(item.component.kind);
          expect(['sticker', 'label_pill']).toContain(item.component.style_preset);
        }
      }
      expect(plan.captions.emphasis_words.length).toBeGreaterThan(0);
    }
  });

  it('writes Bengali keywords as they are and English ones in Title Case', () => {
    const texts = (f: GoldenFixture) =>
      planAndValidate(levelInput(f, 'standard')).plan.items
        .filter((i) => i.component && i.component.type === 'styled_text')
        .map((i) => (i.component as { text: string }).text);
    for (const t of texts(GOLDEN_FIXTURES[0])) {
      expect(t).toBe(titleCase(t, 'en'));
      expect(t).not.toBe(t.toUpperCase());
    }
    const bengali = texts(GOLDEN_FIXTURES[3]);
    expect(bengali.length).toBeGreaterThan(0);
    for (const t of bengali) expect(/[ঀ-৿]/.test(t)).toBe(true);
  });

  it('plans no effect for a phone that renders only captions and cuts, and says so in one warning', () => {
    const f = GOLDEN_FIXTURES[0];
    const request = { ...goldenRequest(f), capabilities: { effects: ['c_word_highlight', 't_jump_cut'], text_styles: [] } };
    const result = planAndValidate({ ...levelInput(f, 'standard'), request });
    expect(result.plan.items).toEqual([]);
    expect(result.rejections).toEqual([]);
    expect(result.warnings).toEqual(['hook_missing']);
    expect(result.plan.structure.cuts.length).toBeGreaterThan(0);
  });

  it('cuts silences and never inside a brush stroke', () => {
    const f = GOLDEN_FIXTURES[0];
    const { plan, context } = planEdit(levelInput(f, 'basic'));
    expect(plan.structure.cuts.length).toBeGreaterThan(0);
    expect(context.protected_src.length).toBeGreaterThan(0);
    expect(plan.structure.cuts.every((c) => c.reason === 'silence')).toBe(true);
  });
});
