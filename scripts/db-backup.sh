#!/usr/bin/env bash
# Makes one encrypted backup of the cloud database.
#
#   DB_URL='postgresql://…' BACKUP_PASSPHRASE='…' scripts/db-backup.sh <output folder>
#
# Writes <output folder>/local-butcher-db-<UTC time>.7z, a 7-Zip archive with
# AES-256 encryption (file names hidden too). Open it on a computer with 7-Zip
# and the passphrase. Inside:
#   public-schema.sql  tables and functions as they were (reference; a restore
#                      runs the migrations instead)
#   public-data.sql    every row of the shop's data
#   auth-data.sql      staff sign-in accounts (Supabase Auth users)
#   manifest.txt       time, schema version and row counts, to check a restore
# Product photos are not included: they stay in Supabase Storage and in each
# device's own backup. Nothing from the database is printed to the log.
set -euo pipefail
OUT="${1:?usage: db-backup.sh <output folder>}"
: "${DB_URL:?DB_URL is not set}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is not set}"
if [ "${#BACKUP_PASSPHRASE}" -lt 16 ]; then
  echo "BACKUP_PASSPHRASE must be at least 16 characters." >&2
  exit 1
fi
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DUMP=(pg_dump "$DB_URL" --no-owner --no-privileges --quote-all-identifiers)

# Each stage says what it is doing, so a failure in the log names its stage.
stage() { echo "stage: $1" >&2; }

stage "checking pg_dump matches the server"
server_major="$(psql "$DB_URL" -X -At -v ON_ERROR_STOP=1 -c "show server_version_num")"
server_major=$((server_major / 10000))
client_major="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
if [ "$client_major" -lt "$server_major" ]; then
  echo "pg_dump $client_major cannot back up a PostgreSQL $server_major server; install postgresql-client-$server_major." >&2
  exit 1
fi

stage "dumping the table definitions"
"${DUMP[@]}" --schema-only --schema=public -f "$WORK/public-schema.sql"
stage "dumping the shop data"
"${DUMP[@]}" --data-only --schema=public -f "$WORK/public-data.sql"
stage "dumping the staff sign-in accounts"
if ! "${DUMP[@]}" --data-only --table=auth.users --table=auth.identities -f "$WORK/auth-data.sql"; then
  # The shop data matters most: keep going without the accounts, and say so.
  echo "warning: the staff sign-in accounts could not be backed up; staff would set new passwords after a restore." >&2
  : >"$WORK/auth-data.sql"
  AUTH_NOTE="auth_accounts=missing"
fi

stage "counting rows"
{
  echo "Local Butcher POS database backup"
  echo "made_at_utc=$STAMP"
  echo "${AUTH_NOTE:-auth_accounts=included}"
  psql "$DB_URL" -X -At -v ON_ERROR_STOP=1 -c "select 'schema_version=' || value from schema_info where key = 'schema_version'"
  psql "$DB_URL" -X -At -v ON_ERROR_STOP=1 -f "$(dirname "$0")/db-row-counts.sql"
} >"$WORK/manifest.txt"

stage "encrypting"
ARCHIVE="$OUT/local-butcher-db-$STAMP.7z"
(cd "$WORK" && 7z a -t7z -mhe=on -mx=9 -bso0 -bsp0 "-p$BACKUP_PASSPHRASE" "$ARCHIVE" \
  public-schema.sql public-data.sql auth-data.sql manifest.txt)
stage "checking the archive opens"
# Check the archive opens with the passphrase before calling it done.
7z t -bso0 -bsp0 "-p$BACKUP_PASSPHRASE" "$ARCHIVE"
echo "$ARCHIVE"
