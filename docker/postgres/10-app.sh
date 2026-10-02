#!/usr/bin/env bash
set -euo pipefail
: "${APP_DB_NAME:?APP_DB_NAME required}"
: "${APP_DB_USER:?APP_DB_USER required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD required}"
export PGPASSWORD="$POSTGRES_PASSWORD"
psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
  --set app_user="$APP_DB_USER" --set app_password="$APP_DB_PASSWORD" --set app_db="$APP_DB_NAME" <<'SQL'
CREATE ROLE :"app_user" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE DATABASE :"app_db" OWNER :"app_user";
SQL
if [ "${APP_DB_CREATEDB:-false}" = true ]; then
  psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
    --set app_user="$APP_DB_USER" <<'SQL'
ALTER ROLE :"app_user" CREATEDB;
SQL
fi
