// AI video editing (ai.video-editing, L5): the golden replay. A `full` trace bundle holds the planner's inputs
// (`structure/input`); planning again from them gives the plan that was delivered. A `meta` bundle, a cut-off row and a bundle
// without a plan are refused with a code. Needs no database and no Nest.
import { EDIT_LEVELS, EditLevel } from '../contract/edit.contract';
import { SlotScores, SlotTexts } from './edit.assembler';
import { PlanEditInput, planAndValidate } from './edit.pipeline';
import { ReplayError, firstDifference, replayBundle, replayInput } from './edit.replay';
import { toEditWords } from './edit.words';
import { GOLDEN_FIXTURES, GoldenFixture, MULTI_PALETTE, goldenRequest } from './fixtures/edit.golden.fixtures';
import { plannerInputTrace } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.helpers';
import { traceRow } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.service';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.repository',
  () => ({ AiVideoEditTraceRepository: class {} })
);

const BIG = 100 * 1024 * 1024;

// Perception that proposes a commentary phrase for every slot, and a writer that supplies a hook and phrases.
const slotIds = Array.from({ length: 40 }, (_, i) => `s${i + 1}`);
const PERCEPTION: { scores: SlotScores; texts: SlotTexts } = {
  scores: { commentary: Object.fromEntries(slotIds.map((id) => [id, 'did_you_know'])) },
  texts: {
    hook: 'Save hours every week',
    complementary: Object.fromEntries(slotIds.map((id) => [id, 'Save two hours'])),
  },
};

const inputOf = (f: GoldenFixture, level: EditLevel, extra: Partial<PlanEditInput> = {}): PlanEditInput => ({
  sessionId: 'golden',
  level,
  request: goldenRequest(f),
  words: toEditWords(f.words),
  palette: MULTI_PALETTE,
  ...extra,
});

// The `structure/input` row as the trace stores it in a mode (redacted JSON, as the database gives it back).
const inputRow = (input: PlanEditInput, mode: 'meta' | 'full', maxBytes = BIG) => ({
  seq: 1,
  step: 'structure',
  kind: 'input',
  payload: JSON.parse(JSON.stringify(traceRow({ editId: 'e1', ...(plannerInputTrace(input).payload as object) }, mode, maxBytes).payload)),
});

// A bundle of a plan made from `input`: its input row and the body that was delivered.
const bundleOf = (input: PlanEditInput, mode: 'meta' | 'full' = 'full') => {
  const plan = planAndValidate(input).plan;
  return {
    edit: { sessionId: input.sessionId, level: input.level },
    steps: [inputRow(input, mode)],
    delivered: JSON.parse(JSON.stringify({ id: 'e1', status: 'READY', cost: 1, plan, assets: [] })),
  };
};

describe('ai.video-editing: golden replay', () => {
  for (const f of GOLDEN_FIXTURES) {
    for (const level of EDIT_LEVELS) {
      it(`${f.name}, ${level}: planning again from the traced inputs gives the delivered plan`, () => {
        const result = replayBundle(bundleOf(inputOf(f, level)));
        expect(result.difference).toBeUndefined();
        expect(result.equal).toBe(true);
      });
    }

    it(`${f.name}, heavy with perception scores and written texts: the replay equals the delivered plan`, () => {
      const result = replayBundle(bundleOf(inputOf(f, 'heavy', { ...PERCEPTION, bannedWords: ['forbidden'] })));
      expect(result.equal).toBe(true);
    });
  }

  it('reads the planner inputs back from the row, as they were passed', () => {
    const input = inputOf(GOLDEN_FIXTURES[0], 'heavy', { ...PERCEPTION, bannedWords: ['forbidden'] });

    const back = replayInput(bundleOf(input));

    expect(back).toEqual(JSON.parse(JSON.stringify(input)));
  });

  it('says where the plans differ when the delivered plan is not what the inputs make', () => {
    const bundle = bundleOf(inputOf(GOLDEN_FIXTURES[0], 'heavy'));
    bundle.delivered.plan.items[0].start_ms += 1;

    const result = replayBundle(bundle);

    expect(result.equal).toBe(false);
    expect(result.difference).toBe('$.items[0].start_ms');
  });

  it('flags a difference as possibly the redaction\'s when the traced input holds the redaction marker', () => {
    const bundle = bundleOf(inputOf(GOLDEN_FIXTURES[0], 'heavy'));
    bundle.delivered.plan.items[0].start_ms += 1;
    expect(replayBundle(bundle).reason).toBeUndefined();

    (bundle.steps[0].payload as any).banned_words = ['https://x.test/a?[redacted]'];
    const flagged = replayBundle(bundle);

    expect(flagged.equal).toBe(false);
    expect(flagged.reason).toBe('redacted_input_possible');
  });

  it('does not flag a replay that equals the delivered plan, whatever the input holds', () => {
    const bundle = bundleOf(inputOf(GOLDEN_FIXTURES[0], 'basic'));
    (bundle.steps[0].payload as any).banned_words = ['[redacted]'];

    expect(replayBundle(bundle).reason).toBeUndefined();
  });

  it('uses the last `structure/input` row (a retried step traces it again)', () => {
    const f = GOLDEN_FIXTURES[1];
    const bundle = bundleOf(inputOf(f, 'standard'));
    bundle.steps.unshift(inputRow(inputOf(f, 'basic'), 'full'));
    bundle.steps[0].seq = 0;

    expect(replayInput(bundle).level).toBe('standard');
    expect(replayBundle(bundle).equal).toBe(true);
  });

  it('compares with the plan of the `deliver/output` row when the bundle has no served body', () => {
    const bundle = bundleOf(inputOf(GOLDEN_FIXTURES[0], 'basic'));
    const traced = { seq: 2, step: 'deliver', kind: 'output', payload: { delivered: bundle.delivered } };

    expect(replayBundle({ edit: bundle.edit, steps: [...bundle.steps, traced] }).equal).toBe(true);
  });

  it('refuses a `meta` bundle: it keeps counts, not the words', () => {
    const bundle = bundleOf(inputOf(GOLDEN_FIXTURES[0], 'heavy'), 'meta');

    expect(() => replayBundle(bundle)).toThrow(ReplayError);
    expect(() => replayBundle(bundle)).toThrow('needs_full_trace');
  });

  it('refuses an input row that was over the size cap', () => {
    const input = inputOf(GOLDEN_FIXTURES[0], 'heavy');
    const bundle = { ...bundleOf(input), steps: [inputRow(input, 'full', 100)] };

    expect(() => replayBundle(bundle)).toThrow('input_truncated');
  });

  it('refuses a bundle without the input row or without a delivered plan', () => {
    const bundle = bundleOf(inputOf(GOLDEN_FIXTURES[0], 'heavy'));

    expect(() => replayBundle({ ...bundle, steps: [] })).toThrow('no_structure_input');
    expect(() => replayBundle({ ...bundle, delivered: null })).toThrow('no_delivered_plan');
  });

  it('finds the first difference of two JSON values', () => {
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeUndefined();
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe('$.a[1].b');
    expect(firstDifference({ a: [1] }, { a: [1, 2] })).toBe('$.a[1]');
    expect(firstDifference({ a: 1 }, { b: 1 })).toBe('$.a');
  });
});
