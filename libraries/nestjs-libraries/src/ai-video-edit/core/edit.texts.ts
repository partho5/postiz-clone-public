// AI video editing (ai.video-editing), the Heavy writer's side of the planner core (spec section 11, step 6): which
// slots the writer is asked about, and the reading of its answer into the assembler's SlotTexts (and the icon queries
// the asset resolver will search). The writer may be wrong or down: every text is cleaned, a banned word drops its
// text, and with no text the plan falls back to Standard's keyword echoes and phrases. Pure functions, no Nest or
// network import; the call itself is `EditLlmService.writeEditTexts`.
import { LEVEL_RULES, EditLevel } from '../contract/edit.contract';
import { SlotScores, SlotTexts } from './edit.assembler';
import { capText } from './edit.rules';
import { HOOK_SLOT_ID, Slot } from './edit.slots';
import { hasBanned } from './edit.validator';

// What the writer wrote, kept on the job: the assembler's texts plus the icon search query per slot id.
export interface WrittenTexts extends SlotTexts {
  icon_queries?: Record<string, string>;
}

// The writer's answer as the model gave it.
export interface WriterAnswer {
  slots: { id: string; text: string; icon_query?: string | null }[];
}

// The most icon query words (English, a short scene).
const MAX_QUERY_WORDS = 6;

// The slots the writer is asked about: the hook slot, then the best scored (words perception stressed count double)
// up to twice the level's feature budget; a slot perception said to leave plain is not asked.
export const writerSlots = (
  slots: Slot[],
  level: EditLevel,
  scores?: SlotScores
): Slot[] => {
  const priority = (s: Slot) =>
    s.score + 2 * (scores?.emphasis?.[s.word_index] || 0);
  const plain = (id: string) => scores?.family?.[id] === 'none';
  const hook = slots.filter((s) => s.id === HOOK_SLOT_ID);
  const rest = slots
    .filter((s) => s.id !== HOOK_SLOT_ID && !plain(s.id))
    .sort((a, b) => priority(b) - priority(a) || a.start_ms - b.start_ms)
    .slice(0, 2 * LEVEL_RULES[level].max_feature_effects);
  return [...hook, ...rest];
};

// A text without quotes, hashtags and the full stops at its ends, one space between words, cut to the most words and
// graphemes the phone can lay out (`capText`, in the video's language).
const cleanText = (raw: string, language?: string) =>
  capText((raw || '').replace(/["“”‘’«»#]/g, ''), language).replace(/[.।]+$/, '');

// An icon query: up to 6 English words (letters, digits and spaces), else none.
const cleanQuery = (raw?: string | null) => {
  const words = (raw || '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.length && words.length <= MAX_QUERY_WORDS
    ? words.join(' ').toLowerCase()
    : undefined;
};

// Reads the writer's answer: only slots that were asked about, one text each (the first wins), cleaned; a text with a
// banned word of the brand is dropped (its slot then keeps the keyword echo). The hook slot's text is the hook.
// Undefined when nothing usable was written. `language` is the video's, for the words and graphemes of the cap.
export const readTexts = (
  answer: WriterAnswer | null | undefined,
  asked: Slot[],
  bannedWords: string[] = [],
  language?: string
): WrittenTexts | undefined => {
  if (!answer || !Array.isArray(answer.slots)) {
    return undefined;
  }
  const ids = new Set(asked.map((s) => s.id));
  const seen = new Set<string>();
  const out: WrittenTexts = {};
  const complementary: Record<string, string> = {};
  const queries: Record<string, string> = {};
  for (const item of answer.slots) {
    if (!item || !ids.has(item.id) || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    const text = cleanText(item.text, language);
    if (text && !hasBanned(text, bannedWords)) {
      if (item.id === HOOK_SLOT_ID) {
        out.hook = text;
      } else {
        complementary[item.id] = text;
      }
    }
    const query = cleanQuery(item.icon_query);
    if (query && !hasBanned(query, bannedWords)) {
      queries[item.id] = query;
    }
  }
  if (Object.keys(complementary).length) {
    out.complementary = complementary;
  }
  if (Object.keys(queries).length) {
    out.icon_queries = queries;
  }
  return Object.keys(out).length ? out : undefined;
};
