# Deploy

Production stack for a single VPS. Images are built by `.github/workflows/build-image.yml`
(tags: `latest`, `v*`, `sha-<short sha>`); the server only pulls and never builds. A step-by-step
version for an assistant or an operator on a fresh server is [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md).

## New server

One command on a fresh Debian or Ubuntu VPS (amd64, at least 20 GB free), as root:

```sh
curl -fsSL https://raw.githubusercontent.com/partho5/postiz-clone-public/main/deploy/scripts/bootstrap.sh -o bootstrap.sh
sudo sh bootstrap.sh --domain app.example.com --email ops@example.com
```

[scripts/bootstrap.sh](scripts/bootstrap.sh) installs git and Docker, adds swap, creates the deploy user (`--user`,
default the sudo user), checks out `deploy/` into `/var/www/smm` (`--dir`), writes `deploy/.env` with every secret
the server can make itself (database passwords, `JWT_SECRET`, `APP_CREDENTIALS_SECRET`, the paid-features signing
key), picks the edge, adds the CI deploy key and prints what to put in GitHub. It then lists the values only you
have (Mailgun, PayPal, R2) and stops: fill them in `deploy/.env` and run the same command again, which does the first
deploy. Running it again never regenerates a filled value. The tier (`2gb`, `4gb`, `8gb`) follows the RAM, or `--tier`.

Edge: on a server that already runs nginx for other sites, bootstrap sets `HOST_NGINX=1`: Caddy stays off, the app
listens on `127.0.0.1:APP_HOST_PORT` ([host-nginx.yaml](host-nginx.yaml)), and the site from
[nginx/site.conf](nginx/site.conf) proxies the domain to it (TLS by certbot with `--email`). Otherwise Caddy owns
ports 80 and 443 and gets the certificate itself; the DNS A record must point at the server first.

GitHub, once per server (bootstrap prints the values): secrets `DEPLOY_SSH_KEY` and `DEPLOY_HOST` (the server's IP,
not a domain behind a proxy), variables `DEPLOY_USER` and `DEPLOY_URL` (`https://<domain>`).

## How a push deploys

A push to `main` runs [build-image.yml](../.github/workflows/build-image.yml). Two jobs run side by side: the
build publishes `ghcr.io/<owner>/<repo>:sha-<7 chars>` (and `latest`), and the e2e suite
([e2e.yml](../.github/workflows/e2e.yml)) tests the same commit. Only when both pass does the deploy job SSH to the
server with `deploy <commit sha>`: a failing test keeps that build out of production (the site keeps running the
previous one). The key's forced command ([scripts/remote-deploy.sh](scripts/remote-deploy.sh)) moves the
server's checkout to that commit, so the deploy files always match the repo, then runs that commit's
[scripts/deploy.sh](scripts/deploy.sh): pull the image, dump the database into `backups/`, migrate, start, wait until
the app answers. CI then checks `DEPLOY_URL/api/` answers 200. One deploy runs at a time; a newer push replaces a
build still running but never stops a deploy that has started, and a dropped connection does not stop it either
(its log is in `/var/www/smm/logs/`). CodeQL runs after a successful Build image. The GitHub side (secrets,
variables, reading a failed run) is in [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md), section 9.

A tracked file edited on the server stops the next deploy (`git -C /var/www/smm status`): change it in the repo.
`deploy/.env`, `backups/`, `logs/` and the volumes are not tracked and never touched by a deploy.

## Rollback, backups, by hand

On the server, in `/var/www/smm`:

- Back to the build before: `sh deploy/scripts/deploy.sh 2gb rollback` (database migrations are not undone).
- A given build: `sh deploy/scripts/deploy.sh 2gb sha-1a2b3c4` (any tag CI built).
- After editing `deploy/.env`: `sh deploy/scripts/deploy.sh 2gb` (recreates only what changed).
- `deploy/.deployed` holds the current build (line 1) and the previous one (line 2). Only those two app images stay
  on disk (each is about 7 GB).
- Every deploy first writes `backups/pre-deploy-<UTC time>.sql.gz`; the last 7 are kept (`DEPLOY_BACKUP_KEEP`).
  Restore: `gunzip -c backups/<file> | docker exec -i postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'` into
  an empty database.

A bigger box: run `deploy.sh 4gb` (or `8gb`) once by hand and change the tier in the deploy key's forced command in
`~/.ssh/authorized_keys`. On 8 GB you may set `TEMPORAL_ENABLE_ES=true` in `deploy/.env` and start with `--profile es`.

## Soak (optional)

As root (the kernel log is read with `dmesg`), in `tmux` or `nohup`: `deploy/scripts/soak.sh 72 2gb`. It writes
`deploy/soak/soak-<date>-2gb.md` (peak memory per service, OOM kills, restarts, kernel log); `result: PASS` (exit 0)
means zero OOM kills were observed, `FAIL` is exit 1, `UNKNOWN` (exit 2) proves nothing. See the script's header.

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
