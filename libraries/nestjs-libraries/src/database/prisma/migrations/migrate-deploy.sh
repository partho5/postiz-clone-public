#!/bin/sh
# Schema migrations: applies pending Prisma migrations to DATABASE_URL.
# Everything is checked before anything is applied: the migrations must produce
# schema.prisma, and the database must equal what its already applied
# migrations produce, replayed in a scratch schema of the same database (no
# CREATEDB needed). A database created earlier by `db push` has the baseline
# schema but no migration history; it is recorded as being at the baseline
# first, and its data is never touched. A refused database is left as it was.
# Migration SQL must not name a schema (e.g. "public") so that it replays.
# Connection strings reach Prisma only through the environment, never as an
# argument, so the password does not show in `ps` on the server.
# Run through `pnpm run prisma-migrate-deploy`.
set -eu
export LC_ALL=C

: "${DATABASE_URL:?DATABASE_URL is required}"
export DATABASE_URL

DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA="$DIR/../schema.prisma"
BASELINE="0_baseline"
PRISMA="pnpm dlx prisma@6.5.0"
REPLAY="_migrate_deploy_replay"
WORK="$(mktemp -d)"

# DATABASE_URL pointed at the scratch schema; any schema it names is replaced.
# Read through env() by $WORK/replay/schema.prisma.
MIGRATE_DEPLOY_REPLAY_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"
case "$MIGRATE_DEPLOY_REPLAY_URL" in
  *\?*) MIGRATE_DEPLOY_REPLAY_URL="$MIGRATE_DEPLOY_REPLAY_URL&schema=$REPLAY" ;;
  *) MIGRATE_DEPLOY_REPLAY_URL="$MIGRATE_DEPLOY_REPLAY_URL?schema=$REPLAY" ;;
esac
export MIGRATE_DEPLOY_REPLAY_URL

# Removes the scratch schema and the working folder, keeping the script's exit code.
clean_up() {
  CODE=$?
  rm -rf "$WORK"
  if [ -n "${REPLAYED:-}" ]; then
    printf 'DROP SCHEMA IF EXISTS "%s" CASCADE;\n' "$REPLAY" |
      $PRISMA db execute --schema "$SCHEMA" --stdin >/dev/null ||
      echo "migrate-deploy: could not drop the scratch schema $REPLAY; the next run replaces it." >&2
  fi
  exit "$CODE"
}
trap clean_up EXIT
trap 'exit 130' INT TERM

# Runs `prisma migrate diff` with the given sides; sets DIFF to 0 (same) or 2 (different), exits on error.
compare() {
  DIFF=0
  $PRISMA migrate diff "$@" --exit-code >/dev/null || DIFF=$?
  if [ "$DIFF" -ne 0 ] && [ "$DIFF" -ne 2 ]; then
    echo "migrate-deploy: could not compare the database (see Prisma's error above);" \
      "nothing was changed." >&2
    exit "$DIFF"
  fi
}

# Diffs a migrations folder, replayed in the scratch schema, against the given side. The replay is a
# `migrate deploy` into the emptied scratch schema (its _prisma_migrations table is not part of a
# diff); Prisma's own replay (--from-migrations) takes the scratch URL only as an argument.
compare_replay() {
  REPLAYED=1
  rm -rf "$WORK/replay"
  mkdir -p "$WORK/replay"
  cp -R "$1" "$WORK/replay/migrations"
  printf 'datasource db {\n  provider = "postgresql"\n  url      = env("MIGRATE_DEPLOY_REPLAY_URL")\n}\n' \
    >"$WORK/replay/schema.prisma"
  if ! printf 'DROP SCHEMA IF EXISTS "%s" CASCADE;\n' "$REPLAY" |
    $PRISMA db execute --schema "$SCHEMA" --stdin >/dev/null; then
    echo "migrate-deploy: could not empty the scratch schema $REPLAY (see Prisma's error above);" \
      "nothing was changed." >&2
    exit 1
  fi
  if ! $PRISMA migrate deploy --schema "$WORK/replay/schema.prisma" >/dev/null; then
    echo "migrate-deploy: the migrations could not be replayed in the scratch schema (see Prisma's error" \
      "above); nothing was changed." >&2
    exit 1
  fi
  compare --from-schema-datasource "$WORK/replay/schema.prisma" "$2" "$3"
}

# Prints the name of every migration folder, in the order Prisma applies them.
migration_names() {
  for file in "$DIR"/*/migration.sql; do
    basename "$(dirname "$file")"
  done
}

# Fails when schema.prisma has changes that no migration makes.
refuse_unmigrated_schema() {
  compare_replay "$DIR" --to-schema-datamodel "$SCHEMA"
  if [ "$DIFF" -eq 2 ]; then
    echo "migrate-deploy: schema.prisma has changes that no migration makes; nothing was changed." \
      "Add a migration with prisma-migrate-dev, then run again." >&2
    exit 1
  fi
}

# Sets APPLIED to the number of leading migrations the database reports as applied.
count_applied() {
  PENDING=$($PRISMA migrate status --schema "$SCHEMA" 2>&1 |
    awk '/have not yet been applied:/ { list = 1; next } list && /^$/ { list = 0 } list { n++ } END { print n + 0 }')
  APPLIED=$(( $(migration_names | wc -l) - PENDING ))
}

# Copies schema.prisma and the first APPLIED migrations into WORK.
prepare_applied() {
  mkdir -p "$WORK/migrations"
  cp "$SCHEMA" "$WORK/schema.prisma"
  cp "$DIR/migration_lock.toml" "$WORK/migrations/"
  for name in $(migration_names | head -n "$APPLIED"); do
    cp -R "$DIR/$name" "$WORK/migrations/"
  done
}

# Fails unless the database has applied every migration copied into WORK, none of them failed.
refuse_mismatched_history() {
  STATUS=0
  OUTPUT=$($PRISMA migrate status --schema "$WORK/schema.prisma" 2>&1) || STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    printf '%s\n' "$OUTPUT"
    echo "migrate-deploy: the database's migration history does not match these migrations;" \
      "nothing was changed." >&2
    exit 1
  fi
}

# Fails when the database differs from what its applied migrations produce.
refuse_drift() {
  compare_replay "$WORK/migrations" --to-schema-datasource "$SCHEMA"
  if [ "$DIFF" -eq 2 ]; then
    echo "migrate-deploy: the database differs from what its applied migrations produce, so it was" \
      "changed outside a migration; nothing was changed. Undo that change, then run again." >&2
    exit 1
  fi
}

# Records the baseline as applied when a history-less database matches it exactly; an empty
# database is left to `migrate deploy`; fails otherwise.
baseline_existing() {
  compare --from-empty --to-schema-datasource "$SCHEMA"
  if [ "$DIFF" -eq 0 ]; then
    return
  fi
  compare --from-schema-datasource "$SCHEMA" --to-schema-datamodel "$DIR/$BASELINE/baseline.prisma"
  if [ "$DIFF" -eq 2 ]; then
    echo "migrate-deploy: the database has no migration history and differs from $BASELINE;" \
      "nothing was changed. Bring it to the $BASELINE schema, then run again." >&2
    exit 1
  fi
  $PRISMA migrate resolve --applied "$BASELINE" --schema "$SCHEMA"
}

refuse_unmigrated_schema
count_applied
if [ "$APPLIED" -gt 0 ]; then
  prepare_applied
  refuse_mismatched_history
  refuse_drift
else
  baseline_existing
fi
$PRISMA migrate deploy --schema "$SCHEMA"
