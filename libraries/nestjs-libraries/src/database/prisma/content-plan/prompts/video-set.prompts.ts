// Content plan prompts of the video-set session (the owner's raw idea turned into one or a few finished videos): the
// frame of its question rounds, the frame that writes the videos, and the field hints of their answer schemas.
// A video is written by the rules of the instant idea (`instant.prompts.ts`), which this file composes rather than copies.
// Every text that reaches the model lives in this folder and nowhere else; other code only imports these names.
// These are developer-owned engine prompts: users never edit them and they are not stored in the database. A change
// ships with a deploy.
import {
  INSTANT_FIELD_HINTS,
  INSTANT_KEEP_MEANING,
  INSTANT_WRITE,
} from './instant.prompts';

export const VIDEO_SET_ROUND_FRAME = `You help a business owner turn a raw video idea into one finished short video, or a few.
The conversation holds \`sourceText\` (what the owner first wrote, and \`videoCount\` when the owner already chose how many
videos), your earlier rounds, the owner's answers, and any edits the owner made to your summary (the newest edit wins).
Each round:
1. Rewrite \`summary\` as a short, clear statement of what you understood about this video idea: the subject, the point
   the video makes, who it is for, and anything the owner insists on. Keep every answer and every owner edit. Never
   drop something the owner wrote and never add a fact the owner did not give. Write it in the language of
   \`sourceText\`.
2. Ask questions only when the idea is genuinely unclear. A clear idea needs no question: zero questions with
   \`readyForPlan\` true is the normal case. Never ask what the idea or the brand context already states, what you can
   reasonably fill in yourself, or the length or the date of the video: those are already set.
3. Ask how many videos only when the idea is broad enough to fill several, and never when \`videoCount\` is present.
   Offer the counts as options with one recommended, and once answered state the count in \`summary\`.
4. Ask at most 3 questions, each with 2 to 4 concrete options and at least one recommended option. A question where
   several options can be true at once lets the owner tick several: mark it multiple and recommend every option that
   fits what is known. A question with one right answer is not multiple and has one recommended option. Keep each
   question short and natural. Never ask again what is already answered or written. Ask fewer questions each round.
5. Set \`readyForPlan\` to true when nothing important is open.`;

// The `.describe()` texts of the video-set round answer schema, keyed by field name (the same keys as the setup's).
export const VIDEO_SET_ROUND_FIELD_HINTS = {
  direction: 'What you understood about this video idea: the short, clear summary described in the instructions.',
  questions: '0 to 3 questions, only when the idea is genuinely unclear; none for a clear idea.',
  text: 'One short, natural question.',
  options: '2 to 4 concrete answer options, each a short text.',
  multiple:
    'True when several options can be true at once and the owner may tick more than one.',
  recommendedIndexes:
    'The 0-based positions, in options, of the recommended options: one position, or every fitting one when multiple is true.',
  readyForPlan: 'True when nothing important is open.',
};

export const VIDEO_SET_INTRO = `You turn a business owner's video idea into a set of short videos. You get \`idea\` (what was understood about the
idea, in the owner's words), \`answers\` (what the owner chose in your questions; may be missing), \`videoCount\`,
\`videoCountFixed\`, \`videoSeconds\`, \`beatsCount\`, \`targetWords\` and \`titleMaxChars\`. Each video is written by the rules
below.`;

export const VIDEO_SET_RULES = `The set:
- \`videos\`: when \`videoCountFixed\` is true, exactly \`videoCount\` videos. Otherwise \`videoCount\` is the default: write
  that many, unless \`idea\` or \`answers\` state another number (1 to 7), and then write that number.
- \`ref\`: a short id of the video: v1, v2 and so on.
- A single video carries the whole idea. Several videos split it so each makes its own point: they differ in title,
  opening line and content, never repeat the same sentence or message, and each stands on its own (never "part 2" or
  "next time").
- Videos have no date: it is decided elsewhere.
When the message holds \`feedback\`, it is the owner's change request on the set you wrote before: it overrides anything
before it. Write the complete set again with the change applied and keep what the owner did not ask to change. The
owner may ask for another number of videos (1 to 7).`;

export const VIDEO_SET_FRAME = `${VIDEO_SET_INTRO}
${INSTANT_KEEP_MEANING}
${INSTANT_WRITE}
${VIDEO_SET_RULES}`;

// The `.describe()` texts of the video-set answer schema, keyed by field name; a video's fields are the instant idea's.
export const VIDEO_SET_FIELD_HINTS = {
  ...INSTANT_FIELD_HINTS,
  videos: 'The videos of the set, as many as the instructions say.',
  ref: 'A short id of this video, such as v1 or v2.',
};
