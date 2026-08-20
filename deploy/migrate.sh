#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${VODOGE_OWNER_USER:?VODOGE_OWNER_USER is required}"
: "${VODOGE_OWNER_PASSWORD:?VODOGE_OWNER_PASSWORD is required}"

admin_psql() {
  PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$@"
}

owner_psql() {
  PGPASSWORD="$VODOGE_OWNER_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$VODOGE_OWNER_USER" "$@"
}

admin_psql -f /workspace/packages/db/bootstrap/roles.sql

if [ "$(owner_psql -Atqc "SELECT to_regclass('app.commands') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0001_regional_data.sql
fi

if [ "$(owner_psql -Atqc "SELECT to_regclass('app.command_delivery_attempts') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0002_command_dispatch_lifecycle.sql
fi
