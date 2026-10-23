-- Automatic backups and a security tidy-up.
--  1. backup_runs: the nightly backup job (.github/workflows/db-backup.yml)
--     writes one row per run, and the Back Office shows when the last good
--     backup was made.
--  2. Lock-down: the public "anon" key can no longer call any function or
--     touch any table. Every screen already needs a signed-in account; this
--     removes the access Supabase grants to anon by default.
-- Safe to run more than once: every statement replaces, re-creates or re-grants.

-- ---------------------------------------------------------------- backups
create table if not exists backup_runs (
  id bigint generated always as identity primary key,
  finished_at timestamptz not null default now(),
  kind text not null check (kind in ('scheduled', 'manual')),
  ok boolean not null,
  bytes bigint,
  note text check (char_length(note) <= 300)
);
create index if not exists backup_runs_finished on backup_runs (finished_at desc);
alter table backup_runs enable row level security;
revoke all on backup_runs from anon, authenticated;

-- Recent backup runs for the Back Office. The backup covers the whole
-- database, so the list is not per store.
create or replace function office_backups(p_token text) returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare me employees := require_office(p_token);
begin
  return jsonb_build_object(
    'lastOkAt', (select max(finished_at) from backup_runs where ok),
    'runs', coalesce((
      select jsonb_agg(row_to_json(x) order by x.finished_at desc) from (
        select finished_at, kind, ok, bytes, note from backup_runs order by finished_at desc limit 20
      ) x), '[]'::jsonb));
end $$;
revoke all on function office_backups(text) from public, anon;
grant execute on function office_backups(text) to authenticated;

-- ---------------------------------------------------------------- lock-down
-- Supabase gives anon (the key built into the web page) execute on every new
-- function and full rights on every new table, and Postgres gives every
-- function to PUBLIC. lock_down_anon() takes all of that away from anon; the
-- signed-in role keeps exactly the functions it could call before. Later
-- migrations end with "select lock_down_anon();" so new functions are closed too.
create or replace function lock_down_anon() returns void
  language plpgsql set search_path = public, extensions as $$
declare
  f record;
  had_auth boolean;
  had_service boolean;
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  for f in
    select p.oid, p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    had_auth := has_function_privilege('authenticated', f.oid, 'execute');
    had_service := has_service_role and has_function_privilege('service_role', f.oid, 'execute');
    execute format('revoke all on function %s from public, anon', f.sig);
    if had_auth then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if had_service then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
  revoke all on all tables in schema public from anon;
  revoke all on all sequences in schema public from anon;
  -- Only the database owner runs this, from the SQL Editor.
  revoke all on function lock_down_anon() from public, anon, authenticated;
end $$;

-- Stop Supabase's automatic anon grants for tables and functions made later.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

select lock_down_anon();

update schema_info set value = '20261030000012' where key = 'schema_version';
