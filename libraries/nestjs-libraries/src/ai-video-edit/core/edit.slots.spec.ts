// AI video editing (ai.video-editing): candidate slots (spec section 11, step 4), hand-computed on a short transcript.
// Needs no database and no Nest.
import { RawWord, toEditWords } from './edit.words';
import { candidateSlots, windowIndex } from './edit.slots';

const raw = (text: string, startMs: number, endMs: number): RawWord => ({
  text,
  startMs,
  endMs,
  type: 'word',
});

// Gaps of 50 ms except: 300 ms after "saved", 700 ms after "works." and none after "Great" (the last word).
// "we", "with" and "and" are stop words; "automation" occurs twice.
const WORDS = toEditWords([
  raw('Today', 200, 600),
  raw('we', 650, 800),
  raw('saved', 850, 1200),
  raw('5', 1500, 1700),
  raw('dollars', 1750, 2200),
  raw('with', 2250, 2400),
  raw('automation', 2450, 3100),
  raw('and', 3150, 3300),
  raw('automation', 3350, 4000),
  raw('works.', 4050, 4500),
  raw('Great', 5200, 5600),
]);
const WINDOW = [{ start_ms: 0, end_ms: 6000 }];

describe('ai.video-editing: candidateSlots', () => {
  it('finds numbers, long, rare and repeated words and words before a pause, skipping stop words', () => {
    const slots = candidateSlots(WORDS, WINDOW);
    expect(
      slots.map((s) => [s.id, s.word_index, s.reasons, s.score])
    ).toEqual([
      ['s1', 0, ['rare_word'], 1],
      ['s2', 2, ['rare_word', 'before_pause'], 2],
      ['h1', 3, ['hook'], 0],
      ['s3', 4, ['rare_word'], 1],
      ['s4', 6, ['long_word'], 1.5],
      ['s5', 8, ['long_word', 'topic_repeat'], 3],
      ['s6', 9, ['rare_word', 'before_pause'], 2],
      ['s7', 10, ['rare_word', 'before_pause'], 2],
    ]);
  });

  it('puts the hook on the best word of the first seconds and keeps its keyword clean', () => {
    const hook = candidateSlots(WORDS, WINDOW).find((s) => s.id === 'h1');
    expect(hook).toMatchObject({ word_index: 3, start_ms: 1500, end_ms: 1700, window: 0, keyword: '5' });
    const slots = candidateSlots(WORDS, WINDOW);
    expect(slots.filter((s) => s.word_index === 3)).toHaveLength(1);
  });

  it('strips punctuation around a keyword', () => {
    const slot = candidateSlots(WORDS, WINDOW).find((s) => s.word_index === 9);
    expect(slot.keyword).toBe('works');
  });

  it('adds the first word after a slide change', () => {
    const slots = candidateSlots(WORDS, WINDOW, { markers: [5000] });
    const last = slots.find((s) => s.word_index === 10);
    expect(last.reasons).toEqual(['rare_word', 'before_pause', 'after_slide_change']);
    expect(last.score).toBe(4);
  });

  it('ignores a slide change with no word soon after it', () => {
    const slots = candidateSlots(WORDS, WINDOW, { markers: [5700] });
    expect(slots.find((s) => s.word_index === 10).reasons).not.toContain('after_slide_change');
  });

  it('keeps words out of protected spans and moves the hook to a word that is still free', () => {
    const windows = [
      { start_ms: 0, end_ms: 1000 },
      { start_ms: 2000, end_ms: 6000 },
    ];
    const slots = candidateSlots(WORDS, windows);
    const anchored = slots.map((s) => s.word_index);
    expect(anchored).not.toContain(3);
    expect(anchored).not.toContain(4);
    expect(slots.find((s) => s.id === 'h1')).toMatchObject({ word_index: 2, window: 0 });
  });

  it('has no hook slot when the first 3 seconds are protected', () => {
    const slots = candidateSlots(WORDS, [{ start_ms: 3000, end_ms: 6000 }]);
    expect(slots.some((s) => s.id === 'h1')).toBe(false);
    expect(slots.map((s) => s.word_index)).toEqual([8, 9, 10]);
  });

  it('counts digits of any script as numbers, and answers nothing for no words', () => {
    const bengali = toEditWords([raw('আজ', 100, 300), raw('১০০', 350, 600), raw('টাকা', 650, 900)]);
    const slots = candidateSlots(bengali, [{ start_ms: 0, end_ms: 2000 }]);
    expect(slots.find((s) => s.word_index === 1)).toBeDefined();
    expect(candidateSlots([], WINDOW)).toEqual([]);
  });

  it('finds the window of an instant', () => {
    const windows = [
      { start_ms: 0, end_ms: 1000 },
      { start_ms: 2000, end_ms: 3000 },
    ];
    expect(windowIndex(windows, 500)).toBe(0);
    expect(windowIndex(windows, 1000)).toBe(-1);
    expect(windowIndex(windows, 2500)).toBe(1);
  });
});
