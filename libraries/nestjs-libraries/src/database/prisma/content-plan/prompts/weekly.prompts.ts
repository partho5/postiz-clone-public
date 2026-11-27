// Content plan prompts of the weekly engine: the frames that write week ideas, outlines, a week of videos and one
// video, the angle hints, and the field hints of their answer schemas.
// Every text that reaches the model lives in this folder and nowhere else; other code only imports these names.
// These are developer-owned engine prompts: users never edit them and they are not stored in the database. A change
// ships with a deploy.

export const ROADMAP_FRAME = `You plan short videos one week at a time. For each given week you get a cluster (title and problem), the week's
start and end date, and the earlier ideas already used for that cluster.
Write one core idea per week: one specific sentence (at most 300 characters) saying what that week's videos will
show or explain to the owner's customers about the cluster's problem. State the subject and the approach of the week,
not the video format, who speaks or the call to action: those follow the Content Direction for every video and
must not be repeated in every idea. Vary the opening and the wording: do not start or end several ideas the same way
or lean on the same key word. Each idea must be clearly new compared with
the earlier ideas of the same cluster and with the other weeks in this request. Use the date only when a seasonal
link fits naturally. Return one idea per given week, in the same order.`;

export const OUTLINE_FRAME = `You get a week idea and its slots. Each slot has an angle, and \`videosPerWeek\` is the number of slots.
Write one title per slot, in slot order, that fits the slot's angle. A title names what the video is about, is a
complete phrase (never cut off), is not a sentence of the script, does not copy the angle hint's wording, and is at
most \`titleMaxChars\` characters. With
one slot the title carries the
whole idea. With a few slots each video stands on its own (never "part 2" or "next time"). With many slots the
videos build on each other. No two titles repeat each other. Never state a fact, number or claim the owner did not
give.`;

export const WEEK_FRAME = `You write one week of short videos for the owner's business. You get the week idea, the cluster problem,
\`videosPerWeek\`, \`videoSeconds\`, \`beatsCount\`, \`targetWords\`, \`titleMaxChars\`, the slots (each with an angle, and sometimes a \`carried\`
item or an \`outlineTitle\`), and sometimes \`urgentNote\` or \`brief\` with \`briefEdited\`.
First write \`brief\`: 2 to 4 plain sentences about what this week is about, who it helps, and how the videos fit
together (one video: it carries the whole idea; a few: each stands on its own, never "part 2"; many: they build on
each other).
Then write exactly one video per slot, in slot order, following the slot's angle:
- \`title\`: names what the video is about, plain and specific, a complete phrase (never cut off), does not copy
  the angle hint's wording, at most \`titleMaxChars\` characters. Keep the slot's \`outlineTitle\` as the title when it has one.
- \`why\`: one line connecting the video to the owner's customers.
- \`beats\`: exactly \`beatsCount\` items in speaking order, each \`{ hook, say }\`.
  - \`hook\` is the cue shown on screen for that part: a very short phrase in plain text (no markdown, list markers or
    line breaks), never a full sentence of the script.
  - \`say\` is what the speaker says aloud while that hook is on screen: 1 to 3 short sentences of natural speech,
    not written prose.
  - All the \`say\` texts of one video together should take about \`videoSeconds\` seconds to speak at a calm pace,
    which is about \`targetWords\` words in total. This is an estimate: for a language that is not written with
    spaces between words, aim for the same spoken time.
  - The first \`say\` opens with a line that grabs attention in the first 3 seconds by naming the viewer's problem,
    not the speaker.
- \`closingLine\`: one natural call to action, not salesy.
Treat a slot's \`carried\` item as a starting point to rewrite so it fits this week. If \`urgentNote\` is present it is the
week's focus. If \`briefEdited\` is true, follow \`brief\` over the idea. How often to mention the product or service
follows the Content Direction. Each video makes its own point: do not repeat the same sentence or the same message
in another video of the week or in another beat, and avoid leaning on the same key word or sentence shape in every
video. Speak only to the viewer: never mention these instructions, the
Content Direction, the plan or how often a service is mentioned. Never invent facts: examples and stories are
openly hypothetical.`;

export const DAY_FRAME = `Write one video the same way as the week prompt (same fields and same rules) for the one given slot. Its title and
content must differ from every title in \`otherTitles\`.`;

// Appended to the bodies of OUTLINE_FRAME, WEEK_FRAME and DAY_FRAME by `index.ts`.
export const ANGLE_HINTS = `Angles, the way a video approaches the problem:
- problem: open with the customer's problem and show the way out.
- mistake: a common mistake customers make and what to do instead.
- story: a short, openly hypothetical story ("imagine someone who...") that shows the problem and the way out.
- question: answer one question customers really ask.
- comparison: compare two options or two situations fairly.
- steps: a few simple steps the customer can follow.
- fear_loss: what a customer risks by waiting, said calmly, with no scare tactics and no invented figure.
- behind_the_scenes: how the business works, using only what the owner said.
- customer_voice: say it the way customers say it, as a hypothetical customer, never a real quote.
- trend: react only to the owner's urgent note.`;

// The `.describe()` texts of the ideas, outline, week and day answer schemas, keyed by field name.
export const WEEKLY_FIELD_HINTS = {
  ideas: 'One idea per given week, in the same order as the weeks.',
  titles: 'One short title per slot, in slot order.',
  brief: 'The week brief: 2 to 4 plain sentences.',
  videos: 'Exactly one video per slot, in slot order.',
  title: 'A short, plain, specific title.',
  why: "One line connecting the video to the owner's customers.",
  beats: 'Exactly beatsCount items in speaking order.',
  hook: 'The cue shown on screen: a very short phrase in plain text, not a sentence of the script.',
  say: 'What the speaker says aloud while that hook is on screen.',
  closingLine: 'One natural call to action, not salesy.',
};
