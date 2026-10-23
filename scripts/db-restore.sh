#!/usr/bin/env bash
# Puts a backup into a NEW, empty Supabase project. Read docs/BACKUP_RECOVERY.md first.
#
#   TARGET_DB_URL='postgresql://…' scripts/db-restore.sh <folder with the unpacked backup>
#
# Before running: create the new project and run every migration in
# supabase/migrations in order (the same ones the backup's schema_version
# names). The script refuses a database that already has sign-in accounts or
# sales, so it cannot overwrite the live shop by mistake.
set -euo pipefail
DIR="${1:?usage: db-restore.sh <folder with public-data.sql, auth-data.sql, manifest.txt>}"
: "${TARGET_DB_URL:?TARGET_DB_URL is not set}"
for f in public-data.sql auth-data.sql manifest.txt; do
  [ -f "$DIR/$f" ] || { echo "Missing $DIR/$f" >&2; exit 1; }
done
PSQL=(psql "$TARGET_DB_URL" -X -At -v ON_ERROR_STOP=1)

want="$(sed -n 's/^schema_version=//p' "$DIR/manifest.txt")"
have="$("${PSQL[@]}" -c "select value from schema_info where key = 'schema_version'")"
if [ "$want" != "$have" ]; then
  echo "The backup is from schema $want but the target database is at $have. Run the migrations up to $want first." >&2
  exit 1
fi
busy="$("${PSQL[@]}" -c "select (select count(*) from auth.users) + (select count(*) from public.sales)")"
if [ "$busy" != "0" ]; then
  echo "The target database already has accounts or sales. Restore only into a new, empty project." >&2
  exit 1
fi

# One transaction: the migrations' starter rows are cleared, the backup's rows
# go in with triggers and foreign-key checks paused (rows arrive in table
# order, not dependency order), and nothing is kept if any step fails.
tables="$("${PSQL[@]}" -c "select string_agg(format('public.%I', relname), ', ') from pg_class c
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")"
"${PSQL[@]}" --single-transaction \
  -c "set session_replication_role = replica" \
  -c "truncate $tables" \
  -f "$DIR/auth-data.sql" \
  -f "$DIR/public-data.sql" >/dev/null

# Compare row counts with the backup's manifest.
got="$("${PSQL[@]}" -f "$(dirname "$0")/db-row-counts.sql")"
if diff <(grep '^rows\.' "$DIR/manifest.txt") <(echo "$got") >/dev/null; then
  echo "Restored. Row counts match the backup for every table."
else
  echo "Restored, but some row counts differ from the backup:" >&2
  diff <(grep '^rows\.' "$DIR/manifest.txt") <(echo "$got") >&2 || true
  exit 1
fi
