#!/usr/bin/env bash
# One-command local start for this Linux PC. See start_local_server_linuxPC.md for the why.
#   ./start_local_server_linuxPC.sh          start everything (idempotent)
#   ./start_local_server_linuxPC.sh stop     stop app services and containers
#   ./start_local_server_linuxPC.sh status   show what is up
# Result: http://localhost:4200 (frontend), :3000 backend, :3002 orchestrator.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS=/tmp/smm-logs
CONTAINERS="smm-test-pg smm-test-redis temporal-postgresql temporal-elasticsearch temporal"
cd "$ROOT"

port_up() { (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

status() {
  for p in 55432:postgres 56379:redis 7233:temporal 3000:backend 3002:orchestrator 4200:frontend; do
    port_up "${p%%:*}" && echo "up    ${p##*:} (${p%%:*})" || echo "DOWN  ${p##*:} (${p%%:*})"
  done
}

stop() {
  # bracket trick so pkill does not match this script's own command line
  pkill -f '[S]ocial-Media-Manager/node_modules' || true
  docker stop $CONTAINERS 2>/dev/null || true
  echo "stopped"
}

case "${1:-start}" in
  stop) stop; exit 0 ;;
  status) status; exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status]"; exit 1 ;;
esac

# 0. Resources
free -h | sed -n 1,2p; df -h / | tail -1
avail_mb=$(free -m | awk '/^Mem:/ {print $7}')
[ "${avail_mb:-0}" -lt 4000 ] && echo "WARNING: under 4 GiB RAM available, close heavy apps (Chrome) first"

# 1. Containers (Docker may have restarted, so always start; no-op if already up)
docker start smm-test-pg smm-test-redis temporal-postgresql temporal-elasticsearch >/dev/null \
  || { echo "docker start failed (is the docker daemon running?)"; exit 1; }
if ! port_up 7233; then
  sleep 20                      # temporal exits if its postgres is still booting
  docker start temporal >/dev/null
  for _ in $(seq 1 40); do port_up 7233 && break; sleep 3; done
fi
port_up 7233 || { echo "temporal did not come up on 7233"; exit 1; }
for _ in $(seq 1 30); do port_up 55432 && port_up 56379 && break; sleep 2; done

# 2. Prisma client + migrations (non-destructive)
pnpm run prisma-generate >/dev/null 2>&1 || { echo "prisma-generate failed"; exit 1; }
pnpm exec dotenv -e .env -- pnpm dlx prisma@6.5.0 migrate deploy \
  --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma 2>&1 | tail -2

# 3. App services (skip any already listening)
mkdir -p "$LOGS"
export NODE_OPTIONS=--max-old-space-size=4096
declare -A PORT=([backend]=3000 [orchestrator]=3002 [frontend]=4200)
for s in backend orchestrator frontend; do
  if port_up "${PORT[$s]}"; then echo "$s already up"; continue; fi
  [ "$s" != frontend ] && rm -rf "apps/$s/dist"
  setsid nohup nice pnpm --filter "./apps/$s" run dev > "$LOGS/$s.log" 2>&1 < /dev/null &
done

echo "waiting for 3000 / 3002 / 4200 (first compile takes a few minutes)..."
for _ in $(seq 1 120); do port_up 3000 && port_up 3002 && port_up 4200 && break; sleep 5; done

curl -s -o /dev/null -w "backend      %{http_code}\n" http://localhost:3000/auth/can-register
curl -s -o /dev/null -w "orchestrator %{http_code}\n" http://localhost:3002/health/status
curl -s -o /dev/null -w "frontend     %{http_code}\n" http://localhost:4200/auth
grep -h "Found .* error" "$LOGS/backend.log" "$LOGS/orchestrator.log" | tail -2
echo "Open http://localhost:4200   (logs: $LOGS/*.log, stop: $0 stop)"
