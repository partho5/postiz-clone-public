#!/bin/sh
# Schema migrations: applies pending migrations to the compose Postgres
# with the app image, before the app starts, as the worker database role; then
# creates and grants the API role the backend connects with. Exits
# non-zero if a migration or the role step fails; the app is then not started
# by this script's caller.
# Usage: ./migrate.sh <compose args>, e.g.
#   deploy/scripts/migrate.sh --env-file deploy/tiers/2gb.env --env-file deploy/.env
set -eu
COMPOSE="docker compose -f $(cd "$(dirname "$0")/.." && pwd)/docker-compose.yaml"

$COMPOSE "$@" up -d --wait postgres
$COMPOSE "$@" run --rm --no-deps app sh -c \
  'DATABASE_URL="${DATABASE_WORKER_URL:?DATABASE_WORKER_URL is required}" pnpm run prisma-migrate-deploy &&
    sh ./libraries/nestjs-libraries/src/database/prisma/credits/scope/money-roles.sh'
