# Rules for every sub agent of the instant video plan

Read these first, then your card in `plans/instant-video-plan.md`: its goal, owner decisions, "What exists today",
"Engine shape", the shared contract and your card. Do only your card. If something outside it blocks you, say so in your
report and don't do it.

## Both repos
- Work on the branch `feat/instant-video-plan`, which is already checked out. Commit your card when it's done, one or
  a few commits, with messages like `feat(content-plan): IV1 ...`. End every commit message with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (the model that writes the code). Never push.
- **No heavy runs.** The owner hasn't approved them on this PC: no `pnpm build`, dev server, Gradle build, test suite or
  spec run. Still write the specs or unit tests your card needs, following the existing spec files next to the code.
  Allowed checks:
  - `npx eslint <changed files>` from the web repo root;
  - a scoped type-check, `nice npx tsc --noEmit -p <app or lib tsconfig>`, with the output filtered to your files;
  - `pnpm run prisma-generate` after a schema change.

  Check `df -h /` first; stop if under 10 GB is free.
- Match the existing code: naming, file layout, and plain-language comments above each function the way the
  neighbouring code writes them. Never write weird new patterns. Avoid new files of pure algorithm logic. A new
  service, repository, prompts file or component is fine where the card asks for it.
- All user text works in any language worldwide: Unicode-safe, `dir="auto"` on user text, nothing language-specific,
  and never name a local language.
- Report back (your final message):
  - the files changed and the commit hashes;
  - the checks you ran, with their real output summarised;
  - anything that differs from the card, and why;
  - open questions.

## Web repo (`/home/haku/projects/Next.js/Social-Media-Manager`)
- Follow `CLAUDE.md`:
  - Backend layers: DTO → Controller → Service → Repository, with server logic in `libraries/`.
  - Prisma only; no raw SQL in code.
  - The system is in production: existing rows and routes keep working.
  - Generic code never branches on a kind or provider name. Use an interface with one implementation per kind.
- **Temporal:** never change a workflow file that is in `origin/main`. Activity parameters keep their shape: `PlanJob`
  stays one object, so adding a `kind` value or an optional field is fine.
- **Prompts:** no text that reaches the model is hard-coded. Every frame, rule, field hint and chat wording is an
  exported constant in `libraries/nestjs-libraries/src/database/prisma/content-plan/prompts/*.prompts.ts`, registered
  the way the existing ones are (see `prompts/index.ts` and `PLANNER_PROMPTS`).
- **Migrations:** add a folder `migrations/<yyyymmddhhmmss>_<name>/migration.sql` next to the existing ones. Produce
  the SQL without a database: run `pnpm dlx prisma@6.5.0 migrate diff --from-schema-datamodel <copy of the old
  schema.prisma> --to-schema-datamodel libraries/nestjs-libraries/src/database/prisma/schema.prisma --script`. The SQL
  must not name a schema (no `"public".`).
- **Credits:** planning actions charge through the service's existing `charge()` and existing action names. Don't
  invent prices.
- **Frontend:**
  - Next.js App Router, with the components in `apps/frontend/src/components/content-plan`.
  - Use SWR with one hook per request and `useFetch`; never eslint-disable `rules-of-hooks`.
  - Use only native components, no npm UI packages.
  - Use Tailwind 3 with the tokens from `colors.scss` and `tailwind.config.cjs` (`newBgColorInner`, `newTextColor/NN`,
    `btnPrimary`, `newFieldBg`, …). No `--color-custom*`.
  - Use the shared `PLAN_PRIMARY_BUTTON`, `PLAN_OUTLINE_BUTTON` and `PLAN_SELECT` from `plan.parts.tsx`, and the
    shared `Textarea`/`Input`.
  - Every string goes through `useT()` with a default text.
  - Tap targets are at least 44px, and the layout works at 400px wide.

## FaceCam repo (`/home/haku/projects/AndroidStudioProjects/FaceCam-Presentation-Recorder`)
- Change only `app/src/main/java/.../contentplan/` and its tests. Don't touch the recording screen: `MainActivity`
  logic and layouts, the drawer, or `service/*`. If one existing call site in `MainActivity` truly has to change, keep
  it to one line and explain why in your report.
- Pure policy goes in small pure classes with JUnit tests, as `PlanAutoTarget` and `PlanAutoTargetTest` do.
- Never switch during a recording or while the Topic Manager is open. Never touch the user's own topic sets. Fail
  closed: on any error, keep the cached week and change nothing.
- Never log plan texts.
