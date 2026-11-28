// AI video editing (ai.video-editing): perception questions and the reading of their answers (spec section 11,
// step 5). Needs no network, no database and no Nest.
import { toEditWords } from './edit.words';
import { goldenRequest, GOLDEN_FIXTURES, speak } from './fixtures/edit.golden.fixtures';
import {
  MAX_PICK_CANDIDATES,
  MAX_QUESTIONS,
  MAX_SLOTS_PER_PIECE,
  PICK_NONE,
  PICK_QUESTION,
  PickContext,
  PieceTarget,
  batches,
  candidatesFor,
  commentaryQuestions,
  mergePieces,
  pieceLength,
  pieceQuestions,
  pickQuestions,
  readPiece,
  targetsByPiece,
  withFallbackPicks,
} from './edit.perception';
import { Direction, Moment } from './edit.moments';
import { EFFECTS } from '../contract/edit.registry';
import { perceptionTargets, planAndValidate } from './edit.pipeline';
import { HOOK_SLOT_ID, Slot } from './edit.slots';
import { phrasesForMood } from '../contract/edit.phrases';

const FIXTURE = GOLDEN_FIXTURES[0];
const REQUEST = goldenRequest(FIXTURE);
const WORDS = toEditWords(FIXTURE.words);
const PALETTE = { mode: 'multi' as const, colors: ['#FF3B30', '#FFD60A'] };

const slot = (id: string, wordIndex: number, score = 1): Slot => ({
  id,
  word_index: wordIndex,
  start_ms: wordIndex * 1000,
  end_ms: wordIndex * 1000 + 400,
  window: 0,
  reasons: id === HOOK_SLOT_ID ? ['hook'] : ['rare_word'],
  score,
  keyword: `w${wordIndex}`,
});

const target = (id: string, wordIndex: number): PieceTarget => ({
  slot: slot(id, wordIndex),
  word: `w${wordIndex}`,
  atMs: wordIndex * 1000,
});

describe('ai.video-editing: perception', () => {
  describe('perceptionTargets', () => {
    it('gives the slots the planner uses, with the source start of every output word', () => {
      const { words, slots, sourceMs } = perceptionTargets(REQUEST, WORDS);

      expect(sourceMs).toHaveLength(words.length);
      expect(slots.length).toBeGreaterThan(0);
      for (const s of slots) {
        // the word index is an output index, and its source time is no earlier than its output time
        expect(words[s.word_index]).toBeDefined();
        expect(sourceMs[s.word_index]).toBeGreaterThanOrEqual(words[s.word_index].start_ms);
      }
    });
  });

  describe('perceptionTargets with a direction', () => {
    // 'there' to 'friend' is a pause of 800 ms inside one sentence
    const spoken = toEditWords(speak(['Hello', 'there', ['friend', 800], 'again']));
    const request = {
      ...REQUEST,
      activity_map: [],
      facecam_track: [],
      video: { ...REQUEST.video, duration_ms: 5000 },
    };
    const sentence: Moment = {
      id: 's1',
      kind: 'sentence',
      start_ms: 150,
      end_ms: 2495,
      word_from: 0,
      word_to: 3,
      label: 'plain',
    };
    const direct = (style: 'calm' | 'lively', source: 'director' | 'none' = 'director'): Direction => ({
      style,
      source,
      moments: [sentence],
    });

    it('keeps the pause inside a sentence in a calm video and cuts it as before otherwise', () => {
      const before = perceptionTargets(request, spoken).durationMs;
      expect(perceptionTargets(request, spoken, direct('calm')).durationMs).toBe(before + 560);
      expect(perceptionTargets(request, spoken, direct('lively')).durationMs).toBe(before);
      expect(perceptionTargets(request, spoken, direct('calm', 'none')).durationMs).toBe(before);
      expect(perceptionTargets(request, spoken, null).durationMs).toBe(before);
    });
  });

  describe('targetsByPiece', () => {
    it('puts each slot in the piece its word was spoken in, with the time inside the piece', () => {
      const words = [{ w: 'a' }, { w: 'b' }, { w: 'c' }];
      const slots = [slot('s1', 0), slot('s2', 1), slot('s3', 2)];
      // 100 s in two pieces of 50 s
      const pieces = targetsByPiece(slots, words, [10_000, 60_000, 99_000], 100_000, 2);

      expect(pieceLength(100_000, 2)).toBe(50_000);
      expect(pieces[0].map((t) => t.slot.id)).toEqual(['s1']);
      expect(pieces[1].map((t) => [t.slot.id, t.atMs])).toEqual([
        ['s2', 10_000],
        ['s3', 49_000],
      ]);
      expect(pieces[0][0]).toMatchObject({ word: 'a', atMs: 10_000 });
    });

    it('keeps the hook and the best scored slots when a piece has too many', () => {
      const words = Array.from({ length: 40 }, (_, k) => ({ w: `w${k}` }));
      const slots = [
        slot(HOOK_SLOT_ID, 0, 0),
        ...Array.from({ length: 39 }, (_, k) => slot(`s${k + 1}`, k + 1, k + 1)),
      ];
      const sourceMs = words.map((_, k) => k * 1000);

      const [piece] = targetsByPiece(slots, words, sourceMs, 50_000, 1);

      expect(piece).toHaveLength(MAX_SLOTS_PER_PIECE);
      expect(piece[0].slot.id).toBe(HOOK_SLOT_ID);
      expect(piece.some((t) => t.slot.id === 's39')).toBe(true);
      expect(piece.some((t) => t.slot.id === 's1')).toBe(false);
    });
  });

  describe('questions', () => {
    it('asks mood, energy, screen_busy, a noul per word and a choice of family per slot', () => {
      const questions = pieceQuestions([target('s1', 3), target('s2', 5)]);

      expect(questions.map((q) => q.id)).toEqual([
        'mood',
        'energy',
        'screen_busy',
        'emph_3',
        'emph_5',
        'fam_s1',
        'fam_s2',
      ]);
      expect(questions.map((q) => q.type)).toEqual([
        'choice',
        'score',
        'noul',
        'noul',
        'noul',
        'choice',
        'choice',
      ]);
      expect(Object.keys(questions[0].criteria!)).toEqual(
        expect.arrayContaining(['excited', 'serious', 'sad', 'funny', 'surprising', 'calm'])
      );
      expect(Object.keys(questions[5].criteria!)).toEqual(
        expect.arrayContaining(['text', 'camera', 'look', 'icon', 'none'])
      );
    });

    it('offers only the phrases of the mood and none, and skips the hook slot', () => {
      const questions = commentaryQuestions(
        [target(HOOK_SLOT_ID, 1), target('s1', 3)],
        'surprising'
      );

      expect(questions.map((q) => q.id)).toEqual(['comm_s1']);
      expect(Object.keys(questions[0].criteria!).sort()).toEqual(
        [...phrasesForMood('surprising').map((p) => p.id), 'none'].sort()
      );
      expect(commentaryQuestions([target('s1', 3)], undefined)).toEqual([]);
    });

    it('splits more than 64 questions into calls of at most 64, in order', () => {
      const targets = Array.from({ length: 40 }, (_, k) => target(`s${k + 1}`, k + 1));
      const questions = pieceQuestions(targets);

      const calls = batches(questions);

      // 3 for the piece, then a word and a family per slot
      expect(questions).toHaveLength(3 + 40 + 40);
      expect(calls.map((c) => c.length)).toEqual([
        MAX_QUESTIONS,
        questions.length - MAX_QUESTIONS,
      ]);
      expect(calls.flat()).toEqual(questions);
    });
  });

  describe('answers', () => {
    it('reads valid answers and ignores invalid ones', () => {
      const scores = readPiece({
        mood: 'funny',
        energy: 'mid_high',
        screen_busy: 1.4,
        emph_3: 0.8,
        emph_5: 'yes',
        fam_s1: 'camera',
        fam_s2: 'sparkles',
        comm_s1: 'did_you_know',
        comm_s2: 'not_a_phrase',
      });

      expect(scores).toEqual({
        mood: 'funny',
        energy: 0.75,
        screen_busy: 1,
        emphasis: { 3: 0.8 },
        family: { s1: 'camera' },
        commentary: { s1: 'did_you_know' },
      });
      expect(readPiece({ mood: 'angry' })).toEqual({});
    });

    it('merges the pieces: common mood, mean energy, all words and slots', () => {
      const merged = mergePieces([
        { mood: 'calm', energy: 0, emphasis: { 1: 0.9 }, family: { s1: 'text' } },
        { mood: 'excited', energy: 1, emphasis: { 40: 0.2 }, commentary: { s9: 'wait' } },
        { mood: 'excited', energy: 0.5 },
      ]);

      expect(merged).toEqual({
        mood: 'excited',
        energy: 0.5,
        emphasis: { 1: 0.9, 40: 0.2 },
        family: { s1: 'text' },
        commentary: { s9: 'wait' },
      });
      expect(mergePieces([])).toBeUndefined();
    });

    it('lets the planner use the scores and still produce a valid plan', () => {
      const { slots } = perceptionTargets(REQUEST, WORDS);
      const family = Object.fromEntries(slots.map((s) => [s.id, 'text' as const]));

      const result = planAndValidate({
        sessionId: 's',
        level: 'standard',
        request: REQUEST,
        words: WORDS,
        palette: PALETTE,
        scores: { mood: 'excited', energy: 1, family, emphasis: { 0: 1 } },
      });

      expect(result.plan.items.length).toBeGreaterThan(0);
      expect(result.plan.captions.emphasis_words).toContain(0);
    });
  });
  describe('picks from the registry', () => {
    const ALL = EFFECTS.map((e) => e.id);
    const ctx = (over: Partial<Omit<PickContext, 'style'>> = {}): Omit<PickContext, 'style'> => ({
      level: 'heavy',
      capabilities: { effects: ALL },
      facecam: true,
      ...over,
    });
    const ids = (label: Parameters<typeof candidatesFor>[0], role: Parameters<typeof candidatesFor>[1], c: PickContext) =>
      candidatesFor(label, role, c).map((e) => e.id).sort();
    const full = (style: 'calm' | 'lively', over: Partial<Omit<PickContext, 'style'>> = {}): PickContext => ({
      ...ctx(over),
      style,
    });

    // synthetic moments on the source timeline of a 3 minute video cut in 3 pieces of 60 s
    const moment = (m: Partial<Moment> & Pick<Moment, 'id' | 'kind' | 'start_ms' | 'label'>): Moment => ({
      end_ms: m.start_ms + 2000,
      ...m,
    });
    const REGION = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };
    const direction = (style: 'calm' | 'lively' = 'calm', extra: Moment[] = []): Direction => ({
      style,
      source: 'director',
      moments: [
        moment({ id: 's1', kind: 'sentence', start_ms: 0, label: 'hook' }),
        moment({ id: 's2', kind: 'sentence', start_ms: 5000, label: 'claim' }),
        moment({ id: 's3', kind: 'sentence', start_ms: 8000, label: 'reason' }),
        moment({ id: 'd1', kind: 'drawing', start_ms: 10_000, end_ms: 12_500, label: 'drawing', region: REGION }),
        moment({ id: 'c1', kind: 'chapter', start_ms: 70_000, end_ms: 70_001, label: 'chapter' }),
        moment({ id: 's4', kind: 'sentence', start_ms: 130_000, label: 'recap' }),
        moment({ id: 's5', kind: 'sentence', start_ms: 150_000, label: 'plain' }),
        ...extra,
      ],
    });
    const DURATION = 180_000;
    const ask = (d: Direction | undefined, c = ctx(), pieces = 3) => pickQuestions(d, c, DURATION, pieces);

    describe('candidatesFor', () => {
      it('keeps the registry entries of the label that fit the level', () => {
        // a calm chapter at Basic: the transitions that serve chapters are Standard or lively
        expect(ids('chapter', 'main', full('calm', { level: 'basic' }))).toEqual([]);
        expect(ids('chapter', 'main', full('calm', { level: 'standard' }))).toEqual(['f_roll', 'tr_dip_color', 'tr_push']);
        for (const level of ['standard', 'heavy'] as const) {
          expect(ids('claim', 'main', full('calm', { level }))).toEqual(['f_hero', 'v_push_in']);
        }
      });

      it('keeps only the ids the phone declared', () => {
        const only = full('calm', { capabilities: { effects: ['tr_push', 'v_push_in'] } });

        expect(ids('chapter', 'main', only)).toEqual(['tr_push']);
        expect(ids('claim', 'main', only)).toEqual(['v_push_in']);
        expect(ids('chapter', 'main', full('calm', { capabilities: { effects: [] } }))).toEqual([]);
      });

      it('drops the effects that do not fit the style and offers them in a lively one', () => {
        expect(ids('chapter', 'main', full('calm'))).not.toEqual(expect.arrayContaining(['tr_whip']));
        expect(ids('chapter', 'main', full('calm'))).toEqual(['f_roll', 'tr_dip_color', 'tr_push']);
        expect(ids('chapter', 'main', full('lively'))).toEqual(
          ['f_roll', 'tr_dip_color', 'tr_flash_cut', 'tr_push', 'tr_whip']
        );
        expect(ids('claim', 'main', full('calm'))).not.toContain('v_punch_in');
        expect(ids('claim', 'main', full('lively'))).toContain('v_punch_in');
      });

      it('offers a facecam move only when the recording has a facecam track', () => {
        const noTrack = full('calm', { facecam: false });

        expect(ids('chapter', 'main', noTrack)).toEqual(['tr_dip_color', 'tr_push']);
        expect(ids('claim', 'main', noTrack)).toEqual(['v_push_in']);
        expect(ids('drawing', 'face', noTrack)).toEqual([]);
        expect(ids('drawing', 'screen', noTrack)).toEqual(['v_spotlight']);
      });

      it('splits a drawing into the facecam role and the screen role', () => {
        expect(ids('drawing', 'face', full('calm'))).toEqual(['f_dodge', 'f_step_aside']);
        expect(ids('drawing', 'screen', full('calm'))).toEqual(['v_spotlight']);
      });

      it('offers the transitions that serve a cut, in a lively style only', () => {
        expect(ids('cut', 'main', full('lively'))).toEqual(['tr_flash_cut', 'tr_whip']);
        expect(ids('cut', 'main', full('calm'))).toEqual([]);
      });

      it('offers at most 12 entries', () => {
        expect(MAX_PICK_CANDIDATES).toBe(12);
        for (const label of ['claim', 'drawing', 'chapter', 'cut'] as const) {
          expect(candidatesFor(label, 'main', full('lively')).length).toBeLessThanOrEqual(MAX_PICK_CANDIDATES);
        }
      });
    });

    describe('pickQuestions', () => {
      it('asks one choice question per labelled moment and role, with the registry text and none', () => {
        const asks = ask(direction()).flat();

        expect(asks.map((a) => a.question.id)).toEqual([
          'pick_s2',
          'pick_d1_face',
          'pick_d1_screen',
          'pick_c1',
          'pick_s4',
        ]);
        expect(asks.map((a) => a.key)).toEqual(['s2', 'd1:face', 'd1:screen', 'c1', 's4']);
        for (const a of asks) {
          expect(a.question.type).toBe('choice');
          expect(a.question.instruction.endsWith(` ${PICK_QUESTION}`)).toBe(true);
          expect(Object.keys(a.question.criteria!)).toEqual([...a.candidates, 'none']);
          expect(a.question.criteria!.none).toBe(PICK_NONE);
        }
        const claim = asks[0];
        expect(claim.question.criteria!.f_hero).toBe(
          EFFECTS.find((e) => e.id === 'f_hero')!.describe
        );
      });

      it('asks nothing for a hook, a reason, an example or a plain sentence', () => {
        const asks = ask(direction()).flat();

        expect(asks.some((a) => ['s1', 's3', 's5'].some((id) => a.key.startsWith(id)))).toBe(false);
      });

      it('sends each question to the piece holding the moment start and says the time inside that piece', () => {
        const pieces = ask(direction());

        expect(pieces.map((p) => p.map((a) => a.key))).toEqual([
          ['s2', 'd1:face', 'd1:screen'],
          ['c1'],
          ['s4'],
        ]);
        expect(pieces[0][0].question.instruction).toContain('From 5.0 s to 7.0 s');
        // the chapter is at 70 s: 10 s into the second piece
        expect(pieces[1][0].question.instruction).toBe(`At 10.0 s the screen changes to a new topic. ${PICK_QUESTION}`);
        // the recap is at 130 s: 10 s into the third piece
        expect(pieces[2][0].question.instruction).toContain('From 10.0 s to 12.0 s');
        expect(pieceLength(DURATION, 3)).toBe(60_000);
      });

      it('puts no transcript word in a question', () => {
        const texts = ask(direction('lively')).flat().map((a) => a.question.instruction);

        for (const text of texts) {
          // only times, the kind of moment and the closed question
          expect(text.replace(/\d+\.\d s/g, 'T')).toMatch(
            /^(From T to T the speaker says one sentence\.|From T to T something is drawn on the screen\.|At T the screen changes to a new topic\.|Where the video cuts from one part to the next, across the whole clip\.) Which edit suits this moment best\?$/
          );
        }
      });

      it('asks pick_cut once, in the first piece, only in a lively style', () => {
        const lively = ask(direction('lively'));
        const calm = ask(direction('calm'));

        expect(lively.flat().filter((a) => a.question.id === 'pick_cut')).toHaveLength(1);
        expect(lively[0].map((a) => a.key)).toContain('cut');
        expect(lively[0].find((a) => a.key === 'cut')!.candidates.sort()).toEqual(['tr_flash_cut', 'tr_whip']);
        expect(calm.flat().some((a) => a.key === 'cut')).toBe(false);
      });

      it('does not ask pick_cut or a pick the phone cannot render', () => {
        const noTransitions = ctx({ capabilities: { effects: ['f_hero'] } });
        const asks = ask(direction('lively'), noTransitions).flat();

        expect(asks.map((a) => a.key)).toEqual(['s2', 's4']);
        expect(asks.every((a) => a.candidates.join() === 'f_hero')).toBe(true);
      });

      it('asks nothing without a director direction', () => {
        expect(ask(undefined).flat()).toEqual([]);
        expect(ask({ style: 'lively', moments: [], source: 'none' }).flat()).toEqual([]);
        expect(ask({ ...direction('lively'), source: 'none' }).flat()).toEqual([]);
        expect(ask(undefined)).toHaveLength(3);
      });

      it('puts a moment past the last piece in the last piece', () => {
        const late = direction('calm', [moment({ id: 's9', kind: 'sentence', start_ms: DURATION + 500, label: 'cta' })]);

        const pieces = ask(late);

        expect(pieces[2].map((a) => a.key)).toContain('s9');
      });

      it('keeps the piece own questions first when the picks push a call over the limit', () => {
        const targets = Array.from({ length: MAX_SLOTS_PER_PIECE }, (_, k) => target(`s${k + 1}`, k + 1));
        const own = pieceQuestions(targets);
        const many = direction(
          'calm',
          Array.from({ length: 30 }, (_, k) =>
            moment({ id: `s${100 + k}`, kind: 'sentence', start_ms: 1000 + k * 1000, label: 'claim' })
          )
        );
        const picks = ask(many)[0].map((a) => a.question);

        const calls = batches([...own, ...picks]);

        expect(own.length).toBeLessThan(MAX_QUESTIONS);
        expect(calls[0].slice(0, own.length)).toEqual(own);
        expect(calls.every((c) => c.length <= MAX_QUESTIONS)).toBe(true);
        expect(calls.flat()).toHaveLength(own.length + picks.length);
      });
    });

    describe('answers and the fallback', () => {
      it('reads a candidate or none and ignores a foreign answer', () => {
        const asks = ask(direction()).flat();
        const scores = readPiece(
          {
            pick_s2: 'f_hero',
            pick_d1_face: 'none',
            // a registry id that is not one of this question's candidates, a number, an unknown id
            pick_d1_screen: 'f_hero',
            pick_c1: 7,
            pick_s4: 'tr_made_up',
          },
          asks
        );

        expect(scores.picks).toEqual({ s2: 'f_hero', 'd1:face': 'none' });
        expect(readPiece({ pick_s2: 'f_hero' }, [])).toEqual({});
        expect(readPiece({ pick_s2: 'f_hero' })).toEqual({});
      });

      it('merges the picks of the pieces', () => {
        const merged = mergePieces([{ picks: { s2: 'v_push_in' } }, { picks: { c1: 'tr_push' } }, {}]);

        expect(merged).toEqual({ picks: { s2: 'v_push_in', c1: 'tr_push' } });
      });

      it('rotates the fallback over the candidates by the moment ordinal, never none', () => {
        const claims = direction('calm', [
          moment({ id: 's20', kind: 'sentence', start_ms: 20_000, label: 'claim' }),
          moment({ id: 's21', kind: 'sentence', start_ms: 30_000, label: 'claim' }),
        ]);

        const asks = ask(claims).flat().filter((a) => a.question.id.startsWith('pick_s2'));

        expect(asks.map((a) => a.key)).toEqual(['s2', 's20', 's21']);
        const [first, second] = asks[0].candidates;
        expect(asks.map((a) => a.fallback)).toEqual([first, second, first]);
        expect(asks.every((a) => a.fallback !== 'none' && a.candidates.includes(a.fallback))).toBe(true);
      });

      it('rotates each kind of moment through its own candidates', () => {
        const chapters = direction('calm', [
          moment({ id: 'c2', kind: 'chapter', start_ms: 80_000, label: 'chapter' }),
          moment({ id: 'c3', kind: 'chapter', start_ms: 90_000, label: 'chapter' }),
        ]);

        const asks = ask(chapters).flat().filter((a) => a.key.startsWith('c'));

        expect(asks.map((a) => a.key)).toEqual(['c1', 'c2', 'c3']);
        const list = asks[0].candidates;
        expect(asks.map((a) => a.fallback)).toEqual([list[0], list[1], list[2]]);
      });

      it('fills only the picks that got no valid answer and says which', () => {
        const asks = ask(direction('lively')).flat();
        const answered = { picks: { s2: 'none', c1: asks.find((a) => a.key === 'c1')!.candidates[0] } };

        const { scores, filled } = withFallbackPicks({ mood: 'calm', ...answered }, asks);

        expect(Object.keys(filled).sort()).toEqual(['cut', 'd1:face', 'd1:screen', 's4']);
        expect([...scores!.fallback_picks!].sort()).toEqual(Object.keys(filled).sort());
        expect(scores!.mood).toBe('calm');
        expect(scores!.picks!.s2).toBe('none');
        expect(scores!.picks!.c1).toBe(answered.picks.c1);
        for (const a of asks.filter((x) => x.key in filled)) {
          expect(scores!.picks![a.key]).toBe(a.fallback);
        }
      });

      it('keeps the fallback keys of an earlier fill and adds the new ones once', () => {
        const asks = ask(direction()).flat();
        const first = withFallbackPicks(undefined, asks.slice(0, 2));
        const again = withFallbackPicks(first.scores, asks);

        expect(first.scores!.fallback_picks).toEqual(asks.slice(0, 2).map((a) => a.key));
        expect([...again.scores!.fallback_picks!].sort()).toEqual(asks.map((a) => a.key).sort());
        expect(new Set(again.scores!.fallback_picks).size).toBe(asks.length);
      });

      it('makes scores out of the fallback alone when Clef-omni gave none, and leaves them without picks to ask', () => {
        const asks = ask(direction()).flat();

        const { scores } = withFallbackPicks(undefined, asks);

        expect(Object.keys(scores!.picks!).sort()).toEqual(asks.map((a) => a.key).sort());
        const untouched = { mood: 'calm' };
        expect(scores!.fallback_picks!.sort()).toEqual(asks.map((a) => a.key).sort());
        expect(withFallbackPicks(untouched, [])).toEqual({ scores: untouched, filled: {} });
        expect(withFallbackPicks(undefined, [])).toEqual({ scores: undefined, filled: {} });
      });
    });
  });
});
