# AI Edit overlays: IconScout mp4 + png (no Lottie) — cross-repo plan

Owner's decision (2026-11-19). **Lottie is out for good. Never propose Lottie JSON, `api-download` or
`ICONSCOUT_DOWNLOAD=api`.** Overlays are IconScout's free mp4 preview (`urls.thumb`) and png only.
This file is the context for BOTH repos; read it before any overlay, asset, plan-contract or renderer work.

- Backend (NestJS): `/home/haku/projects/Next.js/Social-Media-Manager` (`L/` = `libraries/nestjs-libraries/src/`)
- App (Android, Java): `/home/haku/projects/AndroidStudioProjects/FaceCam-Presentation-Recorder`
  (`J/` = `app/src/main/java/com/jovoc/facecampresentationrecorder/`)
- Branch `feat/ai-video-edit` in both. Overall tracker stays `to-build/tasks.md` (app repo); this file tracks only
  this change. Extends spec §14 (Lottie and icon image), §15 (assets), §16 (plan schema), §17 (validator), §19.

## Rules for whoever builds
1. One task below per session, then stop and wait (owner's rule). Tick it in **Progress**, commit
   `feat(ai-edit): <task id> <what>`.
2. Do not run gradle, `pnpm build`, tests, dev servers or the emulator unless the owner says go (PC hangs / SSD tight).
3. Backend does **no media processing**: it stores the file and its metadata, nothing else. All keying is on the phone.
4. Match neighbouring code and comment density. Backend: DTO → Controller → Service → Repository, Prisma only,
   migrations only add. Never log a query or customer text, only kinds of failure.
5. Never assume a value is present: a missing, empty or malformed field drops that slot's icon, it never throws.

## The flow (what is decided)
1. **Query.** The Heavy writer gives a descriptive scene query per slot ("doctor looking at watch"), not one word.
2. **Search.** IconScout v3 `search` (Client-ID only, 0 credits): `asset=lottie` listing for the animated hits (the
   answer's `urls.thumb` is an mp4 preview), `asset=icon` for png. Animated first, png second. `per_page=10`.
3. **Read.** Keep only hits with a string `uuid`, a non-empty string `name` and an https `urls.thumb` of the right
   kind. `response.items.data` missing, not an array or empty → no candidates → slot dropped.
4. **Pick (LLM).** ONE call for all slots of the edit: per slot the slot's text/moment plus `uuid: name` lines of its
   candidates (names only, no tags, no urls). Returns the best `uuid` per slot or `none`. An answer that is not one of
   the candidate uuids counts as `none`. Cheap model (like `writeEditTexts` in `L/openai/openai.service.ts`, schema in
   zod, same style). No separate charge: it is part of the edit's price.
5. **Remember.** `query → picked uuid` is remembered (the existing `_remembered` map idea): a repeat of a query makes
   no search and no LLM call.
6. **Download** the picked `urls.thumb` straight from the CDN (size cap, timeout). Failure → slot dropped.
7. **Store (backend).** Check it is a real mp4 / png and read duration, width, height from the container headers
   (pure byte parsing like `pngInfo`; no ffmpeg). Save in R2 by `uuid`; metadata in `AiEditAsset`.
8. **Plan.** `planAssets` carries the url, `native_duration_ms`, width, height. Component type is `icon_video`
   (mp4) or `icon_image` (png).
9. **Phone downloads** the asset (existing `AssetCache`), **keys the white background to transparent with FFmpegKit
   once**, keeps the result, renders it as an overlay.
10. **Time.** Unchanged rules: hold 500–1500 ms (`icon_hold_ms`), longer clips are sped up at most 3×
    (`lottie_max_factor` is renamed to `clip_max_factor`), shorter ones play at their own length and hold the last
    frame. The icon starts `ENTRY_LEAD_MS` (80 ms) before its word, same as text. Assembler placement rules
    (one overlay at a time, cooldown, zones, level budget Heavy 4 / Standard 2 / Basic 0) are unchanged.

## Storage and metadata
- File: R2 (Cloudflare), key by provider id (`assetKey`). The mp4 is stored as downloaded.
- Metadata: Postgres table `AiEditAsset` (`L/database/prisma/schema.prisma`). Today: provider, providerId (uuid), kind,
  objectKey, nativeDurationMs, width, height, createdAt. **Add nullable columns** (additive migration; production has
  users): `name`, `slug`, `price`, `query`, `colorCodes` (Json), `meta` (Json, rest of the hit), `source`
  (`preview`), `lastUsedAt`. `kind` becomes `video` | `icon` | `sound`.
- Retention (owner: "you decide, but a variable, not hardcoded days"): keep a file until `AI_EDIT_ASSET_RETENTION_DAYS`
  (env, default 30) days after `lastUsedAt`, then delete the R2 object and the row. Never a literal number of days in
  code. Not 24 h: old edits and re-renders still name the url, and the cache is shared by every workspace.
- Orphans: the files of the deleted dev rows `kind='lottie'` (migration `20261121120000`) stay orphaned in R2 under
  `ai-edit/assets/iconscout/*.json`; delete by prefix/extension manually, they are dev cache only.
- Build mode (owner): the main session is controller + monitor, it never codes; a sub-agent codes each task and a
  separate sub-agent verifies it. Keying quality is built first and tuned from the owner's test feedback (A4).

## Phone: keying and rendering (decided)
- FFmpegKit is already in the app (`dev.ffmpegkit-maintained:ffmpeg-kit-full`, used by `J/util/VideoCropHelper`).
- The engine package (`J/aiedit/engine`) imports only engine classes and the Android SDK, so **keying lives in
  `J/aiedit/flow`** (next to `AssetCache`, which downloads) and the engine only reads ready frames.
- Key step, once per asset id, after download, on the background thread:
  `ffmpeg -i <id> -vf "colorkey=0xFFFFFF:0.1:0.1,fps=24,scale='min(512,iw)':-2" -pix_fmt rgba <id>.frames.part/%04d.png`
  (the owner's tested `colorkey` parameters are the baseline; see `/home/haku/projects/tmp/transparent_lottie_workflow.md`).
  Write into a `.part` folder and rename on success (same pattern as `VideoCropHelper`), so a half-keyed asset is never used.
  Failure → the item is left out, the edit never fails because of an asset.
- Why PNG frames and not the `.mov` from the owner's script: the engine draws overlays with Canvas into a texture per
  output frame (`OverlayLayer.draw(canvas, boxW, boxH, elapsedMs, alpha)`), and MediaCodec cannot decode PNG-in-MOV.
  Frame by index is exact and identical on every run, the same property `LottieLayer` had.
- New `FrameSequenceLayer implements OverlayLayer`: frame index = progress from the fit factor (`LottieFit`,
  renamed `ClipFit`) × frame count, last frame held, a small LRU of decoded `Bitmap`s, no per-frame allocation churn.
  A png `icon_image` keeps `IconLayer`.
- Disk: `AssetCache` caps (12 MB per download, total with oldest-first eviction) apply to the mp4; the frames folder
  counts in the total and is evicted with its asset, never one the current plan names.
- Known quality risks to check on real hits (not assumed): white **inside** the subject (coat, eyes) becomes
  transparent; white fringe on antialiased edges. If seen: raise/lower tolerance per asset, or flood-fill from the
  border in Java on the frames; PNG icons are the fallback for white-heavy subjects (the LLM pick may prefer them).

## Tasks

Backend (B) first, then app (A). Each ends with a grep proving no `lottie` remains in the files it touched.

- **B1 Contract.** `L/ai-video-edit/contract/edit.contract.ts`: component type `lottie` → `icon_video`, `PlanAsset.kind`
  `lottie` → `video`, `lottie_max_factor` → `clip_max_factor`, `fit` stays; bump `contract_version`; update
  `edit.contract.view`, the validator, the AI video editing contract and the app repo's spec §14/§15/§16/§17.
- **B2 Schema.** Additive migration + `AiEditAssetsRepository` for the new columns; `lastUsedAt` touched on use.
- **B3 IconScout client.** `iconscout.client.ts`: remove `api` download mode and licensed code; `per_page=10`; read
  `uuid`, `name`, `urls.thumb` defensively (`readHits`); keep `search` + `download` of a CDN url.
- **B4 Picker.** `openai.service.ts` `pickEditIcons` (one call, names only) + `edit.assets.service.ts` flow steps 2–8 incl.
  the `query → uuid` memory and the null/empty handling; `edit.asset.files.ts` `mp4Info` (duration, size from headers)
  replaces `lottieInfo`; assembler `tryIcon` uses `icon_video` and the 80 ms lead-in.
- **B5 Retention.** Delete objects and rows unused for `AI_EDIT_ASSET_RETENTION_DAYS` days (default 30) (a Temporal activity + workflow, new ones, nothing
  already on `main` edited) — or an R2 lifecycle rule plus a row sweep; decide when building.
- **A1 Plan model.** `J/aiedit/engine/plan/PlanComponent` (`ICON_VIDEO`), `PlanAsset`, `PlanParser`,
  `contract/Capabilities` and `EngineContract` to match B1.
- **A2 Keyer.** `J/aiedit/flow` keying step + `AssetCache` integration, `.part` pattern, eviction.
- **A3 Layer.** `FrameSequenceLayer`, `ClipFit`, wire into `IconOverlayPainter`; delete `LottieLayer`; remove the
  `lottie-android` dependency from `app/build.gradle`; `Capabilities` equals what renders.
- **A4 Check.** Owner runs ~20 real hits (people, objects, white-heavy): holes, fringe, speed, memory. Tune A2.

## Progress
- [x] B1  - [x] B2  - [x] B3  - [x] B4  - [x] B5
- [x] A1  - [x] A2  - [x] A3  - [ ] A4
