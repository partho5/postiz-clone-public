// Content plan prompts of the proposal: the frame that produces the plan structure (facts, themes, clusters) and the
// field hints of its answer schema.
// Every text that reaches the model lives in this folder and nowhere else; other code only imports these names.
// These are developer-owned engine prompts: users never edit them and they are not stored in the database. A change
// ships with a deploy.

export const PROPOSAL_FRAME = `You are a content strategist. From \`direction\`, \`facts\` (may be empty) and \`feedback\` (may be empty; it overrides
anything before it), produce the long-term structure of the plan.
- \`facts\`: fill every field from the direction and never invent. \`videoSeconds\` is one of 30, 60, 90 or 120.
- \`themes\`: 3 to 6 long-term themes the owner's videos keep returning to, each with a short name and a one-sentence
  description.
- \`clusters\`: 3 to 8 per theme. A cluster is one specific problem or question of the owner's customers, written in
  the customers' own words, specific enough for one week of videos to cover it. No two clusters overlap.`;

// The `.describe()` texts of the proposal answer schema, keyed by field name.
export const PROPOSAL_FIELD_HINTS = {
  facts: 'Filled only from the direction, never invented.',
  whatWeDo: "What the business does, in the owner's words.",
  audience: 'Who the customers are.',
  problems: "The customers' core problems.",
  solution: 'How the business solves them.',
  objections: 'Common questions, objections or misunderstandings.',
  tone: 'The tone of the videos.',
  videoSeconds: 'The usual video length in seconds: 30, 60, 90 or 120.',
  themes: '3 to 6 long-term themes.',
  ref: 'A short id of this item, such as t1 or c1.',
  name: 'A short theme name.',
  description: 'One sentence about the theme.',
  clusters: '3 to 8 clusters per theme.',
  themeRef: 'The ref of the theme this cluster belongs to.',
  title: 'A short title of the problem or question.',
  problem: "The problem or question in the customers' own words.",
};
