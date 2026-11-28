// AI video editing (ai.video-editing): golden plans. Three English and two Bengali fixture transcripts are planned at
// each level with the whole pure pipeline (protected spans, silence cuts, remap, slots, assembler) and must pass the
// validator with zero warnings and zero rejections (spec section 22). Needs no database and no Nest.
import { EDIT_LEVELS, EditLevel, EditWord, LEVEL_RULES, Plan } from '../contract/edit.contract';
import { effectById } from '../contract/edit.registry';
import { SlotScores, SlotTexts } from './edit.assembler';
import { Direction, SENTENCE_END, applyLabels, buildMoments, sentenceMoments } from './edit.moments';
import { PlanEditInput, perceptionTargets, planAndValidate, planEdit } from './edit.pipeline';
import { titleCase } from './edit.geometry';
import { budgetFor, overlaps } from './edit.rules';
import { validatePlan } from './edit.validator';
import { buildMap, mapInstant, mapInterval } from './edit.timeline';
import { toEditWords } from './edit.words';
import { LEGACY_TEXT_MOTIONS } from '../contract/edit.motions';
import {
  GOLDEN_FIXTURES,
  GoldenFixture,
  LEGACY_CAPABILITIES,
  MULTI_PALETTE,
  TRUST_DIRECTOR_ANSWER,
  TRUST_PICKS,
  TRUST_SAMPLE,
  TRUST_SENTENCE_ENDS,
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

  it('basic is keyword echoes in tilted sticker or label pill (every text has a background), a punch in and caption emphasis, nothing else', () => {
    for (const f of GOLDEN_FIXTURES) {
      const { plan } = planAndValidate(levelInput(f, 'basic'));
      for (const item of plan.items) {
        expect(['x_sticker', 'x_label_tag', 'v_punch_in']).toContain(item.effect);
        if (item.component && item.component.type === 'styled_text') {
          expect(['hook', 'keyword_echo']).toContain(item.component.kind);
          expect(['tilt_sticker', 'label_pill']).toContain(item.component.style_preset);
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

describe('ai.video-editing: golden plans with a direction (task TS6a)', () => {
  const none: Direction = { style: 'calm', source: 'none', moments: [] };
  const calm: Direction = { style: 'calm', source: 'director', moments: [] };

  for (const f of GOLDEN_FIXTURES) {
    it(`${f.name}: no direction, a null one and a \`source: none\` one plan the same items at every level`, () => {
      for (const level of EDIT_LEVELS) {
        const plain = planEdit(levelInput(f, level, PERCEPTION)).plan;
        expect(planEdit(levelInput(f, level, { ...PERCEPTION, direction: null })).plan).toEqual(plain);
        expect(planEdit(levelInput(f, level, { ...PERCEPTION, direction: none })).plan).toEqual(plain);
      }
    });

    it(`${f.name}, heavy and calm: at most half the budget, no cut transition, nothing lively-only`, () => {
      const { plan, decisions } = planEdit(levelInput(f, 'heavy', { direction: calm, scores: { picks: { cut: 'tr_whip' } } }));
      expect(plan.items.filter(isFeature).length).toBeLessThanOrEqual(Math.ceil(LEVEL_RULES.heavy.max_feature_effects / 2));
      expect(plan.items.some((i) => i.layer === 'transition')).toBe(false);
      expect(plan.items.every((i) => (effectById(i.effect).styles ?? ['calm']).includes('calm'))).toBe(true);
      expect(decisions!.direction).toMatchObject({ style: 'calm', cut_transitions: { code: 'style_calm', placed: 0 } });
    });
  }

  it('names the face and screen items of a drawing in the validation context, so the validator keeps them together (task TS9b)', () => {
    const f = GOLDEN_FIXTURES[0];
    const drawing: Direction = {
      style: 'calm',
      source: 'director',
      moments: [{ id: 'd1', kind: 'drawing', start_ms: 9000, end_ms: 12500, region: { x: 0.1, y: 0.5, w: 0.2, h: 0.2 }, label: 'drawing' }],
    };
    const picks = { 'd1:face': 'f_step_aside', 'd1:screen': 'v_spotlight' };
    const { plan, context } = planEdit(levelInput(f, 'heavy', { direction: drawing, scores: { picks } }));
    const face = plan.items.find((i) => i.effect === 'f_step_aside')!;
    const screen = plan.items.find((i) => i.effect === 'v_spotlight')!;
    expect(face).toBeDefined();
    expect(screen).toBeDefined();
    expect(context.drawing_pairs).toHaveLength(1);
    expect([...context.drawing_pairs![0]].sort()).toEqual([face.id, screen.id].sort());
    expect(validatePlan(plan, context).rejections).toEqual([]);
    // without the pair, rule 18 moves or drops the later of the two first
    const alone = validatePlan(plan, { ...context, drawing_pairs: undefined });
    expect(alone.rejections.filter((r) => r.rule === 18).map((r) => r.id)[0]).toBe(screen.id);
    // a plan without a direction names no pair
    expect(planEdit(levelInput(f, 'heavy')).context.drawing_pairs).toEqual([]);
  });
});

// The sample of the owner's video (task TS8): 122 synthetic words at its timings, its event log, a calm director and four picks,
// planned with the whole pure pipeline. What the card expects is asserted here once, on the final behaviour of TS1 to TS9d.
describe('ai.video-editing: golden plan on the trust sample (task TS8)', () => {
  const sample = TRUST_SAMPLE;
  const sampleRequest = goldenRequest(sample);
  const sampleWords = toEditWords(sample.words);

  // The direction as the service keeps it: moments on the source timeline (an identity map), the director's labels laid on them.
  const sampleDirection = (): Direction => ({
    style: TRUST_DIRECTOR_ANSWER.style,
    source: 'director',
    moments: applyLabels(
      buildMoments(sampleWords, sampleRequest.activity_map, sampleRequest.chapters, buildMap(sampleRequest.video.duration_ms, [])),
      TRUST_DIRECTOR_ANSWER
    ),
  });

  // Perception and the writer as the goldens above have them, plus a resolved icon for every slot and the fixed picks.
  const iconIds = Array.from({ length: 120 }, (_, i) => `s${i + 1}`);
  const trustInput = (level: EditLevel): PlanEditInput =>
    levelInput(sample, level, {
      direction: sampleDirection(),
      scores: { ...PERCEPTION.scores, picks: TRUST_PICKS },
      texts: PERCEPTION.texts,
      assets: {
        icons: Object.fromEntries(iconIds.map((id) => [id, { asset_id: 'ic1', kind: 'icon_video' as const, native_duration_ms: 2000 }])),
      },
    });

  const planned = planEdit(trustInput('heavy'));
  const validated = validatePlan(planned.plan, planned.context);
  const items = validated.plan.items;
  const only = (effect: string) => items.filter((i) => i.effect === effect);
  // the plan's own cut map: where the source instants of the event log land on the output
  const map = buildMap(sampleRequest.video.duration_ms, planned.plan.structure.cuts);

  // The drop codes of the TS9 hygiene rules (breathing gap, flash spacing, content keep-out); no other drop is expected.
  const HYGIENE_DROPS = ['breathing_gap', 'flash_spacing', 'content_collision'];
  const dropCodes = (level: EditLevel) => {
    const { plan, context } = planEdit(trustInput(level));
    return validatePlan(plan, context).rejections.filter((r) => r.action === 'dropped').map((r) => r.code);
  };

  it('has 122 synthetic words at the sample timings and 9 sentences, and keeps no real text', () => {
    expect(sample.words).toHaveLength(122);
    expect([sample.words[0].startMs, sample.words[121].endMs]).toEqual([880, 66520]);
    sample.words.forEach((w, k) => expect(w.text).toBe(`w${k + 1}${TRUST_SENTENCE_ENDS.includes(k + 1) ? '.' : ''}`));
    const sentences = sentenceMoments(sampleWords);
    expect(sentences.map((m) => (m.word_to as number) + 1)).toEqual(TRUST_SENTENCE_ENDS);
    expect(sentences.map((m) => m.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
    expect(sampleRequest.video.duration_ms).toBe(67966);
    expect(sampleRequest.chapters!.map((c) => [c.start_ms, c.title])).toEqual([[0, 'T1'], [4785, 'T2'], [28012, 'T3'], [54977, 'T4']]);
  });

  it('labels the sentences as the director answered, finds the drawings and the topic changes on the source timeline', () => {
    const moments = sampleDirection().moments;
    const labels = Object.fromEntries(moments.filter((m) => m.kind === 'sentence').map((m) => [m.id, m.label]));
    expect(labels).toEqual({ s1: 'hook', s2: 'claim', s3: 'plain', s4: 'plain', s5: 'claim', s6: 'plain', s7: 'plain', s8: 'plain', s9: 'recap' });
    expect(moments.filter((m) => m.kind === 'drawing').map((m) => [m.id, m.start_ms, m.end_ms])).toEqual([
      ['d1', 9887, 10507],
      ['d2', 13908, 14350],
      ['d3', 45811, 46528],
      ['d4', 49511, 49877],
    ]);
    // the chapter at 0 is no topic change: the changes are c1 to c3
    expect(moments.filter((m) => m.kind === 'chapter').map((m) => [m.id, m.end_ms])).toEqual([['c1', 4785], ['c2', 28012], ['c3', 54977]]);
  });

  it('cuts silences on the source (never in a drawing) and plans the same every time', () => {
    expect(planned.plan.structure.cuts.length).toBeGreaterThan(0);
    expect(planned.plan.structure.cuts.every((c) => c.reason === 'silence')).toBe(true);
    expect(planned.plan.structure.cuts.some((c) => planned.context.protected_src.some((p) => overlaps(p, { start_ms: c.src_start_ms, end_ms: c.src_end_ms })))).toBe(false);
    expect(planEdit(trustInput('heavy')).plan).toEqual(planned.plan);
  });

  it('plans no whip, no flash cut and no look, and no cut transition: a calm video', () => {
    for (const item of items) {
      expect(['tr_whip', 'tr_flash_cut']).not.toContain(item.effect);
      expect(item.effect.startsWith('l_')).toBe(false);
      expect(effectById(item.effect).styles ?? ['calm']).toContain('calm');
    }
    expect(items.filter((i) => i.layer === 'transition').map((i) => i.effect)).toEqual(['tr_dip_color']);
    expect(planned.decisions!.direction).toMatchObject({
      style: 'calm',
      cut_transitions: { code: 'style_calm', placed: 0 },
      moments: { placed: 4, dropped: 0, unusable: 0 },
    });
  });

  it('steps the face aside and spotlights the first drawing from 400 ms before to 600 ms after it, on the output timeline', () => {
    // the silence cuts move the stroke: its place is the one the plan's own map gives, not its source time
    const stroke = mapInterval(map, 9887, 10507)!;
    expect(stroke.start_ms).not.toBe(9887);
    const [face] = only('f_step_aside');
    const [screen] = only('v_spotlight');
    expect(only('f_step_aside')).toHaveLength(1);
    expect(only('v_spotlight')).toHaveLength(1);
    for (const item of [face, screen]) {
      expect([item.start_ms, item.end_ms]).toEqual([stroke.start_ms - 400, stroke.end_ms + 600]);
    }
    // the pair is named to the validator and keeps its shared time
    expect(planned.context.drawing_pairs).toHaveLength(1);
    expect([...planned.context.drawing_pairs![0]].sort()).toEqual([face.id, screen.id].sort());
    expect(validated.rejections.filter((r) => r.rule === 18 && [face.id, screen.id].includes(r.id))).toEqual([]);
  });

  it('dips to colour centred on the second topic change, on the output timeline', () => {
    // 28012 ms lies in a silence cut: the change shows where the next piece starts
    const change = mapInstant(map, 28012);
    const [dip] = only('tr_dip_color');
    expect(only('tr_dip_color')).toHaveLength(1);
    expect(dip.layer).toBe('transition');
    expect(Math.abs((dip.start_ms + dip.end_ms) / 2 - change)).toBeLessThanOrEqual(1);
  });

  it('grows the face once, on the first claim, starting in a pause and clear of the drawing\'s step aside', () => {
    const [hero] = only('f_hero');
    expect(only('f_hero')).toHaveLength(1);
    // a pause: a word gap of 200 ms or more, or a sentence start; within 600 ms of one
    const words: EditWord[] = planned.context.words;
    const nearPause = words.some((w, k) => {
      const prev = words[k - 1];
      if (prev && !SENTENCE_END.test(prev.w.trim()) && w.start_ms - prev.end_ms < 200) return false;
      const from = prev && w.start_ms - prev.end_ms >= 200 ? prev.end_ms : w.start_ms;
      return hero.start_ms >= from - 600 && hero.start_ms <= w.start_ms + 600;
    });
    expect(nearPause).toBe(true);
    // the first claim is the second sentence: the face grows inside it, before the drawing
    const sentence = perceptionTargets(sampleRequest, sampleWords, sampleDirection()).direction!.moments.find((m) => m.id === 's2')!;
    expect(hero.start_ms).toBeLessThanOrEqual(sentence.start_ms);
    expect(hero.start_ms).toBeGreaterThan(sentence.start_ms - 1000);
    const [aside] = only('f_step_aside');
    expect(aside.start_ms - hero.end_ms).toBeGreaterThanOrEqual(1000);
    expect(validated.rejections.filter((r) => r.rule === 17)).toEqual([]);
  });

  it('keeps every item inside its effect\'s range: duration, number limits and enum values', () => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const entry = effectById(item.effect);
      expect(item.end_ms - item.start_ms).toBeGreaterThanOrEqual(entry.min_duration_ms);
      expect(item.end_ms - item.start_ms).toBeLessThanOrEqual(entry.max_duration_ms);
      for (const [key, [lo, hi]] of Object.entries(entry.param_limits)) {
        const v = item.params[key];
        if (typeof v === 'number') {
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(hi);
        }
      }
      for (const [key, values] of Object.entries(entry.param_enums || {})) {
        if (key in item.params) expect(values).toContain(item.params[key]);
      }
    }
  });

  it('has a validator log with no drop but the hygiene ones, no face move repair and no param repair', () => {
    for (const level of ['standard', 'heavy'] as EditLevel[]) {
      expect(dropCodes(level).filter((c) => !HYGIENE_DROPS.includes(c))).toEqual([]);
    }
    expect(validated.rejections.filter((r) => r.rule === 17)).toEqual([]);
    const codes = validated.rejections.map((r) => r.code);
    for (const code of ['face_move_mid_phrase', 'face_move_overlap', 'param_enum_reset', 'fill_color_reset', 'param_box_fixed']) {
      expect(codes).not.toContain(code);
    }
  });

  it('echoes no caption word (the request has a caption band): only a hook, a commentary or a complementary text', () => {
    expect(sampleRequest.outputs.every((o) => !!o.caption_band)).toBe(true);
    const texts = items.filter((i) => i.component && i.component.type === 'styled_text');
    for (const item of texts) {
      expect(['hook', 'commentary', 'complementary']).toContain((item.component as { kind: string }).kind);
    }
    expect(texts.filter((i) => (i.component as { kind: string }).kind === 'hook').length).toBeLessThanOrEqual(1);
  });

  it('shows at most the calm icons of the budget, on a claim, the labelled sentence that has an icon', () => {
    const icons = items.filter((i) => i.layer === 'icon');
    expect(icons.length).toBeLessThanOrEqual(budgetFor('heavy', planned.plan.video.output_duration_ms, 'calm').icons);
    const outDirection = perceptionTargets(sampleRequest, sampleWords, sampleDirection()).direction!;
    for (const icon of icons) {
      const at = icon.anchor!.word_index;
      const sentence = outDirection.moments.find((m) => m.kind === 'sentence' && at >= (m.word_from as number) && at <= (m.word_to as number))!;
      expect(sentence.label).toBe('claim');
    }
    const standard = planEdit(trustInput('standard'));
    expect(standard.plan.items.filter((i) => i.layer === 'icon').length).toBeLessThanOrEqual(
      budgetFor('standard', standard.plan.video.output_duration_ms, 'calm').icons
    );
  });

  it('keeps texts and icons off the ink of the four strokes (no slide title is given)', () => {
    expect(planned.context.keepouts).toHaveLength(4);
    expect(planned.context.keepouts!.map((k) => k.region)).toEqual(
      sample.activity.filter((a) => a.type === 'brush').map((a) => a.region)
    );
  });
});
