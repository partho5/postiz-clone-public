#!/bin/sh
# Money-table row-level security: creates or updates the API database role (APP_DB_USER)
# and grants it what the backend needs, idempotently, on fresh and existing databases; tables
# that later migrations add are granted too. The API role never bypasses row-level security.
# Runs as the worker role (DATABASE_WORKER_URL), which must bypass it. Called by
# deploy/scripts/migrate.sh after the migrations; locally: sh <this file> with the same env.
# The connection string reaches Prisma through the environment (a datasource file), never as an
# argument, so the password does not show in `ps` on the server.
set -eu

: "${DATABASE_WORKER_URL:?DATABASE_WORKER_URL is required}"
export DATABASE_WORKER_URL
: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

PRISMA="pnpm dlx prisma@6.5.0"
DATASOURCE="$(mktemp -d)"
trap 'rm -rf "$DATASOURCE"' EXIT
trap 'exit 130' INT TERM
printf 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_WORKER_URL")\n}\n' \
  >"$DATASOURCE/schema.prisma"

# Prints a value as an SQL string literal.
literal() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

# Prints a value as an SQL identifier.
identifier() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"
}

# Runs SQL from stdin as the worker role.
execute() {
  $PRISMA db execute --schema "$DATASOURCE/schema.prisma" --stdin
}

# Creates the role if missing and grants it; the password is not part of this statement, so a
# failure never puts it in the database log. mastra_* tables are owned by the API role because
# the backend's Mastra store alters them at runtime.
{
  printf "SELECT set_config('money_rls.api_role', %s, false);\n" "$(literal "$APP_DB_USER")"
  cat <<'SQL'
DO $$
DECLARE
  api text := current_setting('money_rls.api_role');
  mastra record;
BEGIN
  IF api = current_user THEN
    RAISE EXCEPTION 'APP_DB_USER (%) must not be the worker role', api;
  END IF;
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'the worker role % must bypass row-level security', current_user;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = api) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', api);
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), api);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', current_schema(), api);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', current_schema(), api);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', current_schema(), api);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', current_schema(), api);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', current_schema(), api);
  IF to_regclass('_prisma_migrations') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON TABLE _prisma_migrations FROM %I', api);
  END IF;
  FOR mastra IN
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'mastra\_%'
  LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO %I', mastra.tablename, api);
  END LOOP;
END $$;
SQL
} | execute

# Lets the role log in with the configured password, and never as a superuser or around RLS.
printf 'ALTER ROLE %s WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %s;\n' \
  "$(identifier "$APP_DB_USER")" "$(literal "$APP_DB_PASSWORD")" | execute

echo "money-roles: API role $APP_DB_USER is ready."
