#!/bin/sh
# VPS deploy: pulls the app image, backs up the database, runs deploy/scripts/migrate.sh, then
# starts or updates the compose stack with deploy/tiers/<tier>.env. Idempotent: running it again with
# the same image and files changes nothing. Any failure exits non-zero; a failed pull, backup or migration
# leaves the running app as it was (the app is only started after the migration succeeded).
# Usage: deploy/scripts/deploy.sh <tier> [<image tag> | rollback]      tier = 2gb | 4gb | 8gb
#   <image tag>  a tag CI built (sha-<7 chars>, v1.2.3) of the repository named in APP_IMAGE in deploy/.env
#   rollback     the build that ran before the current one (database migrations are not undone)
#   neither      the image named in APP_IMAGE
# deploy/.deployed holds the current build (line 1) and the previous one (line 2).
# Environment: DEPLOY_READY_SECONDS (default 180) how long to wait for the app to answer;
#   DEPLOY_BACKUP_KEEP (default 7) how many pre-deploy database dumps to keep in <checkout>/backups.
set -eu

DEPLOY_DIR=$(cd "$(dirname "$0")/.." && pwd)
READY_SECONDS="${DEPLOY_READY_SECONDS:-180}"
BACKUP_KEEP="${DEPLOY_BACKUP_KEEP:-7}"
BACKUP_DIR="$(dirname "$DEPLOY_DIR")/backups"
STATE_FILE="$DEPLOY_DIR/.deployed"

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

# The build to run. An exported APP_IMAGE wins over the one in deploy/.env for compose and migrate.sh alike.
CONFIGURED=$(env_value APP_IMAGE "$ENV_FILE")
REPOSITORY=$(printf '%s' "${CONFIGURED:?APP_IMAGE is not set in $ENV_FILE}" | sed 's/:[^:/]*$//')
CURRENT=$(sed -n 1p "$STATE_FILE" 2>/dev/null || true)
PREVIOUS=$(sed -n 2p "$STATE_FILE" 2>/dev/null || true)
case "${2:-}" in
  '') APP_IMAGE="$CONFIGURED" ;;
  rollback)
    [ -n "$PREVIOUS" ] || fail "no previous build recorded in $STATE_FILE"
    APP_IMAGE="$PREVIOUS"
    ;;
  *[!A-Za-z0-9._-]*) fail "not an image tag: $2" ;;
  *) APP_IMAGE="$REPOSITORY:$2" ;;
esac
export APP_IMAGE
echo "deploy: build $APP_IMAGE"

set -- --env-file "$TIER_FILE" --env-file "$ENV_FILE"
# HOST_NGINX=1 in deploy/.env: the server's own nginx owns 80/443, so Caddy stays off and the app is
# published on 127.0.0.1:${APP_HOST_PORT:-3000} (see host-nginx.yaml). Placed in "$@" so migrate.sh sees it too.
if [ "$(env_value HOST_NGINX "$ENV_FILE")" = "1" ]; then
  set -- -f "$DEPLOY_DIR/host-nginx.yaml" "$@"
fi
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yaml"

echo "deploy: pulling images ($TIER)"
$COMPOSE "$@" pull

# A dump of the app database before any migration touches it; skipped on a first deploy (no database yet).
if $COMPOSE "$@" ps --status running --services 2>/dev/null | grep -qx postgres; then
  mkdir -p "$BACKUP_DIR"
  DUMP="$BACKUP_DIR/pre-deploy-$(date -u +%Y%m%d-%H%M%S).sql.gz"
  echo "deploy: backing up the database to $DUMP"
  # shellcheck disable=SC2016
  if ! (umask 077 && $COMPOSE "$@" exec -T postgres sh -c \
    'set -o pipefail; pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip' >"$DUMP.part") ||
    [ ! -s "$DUMP.part" ]; then
    rm -f "$DUMP.part"
    fail "database backup failed; nothing was changed"
  fi
  mv "$DUMP.part" "$DUMP"
  # The names hold the UTC time, so name order is age order.
  # shellcheck disable=SC2012
  ls -1r "$BACKUP_DIR"/pre-deploy-*.sql.gz | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
fi

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
# Remember this build and the one it replaced, for rollback.
if [ "$APP_IMAGE" != "$CURRENT" ]; then
  PREVIOUS="$CURRENT"
  printf '%s\n%s\n' "$APP_IMAGE" "$PREVIOUS" >"$STATE_FILE"
fi
# Each app image is about 7 GB, so only the current and the previous build stay on disk: other tags of the app
# repository go, then dangling images (a build whose tag moved). Volumes are never touched.
docker images --format '{{.Repository}}:{{.Tag}}' "$REPOSITORY" |
  grep -vxF -e "$APP_IMAGE" -e "${PREVIOUS:-$APP_IMAGE}" | xargs -r docker rmi >/dev/null 2>&1 || true
docker image prune -f >/dev/null
echo "deploy: ok ($TIER)"
