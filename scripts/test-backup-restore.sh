#!/usr/bin/env bash
# Round trip on a throwaway local PostgreSQL: fills a database (stub + all
# migrations + the shifts test's sales and shifts), backs it up with
# db-backup.sh, restores into a second fresh database with db-restore.sh, and
# checks every table's row count. Also checks the safety refusals. Needs
# PostgreSQL server binaries and 7z.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb | tail -1)")"
TMP="$(mktemp -d)"
PORT="${PGPORT_TEST:-54330}"
if [ "$(id -u)" = "0" ]; then
  PGUSER_OS="${PG_OS_USER:-claude}"
  chown -R "$PGUSER_OS" "$TMP"
  RUN=(su "$PGUSER_OS" -s /bin/bash -c)
else
  RUN=(bash -c)
fi
cleanup() { "${RUN[@]}" "$PGBIN/pg_ctl -D '$TMP/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"${RUN[@]}" "$PGBIN/initdb -D '$TMP/data' -U postgres -A trust >/dev/null"
"${RUN[@]}" "$PGBIN/pg_ctl -D '$TMP/data' -o '-p $PORT -k $TMP -c listen_addresses=' -l '$TMP/log' -w start >/dev/null"
PSQL=(psql -h "$TMP" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
url() { echo "postgresql://postgres@/$1?host=$TMP&port=$PORT"; }

fresh() {
  "${PSQL[@]}" -c "create database $1"
  "${PSQL[@]}" -d "$1" -f "$ROOT/supabase/tests/auth_stub.sql" >/dev/null 2>&1
  for f in "$ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -d "$1" -f "$f" >/dev/null 2>&1; done
}

fresh source
"${PSQL[@]}" -d source -f "$ROOT/supabase/tests/shifts_test.sql" >/dev/null 2>&1
# That test re-runs migration 11 (which sets the schema version back), so
# re-run the newest migration as the owner would; this also checks it is safe twice.
"${PSQL[@]}" -d source -f "$(ls "$ROOT"/supabase/migrations/*.sql | tail -1)" >/dev/null 2>&1
"${PSQL[@]}" -d source -c "insert into backup_runs (kind, ok, bytes) values ('manual', true, 1)"
sales="$("${PSQL[@]}" -d source -At -c "select count(*) from sales")"
[ "$sales" -gt 0 ] || { echo "FAIL: the source database has no sales to back up"; exit 1; }

DB_URL="$(url source)" bash "$ROOT/scripts/db-check-url.sh" | grep -q "Connected. Database schema version 2" \
  || { echo "FAIL: connection check did not pass on a good database"; exit 1; }
if DB_URL="$(url nosuchdb)" bash "$ROOT/scripts/db-check-url.sh" >/dev/null 2>&1; then
  echo "FAIL: connection check passed on a missing database"; exit 1
fi
echo "  ok: connection check"

export BACKUP_PASSPHRASE="correct horse battery staple"
archive="$(DB_URL="$(url source)" bash "$ROOT/scripts/db-backup.sh" "$TMP/out" | tail -1)"
echo "  ok: backup made ($(du -h "$archive" | cut -f1), $sales sales)"

if 7z t -bso0 -bse0 -pwrong "$archive" >/dev/null 2>&1; then echo "FAIL: archive opens with a wrong passphrase"; exit 1; fi
if 7z l -bso0 -bse0 -p "$archive" 2>/dev/null | grep -q public-data; then echo "FAIL: file names are readable"; exit 1; fi
echo "  ok: archive is encrypted, file names hidden"
if DB_URL="$(url source)" BACKUP_PASSPHRASE=short bash "$ROOT/scripts/db-backup.sh" "$TMP/out2" >/dev/null 2>&1; then
  echo "FAIL: a short passphrase was accepted"; exit 1
fi
echo "  ok: short passphrase refused"

mkdir "$TMP/unpacked"
7z x -bso0 -bsp0 "-p$BACKUP_PASSPHRASE" -o"$TMP/unpacked" "$archive"

fresh target
TARGET_DB_URL="$(url target)" bash "$ROOT/scripts/db-restore.sh" "$TMP/unpacked"
got="$("${PSQL[@]}" -d target -At -c "select count(*) from sales")"
[ "$got" = "$sales" ] || { echo "FAIL: restored $got sales, expected $sales"; exit 1; }
# Restored data works: the sales total matches and a new row can still be added.
a="$("${PSQL[@]}" -d source -At -c "select sum(total) from sales")"
b="$("${PSQL[@]}" -d target -At -c "select sum(total) from sales")"
[ "$a" = "$b" ] || { echo "FAIL: sales totals differ ($a vs $b)"; exit 1; }
ua="$("${PSQL[@]}" -d source -At -c "select count(*) from auth.users")"
ub="$("${PSQL[@]}" -d target -At -c "select count(*) from auth.users")"
[ "$ua" = "$ub" ] && [ "$ua" -gt 0 ] || { echo "FAIL: sign-in accounts not restored ($ua vs $ub)"; exit 1; }
"${PSQL[@]}" -d target -c "insert into backup_runs (kind, ok) values ('manual', true)"
echo "  ok: restore matches the source"

if TARGET_DB_URL="$(url target)" bash "$ROOT/scripts/db-restore.sh" "$TMP/unpacked" >/dev/null 2>&1; then
  echo "FAIL: restored over a database that has sales"; exit 1
fi
echo "  ok: refuses a database that already has sales"
fresh older
"${PSQL[@]}" -d older -c "update schema_info set value = '20261029000011'"
if TARGET_DB_URL="$(url older)" bash "$ROOT/scripts/db-restore.sh" "$TMP/unpacked" >/dev/null 2>&1; then
  echo "FAIL: restored into a database at another schema version"; exit 1
fi
echo "  ok: refuses a database at another schema version"
echo "backup and restore test passed"
