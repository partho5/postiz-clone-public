# Handoff: seamless build and deploy (2026-11-25)

Goal (owner): pushing `main` deploys with no hand work, and a brand-new VPS gets the same setup from the repo with one
script, easily and reliably. Plan and per-task detail: `to-build/tasks.md`, section "Deploy: seamless push-to-deploy,
reproducible on a new VPS" (D1-D11). Pipeline and server layout: `deploy/README.md`; step-by-step for a new server:
`deploy/DEPLOY_GUIDE.md`.

## Done and verified

- CI runs per push: Build image (build, then deploy) and Stale references. E2E and CodeQL start via `workflow_run`
  after Build image succeeds on `main` (`e2e.yml` checks out the built commit, `workflow_run.head_sha`). Build
  (`build.yml`) runs on pull requests and by hand only; it repeated the Docker build's compile.
- A newer push cancels only a build still running, never a deploy (`build-image.yml`: concurrency on the build job;
  the deploy job has its own non-cancelling group).
- E2E: the suite had never passed. Two test bugs fixed in `e2e/`: the unscoped page list missed `/terms`,
  `/privacy`, `/data-deletion`, `/logout` (`support/observe.fixture.ts`), and `two.tabs.spec.ts` clicked the hidden
  mobile menu link (now `.filter({ visible: true })`). 14 of 15 passed before; the run for `8c43d095` decides the last.
- Server (`web01`, `/var/www/smm`): now a sparse git checkout of the public repo (deploy/, dynamicconfig/, .gitignore).
  The CI key's forced command is `sh /var/www/smm/deploy/scripts/remote-deploy.sh 2gb`: it moves the checkout to the
  pushed commit, then runs that commit's `deploy.sh` with the image built from it (`sha-<7>`), detached with a log in
  `/var/www/smm/logs/`. Backups of the switch: `backups/pre-checkout-20261125-062614.tgz`,
  `~/.ssh/authorized_keys.bak-20261125-062614`. Verified live: a CI rerun deployed `sha-8c43d09` through it, with
  the pre-deploy dump `backups/pre-deploy-20261125-062719.sql.gz`.
- `deploy.sh <tier> [<tag>|rollback]`: pinned build, `deploy/.deployed` (current, previous), one-command rollback,
  database dump before migrating (last 7 kept), only the current and previous app images kept on disk.
- CI deploy step: SSH user from repository variable `DEPLOY_USER` (`linton`), then checks `DEPLOY_URL/api/`
  (`https://social.nanybot.com`) answers 200, or fails the run.
- `deploy/scripts/bootstrap.sh`: new VPS in one command (Docker, swap, user, checkout, `.env` with generated
  secrets and signing key, host nginx site + certbot or Caddy, CI deploy key with forced command, first deploy once
  owner values are filled). Tested twice in a clean Debian 13 container with docker/systemctl stubbed, both edges.
- Docs rewritten (README, DEPLOY_GUIDE). `gh` CLI is installed in `~/.local/bin` and signed in (keyring; the sandbox
  cannot see it, run gh with the sandbox off). `shellcheck` is in `~/.local/bin`.

## Left to do

1. **Confirm the last E2E test passes** (run after `8c43d095`'s build): `gh run list -R partho5/postiz-clone-public
   -w e2e.yml -L 3`. If `two.tabs.spec.ts` still fails, read `gh run view <id> --log-failed`. Once E2E is green on
   `main`, decide whether it gates the deploy (option noted in the server's old `HANDOFF.md`: make `e2e.yml`
   `workflow_call` and have the deploy job need it; each deploy gets ~10 min slower).
2. **D9, rehearsal on a real fresh VPS** (owner provides a throwaway VPS or a local VM): run bootstrap end to end
   with real Docker, fill owner values (sandbox PayPal, a test Mailgun domain or the log provider is refused in
   production, so a real Mailgun key is needed), reach DEPLOY_GUIDE section 5, then destroy it. Container tests
   cannot cover the real Docker install, certbot or Caddy certificates.
3. **D10, image size**: the app image is about 7.4 GB; pulling it is most of a deploy (about 7 minutes on the 2 GB
   server, and the server has ~30 GB free). Measure layers (`docker history`), slim `Dockerfile.dev` (dev
   dependencies, build caches, pnpm store) without changing what runs.
4. **D11, database password visible in `ps`** during a migration: `money-roles.sh` and `migrate-deploy.sh` pass the
   URL as a Prisma argument. Design note in tasks.md D11 (the shadow database URL has no environment form). Decide
   the approach before coding; these scripts run on every production deploy.
5. Small: the server's untracked `/var/www/smm/HANDOFF.md` (2026-11-24) is out of date; replace it with a pointer to
   this file or delete it. The memory note `public-repo-and-vps-deploy` still describes `manual-up.sh` and says not to
   use `deploy.sh` on the server; both are outdated (the server now runs `remote-deploy.sh` -> `deploy.sh`).

## Rules that matter here

- Never `docker compose down -v`, `docker volume rm`, `docker system prune` on the server; never restart nginx
  (reload only); the server is shared with other sites.
- Tracked files under `deploy/` are changed in the repo, never on the server (the next deploy refuses to run).
- Workflow files already on `origin/main` that are Temporal workflows must not change (CLAUDE.md); GitHub Actions
  workflow files are fine to edit.
