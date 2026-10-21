#!/usr/bin/env bash
# For each supabase/tests/*_test.sql: creates a fresh database on a throwaway
# local PostgreSQL, applies the Supabase stub and all migrations, runs the test. Needs PostgreSQL server binaries
# (initdb, pg_ctl) on PATH or in /usr/lib/postgresql/*/bin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb | tail -1)")"
TMP="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
RUN=()
if [ "$(id -u)" = "0" ]; then
  # PostgreSQL refuses to run as root; use an unprivileged account.
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
for t in "$ROOT"/supabase/tests/*_test.sql; do
  name="$(basename "$t" .sql)"
  echo "== $name"
  "${PSQL[@]}" -c "create database $name"
  "${PSQL[@]}" -d "$name" -f "$ROOT/supabase/tests/auth_stub.sql"
  for f in "$ROOT"/supabase/migrations/*.sql; do
    "${PSQL[@]}" -d "$name" -f "$f"
  done
  "${PSQL[@]}" -d "$name" -f "$t" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  /'
done
echo "migration tests passed"
