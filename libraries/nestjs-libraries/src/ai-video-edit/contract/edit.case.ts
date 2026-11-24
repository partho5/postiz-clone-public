// AI video editing (ai.video-editing): Title Case and the Unicode word segmenter it stands on. It lives in the contract folder
// because the look conformance vectors (`edit.vectors.ts`) need the text a look draws and the contract folder imports nothing
// outside itself; the planner core (`core/edit.geometry.ts`) re-exports these, so there is one source. Pure: no Nest, no Prisma.

// What a Unicode segmenter answers for one piece of text.
export interface TextSegment {
  segment: string;
  isWordLike?: boolean;
}

// The segmenter of `Intl` (it is newer than the TypeScript lib the project builds with).
type SegmenterClass = new (
  locale: string | undefined,
  options: { granularity: 'grapheme' | 'word' }
) => { segment(text: string): Iterable<TextSegment> };

const segmenters = new Map<string, InstanceType<SegmenterClass>>();

// The Unicode segmenter of one granularity for a language; a language tag the runtime does not know uses the root rules.
export const segmenterOf = (granularity: 'grapheme' | 'word', language?: string) => {
  const key = `${granularity}:${language || ''}`;
  let found = segmenters.get(key);
  if (!found) {
    const Segmenter = (Intl as unknown as { Segmenter: SegmenterClass }).Segmenter;
    try {
      found = new Segmenter(language || undefined, { granularity });
    } catch {
      found = new Segmenter(undefined, { granularity });
    }
    segmenters.set(key, found);
  }
  return found;
};

// The text cut at word boundaries as the language divides them, spaces and punctuation included (Chinese, Japanese
// and Thai have no spaces, so their words come from the Unicode dictionary).
export const wordSegments = (text: string, language?: string): TextSegment[] =>
  Array.from(segmenterOf('word', language).segment(text));

// Title Case, the one source of overlay text case: what `case: upper` draws and what the planner writes for its keyword echo
// (owner decision 2026-11-20, no all-caps English text anywhere; the enum value keeps the name `upper`): the first
// letter of every word capitalised and the rest of the word lower case, by the rules of the language (a Turkish `i`
// becomes `İ`, `I` becomes `ı`). Words come from the Unicode word segmenter; only a word that starts with a letter and
// has cased letters is touched, so digits, punctuation, emoji and scripts without case pass through. A letter that
// follows an apostrophe inside a word stays lower case (`don't` gives `Don't`), a hyphen starts a new word (`well-known`
// gives `Well-Known`). Deliberately simple, like the phone's `LookTypography.titleCase` (the vectors must match it):
// a word typed in capitals is lowered too (`NASA` gives `Nasa`), and mid-word capitals go (`iPhone` gives `Iphone`).
const localeLower = (text: string, language?: string) => {
  try {
    return text.toLocaleLowerCase(language || undefined);
  } catch {
    return text.toLocaleLowerCase();
  }
};
const codePointCount = (text: string) => Array.from(text).length;
// A letter with case, as the phone's `Character.toUpperCase/toLowerCase` sees it: one whose capital is two letters
// only (the German sharp s) has none of its own.
const isCased = (ch: string) => {
  const upper = ch.toUpperCase();
  return ch.toLowerCase() !== ch || (upper !== ch && codePointCount(upper) === 1);
};
const hasCase = (text: string) => Array.from(text).some(isCased);
const LETTER_FIRST = /^\p{L}/u;
const isHyphen = (c: string) => c === '-' || c === '\u2010' || c === '\u2011';
const isApostrophe = (c: string) => c === "'" || c === '\u2019';

// One word: its first letter in title form, the rest lower case; a piece that does not start with a letter is kept.
const capitalise = (word: string, language?: string) => {
  if (!word || !LETTER_FIRST.test(word)) return word;
  const first = String.fromCodePoint(word.codePointAt(0) as number);
  let head: string;
  try {
    head = first.toLocaleUpperCase(language || undefined);
  } catch {
    head = first.toUpperCase();
  }
  // A capital that needs two letters (the German sharp s gives SS) is not a title letter: the letter stays as it is.
  if (codePointCount(head) > 1) head = first;
  return head + localeLower(word.slice(first.length), language);
};

// True when the letter at `at` directly follows an apostrophe that directly follows a letter (a contraction).
const followsApostropheInWord = (text: string, at: number) => {
  if (at < 2 || !isApostrophe(text.charAt(at - 1))) return false;
  const before = Array.from(text.slice(0, at - 1)).pop() || '';
  return LETTER_FIRST.test(before);
};

export const titleCase = (text: string, language?: string) => {
  if (!text) return text;
  let out = '';
  let at = 0;
  for (const { segment } of wordSegments(text, language)) {
    const start = at;
    at += segment.length;
    if (!LETTER_FIRST.test(segment) || !hasCase(segment)) {
      out += segment;
    } else if (followsApostropheInWord(text, start)) {
      out += localeLower(segment, language);
    } else {
      let from = 0;
      for (let i = 0; i <= segment.length; i++) {
        if (i === segment.length || isHyphen(segment[i])) {
          out += capitalise(segment.slice(from, i), language);
          if (i < segment.length) out += segment[i];
          from = i + 1;
        }
      }
    }
  }
  return out;
};

// The text as a look draws it: Title Case for `case: upper` (only a text with cased letters changes), else as written.
export const drawnText = (text: string, mode: 'as_written' | 'upper', language?: string) =>
  mode === 'upper' && hasCase(text) ? titleCase(text, language) : text;
