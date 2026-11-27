// AI video editing (ai.video-editing), the Heavy writer (spec section 11 step 6, section 18): the prompt that asks the
// model for the on-screen texts of the chosen slots, a constant in the edit module (a Prompt Book key comes later).
// Pure: it builds the messages, the call is `EditLlmService.writeEditTexts`.
import { EditWord } from './contract/edit.contract';
import { Slot } from './core/edit.slots';

// The role and the rules of the writer; the video's own details follow in `writerMessages`.
export const EDIT_WRITER_PROMPT = `You are a short-form video editor. You write the on-screen text for a fast, face-to-camera self-branding video.
You get the transcript and a list of slots. A slot is a moment of the video, with the words spoken around it and the keyword spoken at it.
Return JSON only: for every slot you write for, its id, a text and an optional icon query.
Rules:
- A text is 1 to 4 words, short and big on screen. Write it in the language of the transcript, whatever the language of these instructions.
- The slot with id "h1" is the hook: the promise of the whole video in its first seconds. Every other slot gets a complementary phrase: it adds something to what is said (a result, a number, a consequence, a reaction), it does not repeat the spoken words. Never copy the caption or the sentence verbatim.
- Write in the brand's voice when one is given. Never use a banned word or phrase when any are given, in any form.
- No hashtags, no emojis, no quotation marks, no full stops.
- An icon query is 2 to 6 English words describing the small scene or situation that suits the moment, as a stock catalogue would name it (for example "doctor looking at watch", "businessman feeling stressed", "rocket launch"), or null when nothing fits. Icons are searched in English even when the text is not.
- Skip a slot rather than write something weak: leave it out of the answer.`;

// How many words around a slot's keyword are given as its context, on each side.
const CONTEXT_WORDS = 8;

// The most characters of the transcript sent (a longer one is cut at a word).
const MAX_TRANSCRIPT_CHARS = 6000;

// What the writer is told about one video.
export interface WriterInput {
  // The words on the output timeline.
  words: EditWord[];
  // The slots the writer may write for.
  slots: Slot[];
  // The video's language (ISO 639-3), when the transcriber reported it.
  language?: string;
  // The brand's voice and banned words, when the workspace has them.
  voice?: string;
  bannedWords?: string[];
}

// The transcript as one text, cut at a word when it is too long.
const transcriptOf = (words: EditWord[]) => {
  const text = words.map((w) => w.w).join(' ');
  return text.length <= MAX_TRANSCRIPT_CHARS
    ? text
    : text.slice(0, MAX_TRANSCRIPT_CHARS).replace(/\s+\S*$/, '');
};

// One line of the slot list: its id, the keyword in brackets and the words around it.
const slotLine = (slot: Slot, words: EditWord[]) => {
  const from = Math.max(0, slot.word_index - CONTEXT_WORDS);
  const around = words
    .slice(from, slot.word_index + CONTEXT_WORDS + 1)
    .map((w) => (w.i === slot.word_index ? `[${w.w}]` : w.w))
    .join(' ');
  return `${slot.id}${slot.reasons.includes('hook') ? ' (hook)' : ''}: ${around}`;
};

// The messages of the writer call: the rules, then the brand and the video.
export const writerMessages = (input: WriterInput) => {
  const parts = [EDIT_WRITER_PROMPT];
  parts.push(
    `Language of the transcript: ${
      input.language || 'the same language as the transcript'
    }.`
  );
  if (input.voice?.trim()) {
    parts.push(`The brand's voice:\n${input.voice.trim()}`);
  }
  if (input.bannedWords?.length) {
    parts.push(
      `Banned words and phrases (never use them):\n${input.bannedWords
        .map((b) => `- ${b}`)
        .join('\n')}`
    );
  }
  parts.push(`Transcript:\n${transcriptOf(input.words)}`);
  parts.push(
    `Slots:\n${input.slots.map((s) => slotLine(s, input.words)).join('\n')}`
  );
  return [{ role: 'user' as const, content: parts.join('\n\n') }];
};
