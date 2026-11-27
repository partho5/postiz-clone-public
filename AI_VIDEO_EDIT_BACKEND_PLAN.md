RULE: this PC hangs under load, so do not run `pnpm build`, tests, specs, the dev server or any other heavy command.
Write code only, and verify at code level (read the code against the contract).
If a check genuinely needs a run, stop and ask the user: they push, pull on a higher-RAM PC and run `pnpm build` and the specs there.

This file is the design overview of the backend side. **The build runs from the app repo's `to-build/tasks.md`**
(`/home/haku/projects/AndroidStudioProjects/FaceCam-Presentation-Recorder/to-build/tasks.md`): self-contained task cards,
one per session, each backend card next to its client app card, with the exact contract JSON. Progress is tracked there only.
-----------------

# AI Video Editing Engine — Backend Build Plan (parts B1–B5)

Top rule, above every other rule: **frictionless, smooth UX that lowers the user's cognitive load.**

The full spec lives in the app repo: `/home/haku/projects/AndroidStudioProjects/FaceCam-Presentation-Recorder/ai-video-editing-spec.md`
(sections are cited below as "spec §N"). Read it before any part. The app's tracker for the same feature is
`AI_VIDEO_EDIT_APP_PLAN.md` in the app repo's root (parts A1–A7).

Branch: `feat/ai-video-edit`. One commit per part (`feat(ai-edit): ...`), ending with the attribution line from the
session. `L/` = `libraries/nestjs-libraries/src/`.

## House rules for this feature

1. Follow `CLAUDE.md`. B1 writes the new contract doc for AI video editing. A change to a frozen contract
   (`credits.ai-charging`, `ai.video-captions`, `api.mobile-direct-upload`) needs a recorded decision first.
2. DTO → Controller → Service → Repository. Prisma only, never raw SQL. Production has users: migrations only add.
3. Workflows and activities already on `main` are never edited. This feature adds new ones.
4. Money goes only through `AiChargingService` / `CreditsService` (reserve, then commit or release; idempotency key per
   job; price from `pricing.config.ts`, never a literal).
5. Every query is scoped to the workspace (`organizationId`). Another workspace's job is 404.
6. Never log transcript words, plan texts or brand text. Errors to the phone use our own codes and words.
7. No video processing on the server (there is no ffmpeg here; media processing runs on RunPod). The phone sends the
   pieces it needs, already cut.
8. Match the look of the neighbouring code: the ai-captions module (`L/database/prisma/ai-captions/`,
   `apps/orchestrator/src/workflows/ai.captions.workflow.ts`) is the model for B2 and B3.

## Parts and their task cards (status lives in `to-build/tasks.md` of the app repo)

| Part | Description | Task cards |
|---|---|---|
| B1 | Contract files and pure planner core, with specs | T0.1, T1.1, T1.2 |
| B2 | Data model, credits, proxy upload purpose, public routes | T2.1, T2.2 |
| B3 | Planning workflow: transcript, structure, Clef-omni perception, writer, assemble, validate | T2.2, T4.1, T4.2 |
| B4 | IconScout assets with a shared R2 cache; sound effect URLs | T5.1 |
| B5 | Caption credits held until used, released on discard | T6.1 |

---

## B1 — Contract files and pure planner core

**Goal:** the language-neutral engine contract and the planning logic as pure functions (no Nest, no Prisma, no network),
fully covered by specs. Nothing is wired to a route yet.

**Folder:** `L/ai-video-edit/`

### contract/ (the single source of truth; the app gets it as JSON from `GET /public/v1/ai-edits/contract` in B2)

- `edit.contract.ts`
  - `CONTRACT_VERSION = 2` (v1 had Lottie; v2 has the mp4 `icon_video`, see AI_EDIT_MP4_OVERLAYS_PLAN.md).
  - Types: `EditLevel` (`basic | standard | heavy`), `OutputRatio` (`9:16 | 4:5 | 1:1`, in that order), `EditRequest`
    (spec §9, without `manual_edit`: the phone remaps), `ActivityEntry` (spec §10), `FacecamKey`, `EditWord`
    (`{ i, w, start_ms, end_ms, conf? }`), `Plan`, `PlanItem`, `PlanComponent`, `PlanCaptions`, `Palette` (spec §16),
    `RegistryEntry` (spec §14 incl. `min_level`, `brand_colorable`).
  - `LEVEL_RULES`: per level max feature effects (3 / 6 / 10), allowed layers, max icons (0 / 2 / 4), text kinds,
    transitions, sounds, `perception` (false / true / true), `writer` (false / false / true) (spec §6).
  - `SPEED_RULES` (spec §12) and `TEXT_HOLD` formula.
  - `ZONES` and `SAFE_RECT` per output ratio (spec §16): 9:16 x 0.06–0.94, y 0.10–0.62; derive 4:5 and 1:1 from the crop.
  - `PROTECTION`: `padding_ms` 300, `min_window_ms` 500, `merge_gap_ms` 400.
- `edit.registry.ts` — every effect of spec §14 as `RegistryEntry[]` (first wave fully filled; the rest with
  conservative defaults). Helpers: `effectById`, `effectsForLevel(level, capabilities)`.
- `edit.styles.ts` — the 6 text looks (sticker, label pill, 3D, soft glow, gradient fill, highlighter) as presets with
  colour **roles** (`accent`, `accent_dark`, `on_accent`), never fixed colours; `DEFAULT_PALETTE` (5 accents, spec §13);
  caption effect ids mapped to the app's subtitle templates.
- `edit.phrases.ts` — about 40 commentary phrases: `{ id, mood[], text: { en, bn } }` ("Interesting", "So sad",
  "Attention", "Did you know?", "Wait…", "Facts", "Big mistake", …). A language without a phrase falls back to keyword echo.
- `edit.sounds.ts` — `pop_1`, `pop_2`, `whoosh_short`, `swoosh`, `ding`, `impact_soft`, `click`, each with the effect
  families it pairs with.
- `edit.contract.view.ts` — `contractView()`: the JSON the route serves (version, registry, styles, palette, phrases,
  sound ids, level rules, speed rules, zones).

### core/

- `edit.words.ts` — `toEditWords(words: TranscriptWord[])` (from `L/muse/transcription.provider.ts`): keep
  `type === 'word'`, index from 0, integer ms.
- `edit.windows.ts` — merge brush/motion entries closer than 400 ms, pad by 300 ms → protected spans; markers
  (`slide_change`, `board_show`, `board_hide`) never protected; free windows = timeline minus spans, drop < 500 ms.
- `edit.timeline.ts` — phase 1: silence cuts from word gaps over a configurable threshold, never inside a protected
  span (keep a small lead-in/out around words); Heavy-only speed segments; the source → output map; remap words,
  activity entries and the facecam track to the output timeline.
- `edit.slots.ts` — candidate slots inside free windows: numbers, long or rare words, words before a pause, words
  repeating the topic, first sentence after a slide change; one hook slot in the first 3 s.
- `edit.assembler.ts` — `assemble(input)` → plan items from slots + scores (perception) + texts (writer), with
  deterministic rules: level budget, pacing (a visible change about every 2–3 s), variety, cooldowns, one text overlay at a
  time, zones per ratio, text hold time, sound pairing, palette `color_slot` rotation. With no scores (Basic, or Clef
  failed) it still works from slots alone (keyword echo, punch-in).
- `edit.validator.ts` — every rule of spec §17, repair order (shift, shorten, swap cheaper, drop), returns
  `{ plan, warnings, rejections }`; sorts by `start_ms`, unique ids.

### Specs (`*.spec.ts` beside each file; fixtures in `core/fixtures/`)

- Windows: brush at start, middle, end; overlapping spans; gaps under 500 ms.
- Remap: cuts and speed segments shift words, spans and the facecam track correctly.
- Validator: one passing and one failing case per rule; repair order.
- Golden plans: 3 English and 2 Bengali transcripts → valid plan with zero warnings at each level.

### Contract doc

- The AI video editing contract doc (kind: declared): purpose, exports
  of B1–B4, routes of B2, prices, statuses.

**Done when:** no file in `L/ai-video-edit/` imports Nest, Prisma or a network client; every spec above exists.

---

## B2 — Data model, credits, proxy upload purpose, public routes

**Goal:** a phone can ask for an AI edit, is charged once, and can read the job. The job does nothing yet (B3).

### Prisma (`L/database/prisma/schema.prisma` + migration folder, pattern `migrations/20261021120000_ai_captions/`)

`model AiVideoEdit`: `id`, `organizationId` (+ relation, `aiVideoEdits` on `Organization`), `userId?`, `sessionId`
(the phone's recording session uuid), `level`, `status` (default `PENDING`), `error?`, `aiCaptionId?`,
`audioUploadId?`, `proxyUploadIds String[]`, `request Json`, `words Json?`, `scores Json?`, `plan Json?`,
`log Json?`, `language?`, `sourceSeconds Int`, `cost Int`, `deletedAt?`, `createdAt`, `updatedAt`.
`@@unique([organizationId, sessionId, level])` (a repeat tap answers the same job), `@@index([organizationId, createdAt])`.

### Credits

- `L/database/prisma/credits/pricing/pricing.config.ts`: actions `ai.edit.basic` 1, `ai.edit.standard` 2,
  `ai.edit.heavy` 3, unit `ITEM` ("AI edit a video, per started 3 minutes").
- `L/database/prisma/credits/pricing/edit.blocks.ts` (+ spec), beside `caption.minutes.ts`: `editBlocks(seconds)` =
  started 3-minute blocks, at least 1.
- `L/database/prisma/credits/ai/ai.charging.service.ts`: `AiKind` += `'edit'`; request field `editLevel`;
  `priced()` → `ai.edit.<level>` × blocks. `POST /ai/quote` accepts it. Drift entry for `credits.ai-charging`.

### Proxy upload purpose (drift entry for `api.mobile-direct-upload`)

- `L/dtos/mobile-upload/mobile.upload.create.dto.ts`: `MOBILE_UPLOAD_PURPOSE_EDIT_PROXY = 'edit_proxy'`.
- `L/upload/r2.uploader.ts`: `EDIT_PROXY_EXT_TO_MIME = { '.mp4': 'video/mp4' }`.
- `L/database/prisma/mobile-upload/mobile.upload.service.ts`: a work file (`transcript_audio` or `edit_proxy`) makes
  no media row; `edit_proxy` takes only `.mp4`, ≤ `AI_EDIT_MAX_PROXY_BYTES` (default 16 MiB, the Clef-omni limit),
  own pending cap 4; generalise `isTranscriptAudio` into a work-file check without changing audio behaviour.
- `L/database/prisma/mobile-upload/mobile.upload.repository.ts`: the 24 h sweep covers both purposes; `hasCaption`
  also answers true when an AI edit job names the upload.
- `L/throttler/throttler.provider.ts`: `edit_proxy` counts in the audio bucket.

### Service and repository (`L/database/prisma/ai-video-edits/`)

- `ai.video.edits.repository.ts` — create (unique race like captions), get by org, update, guarded stale close.
- `ai.video.edits.service.ts`
  - `create(orgId, userId, body)`: repeat → same job; check the caption (READY, same workspace) or the audio upload
    (completed `transcript_audio`), and every proxy upload (completed `edit_proxy`); seconds from the WAV header or
    the caption's `audioSeconds`; reserve `kind: 'edit'` with key `ai:edit:<id>`; 402 `INSUFFICIENT_CREDITS` or
    `AI_CAP_REACHED` → the job row is removed and nothing is held; start `aiVideoEditWorkflow` (B3; until then
    the start fails cleanly → release, FAILED, 503).
  - `get(orgId, id)` → `{ id, status, error?, cost, plan?, assets? }`; stale job (3 h unchanged) ended on read, like
    `AiCaptionsService.expire`.
  - `quote(orgId)` → cost per level for this workspace (`AiChargingService.estimate`), for the button label.
  - `contract()` → `contractView()`.
- Register both in `L/database/prisma/database.module.ts`.

### DTO and routes

- `L/dtos/ai-video-edits/ai.video.edit.create.dto.ts`: `sessionId`, `level`, `aiCaptionId?` or `audioUploadId?`
  (exactly one), `proxyUploadIds?` (≤ 4, required for standard and heavy), `request` (validated object: version,
  video, outputs with crop and caption band, facecam track, activity map ≤ 2000 entries, `text_colors`, language,
  capabilities, options).
- `apps/backend/src/public-api/routes/v1/public.integrations.controller.ts` (same style as the ai-captions routes):
  - `POST /ai-edits` — `posts:write`; 202 `{ id, status, cost }`.
  - `GET /ai-edits/quote` — `posts:read`; `{ basic, standard, heavy }` (declare before `:id`).
  - `GET /ai-edits/contract` — `posts:read`; the contract JSON.
  - `GET /ai-edits/:id` — `posts:read`; 404 `EDIT_NOT_FOUND` for another workspace's.
- No plan feature gate: credits and the free-plan AI cap are the gate.

**Done when:** a repeated create holds credits once; a 402 leaves the ledger unchanged; specs for the service cover
both, plus the proxy purpose rules in the upload service spec.

---

## B3 — Planning workflow

**Goal:** a job goes from PENDING to READY with a validated plan, or to FAILED with its credits released.

### Orchestrator (new files only)

- `apps/orchestrator/src/workflows/ai.video.edit.workflow.ts` — `aiVideoEditWorkflow({ editId })`: `transcribeEdit`
  → `perceiveEdit` → `writeEdit` → `planEdit` → `finishEdit`; on any failure `failEdit` in a non-cancellable scope.
  Timeouts and retries like `ai.captions.workflow.ts`.
- `apps/orchestrator/src/activities/ai.video.edit.activity.ts` — `AiVideoEditActivity`, one object parameter per
  method. Register in `apps/orchestrator/src/app.module.ts` and export from `workflows/index.ts`.

### Steps (service methods; state lives on the job row so every step can be repeated)

1. `transcribeEdit` — words from the caption's `segments[].words` (`aiCaptionId`), else
   `TranscriptionProvider.transcribe(audio key)` (the injected `MuseTranscriptionService` token), then delete the
   audio. Too few words → `NO_SPEECH`, credits released.
2. `perceiveEdit` (standard, heavy) — `L/ai-video-edit/clef.omni.client.ts`:
   `POST https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-omni`,
   bearer `CLOUDFLARE_AI_TOKEN`, body `{ model: 'clef-omni', state, videos, questions }`. Limits: ≤ 2 videos per call
   (≤ 60 s, ≤ 16 MiB each), ≤ 64 questions, media embedded (no URLs), 64k tokens. Question types are only `noul`
   (probability), `choice` (`criteria` map) and `score` (ordered levels). Questions per piece: `mood` (choice),
   `energy` (score), `screen_busy` (noul), one `emph_<word index>` noul per candidate word, `comm_<slot>` choice over
   the mood-matching phrase ids, `fam_<slot>` choice of effect family. Batch when over 64. **Before coding, read the
   model's `schema-input.json` / `schema-output.json` (linked from
   https://developers.cloudflare.com/workers-ai/models/clef-omni/) for the exact media encoding and answer keys.**
   Any failure → no scores for that piece (the assembler works without them). Delete the proxy objects after.
   Cost is about $0.003 for a 2-minute video at 480p.
3. `writeEdit` (heavy) — new `OpenaiService.writeEditTexts(model, effort, messages)` in `L/openai/openai.service.ts`,
   same shape as `writeCaption`, zod schema `{ slots: [{ id, text, icon_query? }] }`. Prompt is a constant in
   `L/ai-video-edit/edit.writer.prompt.ts` (spec §18); model from env `AI_EDIT_WRITER_MODEL`, default
   `PROMPT_BOOK_MODEL`. Brand voice, banned words and colour from the brands service of `brand.profile`. Failure →
   heavy falls back to standard texts.
4. `planEdit` — B1 core: structure, remap, windows, slots, assemble, assets (B4 resolver behind an interface; until B4
   it returns no icons), validate. Store `plan`, `scores`, `log` (rejections and warnings, never words).
5. `finishEdit` — commit, `READY`. `failEdit(editId, error?)` — release unless READY, `FAILED`, delete uploads.

**Done when:** specs cover each step with the Clef and OpenAI clients mocked: success, Clef down (plan still valid),
writer down (heavy still valid), no speech (released), workflow start failure (released).

---

## B4 — Assets: IconScout and sounds

**Goal:** icon and mp4 clip slots get real assets, downloaded once and reused for every user.

- `L/ai-video-edit/assets/iconscout.client.ts` — search `GET https://api.iconscout.com/v3/search` (header `Client-ID`
  = `ICONSCOUT_CLIENT_ID`; asset `lottie` (IconScout's word for the animated listing, whose `urls.thumb` is an mp4) or
  `icon` (png); English query from the writer or the keyword).
  - Download the file from the `urls.thumb` URL already in the search result JSON with a plain GET. There is no paid
    `api-download` call and no licensed mode.
- Prisma `model AiEditAsset` (`provider`, `providerId`, `kind`, `objectKey`, `nativeDurationMs?`, `width?`,
  `height?`, `createdAt`; `@@unique([provider, providerId])`) + migration. Store the file in R2 under
  `ai-edit/assets/<provider>/<id>.<ext>` (`PutObjectCommand`, `R2_BUCKET`) and serve with `mediaUrl`. Clip duration: B4 of
  AI_EDIT_MP4_OVERLAYS_PLAN.md reads it from the mp4 headers (v1 read a Lottie JSON).
- `L/ai-video-edit/assets/edit.assets.service.ts` — implements B3's resolver: cache hit → row; miss → search,
  download, store; any failure → the slot is dropped (never fails the job). Sounds: `AI_EDIT_SOUNDS_BASE_URL/<id>.wav`
  returned in the job's `assets` list.
- `.env.example` and `deploy/.env.example`: `CLOUDFLARE_AI_TOKEN`, `ICONSCOUT_CLIENT_ID`, `AI_EDIT_SOUNDS_BASE_URL`,
  `AI_EDIT_WRITER_MODEL`, `AI_EDIT_ICON_MODEL`, `AI_EDIT_MAX_PROXY_BYTES`.
- Owner action (written at the end of the part): upload CC0 sound files (Kenney "Interface Sounds" / "UI Audio",
  Freesound filtered to CC0) as `<id>.wav` under the sounds base URL.

**Done when:** a second job asking for the same icon makes no IconScout call (spec with the client mocked).

---

## B5 — Caption credits held until used

**Goal:** recording and discarding are free (spec §5). Today `finishCaption` commits the caption credits as soon as the
words are ready, so a discarded take still costs credits.

Facts: the nightly reconciliation (`L/database/prisma/credits/reconcile/credits.reconcile.service.ts`,
`OTHER_STALE_HOURS = 24`) already releases any AI reservation older than 24 h. So an unused hold frees itself after
about 24 h with no new job.

- Drift entry for `ai.video-captions` first.
- Prisma: `AiCaption.creditState String @default("SETTLED")` (old rows stay settled); values `HELD`, `COMMITTED`,
  `RELEASED`, `INCLUDED`.
- `finishCaption` → `READY` with the reservation kept and `creditState = HELD` (no commit). Nothing else about the
  job changes.
- `useCaption(orgId, id)` — `HELD` → commit; if the reservation was already released by the reconciliation, reserve
  again (`reopenReleased`) and commit; `COMMITTED` or `INCLUDED` → nothing. Never throws into a publish.
- `releaseCaption(orgId, id)` — `HELD` → release, `RELEASED`.
- Publish path: where `applyToPosts` / `linkPosts` attach a READY caption to posts, call `useCaption`.
- AI edit: when a job reuses a caption (`aiCaptionId`), release its hold and mark `INCLUDED` (the edit price includes the
  transcript); later uses are free.
- Routes in the public controller: `POST /ai-captions/:id/use` (the app's "sub" embed) and
  `POST /ai-captions/:id/release` (the app's discard), `posts:write`, 200 `{ creditState }`.
- Update the ai-captions specs that expect a commit at finish; add specs for use, release, use after reconciliation, and
  an edit consuming a caption.

**Done when:** record → discard leaves the balance unchanged; record → embed or publish charges once.
