// AI video editing (ai.video-editing), planner core: candidate slots (spec section 11, step 4). A slot is a word, inside
// a free window, where an effect may be anchored: numbers, long or rare words, a word before a pause, a word that
// repeats the topic, the first sentence after a slide change; plus one hook slot in the first 3 seconds. Words and
// windows are on the output timeline. Pure functions, no Nest or Prisma import.
import { EditWord } from '../contract/edit.contract';
import { HOOK_MS } from './edit.rules';
import { Span } from './edit.windows';

export type SlotReason =
  | 'number'
  | 'long_word'
  | 'rare_word'
  | 'before_pause'
  | 'topic_repeat'
  | 'after_slide_change'
  | 'hook';

// One place to anchor an effect: the word, its free window, why it was picked and how strongly.
export interface Slot {
  id: string;
  word_index: number;
  start_ms: number;
  end_ms: number;
  window: number;
  reasons: SlotReason[];
  score: number;
  keyword: string;
}

export interface SlotOptions {
  // Output times of the slide changes (markers of the activity map).
  markers?: number[];
}

// How much each reason adds to a slot's score.
export const SLOT_WEIGHTS: Record<SlotReason, number> = {
  number: 3,
  long_word: 1.5,
  rare_word: 1,
  before_pause: 1,
  topic_repeat: 1.5,
  after_slide_change: 2,
  hook: 0,
};

// A word followed by a gap of at least this long is "before a pause" (a silence cut leaves 240 ms).
export const PAUSE_MS = 240;

// The first word after a slide change counts when it starts within this time of it.
export const SLIDE_REACH_MS = 1500;

// The hook word must start by this time, so its overlay starts inside the first 3 seconds.
export const HOOK_LATEST_START_MS = HOOK_MS - 400;

// A word of this many characters or more is long.
export const LONG_WORD_CHARS = 8;

// The id of the hook slot.
export const HOOK_SLOT_ID = 'h1';

// How much a slot is worth when the planner chooses among them: its score, and twice the probability that perception
// found its word emphasised (`emphasis`: word index to probability). The assembler, the writer and the icon search all
// rank slots with this one formula, so the slots searched are the slots the assembler walks first.
export const priority = (slot: Slot, emphasis?: Record<number, number>) =>
  slot.score + 2 * (emphasis?.[slot.word_index] || 0);

const EDGE = new RegExp('^[^\\p{L}\\p{M}\\p{N}]+|[^\\p{L}\\p{M}\\p{N}]+$', 'gu');
const DIGIT = new RegExp('[0-9\\u09E6-\\u09EF]');

// Words that never make a slot on their own (English and Bengali function words).
const STOP_WORDS = new Set<string>(
  (
    'the a an and or but if of to in on at for with from by as is are was were be been it this that these those i you ' +
    'he she we they me my your our their his her its so do does did not no yes have has had will would can could just ' +
    'very really than then there here what which who when where why how about into out up down over also more most ' +
    'some any all too only like get got go going know think want need make made say said ' +
    'এবং ও কিন্তু যদি তা এই ওই সেই আমি আমরা তুমি আপনি সে তারা এটা এটি ওটা না হ্যাঁ কি কী কেন কোন যে যা করে করা ' +
    'হয় হবে ছিল আছে থেকে জন্য সাথে মধ্যে এর তার তাদের আমার আপনার তো ই আর বা হলো'
  ).split(' ')
);

// Words that count as numbers besides digits (not the plain "one"/"এক", which is everywhere).
const NUMBER_WORDS = new Set<string>(
  (
    'zero two three four five six seven eight nine ten twenty thirty fifty hundred thousand million billion percent ' +
    'দুই তিন চার পাঁচ ছয় সাত আট নয় দশ শত হাজার লক্ষ কোটি শতাংশ'
  ).split(' ')
);

// A word without the punctuation around it, in lower case.
export const cleanWord = (raw: string) => raw.replace(EDGE, '').toLowerCase();

// Whether a word's text ends a sentence.
const endsSentence = (raw: string) => /[.?!।…]["')\]]*$/.test(raw.trim());

const charCount = (s: string) => Array.from(s).length;

// The index of the free window that holds an instant, or -1.
export const windowIndex = (windows: Span[], t: number) =>
  windows.findIndex((w) => w.start_ms <= t && t < w.end_ms);

// The candidate slots in time order, with the hook slot (id `h1`) in place of the word it is anchored on.
export const candidateSlots = (
  words: EditWord[],
  windows: Span[],
  options: SlotOptions = {}
): Slot[] => {
  const clean = words.map((w) => cleanWord(w.w));
  const freq = new Map<string, number>();
  clean.forEach((c) => {
    if (c && !STOP_WORDS.has(c)) freq.set(c, (freq.get(c) || 0) + 1);
  });
  // The first word at or after each slide change, when it comes soon enough
  const afterSlide = new Set<number>();
  for (const m of options.markers || []) {
    const first = words.find((w) => w.start_ms >= m);
    if (first && first.start_ms - m <= SLIDE_REACH_MS) afterSlide.add(first.i);
  }
  const seen = new Map<string, number>();
  const found: Slot[] = [];
  words.forEach((w, k) => {
    const c = clean[k];
    const first = !seen.has(c);
    seen.set(c, (seen.get(c) || 0) + 1);
    const win = windowIndex(windows, w.start_ms);
    if (!c || win < 0) return;
    const isNumber = DIGIT.test(c) || NUMBER_WORDS.has(c);
    if (STOP_WORDS.has(c) && !isNumber) return;
    const reasons: SlotReason[] = [];
    if (isNumber) reasons.push('number');
    if (!STOP_WORDS.has(c) && charCount(c) >= LONG_WORD_CHARS) reasons.push('long_word');
    if (!STOP_WORDS.has(c) && charCount(c) >= 5 && freq.get(c) === 1) reasons.push('rare_word');
    if (!STOP_WORDS.has(c) && charCount(c) >= 4 && (freq.get(c) || 0) >= 2 && !first) {
      reasons.push('topic_repeat');
    }
    const next = words[k + 1];
    if (!next || next.start_ms - w.end_ms >= PAUSE_MS || endsSentence(w.w)) {
      reasons.push('before_pause');
    }
    if (afterSlide.has(w.i)) reasons.push('after_slide_change');
    if (!reasons.length) return;
    found.push({
      id: '',
      word_index: w.i,
      start_ms: w.start_ms,
      end_ms: w.end_ms,
      window: win,
      reasons,
      score: reasons.reduce((sum, r) => sum + SLOT_WEIGHTS[r], 0),
      keyword: c,
    });
  });
  const hook = hookSlot(words, windows, clean, found);
  const slots = found.filter((s) => !hook || s.word_index !== hook.word_index);
  if (hook) slots.push(hook);
  slots.sort((a, b) => a.start_ms - b.start_ms || a.word_index - b.word_index);
  let n = 0;
  return slots.map((s) => (s.reasons.includes('hook') ? s : { ...s, id: `s${++n}` }));
};

// The hook slot: the best word of the first sentence that starts early enough, or of the first seconds when that
// sentence offers none; null when no word of the first seconds lies in a free window.
const hookSlot = (
  words: EditWord[],
  windows: Span[],
  clean: string[],
  found: Slot[]
): Slot | null => {
  const early = words.filter(
    (w) =>
      w.start_ms <= HOOK_LATEST_START_MS &&
      clean[w.i] &&
      windowIndex(windows, w.start_ms) >= 0
  );
  if (!early.length) return null;
  const endIdx = words.findIndex((w) => endsSentence(w.w));
  const sentence = early.filter((w) => endIdx < 0 || w.i <= endIdx);
  const pool = sentence.length ? sentence : early;
  const weight = (w: EditWord) => {
    const slot = found.find((s) => s.word_index === w.i);
    const stop = STOP_WORDS.has(clean[w.i]) ? -5 : 0;
    return (slot ? slot.score : 0) + charCount(clean[w.i]) * 0.1 + stop;
  };
  let best = pool[0];
  for (const w of pool) {
    if (weight(w) > weight(best)) best = w;
  }
  return {
    id: HOOK_SLOT_ID,
    word_index: best.i,
    start_ms: best.start_ms,
    end_ms: best.end_ms,
    window: windowIndex(windows, best.start_ms),
    reasons: ['hook'],
    score: SLOT_WEIGHTS.hook,
    keyword: clean[best.i],
  };
};
