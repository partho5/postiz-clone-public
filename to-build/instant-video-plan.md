# Instant video plan: one reusable planning engine (task cards)

Written 2026-11-27. No code yet. Build one card at a time (see `agent-runner.md`), then pause for the owner.

## Goal
The owner types any raw idea, clicks once, and gets a finished short video (the on-screen topics plus what to say) on a
date. It reaches the phone as its own topic set and is the next one to record. The thinking steps (questions with
recommended answers, "Here's what I understood", the result, a revision) are the same engine the plan setup uses. That
engine is generic, so one video, a set of videos, or a future feature runs the same procedure.

## Owner decisions (2026-11-27)
- Same date as an AI video: both stay.
- Opens in a modal dialog, from a button "Instant video plan" to the right of Regenerate.
- The core UI is minimal: one input, one click, one video out. The defaults (date: today; videos: 1) sit in a folded
  "Options" row with an arrow. Questions appear only when the idea is genuinely unclear, with recommended answers
  pre-selected, so one click continues.
- The result is a **video preview**, not an idea: a phone-shaped 9:16 frame showing each on-screen topic as the phone
  will show it while recording. You can step through the topics, see the script for each, and change the date.
- The setup interview moves onto the engine as the last card.

## What exists today (checked in code)
- The backend has a one-shot instant idea: `POST /content-plan/instant-ideas` (idea + date) → job `instant` →
  `generator.writeInstantIdea` → `PlanInstantIdea` DRAFT → `POST /instant-ideas/:id/confirm`. It has no questions and no
  frontend.
- The setup procedure (`startSetup`, `answer` with rewind, `propose`, `revise`, `confirm`) is tied to the single
  `ContentPlan` row (`status`, `busy`, `ContentPlanRound.planId`) and to `SETUP_FRAME`, which is written for a
  multi-year plan. It can't be reused as it is.
- Phone (FaceCam `contentplan/`):
  - `ContentPlanCard.refresh` fetches `/public/v1/content-plan/week` on resume, at most every 10 minutes (`FRESH_MS`).
  - `PlanSetSync` saves every video of the week as its own set `plan-<id>`, including confirmed instant ideas.
  - `PlanAutoTarget` picks the first unrecorded video dated today or later. On the same date the server order wins, and
    `withInstantIdeas` puts the instant idea **after** the AI video.
  - The switch happens only on a fresh app launch.

  So today a new instant video syncs, but it does **not** become the active set when an AI video has the same date. It
  can also be up to 10 minutes late, and it never switches while the app is only resumed.

## Engine shape
- `PlanSession` (`organizationId`, `planId`, `kind`, `status` ASKING | PROPOSING | PROPOSED | DONE | DISCARDED,
  `sourceText`, `summary`, `options` Json, `proposal` Json, `proposalVersion`, `proposalTurns`, `busy`, `notice`) and
  `PlanSessionRound` (`sessionId`, `index`, `summary`, `questions`, `answers`, `readyForPlan`, `userTurn`,
  `assistantTurn`). These are new tables, so existing rows are untouched.
- `PlanSessionKind` interface: one implementation per kind, the same idea as the provider interface rule. It holds:
  - the prompt keys for the round and the proposal, and the proposal schema;
  - `buildProposal(session)`;
  - `confirm(session, edits)`;
  - `viewOf(proposal)`.

  The generic service never branches on a kind name.
- `ContentPlanSessionService`: `start`, `answer` (with rewind), `propose`, `revise`, `confirm`, `discard`, `view`. It
  holds the session's busy claim and charges through the existing `charge()`. `resolveAnswers` and `writeRound` move
  here from the plan service.
- Generator: `setupRound` becomes a generic `chatRound(frameKey, input)`. The setup calls it with its own frame, so
  setup behaviour is unchanged.
- Jobs: new `PlanJob` kinds `session_proposal` and `session_revise`, with cases in `ContentPlanActivity`. The workflow
  file is not changed, and the activity parameter keeps its shape (an object with `kind`).
- Prompts: every new text goes in `prompts/video-set.prompts.ts`. Nothing is hard-coded.

## Cards

### IV1. Session engine (backend, no visible change)
- Add the Prisma models and the migration.
- Add the `PlanSessionKind` interface, `ContentPlanSessionService`, the repository methods and the generic
  `chatRound`. Move `resolveAnswers` and `writeRound` into the shared service.
- Add the two job kinds and their activity cases.
- Specs: start → round → answer (with rewind) → propose → revise → confirm → discard, run against a test kind. Also
  cover the busy claim, stale round and stale proposal, and the failure path (busy released, notice set).

### IV2. Video-set kind (backend)
- `video-set.prompts.ts`:
  - The round frame asks only when the idea is unclear, and 0 questions is the normal case. It asks for a video count
    only when the idea is broad. It writes the "what I understood" summary.
  - The proposal frame writes N videos with the same rules as `INSTANT_FRAME`: beats `{hook, say}`, title, why, closing
    line.
- Proposal: `videos: [{ ref, title, why, beats, closingLine, date }]`. The dates start at the chosen date, one per
  day.
- `confirm(edits: { dates })` creates `PlanInstantIdea` rows as CONFIRMED, linked by `sessionId`. Each date must fall
  between today and the end of the plan.
- Routes `/content-plan/sessions` (start `{ kind, sourceText, options }`, answer, propose, revise, confirm, discard,
  get), built as DTO → controller → service → repository.
- The one-shot instant endpoints and the public API stay as they are.

### IV3. Owner's video is the next one on the phone (backend)
- `withInstantIdeas` puts an instant video **before** the AI video of the same date (the owner asked for it on purpose).
  The phone's existing `PlanAutoTarget` then picks it, with no phone change needed.
- Add `GET /public/v1/content-plan/week/stamp`: a cheap "has the week changed" value (newest `updatedAt` of the week,
  its days and its instant ideas).
- Specs: the order, and the stamp moving on confirm, regenerate and recorded.

### IV4. Shared flow pieces (frontend)
- Extract from the wizard the parts any session needs: the question round (cards, summary, Continue), the step bar
  and the waiting lines.
- Add the hooks: one SWR hook per session read, following the existing `use.*` pattern.
- The setup wizard is unchanged until IV8.

### IV5. "Instant video plan" modal (frontend)
- Add the button to the right of Regenerate in This week.
- Modal, first step: one textarea and "Plan this video". A folded "Options" row with an arrow holds the date (default
  today) and the number of videos (default 1).
- If the AI has questions, show one question step with the recommended answers pre-selected.
- Result: one phone-frame preview per video:
  - 9:16, with each topic shown large over a dimmed camera area;
  - step through the topics with arrows or a swipe, with dots;
  - "What to say" shows the script for the topic on screen;
  - an editable date chip;
  - "Not right?" sends a revision.
- "Add to plan" closes the modal. The video appears in This week on its date, and the confirmation says it's next on
  the phone.

### IV6. Phone: pick up a new video quickly (FaceCam, `contentplan/` only; recording screen untouched)
- On resume, call `week/stamp` and fetch the week whenever the stamp has changed, instead of waiting out `FRESH_MS`.
  Keep the cache-first display and the offline behaviour.

### IV7. Phone: the owner's new video becomes the active set
- Run the auto-switch on resume too (not only on a fresh launch), for a video the phone hasn't auto-targeted yet.
- Keep the existing guards: never while recording, never with the Topic Manager open, once per video. The owner's own
  topic sets are never touched.

### IV8. Setup on the engine (last)
- Make the setup interview the `plan` kind of the engine.
- Write a migration that moves in-progress setups (`ContentPlanRound` → `PlanSessionRound`).
- The wizard uses the shared pieces, and the old round code is removed.
- Existing confirmed plans are untouched.

## Shared contract (fixed so the web and phone lanes can run in parallel)
`GET /public/v1/content-plan/week/stamp`: same guard, auth and workspace as `GET /public/v1/content-plan/week`. It
answers `200 {"stamp": "<opaque string>"}`, and the stamp changes whenever anything `/week` returns changes: the week,
its days, instant ideas in it, recorded marks, or today's date for the brand. With no active plan or week, it still
answers 200 with a stable stamp.

## Progress (runner)
Branches: web `feat/instant-video-plan`; FaceCam `feat/instant-video-plan`. Coders: Sonnet sub agents, high effort.
Verification is deferred by the owner (2026-11-27): coders only for now, and every card is verified in one pass later.

| Card | Status | Commit | Verified |
|---|---|---|---|
| IV1 | done, awaiting verify | web b446a175 | |
| IV2 | done, awaiting verify | web 60731462 | |
| IV3 | done, awaiting verify | web 828234d8, FaceCam 0df114b | |
| IV4 | done, awaiting verify | web 8cd29519 | |
| IV5 | todo | | |
| IV6 | done, awaiting verify | FaceCam b85b2fe | |
| IV7 | done, awaiting verify | FaceCam eb8563f | |
| IV8 | todo | | |
