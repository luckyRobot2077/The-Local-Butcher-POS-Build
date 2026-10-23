#!/usr/bin/env bash
# Checks DB_URL before a backup and explains in plain words what is wrong.
# Never prints the URL or the password; the server's own error is shown with
# host names and addresses hidden, because the run log of a public repository
# is public.
set -uo pipefail
: "${DB_URL:?DB_URL is not set}"

fail() {
  echo "::error::$1"
  echo "$1" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
}

case "$DB_URL" in
  postgres://* | postgresql://*) ;;
  *) fail "SUPABASE_DB_URL must start with postgresql:// . Copy the Session pooler URI from Supabase (Connect button)." ;;
esac
case "$DB_URL" in
  *"[YOUR-PASSWORD]"* | *"YOUR-PASSWORD"*)
    fail "SUPABASE_DB_URL still has [YOUR-PASSWORD] in it. Replace it, including the square brackets, with the database password." ;;
  *"@db."*".supabase.co"*)
    fail "SUPABASE_DB_URL is the Direct connection, which GitHub cannot reach. Use the Session pooler URI instead (Connect button, then Session pooler)." ;;
  *":6543/"*)
    fail "SUPABASE_DB_URL uses port 6543 (Transaction pooler). Use the Session pooler URI, which uses port 5432." ;;
esac
# Exactly one @ may appear (between the password and the host). More means the
# password itself contains @, # / ? or similar, which must be written encoded.
rest="${DB_URL#*://}"
at_count="$(tr -cd '@' <<<"$rest" | wc -c)"
if [ "$at_count" -ne 1 ]; then
  fail "The password in SUPABASE_DB_URL contains a special character such as @ that breaks the link. Easiest fix: reset the database password in Supabase (Project Settings > Database) to one with only letters and numbers, then update the secret."
fi
userinfo="${rest%%@*}"
case "$userinfo" in
  *"["* | *"]"*)
    fail "SUPABASE_DB_URL has square brackets around the password. Remove the [ and ] so only the password itself is left." ;;
  *"#"* | *"/"* | *"?"* | *" "*)
    fail "The password in SUPABASE_DB_URL contains a character such as # / ? or a space that breaks the link. Reset the database password to letters and numbers only, then update the secret." ;;
esac

if ! err="$(psql "$DB_URL" -X -At -v ON_ERROR_STOP=1 -c "select value from schema_info where key = 'schema_version'" 2>&1 >/tmp/schema_version)"; then
  safe="$(sed -E 's/"[^"]*"/"…"/g; s/\([0-9a-f.:]+\)/(…)/g' <<<"$err" | head -3)"
  case "$err" in
    *"password authentication failed"*)
      fail "Supabase refused the password in SUPABASE_DB_URL. Check you typed the database password (not your Supabase login), or reset it in Project Settings > Database and update the secret." ;;
    *"Tenant or user not found"*)
      fail "Supabase does not recognise the user name in SUPABASE_DB_URL. It must look like postgres.<project id> — copy the Session pooler URI again." ;;
    *"could not translate host name"* | *"Network is unreachable"* | *"timeout expired"* | *"Connection refused"*)
      fail "GitHub could not reach the database. Use the Session pooler URI, and check the Supabase project is not paused. ($safe)" ;;
    *"schema_info"*)
      fail "Connected, but this database has no app tables. SUPABASE_DB_URL may point to another project." ;;
    *)
      fail "Could not connect with SUPABASE_DB_URL: $safe" ;;
  esac
fi
echo "Connected. Database schema version $(cat /tmp/schema_version)."
