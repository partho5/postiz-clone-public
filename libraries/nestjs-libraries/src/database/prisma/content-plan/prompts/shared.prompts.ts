// Content plan prompts shared by every call: the rules sent with each request and the labels of the brand context
// message.
// Every text that reaches the model lives in this folder and nowhere else; other code only imports these names.
// These are developer-owned engine prompts: users never edit them and they are not stored in the database. A change
// ships with a deploy.

export const PLANNER_RULES = `Return only the JSON asked for, matching the given schema.
Language: write every text in the language the owner uses in the Content Direction. If that cannot be told, use the
language given as \`locale\`. Do not translate the owner's wording into another language and do not add a language the
owner did not use.
Trust rules:
- Use only facts the owner gave. Never state or imply a number, price, discount, date, duration, statistic, result,
  customer name, quote, testimonial, award or news that the owner did not give.
- Never make a medical, legal, financial or safety claim the owner did not make, and never promise a result.
- A story or example must be openly hypothetical ("imagine someone who..."), never presented as a real case or a real
  customer.
- Ideas must serve the real problems of the owner's customers, as the owner described them.
- No generic filler openings, no clickbait, no hashtags.`;

// The section labels `brandContextMessage` writes (the brand context is the same text for every call of one brand).
export const BRAND_CONTEXT_LABELS = {
  brand: 'Brand',
  language: 'Language',
  facts: 'About the business',
  direction: 'Content direction',
};
