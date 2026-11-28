// Standalone test of the content plan flow. It reads every prompt text straight out of to-build/tasks.md (B1 step 4), so it
// tests the written plan and not anyone's copy of it. It makes real calls to the Meta Model API and writes every step's
// input and output, plus REPORT.md, to scripts/content-plan-flow-test-output/<time>/.
//
// Run (from the repo root):
//   node --env-file=.env scripts/content-plan-flow-test.mjs
// Options: --input <text file>   the owner's business text (default: a built-in neutral example)
//          --videos <1-7>        videos per week (default 3)      --rounds <n>  max setup rounds (default 3)
//          --name <brand name>   --locale <code> (default en)      --tasks <path to tasks.md>
//
// Where tasks.md is silent the script has to choose; every such choice is listed under "Where tasks.md was silent" in the report.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const TASKS = opt('tasks', path.join(HERE, '..', 'to-build', 'tasks.md'));
const N = Number(opt('videos', 3));
const MAX_ROUNDS = Number(opt('rounds', 3));
const BRAND = { name: opt('name', 'Brightside Dental'), locale: opt('locale', 'en') };
const KEY = process.env.META_MUSE_API_KEY;
if (!KEY) throw new Error('META_MUSE_API_KEY is not set (run with: node --env-file=.env ...)');
if (![1, 2, 3, 4, 5, 6, 7].includes(N)) throw new Error('--videos must be 1-7');

const DEFAULT_SOURCE = `We run Brightside Dental, a family dental clinic in a mid-sized city. We offer checkups, cleaning, fillings, root canal treatment, braces and children's dentistry.
Our patients are mostly working adults aged 25 to 45 and parents of young children. Many put off visits because they are afraid it will hurt and they believe treatment is very expensive. Some think a root canal means losing the tooth.
We want calm, friendly, honest videos. Videos should be about a minute long.`;
const SOURCE_TEXT = opt('input', null) ? readFileSync(opt('input'), 'utf8').trim() : DEFAULT_SOURCE;

// ---------- constants copied from tasks.md "Shared types"
const MODEL = 'muse-spark-1.3-contributor';
const ANGLES = ['problem', 'mistake', 'story', 'question', 'comparison', 'steps', 'fear_loss', 'behind_the_scenes', 'customer_voice', 'trend'];
const ROADMAP_WEEKS = 12, PREVIEW_WEEKS = 4, SLIDE_TEXT_MAX = 200;
const LIMITS = { title: 60, why: 240, hook: 100, idea: 300, brief: 2000, say: 2000, closingLine: 600 };
const SLOT_DAYS = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 5], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5], 7: [0, 1, 2, 3, 4, 5, 6] };
const beatsFor = (s) => (s <= 45 ? 3 : s <= 75 ? 4 : s <= 105 ? 5 : 6);
const WORDS_PER_SECOND = 2.3;
const targetWordsFor = (s) => Math.round(s * WORDS_PER_SECOND);
const DEFAULT_VIDEO_SECONDS = 60;

// ---------- prompts: read from tasks.md, never retyped here
const tasksText = readFileSync(TASKS, 'utf8');
function promptFromTasks(name) {
  const at = tasksText.indexOf('- `' + name + '` (');
  if (at < 0) throw new Error('prompt ' + name + ' not found in tasks.md');
  const open = tasksText.indexOf('```', at);
  const start = tasksText.indexOf('\n', open) + 1;
  const close = tasksText.indexOf('```', start);
  const lines = tasksText.slice(start, close).replace(/\s+$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}
const P = Object.fromEntries(['PLANNER_RULES', 'SETUP_FRAME', 'PROPOSAL_FRAME', 'ROADMAP_FRAME', 'OUTLINE_FRAME', 'WEEK_FRAME', 'DAY_FRAME', 'ANGLE_HINTS']
  .map((n) => [n, promptFromTasks(n)]));
const labelMatch = tasksText.match(/brand: '([^']+)', language: '([^']+)', facts: '([^']+)', direction: '([^']+)'/);
if (!labelMatch) throw new Error('BRAND_CONTEXT_LABELS not found in tasks.md');
const LABELS = { brand: labelMatch[1], language: labelMatch[2], facts: labelMatch[3], direction: labelMatch[4] };
const FRAMES = {
  setup: { body: P.SETUP_FRAME, effort: 'low' },
  proposal: { body: P.PROPOSAL_FRAME, effort: 'medium' },
  roadmap: { body: P.ROADMAP_FRAME, effort: 'medium' },
  outline: { body: P.OUTLINE_FRAME + '\n\n' + P.ANGLE_HINTS, effort: 'medium' },
  week: { body: P.WEEK_FRAME + '\n\n' + P.ANGLE_HINTS, effort: 'medium' },
};

// ---------- small rules (tasks.md B2/B3 "rules")
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const localToday = (now, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const chars = (t) => Array.from(t);
function cutAtWord(text, max) {
  const c = chars(text);
  if (c.length <= max) return text;
  const head = c.slice(0, max).join('');
  const sp = head.lastIndexOf(' ');
  return (sp > max * 0.5 ? head.slice(0, sp) : head).trim();
}
function cleanSlideText(text) {
  let s = String(text).replace(/[\t\r\n]+/g, ' ').replace(/^\s*(?:[-*•#]+|\d+[.)])\s+/, '').replace(/(\*\*|__|`)/g, '').replace(/\s+/g, ' ').trim();
  const q = s.match(/^(["“'‘«「『])(.*)(["”'’»」』])$/);
  if (q) s = q[2].trim();
  return cutAtWord(s, SLIDE_TEXT_MAX);
}
const stableJson = (o) => JSON.stringify(o);
function brandContextMessage({ name, locale, facts, direction }) {
  const parts = [`${LABELS.brand}: ${name}`, `${LABELS.language}: ${locale}`];
  if (facts) parts.push(`${LABELS.facts}:\n${stableJson(facts)}`);
  if (direction) parts.push(`${LABELS.direction}:\n${direction}`);
  return parts.join('\n\n');
}
function rotationOrder(themes, clusters) {
  const queues = themes.map((t) => clusters.filter((c) => c.themeRef === t.ref));
  const out = [];
  for (let i = 0; queues.some((q) => q.length > i); i++) queues.forEach((q) => q[i] && out.push(q[i].ref));
  return out;
}
function pickAngles(count, lastUse, exclude, allowTrend, seed) {
  const cands = ANGLES.filter((a) => !exclude.includes(a) && (allowTrend || a !== 'trend'));
  const start = seed % cands.length;
  const ordered = [...cands.slice(start), ...cands.slice(0, start)]
    .sort((a, b) => (lastUse.get(a) ?? '') < (lastUse.get(b) ?? '') ? -1 : (lastUse.get(a) ?? '') > (lastUse.get(b) ?? '') ? 1 : 0);
  return Array.from({ length: count }, (_, i) => ordered[i % ordered.length]);
}

// ---------- model call (tasks.md "Decisions → Model" and "Token caching")
const OUT = path.join(HERE, 'content-plan-flow-test-output', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(OUT, { recursive: true });
const steps = [];
let sendRetention = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chat(label, key, messages, schema, schemaName) {
  const frame = FRAMES[key];
  for (let attempt = 0; ; attempt++) {
    const body = { model: MODEL, reasoning_effort: frame.effort, max_completion_tokens: 16000, messages,
      response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } },
      prompt_cache_key: 'content-plan:' + key, ...(sendRetention ? { prompt_cache_retention: '24h' } : {}) };
    const t0 = Date.now();
    const res = await fetch('https://api.meta.ai/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(180000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = json.choices?.[0]?.message?.content ?? '';
      const u = json.usage ?? {};
      const usage = { prompt: u.prompt_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, completion: u.completion_tokens ?? 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0, seconds: Math.round((Date.now() - t0) / 100) / 10 };
      const n = String(steps.length + 1).padStart(2, '0');
      steps.push({ n, label, key, usage });
      writeFileSync(path.join(OUT, `${n}-${label}.json`), JSON.stringify({ key, effort: frame.effort, messages, output: text, usage }, null, 2));
      console.log(`${n} ${label}  prompt ${usage.prompt} cached ${usage.cached} completion ${usage.completion}  ${usage.seconds}s`);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error(label + ': the answer is not valid JSON'); }
      return { data: parsed, text };
    }
    const msg = JSON.stringify(json);
    if (res.status === 400 && sendRetention && msg.includes('prompt_cache_retention')) { sendRetention = false; continue; }
    if ([429, 500, 503].includes(res.status) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
    throw new Error(`${label} failed: ${res.status} ${msg.slice(0, 300)}`);
  }
}
const str = { type: 'string' };
const num = { type: 'number' };
const list = (items) => ({ type: 'array', items });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMAS = {
  setup: obj({ direction: str, questions: list(obj({ text: str, options: list(str), recommendedIndex: num })), readyForPlan: { type: 'boolean' } }),
  proposal: obj({ facts: obj({ whatWeDo: str, audience: str, problems: list(str), solution: str, objections: list(str), tone: str, videoSeconds: num }),
    themes: list(obj({ ref: str, name: str, description: str })), clusters: list(obj({ ref: str, themeRef: str, title: str, problem: str })) }),
  ideas: obj({ ideas: list(str) }),
  outline: obj({ titles: list(str) }),
  week: obj({ brief: str, videos: list(obj({ title: str, why: str, beats: list(obj({ hook: str, say: str })), closingLine: str })) }),
};
// Field hints (the .describe() texts) are prompt text too: read them from tasks.md "Field hints (final)" and attach them.
const HINTS = {};
{
  const at = tasksText.indexOf('**Field hints (final)**');
  const open = tasksText.indexOf('```', at), start = tasksText.indexOf('\n', open) + 1, close = tasksText.indexOf('```', start);
  let group = null;
  for (const line of tasksText.slice(start, close).split('\n')) {
    const m = line.trim().match(/^(?:(setup|proposal|ideas|outline|week) answer\s+)?(\w+)\s+(.+)$/);
    if (!m) continue;
    if (m[1]) group = m[1];
    (HINTS[group] ??= {})[m[2]] = m[3].trim();
  }
}
function describeAll(schema, hints) {
  if (schema.type === 'object') for (const [k, v] of Object.entries(schema.properties)) { if (hints[k]) v.description = hints[k]; describeAll(v, hints); }
  if (schema.type === 'array') describeAll(schema.items, hints);
}
for (const [k, schema] of Object.entries(SCHEMAS)) { if (!HINTS[k]) throw new Error('no field hints for ' + k + ' in tasks.md'); describeAll(schema, HINTS[k]); }

// Message order from tasks.md: RULES, brand context, frame, then the task or the chat turns.
const ask = (label, key, ctx, tail, schemaKey) => chat(label, key,
  [{ role: 'developer', content: P.PLANNER_RULES }, { role: 'user', content: brandContextMessage(ctx) },
    { role: 'developer', content: FRAMES[key].body }, ...tail], SCHEMAS[schemaKey], schemaKey);

// ================= THE FLOW =================
const today = localToday(new Date(), 'UTC');

// 1. Setup rounds: an append-only chat. The owner's answers are the recommended options (the UI pre-selects them).
let turns = [];
let userTurn = stableJson({ sourceText: SOURCE_TEXT });
let direction = '';
let round = 0;
for (; round < MAX_ROUNDS; round++) {
  const { data, text } = await ask('setup-round-' + round, 'setup', { ...BRAND, facts: null, direction: null }, [...turns, { role: 'user', content: userTurn }], 'setup');
  turns = [...turns, { role: 'user', content: userTurn }, { role: 'assistant', content: text }];
  direction = data.direction;
  const questions = data.questions.slice(0, 4).filter((q) => q.options.length >= 2).map((q) => ({ ...q, options: q.options.slice(0, 4) }));
  if (data.readyForPlan || questions.length === 0) break;
  const answers = questions.map((q) => ({ question: q.text, answer: q.options[q.recommendedIndex] ?? q.options[0] }));
  userTurn = stableJson({ answers, editedDirection: null });
}

// 2. Proposal: structure (append-only chat), then ideas for 12 weeks, then outlines for the first 4 weeks.
const prop = (await ask('proposal-structure', 'proposal', { ...BRAND, facts: null, direction: null },
  [{ role: 'user', content: stableJson({ direction }) }], 'proposal')).data;
const themes = prop.themes.slice(0, 6);
const clusters = prop.clusters.filter((c) => themes.some((t) => t.ref === c.themeRef));
if (themes.length < 3 || themes.some((t) => !clusters.some((c) => c.themeRef === t.ref))) throw new Error('proposal: themes/clusters unusable');
const videoSeconds = [30, 60, 90, 120].includes(prop.facts.videoSeconds) ? prop.facts.videoSeconds : DEFAULT_VIDEO_SECONDS;
const facts = { ...prop.facts, videoSeconds };
const proposalCtx = { ...BRAND, facts, direction };

const rotation = rotationOrder(themes, clusters);
const byRef = Object.fromEntries(clusters.map((c) => [c.ref, c]));
const weeks = Array.from({ length: ROADMAP_WEEKS }, (_, i) => ({ number: i, weekStart: addDays(today, i * 7), cluster: byRef[rotation[i % rotation.length]] }));
const ideas = (await ask('roadmap-ideas', 'roadmap', proposalCtx, [{ role: 'user', content: stableJson({ weeks: weeks.map((w) => ({
  weekStart: w.weekStart, weekEnd: addDays(w.weekStart, 6), clusterTitle: w.cluster.title, problem: w.cluster.problem, previousIdeas: [] })) }) }], 'ideas')).data.ideas;
if (ideas.length !== weeks.length) throw new Error(`ideas: asked for ${weeks.length}, got ${ideas.length}`);
weeks.forEach((w, i) => { w.idea = cutAtWord(ideas[i], LIMITS.idea); });

for (const w of weeks.slice(0, PREVIEW_WEEKS)) {
  const angles = pickAngles(N, new Map(), [], false, w.number);
  const titles = (await ask('outline-week-' + (w.number + 1), 'outline', proposalCtx, [{ role: 'user', content: stableJson({
    idea: w.idea, clusterTitle: w.cluster.title, problem: w.cluster.problem, videosPerWeek: N, titleMaxChars: LIMITS.title, slots: angles.map((angle) => ({ angle })) }) }], 'outline')).data.titles;
  if (titles.length !== N) throw new Error(`outline week ${w.number + 1}: asked for ${N}, got ${titles.length}`);
  w.outlineRaw = titles;
  w.outline = angles.map((angle, i) => ({ title: cutAtWord(titles[i], LIMITS.title), angle }));
}

// 3. Confirm (no model call), then week 1 is generated: slots from the database value N, then one model call.
const w1 = weeks[0];
const slots = SLOT_DAYS[N].map((offset, i) => ({ dayIndex: offset, date: addDays(w1.weekStart, offset), angle: w1.outline[i].angle, outlineTitle: w1.outline[i].title }));
const beatsCount = beatsFor(videoSeconds), targetWords = targetWordsFor(videoSeconds);
const week = (await ask('week-1', 'week', proposalCtx, [{ role: 'user', content: stableJson({
  idea: w1.idea, clusterTitle: w1.cluster.title, problem: w1.cluster.problem, brief: null, briefEdited: false, urgentNote: null, otherTitles: [],
  slots, videosPerWeek: N, videoSeconds, beatsCount, targetWords, titleMaxChars: LIMITS.title }) }], 'week')).data;
if (week.videos.length !== N) throw new Error(`week 1: asked for ${N} videos, got ${week.videos.length}`);

// 4. Clamp, map to slots by position, build the phone JSON.
const days = week.videos.map((v, i) => {
  const beats = v.beats.map((b) => ({ hook: cutAtWord(cleanSlideText(b.hook), LIMITS.hook), say: b.say.trim() })).filter((b) => b.hook && b.say).slice(0, 6);
  if (beats.length < 3) throw new Error(`video ${i + 1}: fewer than 3 usable beats`);
  return { id: 'test-day-' + (i + 1), date: slots[i].date, dayIndex: slots[i].dayIndex, title: cutAtWord(v.title.trim(), LIMITS.title), angle: slots[i].angle,
    why: cutAtWord(v.why.trim(), LIMITS.why), beats, closingLine: v.closingLine.trim(), status: 'PLANNED', version: 1 };
});
const phone = { status: 'ACTIVE', today, timezone: 'UTC', week: { id: 'test-week-1', weekStart: w1.weekStart, weekEnd: addDays(w1.weekStart, 6),
  idea: w1.idea, status: 'READY', days } };
writeFileSync(path.join(OUT, 'phone-json.json'), JSON.stringify(phone, null, 2));
writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({ direction, facts, themes, clusters, weeks: weeks.map((w) => ({ week: w.number + 1, weekStart: w.weekStart,
  cluster: w.cluster.title, idea: w.idea, outline: w.outline ?? null })) }, null, 2));

// ================= CHECKS (tasks.md Verification 5, what a script can check) =================
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
const allText = [direction, JSON.stringify(facts), ...themes.map((t) => t.name + ' ' + t.description), ...weeks.map((w) => w.idea),
  ...days.map((d) => [d.title, d.why, d.closingLine, ...d.beats.flatMap((b) => [b.hook, b.say])].join(' '))].join(' ');
const given = SOURCE_TEXT + ' ' + String(videoSeconds) + ' ' + String(N);
const numbers = [...new Set(allText.match(/\d+/g) ?? [])].filter((x) => !given.includes(x));
check('12 weekly ideas, all different', new Set(weeks.map((w) => w.idea)).size === ROADMAP_WEEKS);
check(`exactly ${N} videos on the SLOT_DAYS offsets ${JSON.stringify(SLOT_DAYS[N])}`, days.length === N && days.every((d, i) => d.dayIndex === SLOT_DAYS[N][i]));
check(`every video has ${beatsCount} beats`, days.every((d) => d.beats.length === beatsCount), days.map((d) => d.beats.length).join(','));
check(`every hook is at most ${LIMITS.hook} characters`, days.every((d) => d.beats.every((b) => chars(b.hook).length <= LIMITS.hook)));
check('outline titles were kept as the video titles', days.every((d, i) => d.title === slots[i].outlineTitle), days.map((d, i) => d.title === slots[i].outlineTitle).join(','));
check('no title was cut by the character limit (the model respected titleMaxChars)', weeks.slice(0, PREVIEW_WEEKS).every((w) => w.outline.every((o, i) => o.title === w.outlineRaw[i])) && days.every((d, i) => d.title === week.videos[i].title.trim()));
check('no number appears that is not in the owner text (possible invention)', numbers.length === 0, numbers.join(', '));
const sayWords = days.map((d) => d.beats.map((b) => b.say.trim().split(/\s+/).length).reduce((a, b) => a + b, 0));
check(`spoken text is near the ${targetWords}-word estimate (whitespace count, only meaningful for languages written with spaces)`,
  sayWords.every((w) => w >= targetWords * 0.7 && w <= targetWords * 1.3), sayWords.join(', ') + ' words');
const outlineCalls = steps.filter((s) => s.label.startsWith('outline-week-'));
check('later outline calls reuse the cached shared start (cached > 0)', outlineCalls.slice(1).every((s) => s.usage.cached > 0), outlineCalls.map((s) => s.usage.cached).join(', '));
check('same language as the owner text', true, 'NOT CHECKED BY CODE: read the output');
check('stories and examples are openly hypothetical', true, 'NOT CHECKED BY CODE: read the output');

// tasks.md now specifies the answer schemas, field hints, brand-context layout, message keys and the answer turn. What is left to the script:
const gaps = [
  'Setup in a non-interactive test: the script answers every question with its recommended option and stops at readyForPlan or after the round limit.',
  'Previous ideas for the first 12 weeks are sent empty (tasks.md has them only for later top-ups).',
];
const total = steps.reduce((a, s) => ({ prompt: a.prompt + s.usage.prompt, cached: a.cached + s.usage.cached, completion: a.completion + s.usage.completion }), { prompt: 0, cached: 0, completion: 0 });
const report = `# Content plan flow test

Run: ${new Date().toISOString()} | model ${MODEL} | videosPerWeek ${N} | setup rounds ${round + 1} | prompts read from ${TASKS}

## Calls
| # | Step | Prompt tokens | Cached | Completion | Seconds |
|---|---|---|---|---|---|
${steps.map((s) => `| ${s.n} | ${s.label} | ${s.usage.prompt} | ${s.usage.cached} | ${s.usage.completion} | ${s.usage.seconds} |`).join('\n')}

Total: prompt ${total.prompt}, cached ${total.cached}, completion ${total.completion}.

## Checks
${checks.map((c) => `- [${c.ok ? 'x' : ' '}] ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`).join('\n')}

## What the script had to choose itself
${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}

## Files
Each call's exact messages and output: the numbered .json files. The plan: plan.json. What the phone reads: phone-json.json.
`;
writeFileSync(path.join(OUT, 'REPORT.md'), report);
console.log('\n' + checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`).join('\n'));
console.log('\nOutput:', OUT);
