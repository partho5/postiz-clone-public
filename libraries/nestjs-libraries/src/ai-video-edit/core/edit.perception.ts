// AI video editing (ai.video-editing), perception (spec section 11, step 5): the fixed questions put to Clef-omni
// about one proxy piece, and the reading of its answers into the planner's SlotScores. Clef-omni is a decision
// model: it only picks among options given here, it never writes text. Pure functions, no Nest or network import;
// the call itself is `clef.omni.client.ts`.
import { phraseById, phrasesForMood } from '../contract/edit.phrases';
import { FamilyChoice, SlotScores } from './edit.assembler';
import { HOOK_SLOT_ID, Slot } from './edit.slots';

// What one call takes at most (Clef-omni's limit).
export const MAX_QUESTIONS = 64;

// The proxy pieces are at most this long (the app's `Engine.PROXY_MAX_MS`).
export const PIECE_MAX_MS = 60_000;

// The most slots asked about per piece; the hook slot is always one of them, then the best scored.
export const MAX_SLOTS_PER_PIECE = 24;

export type ClefQuestionType = 'noul' | 'choice' | 'score';

// One question: `noul` answers a probability, `choice` the key of one option of `criteria`, `score` the key of one
// level of `criteria` (in order, lowest first).
export interface ClefQuestion {
  id: string;
  type: ClefQuestionType;
  instruction: string;
  criteria?: Record<string, string>;
}

// An answer: a probability, or the key of the option or level picked.
export type ClefAnswer = number | string;

// The answers of one piece by question id; a question that was not answered is missing.
export type ClefAnswers = Record<string, ClefAnswer>;

// The moods perception answers with (the tags of the phrase library).
export const MOODS: Record<string, string> = {
  excited: 'The speaker is excited, enthusiastic',
  serious: 'The speaker is serious, firm',
  sad: 'The speaker is sad or sympathetic',
  funny: 'The speaker is joking or playful',
  surprising: 'The speaker is surprised or surprising the listener',
  calm: 'The speaker is calm and relaxed',
};

// The energy levels, lowest first, and the number each stands for (0 to 1).
export const ENERGY_LEVELS: Record<string, number> = {
  low: 0,
  mid_low: 0.25,
  mid: 0.5,
  mid_high: 0.75,
  high: 1,
};

// The effect families perception chooses between per slot.
export const FAMILIES: Record<string, string> = {
  text: 'A short text pops up on screen',
  camera: 'The camera punches in or the view changes',
  look: 'The picture flashes or glitches for a beat',
  icon: 'A small animated icon appears',
  none: 'Nothing, leave this moment plain',
};

// One slot to ask about: where it is in its piece and the word spoken there.
export interface PieceTarget {
  slot: Slot;
  // the word as spoken
  word: string;
  // milliseconds from the start of the piece
  atMs: number;
}

// The proxy pieces' span: the fewest of at most PIECE_MAX_MS, all the same length, as the app cuts them.
export const pieceLength = (durationMs: number, pieceCount: number) =>
  Math.max(1, Math.ceil(durationMs / Math.max(1, pieceCount)));

// The slots of each piece. `sourceMs` is the source start of each output word (indexed like `words`), which says
// which piece the word was spoken in. A piece keeps the hook slot and the best scored of the rest, in time order.
export const targetsByPiece = (
  slots: Slot[],
  words: { w: string }[],
  sourceMs: number[],
  durationMs: number,
  pieceCount: number
): PieceTarget[][] => {
  const length = pieceLength(durationMs, pieceCount);
  const pieces: PieceTarget[][] = Array.from({ length: pieceCount }, () => []);
  for (const slot of slots) {
    const src = sourceMs[slot.word_index];
    if (src === undefined || !words[slot.word_index]) continue;
    const piece = Math.min(pieceCount - 1, Math.floor(src / length));
    pieces[piece].push({
      slot,
      word: words[slot.word_index].w,
      atMs: Math.max(0, src - piece * length),
    });
  }
  return pieces.map((targets) => {
    const kept = new Set(
      [...targets]
        .sort(
          (a, b) =>
            Number(b.slot.id === HOOK_SLOT_ID) - Number(a.slot.id === HOOK_SLOT_ID) ||
            b.slot.score - a.slot.score
        )
        .slice(0, MAX_SLOTS_PER_PIECE)
    );
    return targets.filter((t) => kept.has(t));
  });
};

// A time in the piece as the questions say it, in seconds with a tenth.
const at = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// A target as the questions refer to it.
const where = (t: PieceTarget) => `At ${at(t.atMs)} the speaker says "${t.word}".`;

// The questions about the piece as a whole and about each target: mood, energy, whether the screen is busy, whether
// each word is stressed and which effect family suits each slot. The answers' ids are the keys `readScores` reads.
export const pieceQuestions = (targets: PieceTarget[]): ClefQuestion[] => [
  {
    id: 'mood',
    type: 'choice',
    instruction: 'What is the overall mood of the speaker in this clip?',
    criteria: MOODS,
  },
  {
    id: 'energy',
    type: 'score',
    instruction: 'How energetic is the speaker in this clip?',
    criteria: {
      low: 'Very quiet and slow',
      mid_low: 'Rather quiet',
      mid: 'Normal',
      mid_high: 'Lively',
      high: 'Very energetic and fast',
    },
  },
  {
    id: 'screen_busy',
    type: 'noul',
    instruction:
      'Is something moving or being drawn on the screen that the viewer must keep watching?',
  },
  ...targets.map(
    (t): ClefQuestion => ({
      id: `emph_${t.slot.word_index}`,
      type: 'noul',
      instruction: `${where(t)} Does the speaker stress this word?`,
    })
  ),
  ...targets.map(
    (t): ClefQuestion => ({
      id: `fam_${t.slot.id}`,
      type: 'choice',
      instruction: `${where(t)} Which kind of visual emphasis suits this moment best?`,
      criteria: FAMILIES,
    })
  ),
];

// The commentary questions: for each slot, which phrase of the closed library (those of the piece's mood) fits, or
// none. Empty when the mood is unknown or has no phrase. The hook slot has its own text and is not asked.
export const commentaryQuestions = (
  targets: PieceTarget[],
  mood: string | undefined
): ClefQuestion[] => {
  const phrases = mood ? phrasesForMood(mood) : [];
  if (!phrases.length) return [];
  const criteria: Record<string, string> = Object.fromEntries(
    phrases.map((p) => [p.id, p.text.en])
  );
  criteria.none = 'No reaction label fits';
  return targets
    .filter((t) => t.slot.id !== HOOK_SLOT_ID)
    .map(
      (t): ClefQuestion => ({
        id: `comm_${t.slot.id}`,
        type: 'choice',
        instruction: `${where(t)} Which short reaction label would a viewer find fitting here?`,
        criteria,
      })
    );
};

// Splits the questions into calls of at most MAX_QUESTIONS, in order.
export const batches = (questions: ClefQuestion[]): ClefQuestion[][] => {
  const out: ClefQuestion[][] = [];
  for (let k = 0; k < questions.length; k += MAX_QUESTIONS) {
    out.push(questions.slice(k, k + MAX_QUESTIONS));
  }
  return out;
};

// A probability from an answer, clamped to 0 to 1; undefined when it is not a number.
const probability = (answer: ClefAnswer | undefined) =>
  typeof answer === 'number' && Number.isFinite(answer)
    ? Math.min(1, Math.max(0, answer))
    : undefined;

// The energy (0 to 1) of an answer: a level key, or a number.
const energyOf = (answer: ClefAnswer | undefined) =>
  typeof answer === 'string' ? ENERGY_LEVELS[answer] : probability(answer);

// What one piece's answers say, in the planner's terms. Answers that are not a valid option are ignored.
export const readPiece = (answers: ClefAnswers): SlotScores => {
  const out: SlotScores = {};
  const mood = answers.mood;
  if (typeof mood === 'string' && mood in MOODS) out.mood = mood;
  const energy = energyOf(answers.energy);
  if (energy !== undefined) out.energy = energy;
  const busy = probability(answers.screen_busy);
  if (busy !== undefined) out.screen_busy = busy;
  for (const [id, answer] of Object.entries(answers)) {
    if (id.startsWith('emph_')) {
      const p = probability(answer);
      const index = Number(id.slice(5));
      if (p !== undefined && Number.isInteger(index)) {
        (out.emphasis ||= {})[index] = p;
      }
    } else if (id.startsWith('fam_')) {
      if (typeof answer === 'string' && answer in FAMILIES) {
        (out.family ||= {})[id.slice(4)] = answer as FamilyChoice;
      }
    } else if (id.startsWith('comm_')) {
      if (typeof answer === 'string' && phraseById(answer)) {
        (out.commentary ||= {})[id.slice(5)] = answer;
      }
    }
  }
  return out;
};

// The scores of the whole video from its pieces' answers: the most common mood (the first piece's wins a tie), the
// mean energy, the mean screen busyness, and every piece's per-word and per-slot answers together. Undefined when
// no piece gave anything.
export const mergePieces = (
  pieces: SlotScores[]
): SlotScores | undefined => {
  const out: SlotScores = {};
  const moods = new Map<string, number>();
  const energies: number[] = [];
  const busy: number[] = [];
  for (const piece of pieces) {
    if (piece.mood) moods.set(piece.mood, (moods.get(piece.mood) || 0) + 1);
    if (piece.energy !== undefined) energies.push(piece.energy);
    if (piece.screen_busy !== undefined) busy.push(piece.screen_busy);
    if (piece.emphasis) out.emphasis = { ...out.emphasis, ...piece.emphasis };
    if (piece.commentary) out.commentary = { ...out.commentary, ...piece.commentary };
    if (piece.family) out.family = { ...out.family, ...piece.family };
  }
  let best = 0;
  for (const [mood, count] of moods) {
    if (count > best) {
      out.mood = mood;
      best = count;
    }
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  if (energies.length) out.energy = mean(energies);
  if (busy.length) out.screen_busy = mean(busy);
  return Object.keys(out).length ? out : undefined;
};
