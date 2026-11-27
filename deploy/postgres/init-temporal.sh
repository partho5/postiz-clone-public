#!/bin/sh
# Runs once, on the first start of an empty data directory.
# Temporal gets its own role; auto-setup creates the temporal and
# temporal_visibility databases with it, so it needs CREATEDB but nothing
# on the app database.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE "${TEMPORAL_DB_USER}" WITH LOGIN CREATEDB PASSWORD '${TEMPORAL_DB_PASSWORD}';
REVOKE ALL ON DATABASE "${POSTGRES_DB}" FROM PUBLIC;
SQL
