#!/bin/sh
# VPS deploy: pulls the image tag named in deploy/.env, runs deploy/scripts/migrate.sh, then
# starts or updates the compose stack with deploy/tiers/<tier>.env. Idempotent: running it again with
# the same image and files changes nothing. Any failure exits non-zero; a failed pull or migration
# leaves the running app as it was (the app is only started after the migration succeeded).
# Usage: deploy/scripts/deploy.sh <tier>      tier = 2gb | 4gb | 8gb
# Environment: DEPLOY_READY_SECONDS (default 180) how long to wait for the app to answer.
set -eu

DEPLOY_DIR=$(cd "$(dirname "$0")/.." && pwd)
READY_SECONDS="${DEPLOY_READY_SECONDS:-180}"

# Prints a message to stderr and stops with a failure.
fail() {
  echo "deploy: $*" >&2
  exit 1
}

# Prints the value of a KEY=value line of an env file, without quotes (empty when unset).
env_value() {
  sed -n "s/^$1=//p" "$2" | tail -n 1 | sed "s/^['\"]//; s/['\"]\$//"
}

TIER="${1:-}"
case "$TIER" in
  '' | *[!a-z0-9]*) fail "usage: deploy.sh <tier> (a name from deploy/tiers/, e.g. 2gb)" ;;
esac
TIER_FILE="$DEPLOY_DIR/tiers/$TIER.env"
ENV_FILE="$DEPLOY_DIR/.env"
[ -f "$TIER_FILE" ] || fail "no tier file $TIER_FILE"
[ -f "$ENV_FILE" ] || fail "no $ENV_FILE; copy deploy/env.example to deploy/.env and fill it"

# Temporal creates a database named "temporal"; a role of the same name stops it creating it.
case "$(env_value TEMPORAL_DB_USER "$ENV_FILE")" in
  temporal | temporal_visibility) fail "TEMPORAL_DB_USER must not equal a Temporal database name (use e.g. temporal_app)" ;;
esac
# env.example ships obvious placeholders; a stack must not start with them.
if grep -q 'change-me\|app.example.com\|mg.example.com\|noreply@example.com' "$ENV_FILE"; then
  fail "$ENV_FILE still holds a placeholder (change-me / app.example.com / mg.example.com / noreply@example.com)"
fi

set -- --env-file "$TIER_FILE" --env-file "$ENV_FILE"
# HOST_NGINX=1 in deploy/.env: the server's own nginx owns 80/443, so Caddy stays off and the app is
# published on 127.0.0.1:${APP_HOST_PORT:-3000} (see host-nginx.yaml). Placed in "$@" so migrate.sh sees it too.
if [ "$(env_value HOST_NGINX "$ENV_FILE")" = "1" ]; then
  set -- -f "$DEPLOY_DIR/host-nginx.yaml" "$@"
fi
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yaml"

echo "deploy: pulling images ($TIER)"
$COMPOSE "$@" pull

echo "deploy: migrating"
sh "$DEPLOY_DIR/scripts/migrate.sh" "$@" || fail "migration failed; the app was not started"

echo "deploy: starting the stack"
$COMPOSE "$@" up -d --wait --remove-orphans

# The app has no container health check; wait until the backend answers through the app's nginx.
echo "deploy: waiting for the app (up to ${READY_SECONDS}s)"
WAITED=0
until $COMPOSE "$@" exec -T app node -e \
  "fetch('http://localhost:5000/api/').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))" \
  >/dev/null 2>&1; do
  WAITED=$((WAITED + 5))
  [ "$WAITED" -lt "$READY_SECONDS" ] || fail "the app did not answer within ${READY_SECONDS}s; see: docker logs app"
  sleep 5
done
# Dangling images only (the previous build lost its tag when :latest moved); volumes are never touched.
# Each app image is about 7 GB, so without this the disk fills after a few deploys.
docker image prune -f >/dev/null
echo "deploy: ok ($TIER)"
