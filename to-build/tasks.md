<!-- runner-config
REPOS=/home/haku/projects/Next.js/Social-Media-Manager
BRANCH=feat/ai-video-edit
-->

RULE: this PC hangs under load, so do not run `pnpm build`, tests, specs, the dev server or any other heavy command.
Write code only, and verify at code level (read the code against the contract). Specs are still written with every card;
the owner runs them on a higher-RAM PC (they push, pull, run `pnpm build` and the specs there). If a check genuinely
needs a run, stop and ask the user.

build one at a time.
and self track progress. you can update this file if needed.
-----------------

<!-- runner-config
REPOS=/home/haku/projects/Next.js/Social-Media-Manager /home/haku/projects/AndroidStudioProjects/FaceCam-Presentation-Recorder
BRANCH=feat/content-plan
-->

# AI content plan — backend + web side (cards B1-B7, decided 2026-11-22)

The phone half is in `/home/haku/projects/AndroidStudioProjects/FaceCam-Presentation-Recorder/to-build/tasks.md`
(cards P1-P4; it copies the **API contract** below and codes against it).

One card = one sub-agent session. Build exactly one card, tick it in **Progress**, commit, stop. A card is self-contained:
read **Shared context**, then the card's own "Read first" list. Branch `feat/content-plan` (create it from the current
`development` HEAD if it does not exist).

## Shared context

### Goal
The owner of a brand explains their business once. From then on the AI plans short videos for years: one core idea per week,
`videosPerWeek` videos per week (1 to 7, the owner's one setting, default 3). Each video has a title, an angle, a one-line "why this helps your business", 3-6 **beats** and a closing
line. A beat is `{ hook, say }`: `hook` is the short hint shown on screen while recording (it stays in the video); `say` is
the script spoken while that hook is on screen. The phone app only shows and records; all thinking happens here.
The test for every choice is the end user: **trust, satisfaction, less cognitive effort**. Nothing may feel forced, and
nothing may change without the user seeing it.

### What people see (web, page "Content plan" at `/plan`)
1. **Setup** (no plan yet).
   - "Tell me about your business": one big textarea, pre-filled from the brand profile when it has data.
   - Then rounds. Each round shows **"Here's what I understood"**: one editable textarea, the *Content Direction*. Under it
     are 0-4 question cards: a question, 2-4 options, one option marked *Recommended* and pre-selected, plus an "Other"
     text box.
   - Buttons: **Continue** (sends the answers and the edited direction) and **Show me the plan**, which is always there from
     round 1 and becomes the primary button when the AI says it has enough.
   - There is no round counter and no limit. The AI's questions narrow down by themselves.
   - A dropdown **Videos per week** (1-7, 3 pre-selected) sits with the direction. It is a plain control, never an AI
     question.
2. **Plan preview**.
   - It shows the Content Direction, "About your business" (facts the AI filled in), 3-6 themes, and the first 4 weeks in
     full (week idea + its video titles with an angle chip, one per video) and "N videos a week". Weeks 5-12 are a collapsed list of ideas.
   - Buttons: **Confirm plan** (one confirm for everything; no partial confirm) and **Something's not right** (a textarea).
     The second one revises the whole proposal and shows it again, as often as needed.
3. **Active plan**.
   - **This week**: the week's idea and its brief (an editable textarea plus a **Regenerate** button). Under it, one
     card per video (`videosPerWeek` cards): date, title, angle chip, why line, the beats (hook in bold, its say below, expandable), the closing line, and a
     *Recorded* tick. Each card has
     **Change this topic** and, in a small menu, **Mark recorded**.
   - **Add my own idea**: a textarea (the idea) and a date picker, then **Refine**. The refined script shows as a
     day card (same layout as above, no angle chip needed). Buttons: **Add to plan** (inserts it on that date) and
     **Edit idea** (back to the textarea). Nothing is inserted before **Add to plan**. On that date the instant idea
     sits next to the AI video, with a "Your idea" chip; the AI video is not changed or moved.
   - **Something happened in my industry**: a textarea plus a button.
   - **Coming up**: weeks 2-12 as a list of ideas, each editable inline until that week starts.
   - **Content direction**: an editable textarea. Saving rewrites the coming weeks and shows the notice "Upcoming weeks
     updated to your new direction".
   - **Videos per week**: a dropdown 1-7 plus the line "Applies from next week".
   - **About your business**: editable fields.
   - **Start over**: confirm dialog, then setup again. The current week stays until the new plan is confirmed.
   - Members with role USER see everything read-only. ADMIN and SUPERADMIN can change things.
4. While AI works, the part that is working shows "Thinking…" and the page polls every 3 s. A failure shows one quiet line
   and a **Try again** button, never a stack trace.

### Decisions
- **Words**: *Content Direction* = the one user-owned instruction every AI decision follows. *Brief* = this week's
  plain-language prompt (AI writes it; the user may edit it; if not edited, it is used as is). *Theme* = pillar.
  *Cluster* = one problem or question under a theme. *Angle* = one of the fixed angle keys below. Themes, clusters and angles
  are internal words; the UI shows "themes", the week idea and an angle chip only.
- **Weeks**: a week is 7 days starting on the brand-local date the plan was confirmed. Every next week starts the day after.
  Dates are stored as `YYYY-MM-DD` strings in the brand's timezone (`Organization.timezone`, fallback `UTC`). There is no
  Monday rule.
- **Videos per week**: one number per brand, `ContentPlan.videosPerWeek` (1-7, default 3), chosen in a plain web dropdown,
  never by the AI. It is the only variable of this feature.
  - Week ideas, themes, clusters and the 12-week roadmap do **not** depend on it, so changing it never rewrites the
    roadmap.
  - It matters only when a week is expanded into videos: the week gets exactly `videosPerWeek` days, on the offsets of
    `SLOT_DAYS[videosPerWeek]` counted from the week's start. The other days of the week have no row.
  - It is read when the week is generated (at the week's start; the first week right after confirm). A week that is
    already generated keeps its days, so a change applies from the next week. Regenerate and Change this topic never add or
    remove days.
  - Saving a new value also clears the `outline` of weeks with status IDEA (their titles were written for the old count).
    No AI call.
  - Week and day prompts receive `videosPerWeek` in their input. One video: it carries the whole week idea alone. A few:
    each video stands alone, never "part 2". Many: the videos build on each other.
- **Instant idea** (the owner's own video): a row of its own kind, `kind = INSTANT_IDEA`, with its own `date`. It is not a
  day slot: it never uses or changes a `dayIndex`, and the AI days of the week stay exactly as they are. The owner types
  an idea, the AI refines it into the same shape as a day (title, why, 3-6 beats, closing line; `angle` may be empty),
  the owner sees the script, then confirms **Add to plan**. Nothing is inserted before that confirm.
  - It does **not** count toward `videosPerWeek` (for now).
  - It does **not** affect anything else: the roadmap, cluster rotation, angle last-use, the week's AI prompts or any
    other week. The AI never reads instant ideas.
  - **Discard** has no software state. A planned day the owner does not record stays on the calendar as unrecorded
    (`PLANNED` until its date passes, then `MISSED`), exactly as now.
  - Its status uses the same values as a day (`PLANNED`, `RECORDED`, `MISSED`) and **Mark recorded** works the same way.
  - The phone gets it in the same `days` list as the AI days, with `kind` set (see the API contract). The phone does
    not branch on the process; it shows and records the rows it gets.
- **Rolling roadmap**: there are always `ROADMAP_WEEKS = 12` weeks from the current one onward, each with a cluster and a
  one-line idea. When fewer remain, the next ones are written in the background, at most 12 per AI call. There is no 6- or
  12-month choice, and the roadmap never ends.
- **Cluster rotation (code, not AI)**: at confirm, clusters get a `rotationIndex` by interleaving the themes (theme1-c1,
  theme2-c1, theme3-c1, theme1-c2, …; a theme that runs out is skipped). The next week's cluster is the next
  non-archived one after the previous week's cluster in `rotationIndex` order, wrapping round.
- **Angle choice (code, not AI)**: `ANGLES = ['problem','mistake','story','question','comparison','steps','fear_loss',
  'behind_the_scenes','customer_voice','trend']`. `trend` is used only in a week with an urgent note, because there is no
  live trend data and the AI must never invent news.
  - For a cluster, an angle's *last use* = the latest date among:
    - its days with status `RECORDED`;
    - its days with status `PLANNED` in a week whose `weekStart` ≥ the current week's start;
    - its `carryIn` items.
  - Picking `count` angles: never-used first, then the oldest last use, with ties broken by `ANGLES` order. Angles already
    taken in the same week are excluded. If fewer than `count` remain, reuse from the start of the same order. The pick never fails.
- **Week content is generated at the week's start** (the hourly tick picks it up within the hour after brand-local
  midnight), so the leftovers of the week before are exactly known. The first week is generated right after confirm.
- **Leftovers (skipped days and days an urgent note displaces)**:
  - At most `CARRY_MAX = 3` go into the next not-yet-generated week as `carryIn` items `{ title, angle, clusterId }`.
    Items already there are kept first, then earliest `dayIndex` first.
  - The rest are dropped: their status becomes `MISSED`, so they do not count as used and come back later in the rotation.
  - Carried items are blended into that week's single generation at video positions 2, 4 and 6 (1-based), only where the
    position exists. So at most 0 are used for 1 video, 1 for 2-3, 2 for 4-5 and 3 for 6-7. An item that does not fit is
    ignored (it was already MISSED, so its angle comes back later). The week keeps its `videosPerWeek` videos and dates.
- **What regenerate touches**: only days with status `PLANNED` and `date >= today` (brand-local). Recorded days and past
  days are never rewritten.
- **Direction edit**:
  - Saves the direction and bumps `directionVersion`.
  - Rewrites the ideas of weeks that start after the current week, still have status `IDEA` and have
    `ideaEdited = false`. It also clears their `outline`.
  - The current week is untouched (the user edits its brief for that). Themes and clusters stay; changing them means
    *Start over*.
- **Free**: every AI call goes through `CreditsService.spend` with a price-0 action (`plan.*` keys, not `ai.*`, so the free
  plan's AI cap does not count them). Charging can later be switched on in `pricing.config.ts` without code. No
  `@RequireFeature`.
- **Silent abuse guard**: a throttler bucket per brand for `POST`/`PUT` under `/content-plan` (the existing global limit,
  `API_LIMIT`, default 90 per hour). It is not a round counter and is never shown as a limit. A 429 shows "Busy, try again in
  a minute."
- **Language**: any language. The AI writes in the language the owner uses in the Content Direction (else in the source text);
  if that can't be told, the language of `Organization.locale` (fallback `en`). There is no per-language code.
- **Model (owner call 2026-11-22)**: Meta Model API, `POST https://api.meta.ai/v1/chat/completions`, model
  `muse-spark-1.3-contributor`. Not OpenAI.
  - The facts below are from Meta's docs (https://dev.meta.ai/docs/protocols/chat-completions, `/docs/structured-output`,
    `/docs/muse-spark`, `/docs/error-handling`, read 2026-11-22).
  - The endpoint is **OpenAI-compatible**, so the existing `openai` npm client works with
    `baseURL: 'https://api.meta.ai/v1'`.
  - Auth is `Authorization: Bearer <key>`, using the deployment key `META_MUSE_API_KEY` that Muse Transcribe already uses.
    An empty key means the feature answers 503 `PLAN_NOT_AVAILABLE`, never a start-up error.
  - The answer is at `choices[0].message.content`.
  - Structured output: `response_format: { type: 'json_schema', json_schema: { name, schema, strict } }` (constrained
    decoding). `zodResponseFormat` produces exactly this.
  - The strict subset: root is a plain object; every object has `additionalProperties: false`; every property is
    `required`; no `allOf` or `oneOf`; no recursion.
  - Muse Spark is a reasoning model:
    - send `reasoning_effort` (`minimal|low|medium|high|xhigh`; `none` and `max` are refused on this variant);
    - the default is `high`, which is slow;
    - leave `temperature` unset.
  - Do not send `stop`, `n > 1`, `logit_bias`, `logprobs`, `frequency_penalty` or `presence_penalty` (400).
  - Use `max_completion_tokens`, which also covers the reasoning tokens.
  - Errors: retry 429 (honour `Retry-After`), 500 and 503 with backoff. Do not retry 400, 401, 402, 403, 404 or 504 (a 504
    is a too-long non-streaming call: lower the effort or the output instead).
  - The limit for this variant is 150 requests per minute per team, so the tick runs at most 4 plans at a time.
  - Planner prompts, the model and the effort per prompt live **only in code** (`content-plan/prompts/index.ts`). A
    change ships with a deploy (owner call 2026-11-22). The model is `muse-spark-1.3-contributor`; the effort is
    `medium`, and `low` for `setup` so a question round stays quick.
  - The existing Prompt Book (`prompt-book/*`, the AI captions prompt collection behind `/admin/prompts` and Settings →
    AI prompts) is **not used and not changed** by this feature.
  - **Contributor mode**: Meta may use prompts and answers sent to this model to train its models (standard
    `muse-spark-1.3` does not). Brand info goes into these prompts, so the privacy page must say so (B1 step 8).
- **Trust rules in every call**: they are part of `PLANNER_RULES` (exact text in B1 step 4), sent with every call: use only
  facts the owner gave, no invented number, price, duration or result, no claim the owner did not make, any story openly
  hypothetical, ideas serve the owner's customers' real problems, no generic filler.
- **Prompts live in files (owner rule 2026-11-22)**.
  - No prompt is hard-coded in code. Every text that reaches the model is a named variable in `content-plan/prompts/`,
    with related prompts in one file.
  - These are the low-level engine prompts, the ones that drive setup, the plan, the weekly brief and the content. They
    are developer-owned and never user-editable, and they are not stored in the database.
  - What users own (Content Direction, weekly brief, facts, urgent note) is per-brand data in the database. The engine
    prompts read it as input.
  - The verifier of every card greps the changed non-prompt files for prose string literals sent to the model, and fails
    the card if it finds one.
- **Token caching (owner call 2026-11-22: cache wherever it lowers cost)**.
  - The facts below are from https://dev.meta.ai/docs/prompt-caching, read 2026-11-22. Meta caches the longest identical
    **prefix** of a request automatically, with no flag. A cached input token costs $0.002/M instead of $0.10/M on the
    contributor model, and there is no write or storage charge. The response reports it in
    `usage.prompt_tokens_details.cached_tokens`.
  - So every call is built to make the shared prefix as long as possible:
    1. **Fixed message order, static first**:
       1. `developer`: `RULES` (the same for every call);
       2. `user`: the **brand context** (brand name, locale, facts, Content Direction; it changes only when the owner edits
          it);
       3. `developer`: the frame body of this kind of call (the same for every brand);
       4. only then the task message(s), which are the parts that change per call.
       The frame comes after the two shared parts on purpose: frames differ per call kind, so a frame placed first stops
       the shared start from being a cached prefix (a real run with the frame first cached 0 tokens). The owner's
       verification checks that Meta accepts a `developer` message after a `user` message.
       Nothing that changes per call (dates, ids, `today`, attempt numbers) may appear before the task message.
    2. **Byte-stable text**: the brand context is built by one function, `brandContextMessage(plan, org)`, with a fixed
       key order and fixed formatting. Never put a timestamp in it. Two calls for the same brand produce the identical
       string.
    3. **Chats are append-only**: the setup rounds and the proposal/revise loop are sent as a growing conversation, so
       everything before the newest user turn is a cached prefix.
       - Old turns are stored exactly as sent (`userTurn` / `assistantTurn`) and re-sent byte for byte, never rebuilt or
         edited.
       - An owner's edit to the direction goes into the **new** user turn (its `editedDirection` field), never
         into an older message.
       - Context therefore grows by one round each time, but the earlier rounds are billed at the cached rate.
    4. **Routing hint**: `prompt_cache_key: 'content-plan:' + promptKey` (one value per prompt kind, never per user or
       brand, as Meta advises), plus `prompt_cache_retention: '24h'`, since the hourly ticks are bursty.
       - The retention field is documented for Chat Completions in the API reference, but the caching guide describes it
         for Responses only.
       - If a call answers 400 and the error names `prompt_cache_retention`, retry once without it and stop sending it for
         the process lifetime (a module-level flag).
    5. **Batch calls that share context in a short window** (cache lifetime is not guaranteed past minutes to hours):
       - the proposal's structure, ideas and 4 outlines run one after another in the same job;
       - tick work runs by plan, so one brand's week, outline and roadmap calls happen back to back.
    6. **Measure**: after every call, log one line with ids and numbers only: `content plan tokens key=<promptKey>
       plan=<planId> prompt=<n> cached=<n> completion=<n>`. Store the same numbers in the call's credit-ledger
       `metadata` (`spend(...)` request metadata), so the owner can check the cache hit rate.
- **Phone**: reads the current week and reports "recorded"; nothing else.
  - While recording it shows only the hooks, as slides (the screen is captured, so a script on screen would end up in the
    video).
  - Practice mode, with no facecam and no recording, shows each hook with its `say` under it.
  - Writing the script per hook ties each on-screen cue to the words practised with it.
- **Video length**: `facts.videoSeconds` (30/60/90/120, default 60), set during setup and editable in "About your
  business". The number of beats comes from it (`beatsFor`). The product-mention mix lives in the Content Direction (per
  brand, owner-editable), never in code.

### Data model (Prisma, one migration `YYYYMMDDHHMMSS_content_plan`)
Add each model with a one-line comment above it (house style). Add the back-relations `contentPlan ContentPlan?` and
`planDays PlanDay[]` on `Organization`.
```prisma
// A brand's content plan: the confirmed direction the AI plans every week from. One per workspace.
model ContentPlan {
  id               String    @id @default(uuid())
  organizationId   String    @unique
  organization     Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  status           String    @default("SETUP")   // SETUP | PROPOSED | ACTIVE
  sourceText       String?   @db.Text            // what the owner first wrote about the business
  direction        String?   @db.Text            // the Content Direction
  directionVersion Int       @default(0)
  videosPerWeek    Int       @default(3)           // 1-7 videos per week, the owner's choice
  facts            Json?                          // PlanFacts
  proposal         Json?                          // PlanProposal while PROPOSED
  proposalVersion  Int       @default(0)
  proposalTurns    Json?                          // ChatTurn[] of the proposal/revise conversation, exactly as sent (cache prefix)
  busy             String?                        // 'round' | 'proposal' | 'replan' while a job runs
  notice           String?                        // 'roadmap_updated' | 'proposal_failed' | 'replan_failed'
  confirmedAt      DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  rounds           ContentPlanRound[]
  themes           PlanTheme[]
  clusters         PlanCluster[]
  weeks            PlanWeek[]
}

// One question round of a plan's setup: what the AI understood and what it asked.
model ContentPlanRound {
  id           String   @id @default(uuid())
  planId       String
  plan         ContentPlan @relation(fields: [planId], references: [id], onDelete: Cascade)
  index        Int
  direction    String   @db.Text   // the "Here's what I understood" text shown after this round
  questions    Json               // PlanQuestion[]
  answers      Json?              // PlanAnswer[] the owner sent for these questions
  readyForPlan Boolean  @default(false)
  userTurn      String  @db.Text  // the exact user message that produced this round (re-sent byte for byte later)
  assistantTurn String  @db.Text  // the exact assistant JSON text of this round (re-sent byte for byte later)
  createdAt    DateTime @default(now())
  @@unique([planId, index])
}

// A long-term theme (pillar) of a plan.
model PlanTheme {
  id          String    @id @default(uuid())
  planId      String
  plan        ContentPlan @relation(fields: [planId], references: [id], onDelete: Cascade)
  name        String
  description String?   @db.Text
  position    Int
  archivedAt  DateTime?
  clusters    PlanCluster[]
}

// One customer problem or question under a theme; a week covers one cluster.
model PlanCluster {
  id            String    @id @default(uuid())
  planId        String
  plan          ContentPlan @relation(fields: [planId], references: [id], onDelete: Cascade)
  themeId       String
  theme         PlanTheme @relation(fields: [themeId], references: [id], onDelete: Cascade)
  title         String
  problem       String    @db.Text
  rotationIndex Int
  archivedAt    DateTime?
  weeks         PlanWeek[]
  @@index([planId, rotationIndex])
}

// One week of a plan: its idea, its brief and, once generated, its videos (`videosPerWeek` days).
model PlanWeek {
  id          String    @id @default(uuid())
  planId      String
  plan        ContentPlan @relation(fields: [planId], references: [id], onDelete: Cascade)
  clusterId   String
  cluster     PlanCluster @relation(fields: [clusterId], references: [id], onDelete: Cascade)
  weekStart   String              // YYYY-MM-DD, brand-local, first of the 7 days
  idea        String    @db.Text
  ideaEdited  Boolean   @default(false)
  outline     Json?               // PlanOutlineItem[videosPerWeek] confirmed in the preview (first 4 weeks only)
  brief       String?   @db.Text
  briefEdited Boolean   @default(false)
  urgentNote  String?   @db.Text
  carryIn     Json?               // PlanCarryItem[] (max 3)
  status      String    @default("IDEA")   // IDEA | GENERATING | READY | FAILED
  attempts    Int       @default(0)
  generatedAt DateTime?
  version     Int       @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  days        PlanDay[]
  @@unique([planId, weekStart])
  @@index([planId, status])
}

// An owner's own video, dated by the owner. Not a day slot: no dayIndex, no effect on PlanDay or on the AI roadmap.
model PlanInstantIdea {
  id             String    @id @default(uuid())
  planId         String
  plan           ContentPlan @relation(fields: [planId], references: [id], onDelete: Cascade)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  date           String              // YYYY-MM-DD, brand-local
  idea           String    @db.Text  // what the owner typed
  title          String
  why            String    @db.Text
  beats          Json                // PlanBeat[] 3-6, same as PlanDay
  closingLine    String    @db.Text
  status         String    @default("DRAFT")   // DRAFT (not shown to the phone) | PLANNED | RECORDED | MISSED
  recordedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  @@index([organizationId, date])
}

// One day of a week: the video to record that day.
model PlanDay {
  id             String    @id @default(uuid())
  weekId         String
  week           PlanWeek  @relation(fields: [weekId], references: [id], onDelete: Cascade)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  dayIndex       Int                 // 0-6, one of SLOT_DAYS[videosPerWeek]
  date           String              // YYYY-MM-DD, brand-local
  title          String
  angle          String              // one of ANGLES
  why            String    @db.Text
  beats          Json                // PlanBeat[] 3-6: { hook (on-screen hint), say (script while it shows) }
  closingLine    String    @db.Text
  status         String    @default("PLANNED")   // PLANNED | RECORDED | MISSED
  busy           Boolean   @default(false)
  recordedAt     DateTime?
  version        Int       @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  @@unique([weekId, dayIndex])
  @@index([organizationId, date])
}
```

### Shared types (file `libraries/nestjs-libraries/src/dtos/content-plan/content.plan.schema.ts`; both the backend and the frontend import from it)
```ts
export const ANGLES = ['problem','mistake','story','question','comparison','steps','fear_loss',
  'behind_the_scenes','customer_voice','trend'] as const;
export type Angle = (typeof ANGLES)[number];
export const ROADMAP_WEEKS = 12;
export const CARRY_MAX = 3;
export const PREVIEW_WEEKS = 4;   // weeks with a full outline in the preview
export const LIMITS = { sourceText: 8000, direction: 6000, brief: 2000, idea: 300, urgentNote: 1000, feedback: 2000,
  title: 60, why: 240, hook: 100, other: 300,
  // `say` and `closingLine` are never shown while recording (Practice only), so they get no visible-text limit, only a
  // high safety cap against runaway output.
  say: 2000, closingLine: 600 };
export const SLIDE_TEXT_MAX = 200;        // the phone's text-slide limit
export const SLIDE_TEXT_FULL_SIZE = 100;  // up to this length the phone shows a slide at full size (26sp)
export const VIDEO_SECONDS = [30, 60, 90, 120] as const;
export const DEFAULT_VIDEO_SECONDS = 60;
export const VIDEOS_PER_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;
export const DEFAULT_VIDEOS_PER_WEEK = 3;
// Which days of the 7-day week (offsets from the week's start) carry a video: spread evenly, floor(i * 7 / count).
export const SLOT_DAYS: Record<number, number[]> = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 5],
  5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5], 7: [0, 1, 2, 3, 4, 5, 6] };
// Beats per video, decided by code from the video length: ≤45 s → 3, ≤75 s → 4, ≤105 s → 5, else 6.
export const beatsFor = (seconds: number) => (seconds <= 45 ? 3 : seconds <= 75 ? 4 : seconds <= 105 ? 5 : 6);
// Estimate of spoken words per second, used only to give the model a spoken-length target (`targetWords`); code never
// counts words and never checks against it.
export const WORDS_PER_SECOND = 2.3;
export const targetWordsFor = (seconds: number) => Math.round(seconds * WORDS_PER_SECOND);
export type PlanStatus = 'NONE' | 'SETUP' | 'PROPOSED' | 'ACTIVE';
export interface PlanFacts { whatWeDo: string; audience: string; problems: string[]; solution: string;
  objections: string[]; tone: string; videoSeconds: (typeof VIDEO_SECONDS)[number]; }
export interface PlanBeat { hook: string; say: string; }
export interface PlanQuestion { id: string; text: string; options: { id: string; label: string }[];
  recommendedOptionId: string; }
export interface PlanAnswer { questionId: string; optionId: string | null; other: string | null; }
export interface PlanOutlineItem { title: string; angle: Angle; }
export interface PlanCarryItem { title: string; angle: Angle; clusterId: string; }
export interface PlanProposal { version: number; facts: PlanFacts;
  themes: { ref: string; name: string; description: string }[];
  clusters: { ref: string; themeRef: string; title: string; problem: string }[];
  weeks: { weekStart: string; clusterRef: string; idea: string; outline: PlanOutlineItem[] | null }[]; }
export interface PlanDayView { id: string; date: string; dayIndex: number; title: string; angle: Angle; why: string;
  beats: PlanBeat[]; closingLine: string; status: 'PLANNED' | 'RECORDED' | 'MISSED'; busy: boolean; version: number; }
export interface PlanWeekView { id: string; weekStart: string; weekEnd: string; idea: string; brief: string | null;
  urgentNote: string | null; status: 'IDEA' | 'GENERATING' | 'READY' | 'FAILED'; days: PlanDayView[]; }
export interface PlanUpcomingView { id: string; weekStart: string; idea: string; ideaEdited: boolean; theme: string; }
export interface PlanView { status: PlanStatus; canEdit: boolean; videosPerWeek: number; prefill: string; sourceText: string | null;
  direction: string | null; facts: PlanFacts | null; busy: string | null; notice: string | null;
  round: { id: string; index: number; direction: string; questions: PlanQuestion[]; readyForPlan: boolean } | null;
  proposal: PlanProposal | null; themes: { id: string; name: string }[]; today: string; }
```
Also put the zod body schemas here (one per route body, `.strict()`, lengths from `LIMITS`), following
`dtos/brands/brand.profile.schema.ts`. Services validate `@Body() body: unknown` with them, like `BrandsService.parse`.

### API contract (the app codes against the public part; keep exact)
Web (`/content-plan`, `AuthMiddleware`, workspace from `x-workspace-id`). Mutations need ADMIN or SUPERADMIN
(403 `ADMIN_REQUIRED`). Validation errors are 400 `INVALID_PLAN` with `fields[]`.
```
GET  /content-plan                         → 200 PlanView (status NONE when no row; prefill built from the brand profile)
POST /content-plan/setup/start   { sourceText }                      → 200 PlanView (round 0)     409 PLAN_EXISTS when ACTIVE
POST /content-plan/setup/answer  { roundId, direction, answers: PlanAnswer[] } → 200 PlanView (next round)
                                                                       409 ROUND_STALE when roundId is not the latest
POST /content-plan/proposal      { direction, videosPerWeek, answers?: PlanAnswer[] } → 202 PlanView (busy 'proposal'; job started)
POST /content-plan/proposal/revise { proposalVersion, feedback }       → 202 PlanView      409 PROPOSAL_STALE
POST /content-plan/confirm       { proposalVersion }                   → 200 PlanView (ACTIVE) 409 PROPOSAL_STALE
POST /content-plan/reset                                               → 200 PlanView (SETUP, round null)
PUT  /content-plan/direction     { direction }                         → 202 PlanView (busy 'replan')
PUT  /content-plan/facts         { facts: PlanFacts }                  → 200 PlanView
PUT  /content-plan/videos-per-week { videosPerWeek }                   → 200 PlanView (applies from the next week)
GET  /content-plan/weeks/current                                       → 200 PlanWeekView | 204 when none
GET  /content-plan/weeks/upcoming                                      → 200 PlanUpcomingView[] (after the current week)
PUT  /content-plan/weeks/:id/brief  { brief }    → 202 PlanWeekView (current week; PLANNED days from today regenerate)
PUT  /content-plan/weeks/:id/idea   { idea }     → 200 PlanUpcomingView (only weeks after the current one, status IDEA)
POST /content-plan/weeks/:id/urgent { note }     → 202 PlanWeekView (current week only)
POST /content-plan/days/:id/regenerate           → 202 PlanDayView (PLANNED, date >= today)   409 DAY_LOCKED otherwise
POST /content-plan/days/:id/recorded             → 200 PlanDayView (idempotent)
POST /content-plan/instant-ideas { idea, date }  → 202 PlanInstantIdeaView (status DRAFT, busy 'instant'; the AI refines it)
POST /content-plan/instant-ideas/:id/confirm     → 200 PlanInstantIdeaView (status PLANNED, now in the week's days)
                                                   409 DRAFT_NOT_READY while still refining. Re-refine = POST again with the same idea.
404 PLAN_NOT_FOUND / WEEK_NOT_FOUND / DAY_NOT_FOUND for rows of another workspace. 409 PLAN_BUSY while the same thing
is already generating.
```
Public (`/public/v1`, device token or scoped key, workspace by `x-workspace-id`, `PublicAuthMiddleware`):
```
GET  /public/v1/content-plan/week                     @RequireScope('posts:read')
  200 { status: 'NONE'|'SETUP'|'PROPOSED'|'ACTIVE', today: 'YYYY-MM-DD', timezone: string,
        week: null | { id, weekStart, weekEnd, idea, status: 'IDEA'|'GENERATING'|'READY'|'FAILED',
                       days: [ { id, kind: 'PLANNED'|'INSTANT_IDEA', date, dayIndex: number|null, title, angle: string|null, why,
                                 beats: [ { hook, say } ],      // 3-6, in speaking order
                                 closingLine,
                                 status: 'PLANNED'|'RECORDED'|'MISSED', version } ] } }
  `days` is [] unless status is READY. `week` is the week containing `today` (also during reset/SETUP, when it exists).
  `days` holds only the week's video days (1-7). `dayIndex` is 0-6 within the week, so with fewer than 7 videos a week the
  days are not consecutive and today may have no day.
  Slides: the phone makes exactly one TEXT slide per beat from `hook`, in order. `hook` is already clean plain text
  (no markdown, list markers or line breaks) of at most SLIDE_TEXT_MAX (200) characters, normally at most 100.
  `say` and `closingLine` are never shown while recording (practice mode only).
POST /public/v1/content-plan/days/:id/recorded   {}   @RequireScope('posts:write')   + Idempotency-Key
  200 { id, status: 'RECORDED' }   (already recorded → the same 200)   404 DAY_NOT_FOUND
```
Web link target `content-plan` (no identifier) opens `/plan`.

### Code rules (every card)
- Layers: DTO/zod → Controller → Service → Repository; the logic lives in `libraries/nestjs-libraries`. No raw SQL, only
  Prisma. Every new file starts with a short comment saying what it is for. No `_planning` paths, and no IDs like `G-0xx`,
  `D-0xx` or `DR-0xx`, in code or docs (CI job `stale-references.yml`).
- Never change an existing workflow or activity. The new ones are new files.
- No provider-specific or language-specific `if`s.
- Never log the owner's texts, prompts or AI output (they are business data). Log ids and error codes only.
- SWR: one hook per fetch, `useFetch`, never `eslint-disable`. Tailwind tokens only (no `--color-custom*`). No new npm
  packages.
- Commit per card: `feat(content-plan): <card> <what>`, with explicit paths, ending with the session's `Co-Authored-By` line.
- Read big files by line range. Do not run builds, tests or the dev server (RULE above). Write specs; the owner runs them.

### File map (where things go)
| What | Path |
|---|---|
| Shared types + zod | `libraries/nestjs-libraries/src/dtos/content-plan/content.plan.schema.ts` |
| **Every prompt text** (frames, rules, labels, schema hints) | `libraries/nestjs-libraries/src/database/prisma/content-plan/prompts/{shared,setup,proposal,weekly}.prompts.ts` + `index.ts` |
| Repository / service / generator | `libraries/nestjs-libraries/src/database/prisma/content-plan/content.plan.{repository,service,generator}.ts` |
| Date + rotation + angle helpers (pure, exported for specs) | same folder, `content.plan.rules.ts` |
| Web controller | `apps/backend/src/api/routes/content.plan.controller.ts` |
| Public controller | `apps/backend/src/public-api/routes/v1/public.content.plan.controller.ts` |
| Workflows | `apps/orchestrator/src/workflows/content.plan.tick.workflow.ts`, `content.plan.job.workflow.ts` |
| Activity | `apps/orchestrator/src/activities/content.plan.activity.ts` |
| Frontend | `apps/frontend/src/app/(app)/(site)/plan/page.tsx`, `apps/frontend/src/components/content-plan/*` |
One task card = one session (one sub agent). Build exactly one card, tick it in **Progress**, commit, stop. A card is
self-contained: read **Shared context**, then the card's own "Read first" list. Don't read the other cards' sections.

# Web: brand switch you can see and tap, with a full page load (cards W1-W2)

The phone half is in `/home/haku/projects/AndroidStudioProjects/FaceCam-Presentation-Recorder/to-build/tasks.md` (cards
WS1-WS3). The two halves don't depend on each other. The previous card set (S0-S9) is in this file's git history.

## Shared context

## B1 — Foundation: schema, types, pricing, prompts, Meta chat client, throttle, web link
**Read first:** `schema.prisma` (the `Organization` model at about line 11, `AiCaption` at about line 372 for style);
`migrations/20261021120000_ai_captions/migration.sql`; `dtos/brands/brand.profile.schema.ts`;
`credits/pricing/pricing.config.ts` (the `PRICING.actions` entries `brand.create` and `ai.captions.per_minute`) and its
spec that pins the action list (`grep -rn "brand.create" libraries --include=*.spec.ts`);
`prompt-book/prompt.book.defaults.ts` (only to see how captions keep prompt texts in named constants; do not change any
prompt-book file); `openai/openai.service.ts`
`writeCaption` and `CaptionPrompt` (the `parse` + `zodResponseFormat` pattern to copy); `muse/muse.transcription.service.ts`
(header comment style, how it reads `META_MUSE_API_KEY`); **Decisions → Model** above; `throttler/throttler.provider.ts`; `dtos/web-handoff/web.link.request.dto.ts`
(`WEB_LINK_TARGETS`) and `web-handoff/web.handoff.service.ts` (`TARGET_PATHS`, and how `billing` is handled without an id).

**Do**
1. Prisma: add the 6 models and 2 back-relations exactly as in **Data model**. Write the migration SQL by hand in the style of
   the ai_captions migration (CREATE TABLE, indexes, FKs with ON DELETE CASCADE; no schema name such as `"public"`).
   Folder `20261124120000_content_plan`.
2. `content.plan.schema.ts`: everything in **Shared types**, plus zod bodies:
   - `StartSetupSchema`, `AnswerSetupSchema`, `ProposeSchema`, `ReviseSchema`, `ConfirmSchema`, `DirectionSchema`,
     `FactsSchema`, `BriefSchema`, `IdeaSchema`, `UrgentSchema`, `VideosPerWeekSchema`. `VideosPerWeekSchema` and
     `ProposeSchema.videosPerWeek` accept only an integer from `VIDEOS_PER_WEEK`.
   - Trim strings. Empty `direction`, `brief`, `idea`, `note` or `feedback` → invalid. An `answers` item needs `optionId` or a
     non-empty `other`.
3. `pricing.config.ts` `PRICING.actions`: add `plan.setup_round`, `plan.proposal`, `plan.week`, `plan.day`, `plan.roadmap`,
   each `cost: 0, unit: 'CALL'` with a short description. Update the spec that pins the action list.
4. **Prompt files: no prompt text anywhere else in the codebase** (owner rule).
   - Folder `libraries/nestjs-libraries/src/database/prisma/content-plan/prompts/`, with one file per group of related
     prompts. Every prompt is an exported `const` string. A prompt that must fill in values is an exported function in the
     same file that returns a template literal.
   - The files:
     - `shared.prompts.ts`:
       - `PLANNER_RULES`: the exact text below (language rule, "return only the JSON asked for" and the Trust rules);
       - `BRAND_CONTEXT_LABELS`: the section labels `brandContextMessage` writes, e.g.
         `{ brand: 'Brand', language: 'Language', facts: 'About the business', direction: 'Content direction' }`.
     - `setup.prompts.ts`: `SETUP_FRAME` and `SETUP_FIELD_HINTS` (the `.describe()` texts of the setup LLM schema).
     - `proposal.prompts.ts`: `PROPOSAL_FRAME` and `PROPOSAL_FIELD_HINTS`.
     - `weekly.prompts.ts`: `ROADMAP_FRAME`, `OUTLINE_FRAME`, `WEEK_FRAME`, `DAY_FRAME`, `ANGLE_HINTS` and `WEEKLY_FIELD_HINTS`.
     - `index.ts`:
       - re-exports everything;
       - `PLANNER_MODEL = 'muse-spark-1.3-contributor'`;
       - `PLANNER_PROMPTS: Record<PlannerPromptKey, { body: string; effort: 'minimal'|'low'|'medium'|'high' }>`, the
         single list the generator reads.
   - Each file starts with a comment: what its prompts are for, that prompt text lives only in this folder, that these
     are developer-owned engine prompts, and that a change ships with a deploy.
   - Text that reaches the model in any form counts as a prompt and lives here: frames, rules, labels, schema
     `.describe()` texts and any sentence a chat turn adds. Code elsewhere only imports these names. JSON keys of a
     `stableJson` turn are field names, not prompts.
   - Prompt keys and efforts: `planner.frame.setup` (effort `low`); `planner.frame.proposal`, `planner.frame.roadmap`,
     `planner.frame.outline`, `planner.frame.week` and `planner.frame.day` (effort `medium`). These keys are code
     names only, also used in `prompt_cache_key` and the usage log.
   - **Final prompt texts. Copy them exactly into the variables named in each heading; no rewording.** They are plain
     instructions with no placeholders (the inputs arrive as JSON user messages). They name no language and no script: the
     only language rule is the one in `PLANNER_RULES`. No prompt asks for a number of words in a visible text; lengths of
     titles and hooks are cut in code by characters (`LIMITS`).
     - `PLANNER_RULES` (`shared.prompts.ts`):
       ```
       Return only the JSON asked for, matching the given schema.
       Language: write every text in the language the owner uses in the Content Direction. If that cannot be told, use the
       language given as `locale`. Do not translate the owner's wording into another language and do not add a language the
       owner did not use.
       Trust rules:
       - Use only facts the owner gave. Never state or imply a number, price, discount, date, duration, statistic, result,
         customer name, quote, testimonial, award or news that the owner did not give.
       - Never make a medical, legal, financial or safety claim the owner did not make, and never promise a result.
       - A story or example must be openly hypothetical ("imagine someone who..."), never presented as a real case or a real
         customer.
       - Ideas must serve the real problems of the owner's customers, as the owner described them.
       - No generic filler openings, no clickbait, no hashtags.
       ```
     - `SETUP_FRAME` (`setup.prompts.ts`):
       ```
       You are a content strategist interviewing a business owner so that short social videos can be planned for years.
       The conversation holds `sourceText` (what the owner first wrote), your earlier rounds, the owner's answers, and any
       edits the owner made to your summary (the newest edit wins).
       Each round:
       1. Rewrite `direction` as a clear, well-spaced summary in short paragraphs or bullets: what the business does, for
          whom, the customers' core problems, how the business solves them, common questions, objections or
          misunderstandings, the tone, and anything the owner insists on. Keep every answer and every owner edit. Never
          drop something the owner wrote and never add a fact the owner did not give.
       2. The summary must also state the usual video length (30, 60, 90 or 120 seconds) and how often videos should
          mention the product or service versus teach or tell a story. When either is unknown, ask one question for it,
          with a recommended option.
       3. Ask only questions whose answer would change the plan: at most 4, each with 2 to 4 concrete options and one
          recommended option. Keep each question short and natural. Never ask again what is already answered or written.
          Ask fewer questions each round.
       4. Set `readyForPlan` to true when nothing important is open.
       ```
     - `PROPOSAL_FRAME` (`proposal.prompts.ts`):
       ```
       You are a content strategist. From `direction`, `facts` (may be empty) and `feedback` (may be empty; it overrides
       anything before it), produce the long-term structure of the plan.
       - `facts`: fill every field from the direction and never invent. `videoSeconds` is one of 30, 60, 90 or 120.
       - `themes`: 3 to 6 long-term themes the owner's videos keep returning to, each with a short name and a one-sentence
         description.
       - `clusters`: 3 to 8 per theme. A cluster is one specific problem or question of the owner's customers, written in
         the customers' own words, specific enough for one week of videos to cover it. No two clusters overlap.
       ```
     - `ROADMAP_FRAME` (`weekly.prompts.ts`):
       ```
       You plan short videos one week at a time. For each given week you get a cluster (title and problem), the week's
       start and end date, and the earlier ideas already used for that cluster.
       Write one core idea per week: one specific sentence (at most 300 characters) saying what that week's videos will
       show or explain to the owner's customers about the cluster's problem. State the subject and the approach of the week,
       not the video format, who speaks or the call to action: those follow the Content Direction for every video and
       must not be repeated in every idea. Vary the opening and the wording: do not start or end several ideas the same way
       or lean on the same key word. Each idea must be clearly new compared with
       the earlier ideas of the same cluster and with the other weeks in this request. Use the date only when a seasonal
       link fits naturally. Return one idea per given week, in the same order.
       ```
     - `OUTLINE_FRAME` (`weekly.prompts.ts`):
       ```
       You get a week idea and its slots. Each slot has an angle, and `videosPerWeek` is the number of slots.
       Write one title per slot, in slot order, that fits the slot's angle. A title names what the video is about, is a
       complete phrase (never cut off), is not a sentence of the script, does not copy the angle hint's wording, and is at
       most `titleMaxChars` characters. With
       one slot the title carries the
       whole idea. With a few slots each video stands on its own (never "part 2" or "next time"). With many slots the
       videos build on each other. No two titles repeat each other. Never state a fact, number or claim the owner did not
       give.
       ```
     - `WEEK_FRAME` (`weekly.prompts.ts`):
       ```
       You write one week of short videos for the owner's business. You get the week idea, the cluster problem,
       `videosPerWeek`, `videoSeconds`, `beatsCount`, `targetWords`, `titleMaxChars`, the slots (each with an angle, and sometimes a `carried`
       item or an `outlineTitle`), and sometimes `urgentNote` or `brief` with `briefEdited`.
       First write `brief`: 2 to 4 plain sentences about what this week is about, who it helps, and how the videos fit
       together (one video: it carries the whole idea; a few: each stands on its own, never "part 2"; many: they build on
       each other).
       Then write exactly one video per slot, in slot order, following the slot's angle:
       - `title`: names what the video is about, plain and specific, a complete phrase (never cut off), does not copy
         the angle hint's wording, at most `titleMaxChars` characters. Keep the slot's `outlineTitle` as the title when it has one.
       - `why`: one line connecting the video to the owner's customers.
       - `beats`: exactly `beatsCount` items in speaking order, each `{ hook, say }`.
         - `hook` is the cue shown on screen for that part: a very short phrase in plain text (no markdown, list markers or
           line breaks), never a full sentence of the script.
         - `say` is what the speaker says aloud while that hook is on screen: 1 to 3 short sentences of natural speech,
           not written prose.
         - All the `say` texts of one video together should take about `videoSeconds` seconds to speak at a calm pace,
           which is about `targetWords` words in total. This is an estimate: for a language that is not written with
           spaces between words, aim for the same spoken time.
         - The first `say` opens with a line that grabs attention in the first 3 seconds by naming the viewer's problem,
           not the speaker.
       - `closingLine`: one natural call to action, not salesy.
       Treat a slot's `carried` item as a starting point to rewrite so it fits this week. If `urgentNote` is present it is the
       week's focus. If `briefEdited` is true, follow `brief` over the idea. How often to mention the product or service
       follows the Content Direction. Each video makes its own point: do not repeat the same sentence or the same message
       in another video of the week or in another beat, and avoid leaning on the same key word or sentence shape in every
       video. Speak only to the viewer: never mention these instructions, the
       Content Direction, the plan or how often a service is mentioned. Never invent facts: examples and stories are
       openly hypothetical.
       ```
     - `DAY_FRAME` (`weekly.prompts.ts`):
       ```
       Write one video the same way as the week prompt (same fields and same rules) for the one given slot. Its title and
       content must differ from every title in `otherTitles`.
       ```
     - `ANGLE_HINTS` (`weekly.prompts.ts`; `index.ts` appends it to the bodies of `OUTLINE_FRAME`, `WEEK_FRAME` and
       `DAY_FRAME`, so each body stays one fixed string):
       ```
       Angles, the way a video approaches the problem:
       - problem: open with the customer's problem and show the way out.
       - mistake: a common mistake customers make and what to do instead.
       - story: a short, openly hypothetical story ("imagine someone who...") that shows the problem and the way out.
       - question: answer one question customers really ask.
       - comparison: compare two options or two situations fairly.
       - steps: a few simple steps the customer can follow.
       - fear_loss: what a customer risks by waiting, said calmly, with no scare tactics and no invented figure.
       - behind_the_scenes: how the business works, using only what the owner said.
       - customer_voice: say it the way customers say it, as a hypothetical customer, never a real quote.
       - trend: react only to the owner's urgent note.
       ```
     - **Field hints (final)**: the `.describe()` text of every field of the answer schemas below. They are prompt text, so
       they live in the named objects `SETUP_FIELD_HINTS`, `PROPOSAL_FIELD_HINTS` and `WEEKLY_FIELD_HINTS` (keyed by
       field name) and B2 only imports them. Copy them exactly.
       ```
       setup answer       direction        The Content Direction: the clear, well-spaced summary described in the instructions.
                          questions        0 to 4 questions whose answers would change the plan.
                          text             One short, natural question.
                          options          2 to 4 concrete answer options, each a short text.
                          recommendedIndex The 0-based position, in options, of the recommended option.
                          readyForPlan     True when nothing important is open.
       proposal answer    facts            Filled only from the direction, never invented.
                          whatWeDo         What the business does, in the owner's words.
                          audience         Who the customers are.
                          problems         The customers' core problems.
                          solution         How the business solves them.
                          objections       Common questions, objections or misunderstandings.
                          tone             The tone of the videos.
                          videoSeconds     The usual video length in seconds: 30, 60, 90 or 120.
                          themes           3 to 6 long-term themes.
                          ref              A short id of this item, such as t1 or c1.
                          name             A short theme name.
                          description      One sentence about the theme.
                          clusters         3 to 8 clusters per theme.
                          themeRef         The ref of the theme this cluster belongs to.
                          title            A short title of the problem or question.
                          problem          The problem or question in the customers' own words.
       ideas answer       ideas            One idea per given week, in the same order as the weeks.
       outline answer     titles           One short title per slot, in slot order.
       week answer        brief            The week brief: 2 to 4 plain sentences.
                          videos           Exactly one video per slot, in slot order.
                          title            A short, plain, specific title.
                          why              One line connecting the video to the owner's customers.
                          beats            Exactly beatsCount items in speaking order.
                          hook             The cue shown on screen: a very short phrase in plain text, not a sentence of the script.
                          say              What the speaker says aloud while that hook is on screen.
                          closingLine      One natural call to action, not salesy.
       ```
     - Code falls back to `DEFAULT_VIDEO_SECONDS` when `facts.videoSeconds` is not one of 30/60/90/120.
5. New file `libraries/nestjs-libraries/src/muse/muse.chat.service.ts`, `@Injectable() class MuseChatService`. Register it
   in `database.module.ts` providers next to `MuseTranscriptionService` (about line 153). Do **not** touch
   `OpenaiService` or the captions code.
   - Header comment: what it is, plus the docs URLs and the date from Decisions → Model (copy the style of the top of
     `muse.transcription.service.ts`).
   - Constants: `MUSE_CHAT_BASE_URL = 'https://api.meta.ai/v1'`, `MUSE_CHAT_TIMEOUT_MS = 180_000`,
     `MUSE_CHAT_MAX_COMPLETION_TOKENS = 16_000`.
   - `configured(): boolean` = `!!process.env.META_MUSE_API_KEY?.trim()`.
   - A lazily built client: `new OpenAI({ apiKey: process.env.META_MUSE_API_KEY, baseURL: MUSE_CHAT_BASE_URL })` (the
     `openai` package already in the repo; no new package). It is built on first use, so a missing key never breaks
     start-up.
   - Export `type ChatTurn = { role: 'developer' | 'user' | 'assistant'; content: string }` and
     `type PlanUsage = { prompt: number; cached: number; completion: number }`.
   - `writePlanPart<T extends z.ZodTypeAny>(model: string, reasoningEffort: 'minimal'|'low'|'medium'|'high',
     messages: ChatTurn[], schema: T, name: string, cacheKey: string):
     Promise<{ data: z.infer<T> | null; text: string; usage: PlanUsage }>`:
     ```ts
     const answer = await this.client().chat.completions.parse(
       { model, reasoning_effort: reasoningEffort, max_completion_tokens: MUSE_CHAT_MAX_COMPLETION_TOKENS,
         messages, response_format: zodResponseFormat(schema, name),
         prompt_cache_key: cacheKey,
         ...(sendRetention ? { prompt_cache_retention: '24h' } : {}) },
       { timeout: MUSE_CHAT_TIMEOUT_MS, maxRetries: 2 });   // the SDK retries 429/5xx and honours Retry-After
     const message = answer.choices[0]?.message;
     return { data: message?.parsed ?? null, text: message?.content ?? '',
       usage: { prompt: answer.usage?.prompt_tokens ?? 0,
                cached: answer.usage?.prompt_tokens_details?.cached_tokens ?? 0,
                completion: answer.usage?.completion_tokens ?? 0 } };
     ```
     - `text` is the raw assistant content, which a chat stores as its `assistantTurn`.
     - `sendRetention` is a module-level `let` that starts `true`. A 400 `APIError` whose message names
       `prompt_cache_retention` sets it to `false` and retries once (Decisions → Token caching).
   - Use role `developer` for instructions (Meta's preferred instruction role).
   - If TypeScript refuses `'developer'` or `reasoning_effort` on the installed SDK version, read the installed type, then
     cast the request object once with a comment. Do not upgrade the package.
   - Errors: let `OpenAI.APIError` through. The generator maps it (B2).
   - LLM schemas (defined in B2) use only object, array, string, boolean, number and enum, with every field required. No
     `.optional()`, `.nullable()` at the root, `.min()` or `.max()`. This is Meta's strict subset. Lengths are clamped after
     parsing.
   - Env docs: in `deploy/env.example` and `.env.example`, extend the `META_MUSE_API_KEY` comment to say it also runs the
     content planner (Meta Model API chat). In `deploy/DEPLOY_GUIDE.md` line 56, add "content plan" to what the key enables.
6. Throttler:
   - Add `isContentPlanWrite = (method, url) => (method === 'POST' || method === 'PUT') && /^\/content-plan(\/|\?|$)/.test(url)`
     to the `canActivate` list.
   - In `getTracker` return `req.org.id + '_content_plan'` for it, placed before the final `return`.
   - Check that web routes reach the guard with this URL shape: read how `AuthMiddleware` routes are mounted in
     `apps/backend/src/api/api.module.ts`. If the URL has a prefix, match it.
7. Web link: add `'content-plan'` to `WEB_LINK_TARGETS` and `TARGET_PATHS['content-plan'] = '/plan'`, with no identifier.
   Handle it like `billing`.
8. Privacy page `apps/frontend/src/app/(app)/(legal)/privacy/page.tsx`, the "AI providers" line: add that business details
   entered in the content plan are sent to Meta to write the plan, and that Meta may use them to improve its models. Update
   `legal.pages.spec.ts` if it pins that text.

**Spec (write, do not run)**: `MuseChatService` with a stubbed client (the request has the model, `reasoning_effort`,
`max_completion_tokens`, a `json_schema` response format, `prompt_cache_key` and `prompt_cache_retention: '24h'`; usage maps
`cached_tokens`; a 400 naming `prompt_cache_retention` is retried once without it and later calls omit it; `configured()`
is false for an empty or blank key); the zod
schemas (a good body passes; an empty direction, an over-long brief, or an answer
without an option or other text is refused); the pricing list spec; every `PlannerPromptKey` has a non-empty body and a
valid effort in `PLANNER_PROMPTS`; `VideosPerWeekSchema` accepts 1-7 and refuses 0, 8 and 2.5.

**Done when** the schema compiles by reading; migration SQL matches the models one to one; the prompt bodies are complete.

## B2 — Generator (AI calls only, no database)
**Read first:** B1 files; `ai-captions/ai.captions.generator.ts` (class shape and its call to `OpenaiService`; here
`MuseChatService` takes that place, and prompts come from `prompts/index.ts`, not from the Prompt Book),
`ai-captions/ai.captions.generator.spec.ts` (stub pattern).

**Do** — `content.plan.generator.ts`, `@Injectable() class ContentPlanGenerator(MuseChatService)`. It does not depend on
`PromptBookService`.
1. Private `ask(orgId, key: PlannerPromptKey, input: object, schema, name)`:
   - If `!muse.configured()`, throw `PlanNotConfigured` (exported). The service turns it into 503 `PLAN_NOT_AVAILABLE`.
   - `frame = PLANNER_PROMPTS[key]` (synchronous, from code).
   - Messages, in this fixed order (Decisions → Token caching):
     1. `{role:'developer', content: RULES}`;
     2. `{role:'user', content: brandContext}`;
     3. `{role:'developer', content: frame.body}`;
     4. then either `{role:'user', content: stableJson(input)}` (one-shot calls), or, for chats, the stored turns followed
        by the new user turn.
   - `brandContext` is a string the caller passes, built by `brandContextMessage(ctx: BrandContext)`. Define it in
     `content.plan.rules.ts` in this card, next to `cleanSlideText`, with
     `BrandContext = { name, locale, facts: PlanFacts | null, direction: string | null }` and a fixed key order.
     - During setup the caller passes `facts: null, direction: null`, because the direction lives in the chat turns.
     - After confirm it passes both. `stableJson(value)` = `JSON.stringify` of an object the caller built with a fixed key order;
     never pass objects spread from Prisma rows.
   - `cacheKey = 'content-plan:' + key`.
   - After the call, log the one usage line (ids and numbers only) and return `usage` to the caller, which puts it into the
     spend metadata.
   - Map errors:
     - `OpenAI.APIError` with status 401, 402 or 403 → `PlanNotConfigured`. Log only "content plan: Meta key or billing
       refused" plus the status.
     - Any other API error, a timeout or a `null` answer → `PlanAiFailed`.
   - `RULES` is `PLANNER_RULES` imported from `prompts/shared.prompts.ts`. The LLM zod schemas take their `.describe()`
     texts from the `*_FIELD_HINTS` of the matching prompts file. This file holds **no** prompt text of its own.
   - Calls `writePlanPart(PLANNER_MODEL, frame.effort, …)`. A `null` answer throws `PlanAiFailed` (an Error
     subclass exported from the generator).
   **Answer shapes, brand context and task messages (final)**: the generator uses exactly these, so no shape or key name is
   left to the implementer.
   - LLM answer schemas (strict subset, every field required; the hints above are the `.describe()` texts):
     - setup: `{ direction: string, questions: [{ text: string, options: string[], recommendedIndex: number }], readyForPlan: boolean }`;
     - proposal: `{ facts: { whatWeDo, audience, problems: string[], solution, objections: string[], tone, videoSeconds: number },
       themes: [{ ref, name, description }], clusters: [{ ref, themeRef, title, problem }] }`;
     - ideas: `{ ideas: string[] }`; outline: `{ titles: string[] }`;
     - week and day: `{ brief: string, videos: [{ title, why, beats: [{ hook, say }], closingLine }] }` (a day answer has one
       video).
   - `brandContextMessage` writes these blocks, joined by one blank line, using `BRAND_CONTEXT_LABELS`:
     `Brand: <name>`, `Language: <locale>`, then only when present `About the business:` + a new line + `stableJson(facts)`,
     then only when present `Content direction:` + a new line + the direction.
   - Which context each call gets: the setup rounds and the proposal structure chat get `facts: null, direction: null`
     (the direction lives in the chat turns). The ideas, outline, week, day and replan calls get the direction and facts.
   - A frame body is the frame text, a blank line, then `ANGLE_HINTS` for `OUTLINE_FRAME`, `WEEK_FRAME` and `DAY_FRAME`
     (built once in `prompts/index.ts`).
   - Task message (the last user turn) = `stableJson` of these keys, in this order:
     - setup round 0: `{ sourceText }`; later rounds: `{ answers: [{ question, answer }], editedDirection }`;
     - proposal: `{ direction }`, and for a revise `{ feedback }`;
     - ideas: `{ weeks: [{ weekStart, weekEnd, clusterTitle, problem, previousIdeas }] }`;
     - outline: `{ idea, clusterTitle, problem, videosPerWeek, titleMaxChars, slots: [{ angle }] }` (`titleMaxChars` = `LIMITS.title`);
     - week: `{ idea, clusterTitle, problem, brief, briefEdited, urgentNote, otherTitles, slots, videosPerWeek, videoSeconds,
       beatsCount, targetWords, titleMaxChars }`; day: the same with one slot in `slots`.
2. Public methods. Each has a typed input; each returns clamped, validated output, and throws `PlanAiFailed` when the shape
   is unusable.
   - `setupRound({ orgId, brandContext, turns: ChatTurn[] /*stored earlier rounds*/, newUserTurn: string })` →
     `{ direction, questions: PlanQuestion[] (≤4, 2-4 options, recommendedOptionId ∈ options, else the first option),
     readyForPlan, assistantTurn: string /*raw text to store*/, usage }`.
     - Question and option ids are made by code (`q1..`, `o1..`), not trusted from the AI.
     - Ids are rewritten only in the returned `questions`. `assistantTurn` stays the raw text, so the stored chat matches
       what the model said.
   - `proposeStructure({ orgId, brandContext, turns: ChatTurn[], newUserTurn })` → `{ facts, themes (3-6), clusters (refs
     t1../c1.., each themeRef valid; drop invalid ones; fail if a theme ends up with no cluster), assistantTurn, usage }`.
   - `writeIdeas({ orgId, locale, direction, facts, weeks: [{ weekStart, weekEnd, clusterTitle, problem, previousIdeas[] }] })`
     → `string[]`, same length and order as `weeks`; fail on a length mismatch.
   - `writeOutline({ orgId, locale, direction, facts, idea, clusterTitle, problem, angles: Angle[] /*one per video*/, videosPerWeek })` →
     `string[]` (one title per angle, same order). Fails on a length mismatch.
   - `writeWeek({ orgId, locale, direction, facts, idea, clusterTitle, problem, brief, briefEdited, urgentNote,
     otherTitles: string[] /*days of the week not being written*/,
     slots: [{ dayIndex, date, angle, carried?: { title } , outlineTitle?: string }] })` →
     `{ brief, days: [{ dayIndex, title, why, beats: PlanBeat[], closingLine }] }`, one per slot in slot order. The input
     also carries `videosPerWeek` (the same as the slot count), `videoSeconds`, `beatsCount = beatsFor(videoSeconds)` and `targetWords = targetWordsFor(videoSeconds)`. The angle comes from the slot, never from the AI.
     The LLM schema has no `dayIndex` field: code maps the answers to slots by position.
   - `writeDay({ …same context…, slot, otherTitles: string[] })` → one day.
3. Clamp to `LIMITS`:
   - Trim everything. Text the user can see (`title`, `why`, `hook`, the brief and idea) is cut at a word boundary (copy
     `cutAtWord` from the captions generator, or import it if it is exported). `say` and `closingLine` are not shown while
     recording, so they are only trimmed; they are cut only if they pass their high safety cap.
   - Every `hook` goes through `cleanSlideText`, then is cut to `LIMITS.hook`. Create `content.plan.rules.ts` in this card
     with only `cleanSlideText` and `brandContextMessage`; B3 adds the other rules to the same file.
   - Drop beats with an empty hook or say. Keep at most 6. Fail with `PlanAiFailed` if fewer than 3 remain.
4. `cleanSlideText(text)` is the one owner of what a slide may contain:
   - strip leading list markers (`-`, `*`, `•`, `1.`, `1)`, `#`);
   - strip markdown emphasis (`**`, `__`, backticks);
   - turn line breaks and tabs into single spaces;
   - collapse spaces and trim;
   - remove wrapping quotes;
   - cut to `SLIDE_TEXT_MAX`.
   It never changes letters, so any script and any language stay intact.

**Spec (stub MuseChatService)**: the messages contain the frame body from `PLANNER_PROMPTS` (role `developer`) and the JSON
input; no key → `PlanNotConfigured` with no call made; a 401 → `PlanNotConfigured`; a 500 → `PlanAiFailed`; question ids are
rewritten and a bad `recommendedOptionId` falls back to the first option; over-long strings are clamped; a week answer with
the wrong day count throws `PlanAiFailed`; the angle in the output is the slot's angle; the model is `PLANNER_MODEL` and the
effort is the prompt's own;
message order is RULES, brand context, frame, then task or turns, and two calls for the same brand produce byte-identical
RULES and brand-context messages; a chat call re-sends the stored turns unchanged before the new turn; `cacheKey` is
`content-plan:<key>`; `brandContextMessage` output does not change with key order of its input object;
the input carries `beatsCount = beatsFor(videoSeconds)` (30 s → 3, 60 → 4, 90 → 5, 120 → 6) and `targetWords` (60 s → 138); a day with 2 usable beats throws;
`cleanSlideText` cases: `"1. **Pick one**"` → `"Pick one"`, `"- a\nb"` → `"a b"`, quoted text unwrapped, Bengali, Arabic and
Hindi text unchanged, 250 characters → 200.

## B3 — Setup and proposal: repository, service, web routes, rules
**Read first:** B1-B2 files; `brands/brands.repository.ts`, `brands/brands.service.ts` (`parse`, the exceptions,
`canEditRole`); `apps/backend/src/api/routes/brands.controller.ts` (`assertAdmin`, `@GetOrgFromRequest`, `@Body() body:
unknown`); `apps/backend/src/api/api.module.ts` (`authenticatedController`); `database.module.ts` (the providers list);
`ai-captions/ai.captions.service.ts` (how it starts a workflow, about line 311-400: `getRawClient`, `workflowId`,
`taskQueue: 'main'`, `typedSearchAttributes`, 503 when there is no client); `credits/credits.service.ts` `spend`.

**Do**
1. `content.plan.rules.ts` (created in B2 with `cleanSlideText`): add these pure exported functions, no Nest, no Prisma.
   - `localToday(now: Date, timeZone: string): string`, using
     `new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).format(now)`. A bad
     timezone falls back to `UTC`.
   - `addDays(date: string, n: number): string` (UTC math on the parts).
   - `daysBetween(from: string, to: string): number`. A week's number = `Math.floor(daysBetween(firstWeekStart,
     weekStart) / 7)`, where `firstWeekStart` is the earliest `weekStart` of the plan.
   - `rotationOrder(themes: {id, position}[], clusters: {id, themeId, position}[]): string[]` (interleave, Decisions).
   - `nextClusterId(rotation: string[], previousClusterId: string | null): string`.
   - `pickAngles(count, lastUse: Map<Angle, string /*date*/>, exclude: Angle[], allowTrend: boolean, seed: number): Angle[]`
     (Decisions → Angle choice).
     - Ties are broken by `ANGLES` order starting at index `seed % candidates.length` and wrapping, so weeks do not all
       open with the same angle. Callers pass the week's number since confirm (0, 1, 2…).
     - The result is returned in that same tie-break order, which is also the day order.
   - `slotsForWeek({ weekStart, videosPerWeek, outline, carryIn, pickedAngles }): Slot[]` (`videosPerWeek` slots; each
     `dayIndex` is from `SLOT_DAYS[videosPerWeek]` and `date = addDays(weekStart, dayIndex)`; outline titles and angles
     when present, else the picked angles; carry items replace the slots at positions 1, 3, 5 (0-based) that exist, in
     order; carry items that do not fit are ignored).
   - `mergeCarry(existing: PlanCarryItem[], incoming: PlanCarryItem[]): { kept, dropped }` (cap `CARRY_MAX`).
2. `ContentPlanRepository`, using `PrismaRepository<'contentPlan'>` etc. (copy the BrandsRepository constructor style),
   with a method per query the services need. Every query by id also filters by `organizationId` (through
   `plan.organizationId` or `PlanDay.organizationId`).
3. `ContentPlanService`, registered in `database.module.ts` so the orchestrator can use it too:
   - `view(org, user)` → `PlanView` (including `videosPerWeek`).
     - `canEdit` comes from the caller's role.
     - `prefill` is built from the brand profile (name, tagline, audience, voice, pillars), joined as plain lines; it is
       empty when there are none.
     - `today = localToday(now, org.timezone)`.
     - `round` is the latest round.
   - `startSetup(org, body)`:
     - Creates or updates the row: status SETUP, sourceText; rounds of a previous setup are deleted.
     - `busy='round'`, then `generator.setupRound` inside `credits.spend({ organizationId: org.id, actionKey:
       'plan.setup_round', idempotencyKey: 'plan:round:' + uuid, metadata: { planId } }, …)`.
     - Saves round 0 and sets `direction` to the round's direction. `busy=null` in a `finally`.
     - This call is synchronous: one small AI call.
   - `answer(org, body)`:
     - The `roundId` must be the latest round, else 409 ROUND_STALE.
     - Saves the answers on that round, and stores the owner's `direction` from the body first (their edit wins).
     - The next round is generated as an **append-only chat** (Decisions → Token caching):
       1. RULES, brand context, frame;
       2. for each earlier round in index order, its stored `userTurn` (user) and `assistantTurn` (assistant), byte for
          byte;
       3. a new user turn = `stableJson({ answers, editedDirection })`, where `editedDirection` is null when the owner
          did not change the summary.
          - The model never sees the question and option ids (code makes them after the call), so `answers` in this turn
            are not ids. Code resolves each `PlanAnswer` against the stored round's questions and sends
            `{ question: <the question text>, answer: <the chosen option's text, or the owner's "other" text> }`.
          - The ids stay in the web API and the database only.
     - The new round stores that new user turn as its `userTurn` and the raw answer text as its `assistantTurn`.
     - Round 0's `userTurn` is `stableJson({ sourceText })`.
     - The brand context during setup has no facts or direction yet (only name and locale), so it stays identical for every
       round.
   - `propose(org, body)`:
     - Stores direction and `videosPerWeek` (and answers on the latest round when given), sets `busy='proposal'`, and starts the job
       `contentPlanJobWorkflow` `{ kind: 'proposal', planId }`.
     - The job runs `buildProposal(planId, feedback | null)`:
       1. `proposeStructure`.
       2. Compute the rotation over the proposed refs.
       3. Week starts from `today` (or from the day after the current READY week ends, when one exists from a previous
          plan).
       4. Clusters for 12 weeks by rotation.
       5. `writeIdeas` for 12.
       6. For the first `PREVIEW_WEEKS` weeks only: `pickAngles(videosPerWeek, empty map, [], false, weekNumber)`, then
          `writeOutline` for the titles, stored as the week's `outline` (`videosPerWeek` × `{ title, angle }`).
       7. Save `proposal` with `version = proposalVersion + 1`, status PROPOSED, `busy=null`.
     - On failure: `busy=null, notice='proposal_failed'`.
   - `revise(org, body)`: `proposalVersion` must match (else 409). Same job with `feedback`.
     - The structure call is an append-only chat stored in `proposalTurns`. The first propose stores
       `[user: stableJson({ direction }), assistant: <structure answer text>]`.
     - Each revise appends `user: stableJson({ feedback })` and the new assistant text, so earlier turns are a cached
       prefix.
     - `writeIdeas` and `writeOutline` stay one-shot calls. They run straight after the structure call in the same job,
       sharing the frame + RULES + brand-context prefix.
     - `confirm`, `reset` and a new `propose` after a reset clear `proposalTurns`.
   - `confirm(org, body)`: version check, then one transaction:
     1. Archive the old themes and clusters.
     2. Create themes and clusters with `rotationIndex`.
     3. Delete weeks that have status IDEA and `weekStart >= today`.
     4. Create the 12 weeks from the proposal: map refs to ids and keep the outline.
     5. Status ACTIVE, `confirmedAt`, `proposal = null`, `facts = proposal.facts`.
     6. After the transaction, if the first week starts today, start the job `{ kind: 'week', weekId }`.
   - `reset(org)`: status SETUP, rounds deleted, `proposal=null`, `notice=null`. Weeks are kept, so the phone keeps the
     current one.
   - `startJob(job)` (private): `workflowId: 'content_plan_' + kind + '_' + id`, so a duplicate start is refused. That
     shows as 409 PLAN_BUSY. If there is no client, mark the row not busy and answer 503 `PLAN_NOT_AVAILABLE`.
4. `ContentPlanController` (`@ApiTags('Content plan') @Controller('/content-plan')`):
   - Routes `GET /`, `POST /setup/start`, `POST /setup/answer`, `POST /proposal`, `POST /proposal/revise`,
     `POST /confirm`, `POST /reset`, `PUT /facts`.
   - Mutations call `assertAdmin` (copy it from brands.controller).
   - Add the controller to `authenticatedController`.
5. The generator's `PlanNotConfigured` → 503 `{ code: 'PLAN_NOT_AVAILABLE' }` and `PlanAiFailed` → 502
   `{ code: 'PLAN_AI_FAILED' }` (sync setup routes). In jobs, the same errors set the row's FAILED status or notice.
   Exceptions are HttpExceptions with `{ code }` bodies like the brands ones: `InvalidPlanException` (400 with
   `fields`), `PlanNotFoundException`, `PlanConflictException(code)`.

**Spec**:
- Rules: `localToday` across a date line; `addDays` across months and years; the interleaved rotation; `nextClusterId`
  wraps; `pickAngles` (never-used first, oldest next, excludes, trend only when allowed, never short); `slotsForWeek`
  (count and offsets from `SLOT_DAYS` for 1 to 7 videos; carry at positions 2, 4, 6 only where they exist, so 1 video takes
  none); `mergeCarry` cap.
- Service (mocked repository, generator and Temporal client, like `ai.captions.service.spec.ts`): a stale round → 409; the
  owner's direction is saved before the next round; answer sends only the latest round; confirm with a stale version →
  409; confirm creates 12 weeks with the right clusters and starts the first week job; reset keeps weeks; a USER role → 403
  at the controller.

## B4 — Weekly engine and orchestrator
**Read first:** B3 files; `apps/orchestrator/src/workflows/credits.reconcile.workflow.ts`;
`digest.email.workflow.v1.0.1.ts` (the `sleep` + `continueAsNew` loop); `ai.captions.workflow.ts` (job with a
`CancellationScope.nonCancellable` failure path); `activities/ai.captions.activity.ts`; `apps/orchestrator/src/app.module.ts`
(activities list); `workflows/index.ts`; `libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts`.

**Do**
1. Service methods (called by the activity):
   - `tick(now)`: pages ACTIVE plans (50 per page, cursor on id) and runs `advance(plan, now)` for each, 4 at a time, each in
     its own try/catch (log the plan id and error code only).
   - `advance(plan, now)`:
     1. `today = localToday(now, tz)`.
     2. **Roll over**: for every week with status READY that has ended (`addDays(weekStart, 7) <= today`), turn its PLANNED
        days into MISSED. Give the earliest ones to `mergeCarry` into the first week with status IDEA starting on or after
        `today`, and write that week's `carryIn`.
     3. If there is no week containing `today` (the plan was idle), extend the roadmap starting from `today`.
     4. If the current week has status IDEA, or FAILED with `attempts < 3`, call `generateWeek(weekId)`.
     5. If fewer than `ROADMAP_WEEKS` weeks start on or after the current week's start, call `extendRoadmap`.
   - `generateWeek(weekId)`:
     1. Set status GENERATING and `attempts + 1`.
     2. Build the angle-use map for its cluster (Decisions). `pickAngles(videosPerWeek - carried, …, exclude carried angles,
        allowTrend = !!urgentNote)`.
     3. `slotsForWeek`, then `generator.writeWeek` inside `spend('plan.week')`.
     4. Upsert the `videosPerWeek` days (value read from the plan now) by `(weekId, dayIndex)` with status PLANNED and `version + 1`.
     5. Brief: saved only when `briefEdited` is false.
     6. Status READY, `generatedAt`. On error the status is FAILED.
   - `regenerateDays(weekId, fromDate)`:
     1. Only PLANNED days with `date >= fromDate`: mark them `busy`.
     2. One `writeWeek` call with those slots only. Keep their angles unless the week has an urgent note; then re-pick with
        trend allowed.
     3. Pass the titles of the week's other days as `otherTitles`.
     4. Update those days and clear `busy`.
   - `regenerateDay(dayId)`: pick 1 angle excluding the other days' angles of the week, `writeDay` with `otherTitles`,
     update, clear `busy`.
   - `extendRoadmap(planId, fromDate?)`: append weeks after the last one (`addDays(last.weekStart, 7)`, or `fromDate`) up to
     `ROADMAP_WEEKS` from the current week. Clusters by `nextClusterId`. Give `writeIdeas` the last 3 ideas of each cluster,
     inside `spend('plan.roadmap')`.
   - `replan(planId)`: the weeks from Decisions → Direction edit. `writeIdeas` for them, update `idea`, clear `outline`, then
     `busy=null, notice='roadmap_updated'`. On failure `notice='replan_failed'`.
2. Orchestrator:
   - `ContentPlanActivity` (`@Injectable() @Activity()`) with methods taking one object argument:
     - `contentPlanTick({})`
     - `contentPlanRunJob({ kind: 'proposal'|'revise'|'week'|'days'|'day'|'replan', id: string, feedback?: string,
       fromDate?: string })`, which switches to the service method;
     - `contentPlanJobFailed({ kind, id })`, which clears `busy`, sets FAILED or notice.
   - Add it to `app.module.ts`.
   - `content.plan.tick.workflow.ts`: `export async function contentPlanTickWorkflow()`. Loop 24 times:
     `await sleep(3600000); await contentPlanTick({})`, then `continueAsNew`. The tick activity gets
     `startToCloseTimeout: '55 minute'` and retry `{ maximumAttempts: 2 }`.
   - `content.plan.job.workflow.ts`: `contentPlanJobWorkflow(job)`. `contentPlanRunJob` (10 minutes, 3 attempts,
     5-second initial interval). In the catch, `CancellationScope.nonCancellable(() => contentPlanJobFailed(job))`.
   - Export both from `workflows/index.ts`.
   - In `InfiniteWorkflowRegister` add `startContentPlanTickWorkflow()` (workflowId `content-plan-tick-workflow`), copying
     `startFreeGrantWorkflow`.
3. Wire B3's `confirm` and `propose`/`revise` to these jobs (kinds `week`, `proposal`, `revise`).

**Spec**: `advance` against a mocked repository:
- a week that ended with 5 unrecorded days → 3 carried, 2 MISSED and not counted as used;
- the current week IDEA → generated;
- FAILED with attempts 3 → not retried;
- the roadmap is topped up to 12;
- an idle plan gets weeks from today;
- `generateWeek` never sends the angle `trend` without an urgent note;
- `regenerateDays` never touches RECORDED days or past dates;
- `generateWeek` with `videosPerWeek` 1, 3 and 7 writes exactly that many days on the `SLOT_DAYS` offsets, and a week
  generated before a change keeps its days.

The workflow spec is optional (pattern `credits.reconcile.workflow` spec, real Temporal; the owner runs it).

## B5 — Change routes and phone routes
**Read first:** B3-B4 files; `apps/backend/src/public-api/routes/v1/public.integrations.controller.ts` (class decorators
about line 81: `@ApiTags`, `@Controller('/public/v1')`, `@UseGuards(ScopeGuard, FeatureGuard)`; and the `/ai-captions`
routes about line 700 for `@RequireScope`, `@GetOrgFromRequest`, `res.status`); `public.api.module.ts`
(`authenticatedController`).

**Do**
1. Service:
   - `direction(org, body)`: save, `directionVersion + 1`, `busy='replan'`, job `replan`.
   - `currentWeek(org)` → `PlanWeekView | null`.
   - `upcoming(org)` → `PlanUpcomingView[]`.
   - `brief(org, weekId, body)`: current week only. Save the brief with `briefEdited = true`, then job `days` from `today`.
   - `idea(org, weekId, body)`: only weeks after the current one with status IDEA. Sets `ideaEdited = true` and clears the
     outline.
   - `urgent(org, weekId, body)`: current week only.
     1. Take up to 3 PLANNED days from today onward as carry items for the next IDEA week (`mergeCarry`).
     2. Set `urgentNote` and `briefEdited = false`.
     3. Job `days` from `today`.
   - `regenerate(org, dayId)`: 409 DAY_LOCKED unless the day is PLANNED with `date >= today`. Sets `busy`, then job `day`.
   - `recorded(org, dayId)`: set RECORDED and `recordedAt`. Idempotent.
   - `videosPerWeek(org, body)`: save the value and clear the `outline` of weeks with status IDEA. No job and no AI call.
     Generated weeks are untouched (Decisions → Videos per week).
   - `phoneWeek(org)` → the public shape.
2. Web controller: add the week and day routes from the contract, and `PUT /videos-per-week`.
3. `PublicContentPlanController`:
   - Copy the class decorators of `PublicIntegrationsController`.
   - `GET /content-plan/week` (`posts:read`) and `POST /content-plan/days/:id/recorded` (`posts:write`).
   - The org comes from `@GetOrgFromRequest()`. There is no role check: any member's device may report a recording.
   - Add it to `authenticatedController` in `public.api.module.ts`.

**Spec**: phone week shape matches the contract exactly; days `[]` unless READY; recorded is idempotent and 404 for another
workspace's day; brief edit regenerates only PLANNED days from today; urgent carries at most 3 and sets the note; idea edit
refused for the current week; regenerate a recorded day → 409; a new `videosPerWeek` keeps generated weeks and clears the outline of IDEA weeks only.

## B6 — Web: setup and preview
**Read first:** `apps/frontend/src/app/(app)/(site)/ai-captions/page.tsx`; `components/ai-captions/use.ai.captions.ts` (SWR,
polling); `components/brand/profile/brand.settings.tsx` (`useFetch`, `useToaster`, `useT`, `useUser`, `useIdempotencyKey`, card
classes); `components/layout/top.menu.tsx` (`useMenuItem`, the captions entry about line 141); `components/layout/new-modal.tsx`
(`areYouSure`); `@gitroom/react/form/{button,textarea,input}`; `apps/frontend/src/app/colors.scss`, `global.scss`,
`tailwind.config.js`.

**Do**
1. Page `app/(app)/(site)/plan/page.tsx`, a copy of the captions page with title `${PRODUCT_NAME} Content plan`, renders
   `<ContentPlanComponent />`.
2. Menu entry `{ name: t('content_plan_menu', 'Plan'), icon: <calendar-like svg>, path: '/plan' }`, not hidden for Free.
3. Hooks in `components/content-plan/`, one file per hook:
   - `use.content.plan.ts` (`/content-plan`; `refreshInterval: 3000` while `busy`);
   - `use.plan.current.week.ts` (`/content-plan/weeks/current`; polls while GENERATING or any day is busy);
   - `use.plan.upcoming.ts`.
4. `content.plan.component.tsx`: switch on `status`. NONE and SETUP → `<PlanSetup/>`. PROPOSED (or SETUP with `busy`
   `'proposal'`) → `<PlanPreview/>`. ACTIVE → `<PlanActive/>` (B7).
5. `plan.setup.tsx`:
   - NONE: a textarea pre-filled with `prefill` and a **Start** button.
   - SETUP: an editable direction textarea titled "Here's what I understood", with a small note "Edit anything that's not
     right", and the question cards (`plan.question.card.tsx`).
   - A **Videos per week** select (the values of `VIDEOS_PER_WEEK`, `DEFAULT_VIDEOS_PER_WEEK` pre-selected) next to the
     direction textarea in SETUP, with the line "How many videos can you make a week? You can change this later; it applies
     from the next week." Its value is sent with **Show me the plan** (`POST /proposal`).
   - Question card: radio options with the recommended one pre-selected and a "Recommended" label, plus an "Other" text box.
     Typing in Other un-selects the options.
   - Buttons **Continue** and **Show me the plan**. The second is primary when `readyForPlan` is true or there are no
     questions.
   - While a call runs, the buttons are disabled and "Thinking…" shows.
   - Mutations send `Idempotency-Key` (`useIdempotencyKey`, as in brand settings) and `mutate` the view with the answer.
6. `plan.preview.tsx`:
   - Direction (read-only here), facts and "N videos a week" as plain text.
   - Themes as chips.
   - 4 week cards with idea and one title per video plus angle chips (`plan.angle.chip.tsx`, labels from `useT` keyed `plan_angle_<key>`).
   - A collapsed "Weeks 5-12" list.
   - **Confirm plan** and **Something's not right** (a textarea, then revise).
   - On `notice === 'proposal_failed'`: one line plus **Try again**.
7. User role (`!canEdit`): everything read-only, with no buttons except navigation.

## B7 — Web: active plan
**Read first:** B6 files.

**Do** — `plan.active.tsx` plus small parts:
1. `plan.this.week.tsx`:
   - The week idea, the brief textarea and **Regenerate** (enabled when changed).
   - One `plan.day.card.tsx` card per day of the week (`days.length`, which is `videosPerWeek`): date (formatted with the brand locale), title, angle chip, why, and the beats as a
     numbered list (hook in bold as "On screen", its say below as "You say"; the says collapse behind "Show script"), then
     the closing line; a Recorded tick; **Change this topic**, disabled unless PLANNED and `date >= today`; a small
     menu with **Mark recorded**.
   - "Thinking…" overlay on busy days.
   - Status IDEA or GENERATING: "Writing this week's videos…". FAILED: one line plus **Try again**, which calls
     `PUT /weeks/:id/brief` with the current brief.
2. `plan.urgent.tsx`: "Something happened in my industry?" textarea plus a button. Afterwards: "This week now focuses on
   it. The rest moves to next week."
3. `plan.upcoming.tsx`: list of weeks 2-12 (date range plus idea) with inline edit and Save.
4. `plan.direction.tsx`: textarea plus Save. Afterwards: "Updating your coming weeks…" while `busy === 'replan'`, then the
   notice "Upcoming weeks updated to your new direction".
5. `plan.facts.tsx`: editable facts (text inputs; problems and objections one per line; video length as a 30/60/90/120 s
   select) plus Save. A new length applies from the next generated week; say so in one line under the select.
6. `plan.videos.tsx`: a select of `VIDEOS_PER_WEEK` with the current `videosPerWeek` plus Save (`PUT /videos-per-week`),
   and the line "Applies from next week" under it. Read-only for `!canEdit`.
7. **Start over** at the bottom: `areYouSure`, then `POST /reset`.
8. All errors: `useToaster` with the server's `code` mapped to a friendly line (`PLAN_BUSY` → "Already working on it",
   429 → "Busy, try again in a minute").

## B8 — Instant idea: backend (prompts, generator, repository, service, job, routes)
**Depends on:** B1-B5. **Read first:** the **Instant idea** bullet in Decisions, the `PlanInstantIdea` model, the API
contract (`instant-ideas` routes and the public `days[]` shape), `content.plan.prompts.ts`, `content.plan.generator.ts`
(`writeDay`, clamping, `cleanSlideText`), `content.plan.service.ts` (`claim`, `startJob`, `charge`, `phoneWeek`,
`currentWeek`, `recorded`, the day view mappers), `content.plan.repository.ts`, `content.plan.activity.ts`
(`contentPlanRunJob`, `contentPlanJobFailed`), B1 pricing file, and `content.plan.change.spec.ts` for the spec style.

**Do**
1. **Prompts** (`content.plan.prompts.ts`, same grouping as the others, no inline text elsewhere): an instant-idea group
   (task text, field hints). The AI input is only the owner's idea, the brand context (name, locale, direction, facts) and
   `videoSeconds`. It refines the owner's own idea into `{ title, why, beats (3-6, { hook, say }), closingLine }`. It must
   keep the owner's meaning, invent no numbers, names or results, and write in the idea's language (the brand locale when
   unclear). No angle.
2. **Pricing:** add the credit action `plan.instant` next to `plan.proposal`, charged and refunded the same way.
3. **Generator:** `writeInstantIdea({ orgId, name, locale, direction, facts, idea, videoSeconds })` returns
   `{ day: { title, why, beats, closingLine }, usage }`. Use the same `ask`, clamps (`LIMITS`), `cleanSlideText` and
   `PlanAiFailed` rules as `writeDay`; empty title or fewer than 3 usable beats throws `PlanAiFailed`.
4. **Types** (`content.plan.schema.ts`): `PlanInstantIdeaView = { id, date, idea, title, why, beats, closingLine,
   status: 'DRAFT'|'PLANNED'|'RECORDED'|'MISSED' }`. Add `instantDraft: PlanInstantIdeaView | null` to `PlanView` (the
   open draft, or null). `PlanDayView` already has `kind`; make `dayIndex` and `angle` nullable in both web and phone
   views, with `kind: 'INSTANT_IDEA'` rows.
5. **Repository** (Prisma only): `createDraft` (replaces the organization's open DRAFT row, with an empty `title` until
   refined), `getInstantIdea(organizationId, id)` (always filtered by organization), `saveRefined`, `confirm` (DRAFT to
   PLANNED, only when `title` is not empty), `markInstantRecorded` (sets `recordedAt`, idempotent),
   `instantIdeasBetween(organizationId, from, to)`, `purgeStaleDrafts(olderThan)`.
6. **Service**:
   - `startInstantIdea(org, { idea, date })`: admin only; plan ACTIVE (else 409 `PLAN_NOT_ACTIVE`); `date` between today
     and the end of the last roadmap week, else 400 `INVALID_PLAN`; claim `busy = 'instant'` (409 `PLAN_BUSY`); create the
     draft; start a job `{ kind: 'instant', id: draftId }`; return 202 with the plan view (its `instantDraft` set).
   - `refineInstantIdea(draftId)` (called by the job): spends `plan.instant` through `charge`, calls `writeInstantIdea`,
     saves it, clears `busy`. Throws on failure like `buildProposal`.
   - `instantFailed(draftId)`: clears `busy`, sets `notice = 'instant_failed'`, keeps the draft so Try again can re-POST.
   - `confirmInstantIdea(org, id)`: admin only; 409 `DRAFT_NOT_READY` while `title` is empty or busy is `'instant'`;
     sets PLANNED; returns the view.
   - `recorded`: when no `PlanDay` matches the id, look for a `PlanInstantIdea` of the organization and mark it (same
     200 and idempotency); otherwise 404 `DAY_NOT_FOUND`. Both the web and the public route use it.
   - `currentWeek` (web) and `phoneWeek` (public): append the instant ideas whose `date` is inside the week, status not
     DRAFT, as `kind: 'INSTANT_IDEA'`, `dayIndex: null`, `angle: null`, `version: 0`. Order by date, the AI day before the
     instant idea on the same date. In the phone view they appear only when the week is READY, like all days. A PLANNED
     instant idea whose date is before `today` is shown as `MISSED` (derived in the view only, nothing is written).
   - Instant ideas never count toward `videosPerWeek`, and are never read by the roadmap, rotation, angle history, week or
     day prompts.
   - The tick calls `purgeStaleDrafts` (older than 24 hours).
   - `PlanJob.kind` gets `'instant'`; `PlanView.instantDraft` is filled in `view`.
7. **Orchestrator:** a `case 'instant'` in `contentPlanRunJob` (calls `refineInstantIdea`) and in `contentPlanJobFailed`
   (calls `instantFailed`). Do not change any activity or workflow parameter, only add the case.
8. **Controller** (`content.plan.controller.ts`): `POST /content-plan/instant-ideas` (zod `InstantIdeaSchema`, 202) and
   `POST /content-plan/instant-ideas/:id/confirm` (200). Error codes as in the contract. The public controller needs no
   new route (its `recorded` route already calls the service).

**Spec** (`content.plan.instant.spec.ts`, in-memory fakes like `content.plan.change.spec.ts`): date out of range gives
`INVALID_PLAN`; a second start replaces the first draft; confirm before refine gives `DRAFT_NOT_READY`; a failed refine
sets the notice and frees `busy`; credits are charged once and refunded on failure; confirm makes it appear in
`phoneWeek` after the AI day with `kind` `INSTANT_IDEA`, `dayIndex` null and `angle` null; it is hidden when the week is
not READY; a past PLANNED one shows MISSED; `recorded` on its id works, twice gives the same 200, another organization's
id gives 404; the AI days, `videosPerWeek` and rotation are unchanged by it.

## B9 — Instant idea: web
**Depends on:** B8, B6, B7. **Read first:** B7's `plan.active.tsx`, `plan.this.week.tsx`, `plan.day.card.tsx`,
`use.plan.request.ts`, `use.plan.current.week.ts`, `plan.parts.tsx`; "What people see" item 3 (Add my own idea).

**Do**
1. `plan.instant.tsx` (`PlanInstant`, rendered by `PlanActive` under **This week**, hidden for members who cannot edit):
   - Idle: a textarea (`dir="auto"`, max 1000 characters), a date input (min today, max the last roadmap week's end, default
     today) and **Refine** (disabled while empty).
   - Thinking: while `plan.busy === 'instant'` show "Thinking…" and keep polling every 3 s.
   - Draft: when `plan.instantDraft` has a title, show the same day card layout with the "Your idea" chip and no angle chip,
     with **Add to plan** (`POST /instant-ideas/:id/confirm`) and **Edit idea** (back to the textarea, text kept, **Refine**
     posts again and replaces the draft).
   - Failure: `notice === 'instant_failed'` shows one quiet line and **Try again** (re-POST with the kept idea and date).
   - After **Add to plan**: if the date is in the current week the card shows in the list; otherwise a line "Added for
     <date>" (reader's locale, through `planDate`).
2. `plan.day.card.tsx`: for `kind === 'INSTANT_IDEA'` show the "Your idea" chip instead of the angle chip, hide **Change
   this topic**, keep **Mark recorded** and Missed derivation.
3. `use.plan.request.ts`: friendly toasts for `DRAFT_NOT_READY` and `PLAN_NOT_ACTIVE`; `INVALID_PLAN` on the date shows
   "Pick a date from today to the end of your plan". `use.plan.current.week.ts` also polls while `busy === 'instant'`.
4. No script text anywhere that is not already shown in the other cards. Every displayed text has `dir="auto"`.

## Verification (owner, on the higher-RAM PC)
1. `pnpm run prisma-generate`, `pnpm build`, then the new specs:
   `pnpm test -- content.plan` and `TEST_DATABASE_URL=... pnpm run test:integration -- content-plan`.
2. With `META_MUSE_API_KEY` set (a Meta Model API key with access to `muse-spark-1.3-contributor`) and the orchestrator running with `RUN_CRON=1`: open `/plan` → type about a real business →
   answer 2-3 rounds → Show me the plan → revise once → Confirm. Expect: the week is ready within about a minute, and as many
   videos as chosen (try 1, 3 and 7) in the business's language. Change the number afterwards: the current week keeps its
   videos and the next week uses the new number.
3. Phone: see P1-P4.
4. Wait for or simulate the next week (set the current week's `weekStart` 7 days back in the DB, then run the tick) →
   leftovers carried (max 3), new week generated.

5. **Prompt acceptance** (owner, once after B2): run a fixture business, written in any language, through a real call and
   read the output.
   - No number, price, duration, result or person's name appears that is not in the fixture text.
   - Every example or story is openly hypothetical.
   - Everything is in the fixture's language and no other.
   - Reading one video's `say` texts aloud takes about `videoSeconds` seconds.
   - Every hook is a short phrase, not a sentence of the script.
   - Meta accepts the order RULES, brand context, frame (a `developer` message after a `user` message), and a second call
     for the same brand reports `cached` above 0.

## Progress (runner-maintained)
| Card | What | Depends on | Status |
|---|---|---|---|
| B1 | Schema, types, pricing, prompts, Meta chat client, throttle, web link | — | ☑ |
| B2 | Generator | B1 | ☑ |
| B3 | Setup + proposal service, rules, web routes | B2 | ☑ |
| B4 | Weekly engine + orchestrator | B3 | ☑ |
| B5 | Change routes + phone routes | B4 | ☑ |
| B6 | Web setup + preview | B3 (contract) | ☑ |
| B7 | Web active plan | B5, B6 | ☑ |
| B8 | Instant idea: backend | B1-B5 | ☑ |
| B9 | Instant idea: web | B8, B6, B7 | ☐ |
### Goal
A person with several brands always sees which brand the tab is in, at every screen width, and switches by clicking or
tapping the header badge (Ctrl+K keeps working). A switch never carries anything from the old brand: it is a **full page
load**, never an in-place state change. It lands in the same section of the new brand and becomes the default for new tabs
and the next sign-in.

### Owner decisions (2026-11-20)
- The visible word is **Brand**, as in the header, "New brand" and the palette. Code names keep "workspace" or "org".
- Landing: the same top-level section, such as Analytics → Analytics. An item page (`/agents/<id>`) lands on its section
  root, and anything unknown lands on `/launches`. The query string and hash are always dropped, so no id of the old brand
  reaches the new brand's URL.
- The switch saves the default by calling the existing `POST /user/change-org`. This resolves open decision D-412. If
  that call fails, the switch still happens.
- No backend, schema or workflow change, and no new page.
- **Not doing:** a separate "choose brand" page, a subdomain per brand, a side-menu entry, or any in-place switch without a
  reload.

### What already exists (reuse, don't rebuild)
- Brand in the URL: `/w/<id>/…`, helpers in `libraries/helpers/src/utils/workspace.path.ts` (`splitWorkspacePath`,
  `workspacePath`). `apps/frontend/src/proxy.ts` rewrites the URL and sets `x-workspace-id`. The backend checks
  membership and answers 403 for a non-member.
- Palette: `apps/frontend/src/components/brand/switcher/brand.switcher.tsx`. Ctrl+K or Cmd+K (not inside the editor),
  filter, arrow keys, Enter, Escape, prefetch of the highlighted brand, a "New brand" entry, and a full load via
  `window.location.assign(workspacePath('/launches', id))`. Brands come from `use.switcher.brands.ts` (SWR, only while
  open).
- Badge: `brand.badge.tsx` (avatar, name and colour from `useCurrentBrand`; renders nothing until it has data). It's
  mounted twice in `apps/frontend/src/components/new-layout/layout.component.tsx`: inside the title (shown `sm` to `md`)
  and on the right (shown from `md`). There's none below `sm`, so phones see no brand.
- Saved default: `POST /user/change-org` with `{ id }` (`apps/backend/src/api/routes/users.controller.ts`) sets the
  `showorg` cookie. It's read only when a request has no `x-workspace-id`, so open tabs are unaffected. A cookie
  pointing at a brand the user has left falls back to their first brand.
- Spec: `apps/frontend/src/components/brand/switcher/brand.switcher.spec.ts` (jsdom; mocks `useFetch`, `useT`,
  `useModals`, `useWorkspaceId`; records `location.assign`). Its header comment gives the run command.

### Rules (from `CLAUDE.md`)
- Follow the patterns around you: the drawer state in `layout.component.tsx` (`mobileDrawerOpen` with `MobileNavigation`
  `isOpen / onOpen / onClose`) is the model for the palette's open state.
- Text goes through `useT()` as `t('key', 'English fallback')`, like the existing brand keys. No locale file edits.
- Tailwind 3 with the existing tokens (`bg-boxHover`, `text-textItemBlur`, `bg-newBgColorInner`…). Never use
  `--color-custom*`.
- No new file of pure logic. Helpers live as local functions in the component that uses them.
- Every in-app navigation goes through `workspacePath` (the lint rules in `eslint.config.mjs` enforce it).
- Commit per card: `feat(brand): <card id> <what>`, ending with the `Co-Authored-By` line the session gives.
- After the card, run a sub agent that compares the new code with nearby code for odd patterns (`CLAUDE.md`).

### Leak guard (what a switch must not carry)
| Carrier | Guarded by |
|---|---|
| SWR cache, React state, open modals, CopilotKit | full page load |
| Ids and query in the URL | landing on the section root only (W2) |
| Other open tabs | each tab's URL decides its brand |
| `localStorage` | read through: only UI preferences and `returnUrl`, nothing per brand |

## Progress

| Card | Repo | What | Depends on | Status |
|---|---|---|---|---|
| W1 | web | The badge is a button that opens the palette at every width; the layout owns the palette's open state | - | ✅ |
| W2 | web | The switch saves the default, then does a full load into the same section; shows Switching…; records D-412 | W1 | ✅ |

## W1: The badge opens the palette, at every width

**Read first:** `brand.badge.tsx`, `brand.switcher.tsx`, `brand.switcher.spec.ts`, `brand.avatar.tsx`,
`new-layout/layout.component.tsx` (the header block and the `mobileDrawerOpen` state), and `MobileNavigation`'s props.

**Do:**
- `BrandBadge` becomes a `<button type="button">` with `aria-label` "Switch brand" (key `switch_brand`), a small down
  chevron after the name, and a tooltip of "Switch brand (Ctrl+K)" (key `brand_switch_hint`, fallback updated). It takes
  `onClick` and an optional `compact` (avatar and chevron, no name). It still renders nothing until the brand has loaded.
  Keep its separator, because the `sm`-`md` slot hides it with `[&>div:last-child]:hidden`.
- `BrandSwitcher` takes `isOpen`, `onOpen` and `onClose` in place of its own `open` state. Ctrl+K calls `onOpen` or
  `onClose`. Every other behaviour stays exactly as it is.
- The layout holds `brandSwitcherOpen` and passes it down, as it does for the drawer. Both existing badges open the
  palette. Add a compact badge visible only below `sm`, placed just before the menu button.
- Spec: mount the palette through a small test component that holds the open state. All current cases keep passing
  unchanged in meaning. Add: clicking the badge calls `onClick`; the compact badge shows no name but keeps the avatar and
  label.

**Done when:** reading the code shows one palette, opened by click, tap or Ctrl+K; phones get a badge; the spec is
updated, not run (owner runs it); the commit is in.

## W2: Switch saves the default and keeps the section

**Read first:** `brand.switcher.tsx` (after W1), `brand.switcher.spec.ts`, `libraries/helpers/src/utils/workspace.path.ts`,
`users.controller.ts` (`changeOrg`), the page list under `apps/frontend/src/app/(app)/(site)/`, and `_planning/_decisions.md`
row D-412 (and its last rows, for the numbering).

**Do:**
- In the palette, choosing another brand:
  1. Marks that row "Switching…" (key `switching_brand`) and ignores further choices, clicks and Enter.
  2. Awaits `fetch('/user/change-org', { method: 'POST', body: JSON.stringify({ id }) })`. Any failure is ignored.
  3. Calls `window.location.assign(<target>)`.
  Choosing the current brand still only closes the palette.
- The target comes from a local function in the same file. Take the path without `/w/<id>`
  (`splitWorkspacePath(window.location.pathname).path`) and match it against the section roots: `/launches`,
  `/analytics`, `/media`, `/plugs`, `/agents`, `/third-party`, `/settings`, `/billing`, `/ai-captions`, `/quick-start`,
  `/super-admin`.
  - If the path equals a root or starts with root + `/`, the target is `workspacePath(root, id)`.
  - Anything else gives `workspacePath('/launches', id)`.
  - Never keep the query string, the hash or anything after the root.
- The prefetch link uses the same target.
- Spec: change the existing `/launches` expectations only where the test now sets a section path. Add these cases:
  - `change-org` is posted with the id **before** `assign`
  - a failed `change-org` still navigates
  - `/analytics` → `/w/B/analytics`
  - `/agents/<id>` → `/w/B/agents`
  - `/billing/topup-return?token=x` → `/w/B/billing`
  - an unknown path → `/w/B/launches`
  - a second choice while switching does nothing
  - the prefetch href equals the target
- Planning records: add a `_planning/_decisions.md` row saying D-412 is resolved (`change-org` before the full load;
  landing on the section root, by owner request 2026-11-20). Add a one-line `_planning/_state.md` log entry noting an
  owner-requested update to `brand.switcher` (G-016), with no new sub-module.

**Done when:** reading the code shows the order save → load, the landing rule, and the double-choice guard; the spec has
every case above; the planning rows are added; the commit is in.

## Owner checks (after W2, on the desktop)

Commands:
- The spec command from the header of `brand.switcher.spec.ts`
- `pnpm lint` from the root
- A frontend type check
- `e2e/tenancy/*`

Manual:
1. [ ] Desktop width, a user with three brands: click the header badge; the palette opens with the current brand marked.
2. [ ] From A's Analytics choose B: a full load (the network tab shows a document request) to `/w/B/analytics`; nothing
   of A shows.
3. [ ] From `/w/A/agents/<id>`, switch: you land on `/w/B/agents`.
4. [ ] A new tab at the site root opens brand B.
5. [ ] A second tab still on A keeps showing A.
6. [ ] 375 px width: the brand avatar is in the header; tap it; the palette opens and the switch works.
7. [ ] Ctrl+K toggles the palette; Ctrl+K inside the post editor still makes a link.
8. [ ] With the network to `/user/change-org` blocked (devtools), the switch still happens.
