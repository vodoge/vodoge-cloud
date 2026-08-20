#!/bin/sh
set -eu

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${VODOGE_OWNER_USER:?VODOGE_OWNER_USER is required}"
: "${VODOGE_OWNER_PASSWORD:?VODOGE_OWNER_PASSWORD is required}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  --set=owner_user="$VODOGE_OWNER_USER" \
  --set=owner_password="$VODOGE_OWNER_PASSWORD" <<'SQL'
CREATE ROLE :"owner_user" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT
    PASSWORD :'owner_password';
ALTER DATABASE :"database_name" OWNER TO :"owner_user";
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"database_name" TO :"owner_user";
SQL
