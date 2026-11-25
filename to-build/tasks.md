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

TODO (lint): add a lint rule for `e2e/` that rejects text-based selectors, so a copy change can never break an E2E test.
Reject `getByText(...)` and `getByRole(..., { name: ... })` / `getByLabel` / `getByPlaceholder` with a string or regex on UI wording.
Allow `getByTestId`, `locator('input[name=...]')`, `locator('a[href=...]')` and assertions on seeded data.
The one allowed exception: text that is itself the thing under test (legal wording), marked with an explicit
disable comment that names the reason. Wire it into the root lint run (linting runs only from the root).
-----------------
