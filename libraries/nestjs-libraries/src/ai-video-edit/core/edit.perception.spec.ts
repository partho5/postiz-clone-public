// AI video editing (ai.video-editing): perception questions and the reading of their answers (spec section 11,
// step 5). Needs no network, no database and no Nest.
import { toEditWords } from './edit.words';
import { goldenRequest, GOLDEN_FIXTURES } from './fixtures/edit.golden.fixtures';
import {
  MAX_QUESTIONS,
  MAX_SLOTS_PER_PIECE,
  PieceTarget,
  batches,
  commentaryQuestions,
  mergePieces,
  pieceLength,
  pieceQuestions,
  readPiece,
  targetsByPiece,
} from './edit.perception';
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
});
