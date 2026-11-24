# Start the local server (this Windows PC)

Verified working on 2026-10-14. Run everything from **Git Bash** in the repo root
`/e/Development/Javascript/social-media-manager`. Result: the app at http://localhost:4200.

| Service | URL / port | How it runs |
|---|---|---|
| Frontend (Next.js) | http://localhost:4200 | `pnpm --filter ./apps/frontend run dev` |
| Backend (NestJS) | http://localhost:3000 | `pnpm --filter ./apps/backend run dev` |
| Orchestrator (NestJS worker) | http://localhost:3002 | `pnpm --filter ./apps/orchestrator run dev` |
| Postgres (docker `postiz-postgres`) | `localhost:5433` | docker-compose.dev.yaml + port override |
| Redis (docker `postiz-redis`) | `localhost:6379` | docker-compose.dev.yaml |
| Temporal (docker) | `localhost:7233`, UI http://localhost:8080 | docker-compose.dev.yaml |

## Why it is not just `pnpm dev`

- `docker` is **not on PATH**. Use `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`.
- A native Windows Postgres owns port **5432**, so the project's dev Postgres is published on **5433**.
- `.env` is stale for this PC: `DATABASE_URL` / `REDIS_URL` point at `localhost:55432` / `:56379`, which are
  containers (`otp-pg`, `otp-redis`) of another project. **Do not edit `.env` and do not start those
  containers.** Override the connection strings as process env vars instead (`dotenv-cli` does not override
  variables that are already set).
- The orchestrator connects with a second role, `DATABASE_WORKER_URL` (table owner, bypasses RLS). The
  backend uses `DATABASE_URL` (the RLS-scoped `postiz-api` role). Both must be overridden.

## 1. Start Docker Desktop and wait for the engine

```bash
D="/c/Program Files/Docker/Docker/resources/bin/docker.exe"
"/c/Program Files/Docker/Docker/Docker Desktop.exe" >/dev/null 2>&1 &
for i in $(seq 1 30); do "$D" info >/dev/null 2>&1 && { echo ready; break; }; sleep 5; done
```

(Skip if `"$D" info` already works.)

## 2. Start Postgres (5433), Redis and Temporal

```bash
cd /e/Development/Javascript/social-media-manager
D="/c/Program Files/Docker/Docker/resources/bin/docker.exe"

# Port override so Postgres does not clash with the native one on 5432
OVERRIDE="$TEMP/postiz-compose.override.yaml"
cat > "$OVERRIDE" <<'EOF'
services:
  postiz-postgres:
    ports: !override
      - "5433:5432"
EOF

"$D" compose -f docker-compose.dev.yaml -f "$OVERRIDE" up -d \
  postiz-postgres postiz-redis temporal-elasticsearch temporal-postgresql temporal temporal-ui
```

Temporal sometimes exits on its first start because its Postgres was still booting. If so:

```bash
"$D" start temporal
for i in $(seq 1 20); do (echo > /dev/tcp/127.0.0.1/7233) 2>/dev/null && { echo "temporal up"; break; }; sleep 4; done
```

Check: `"$D" ps --format '{{.Names}}  {{.Status}}  {{.Ports}}'` should list postiz-postgres (`5433->5432`),
postiz-redis, temporal, temporal-ui, temporal-elasticsearch, temporal-postgresql as `Up`.

## 3. One-time setup (already done on this PC; repeat only when noted)

- **Prisma client**: only after a fresh `pnpm install` or a `schema.prisma` change:
  `pnpm dlx prisma@6.5.0 generate --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma`
- **DB schema**: the `postiz-db-local` database is already migrated (latest `20261011120000_brand_profile`).
  After pulling new migrations run, with the **worker** URL:
  `DATABASE_URL="$DATABASE_WORKER_URL" pnpm run prisma-migrate-deploy` (export the vars from step 4 first).
- **API role password** (done; the DB volume persists): `postiz-api` has the password `postiz-api-local-pwd`.
  If the volume is ever recreated:
  `"$D" exec postiz-postgres psql -U postiz-local -d postiz-db-local -c "ALTER ROLE \"postiz-api\" PASSWORD 'postiz-api-local-pwd'"`

## 4. Start the three app services

```bash
cd /e/Development/Javascript/social-media-manager
LOGS="$TEMP/smm-logs"; mkdir -p "$LOGS"

export DATABASE_URL="postgresql://postiz-api:postiz-api-local-pwd@localhost:5433/postiz-db-local"
export DATABASE_WORKER_URL="postgresql://postiz-local:postiz-local-pwd@localhost:5433/postiz-db-local"
export REDIS_URL="redis://localhost:6379"

rm -rf apps/backend/dist apps/orchestrator/dist
nohup pnpm --filter ./apps/backend      run dev > "$LOGS/backend.log"      2>&1 &
nohup pnpm --filter ./apps/orchestrator run dev > "$LOGS/orchestrator.log" 2>&1 &
nohup pnpm --filter ./apps/frontend     run dev > "$LOGS/frontend.log"     2>&1 &
```

First compile takes about 2-3 minutes. Wait until all three ports answer:

```bash
for i in $(seq 1 40); do a=0; for p in 3000 3002 4200; do (echo > /dev/tcp/127.0.0.1/$p) 2>/dev/null && a=$((a+1)); done; [ $a -eq 3 ] && break; sleep 6; done
echo "ports up: $a/3"
curl -s -o /dev/null -w "backend      %{http_code}\n" http://localhost:3000/auth/can-register   # 200
curl -s -o /dev/null -w "orchestrator %{http_code}\n" http://localhost:3002/health/status        # 200
curl -s -o /dev/null -w "frontend     %{http_code}\n" http://localhost:4200/auth                 # 200
```

## 5. Use it

Open http://localhost:4200. The dev database starts with 0 users, so register a new account on the sign-up
page. Other UIs: Temporal http://localhost:8080.

## Stop

```bash
# app services (all node processes of this repo)
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'social-media-manager' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"

# containers (data is kept in the volumes)
"$D" stop postiz-postgres postiz-redis temporal temporal-ui temporal-elasticsearch temporal-postgresql
```

## Troubleshooting (only things seen on this PC)

- Orchestrator log shows `Can't reach database server at localhost:55432`: `DATABASE_WORKER_URL` was not
  exported in that shell. Export all three variables from step 4 and restart the orchestrator.
- Backend or orchestrator cannot reach Temporal: `"$D" start temporal`, wait for port 7233, restart them.
- Logs: `$TEMP/smm-logs/*.log`.
