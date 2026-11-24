# Start the local server (this Linux PC)

Verified working on 2026-10-15. Run everything from a bash shell in the repo root
`/home/haku/projects/Next.js/Social-Media-Manager`. Result: the app at http://localhost:4200.

| Service | URL / port | How it runs |
|---|---|---|
| Frontend (Next.js) | http://localhost:4200 | `pnpm --filter ./apps/frontend run dev` |
| Backend (NestJS) | http://localhost:3000 | `pnpm --filter ./apps/backend run dev` |
| Orchestrator (NestJS worker) | http://localhost:3002 | `pnpm --filter ./apps/orchestrator run dev` |
| Postgres (docker `smm-test-pg`) | `localhost:55432` | existing container, the one `.env` points at |
| Redis (docker `smm-test-redis`) | `localhost:56379` | existing container |
| Temporal (docker) | `localhost:7233`, UI http://localhost:8080 | `docker-compose.dev.yaml` |

## Why it is not just `pnpm dev`

- A host Postgres owns **5432** and a host Redis owns **6379**, so `postiz-postgres` / `postiz-redis`
  from `docker-compose.dev.yaml` cannot bind. Do not start them.
- `.env` already points `DATABASE_URL` at `localhost:55432` (container `smm-test-pg`), so use that
  container and leave `.env` alone. Nothing needs to be overridden on this PC.
- Only Temporal comes from the dev compose file: `temporal`, `temporal-postgresql`,
  `temporal-elasticsearch`.
- The extension app is left out of the start command (heavy, not needed to run the app).

## 0. Check RAM and disk first

```bash
free -h; df -h /
```

The three dev servers plus Temporal take roughly 6-8 GiB. If available RAM is under ~4 GiB, close Chrome
or other heavy processes first. Cap Node to keep it bounded: `export NODE_OPTIONS=--max-old-space-size=4096`.

## 1. Start the containers

```bash
cd /home/haku/projects/Next.js/Social-Media-Manager

# App database and Redis (existing containers, data kept in their volumes)
docker start smm-test-pg smm-test-redis

# Temporal stack, only these services (not postiz-postgres / postiz-redis)
docker compose -f docker-compose.dev.yaml up -d temporal-postgresql temporal-elasticsearch temporal
```

Temporal can exit on its first start while its Postgres is still booting. If so:

```bash
docker start temporal
timeout 60 bash -c 'until (echo > /dev/tcp/127.0.0.1/7233) 2>/dev/null; do sleep 3; done' && echo "temporal up"
```

Check: `docker ps --format '{{.Names}}  {{.Status}}  {{.Ports}}'` lists `smm-test-pg` (`55432->5432`),
`smm-test-redis` (`56379->6379`), `temporal` (`7233`), `temporal-postgresql`, `temporal-elasticsearch` as `Up`.

## 2. Prisma client and migrations (only when needed)

Run these after a fresh `pnpm install`, a `schema.prisma` change, or pulling new migrations. Skipping them
shows up as dozens of `TS2339 ... does not exist` errors in the backend/orchestrator (`mobileUpload`,
`posterKey`, ...) and the backend never starts.

```bash
pnpm run prisma-generate

# apply pending migrations to the DB in .env (non-destructive)
pnpm exec dotenv -e .env -- pnpm dlx prisma@6.5.0 migrate deploy \
  --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma
```

To see what is pending first, use `migrate status` instead of `migrate deploy`.

## 3. Start the three app services

```bash
cd /home/haku/projects/Next.js/Social-Media-Manager
LOGS=/tmp/smm-logs; mkdir -p "$LOGS"
export NODE_OPTIONS=--max-old-space-size=4096

rm -rf apps/backend/dist apps/orchestrator/dist
nohup nice pnpm --filter ./apps/backend      run dev > "$LOGS/backend.log"      2>&1 &
nohup nice pnpm --filter ./apps/orchestrator run dev > "$LOGS/orchestrator.log" 2>&1 &
nohup nice pnpm --filter ./apps/frontend     run dev > "$LOGS/frontend.log"     2>&1 &
```

First compile takes a few minutes (the frontend answers first, the backend last). Wait for all three
ports and check them:

```bash
timeout 240 bash -c 'until for p in 3000 3002 4200; do (echo > /dev/tcp/127.0.0.1/$p) 2>/dev/null || exit 1; done; do sleep 5; done'
curl -s -o /dev/null -w "backend      %{http_code}\n" http://localhost:3000/auth/can-register   # 200
curl -s -o /dev/null -w "orchestrator %{http_code}\n" http://localhost:3002/health/status        # 200
curl -s -o /dev/null -w "frontend     %{http_code}\n" http://localhost:4200/auth                 # 200
```

Also look for `Found 0 errors. Watching for file changes.` in `backend.log` and `orchestrator.log`.

## 4. Use it

Open http://localhost:4200 and register or log in. Temporal UI: http://localhost:8080 (only if you also
start `temporal-ui`: `docker compose -f docker-compose.dev.yaml up -d temporal-ui`).

## Stop

```bash
# app services (this repo's node processes)
pkill -f 'Social-Media-Manager/node_modules' || true

# containers (data is kept in the volumes)
docker stop temporal temporal-elasticsearch temporal-postgresql smm-test-pg smm-test-redis
```

## Troubleshooting (only things seen on this PC)

- `failed to bind host port 0.0.0.0:6379` (or 5432) when running `docker compose up` with no service list:
  the host already runs Redis/Postgres. Name only the Temporal services as in step 1, and
  `docker rm postiz-postgres postiz-redis` if compose left them in `Created`.
- Backend log shows `Found 55 errors` / `Property 'x' does not exist`: stale Prisma client, run step 2.
- `Can't reach database server at localhost:55432`: `docker start smm-test-pg`.
- Backend or orchestrator cannot reach Temporal: `docker start temporal`, wait for port 7233, restart them.
- Backend warns `MAIN_URL not set`: harmless for local dev.
- Browser keeps bouncing between `/` and `/launches`: an `auth` cookie the backend rejects (401). Open
  http://localhost:4200/auth/logout, or delete the `auth` cookie for `localhost` in DevTools, then log in again.
- Logs: `/tmp/smm-logs/*.log`.
