# Deploy

Production stack for a single VPS. Images are built by `.github/workflows/build-image.yml`
(tags: `latest`, `v*`, short sha); the server only pulls and never builds. A step-by-step
version for an assistant or an operator on a fresh server is [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md).

## First deploy (2 GB box)

1. Swap, once: `sudo deploy/scripts/setup-swap.sh 2G`.
2. Docker and the compose plugin installed; DNS A record `DOMAIN` -> the VPS; ports 80 and 443 open.
3. Env: `cp deploy/env.example deploy/.env`, then fill every line marked `<-- FILL`. Generate
   secrets with `openssl rand -hex 24` (URL-safe: they go into database URLs). This one file feeds
   both compose and the app; there is no second `.env`.
4. Deploy: `deploy/scripts/deploy.sh 2gb`. It pulls the image, applies migrations and creates the
   database roles, starts the stack, and waits until the app answers. It exits non-zero and does
   not start the app if the pull or a migration fails.
5. Check: `docker ps` shows `app caddy postgres redis temporal` up; `curl -s https://$DOMAIN/api/`
   answers.
6. Soak, as root (the kernel log is read with `dmesg`, which is root-only where
   `kernel.dmesg_restrict=1`; or `sudo sysctl kernel.dmesg_restrict=0` once), in `tmux` or `nohup`:
   `deploy/scripts/soak.sh 72 2gb`. It writes `deploy/soak/soak-<date>-2gb.md` (date, tier, peak
   memory per service, OOM kills, restarts, kernel log); commit that file. The raw `.csv` stays
   untracked. `result: PASS` (exit 0) means zero OOM kills were observed; `FAIL` is exit 1;
   `UNKNOWN` (exit 2, a counter or the kernel log shows `n/a`) means one could not be read and
   proves nothing. The run does not start (exit 2, no sample) when `dmesg` cannot be read or already
   holds an out-of-memory message (reboot, or `sudo dmesg -C`). Container restart and OOM-killed
   flags count from container creation, so after a FAIL recreate the containers first:
   `docker compose -f deploy/docker-compose.yaml --env-file deploy/tiers/2gb.env --env-file deploy/.env up -d --force-recreate`.

## Update

`deploy/scripts/deploy.sh 2gb` again. Same image and files change nothing. To roll out or back a
specific build, set `APP_IMAGE=ghcr.io/<owner>/social-media-manager:<tag>` in `deploy/.env` first.
Migrations run before the app restarts; there is no downtime guarantee during the restart.

A bigger box: `deploy/scripts/deploy.sh 4gb` (or `8gb`). On 8 GB you may set
`TEMPORAL_ENABLE_ES=true` in `deploy/.env` and start with `--profile es`.

## Mobile client (Android)

The phone app needs one stable base URL: `https://$DOMAIN/api` (the value of
`NEXT_PUBLIC_BACKEND_URL`). Caddy terminates TLS for `$DOMAIN` (Let's Encrypt, automatic once DNS
points here and 80/443 are reachable) and proxies to the app container, whose nginx sends `/api/`
to the backend. The same host serves the web app. Routes the app uses: `POST /api/auth/otp/request`
(`{"email"}`, 204), `POST /api/auth/token` (`grant_type` `email_otp` or `refresh_token`),
`POST /api/auth/token/revoke`. Changing `DOMAIN` later changes that URL and every installed app must be pointed at
the new one, so pick the domain once.

## Ops

- Logs: `docker logs app` (backend, orchestrator, frontend share one stream), `docker logs temporal`.
- Temporal UI: `docker compose -f deploy/docker-compose.yaml --env-file deploy/tiers/2gb.env --env-file deploy/.env --profile ops up -d temporal-ui`,
  then `ssh -L 8080:127.0.0.1:8080 <vps>`. Stop it when done.
- Local run on a machine where 80/443 are taken: set `CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` in `deploy/.env`.

## 2 GB sizing (measured 2026-10-08, see `deploy/tiers/2gb.env`)

| Container | Limit | Measured resident (peak with cache) |
|---|---|---|
| app (backend heap 576, orchestrator heap 416, frontend heap 192, nginx, pm2) | 1500m | 1200 (1500 while starting) |
| postgres (app + Temporal) | 400m | 47 (301) |
| temporal (SQL visibility, 4 shards) | 350m | 145 (350) |
| redis (`maxmemory 64mb`) | 96m | 4 (12) |
| caddy | 64m | 10 (64) |

About 770 MB of the app's 1200 MB is the `pnpm`, `dotenv` and `pm2` wrapper processes around the
three apps. The limits are ceilings and add up to more than 2 GB; the resident total is about
1.4 GB, so the box runs on RAM with the 2 GB swap as the cushion. An app limit of 1200m was
measured to OOM-loop. Whether this holds for 72 hours is what `soak.sh` on the VPS decides.
