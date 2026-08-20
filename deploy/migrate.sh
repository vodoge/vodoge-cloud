#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${VODOGE_OWNER_USER:?VODOGE_OWNER_USER is required}"
: "${VODOGE_OWNER_PASSWORD:?VODOGE_OWNER_PASSWORD is required}"
: "${VODOGE_APP_USER:?VODOGE_APP_USER is required}"
: "${VODOGE_APP_PASSWORD:?VODOGE_APP_PASSWORD is required}"

admin_psql() {
  PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$@"
}

owner_psql() {
  PGPASSWORD="$VODOGE_OWNER_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$VODOGE_OWNER_USER" "$@"
}

admin_psql -f /workspace/packages/db/bootstrap/roles.sql

# vodoge_app stays NOLOGIN. The gateway connects as this inherited login role.
case "$VODOGE_APP_USER" in
  *[!a-zA-Z0-9_]*|"")
    echo "VODOGE_APP_USER must be a simple SQL identifier" >&2
    exit 1
    ;;
esac
if [ "$(admin_psql -Atqc "SELECT COUNT(*) FROM pg_roles WHERE rolname = '${VODOGE_APP_USER}'")" = "0" ]; then
  admin_psql \
    --set=app_user="$VODOGE_APP_USER" \
    --set=app_password="$VODOGE_APP_PASSWORD" <<'SQL'
CREATE ROLE :"app_user" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT
    PASSWORD :'app_password';
SQL
fi
admin_psql \
  --set=app_user="$VODOGE_APP_USER" \
  --set=app_password="$VODOGE_APP_PASSWORD" \
  --set=database_name="$PGDATABASE" <<'SQL'
ALTER ROLE :"app_user" PASSWORD :'app_password';
GRANT vodoge_app TO :"app_user";
GRANT CONNECT ON DATABASE :"database_name" TO :"app_user";
SQL

if [ "$(owner_psql -Atqc "SELECT to_regclass('app.commands') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0001_regional_data.sql
fi

if [ "$(owner_psql -Atqc "SELECT to_regclass('app.command_delivery_attempts') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0002_command_dispatch_lifecycle.sql
fi

if [ "$(owner_psql -Atqc "SELECT to_regclass('app.ingress') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0003_ingress.sql
fi

if [ "$(owner_psql -Atqc "SELECT to_regprocedure('app.accept_ingress(uuid,uuid,bigint,uuid,text,jsonb)') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0004_accept_ingress.sql
fi

if [ "$(owner_psql -Atqc "SELECT to_regclass('app.tenants') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0005_tenants.sql
fi

if [ "$(owner_psql -Atqc "SELECT to_regclass('app.enrollment_codes') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0006_enrollment.sql
fi

owner_psql -f /workspace/packages/db/bootstrap/seed_operator.sql

if [ "$(owner_psql -Atqc "SELECT to_regclass('app.rules') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0007_rules_and_audit.sql
fi

if [ "$(owner_psql -Atqc "SELECT to_regprocedure('app.project_ingress_row()') IS NOT NULL")" != "t" ]; then
  owner_psql -f /workspace/packages/db/migrations/0008_project_ingress.sql
fi
