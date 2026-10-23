-- Lock-down (migration 12): anon can call no function and use no table, every
-- security definer function pins its search_path, and signed-in staff still
-- reach what the app uses. Also the backup_runs table and office_backups().
do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');
  if bad is not null then raise exception 'FAIL: anon can execute %', bad; end if;
  raise notice 'ok: anon can execute no public function';

  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'S')
    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
      or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'));
  if bad is not null then raise exception 'FAIL: anon has rights on %', bad; end if;
  raise notice 'ok: anon has no table rights';

  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if bad is not null then raise exception 'FAIL: security definer without search_path: %', bad; end if;
  raise notice 'ok: every security definer function sets search_path';

  if not has_function_privilege('authenticated', 'sync_sale(jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'office_backups(text)', 'execute')
     or not has_function_privilege('authenticated', 'whoami()', 'execute') then
    raise exception 'FAIL: signed-in staff lost a function the app uses';
  end if;
  if has_function_privilege('authenticated', 'lock_down_anon()', 'execute') then
    raise exception 'FAIL: staff can run lock_down_anon';
  end if;
  if has_table_privilege('authenticated', 'backup_runs', 'select') then
    raise exception 'FAIL: staff can read backup_runs directly';
  end if;
  raise notice 'ok: staff keep the app functions and cannot read backup_runs directly';
end $$;

-- A later migration closes its new functions by ending with lock_down_anon().
create function hardening_probe() returns int language sql as $$ select 1 $$;
select lock_down_anon();
do $$ begin
  if has_function_privilege('anon', 'hardening_probe()', 'execute') then
    raise exception 'FAIL: a new function is open to anon';
  end if;
  if not has_function_privilege('authenticated', 'hardening_probe()', 'execute') then
    raise exception 'FAIL: a new function is closed to signed-in staff';
  end if;
  raise notice 'ok: lock_down_anon closes new functions to anon and keeps them for staff';
end $$;
drop function hardening_probe();

-- office_backups: needs a Back Office session, then reports the last good run.
insert into stores (id, name) values ('00000000-0000-0000-0000-0000000000b1', 'Backup Shop');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b2', 'owner@backup.test');
insert into staff_profiles (user_id, store_id, role, display_name)
  values ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1', 'owner', 'Owner');
insert into employees (id, store_id, employee_no, name, role, active, badge_hash)
  values ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b1', 'E-0001', 'Owner', 'owner', true,
    repeat('a', 64));
insert into office_sessions (token_hash, store_id, employee_id, expires_at)
  values (encode(extensions.digest('tok-b', 'sha256'), 'hex'), '00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-0000000000b3', now() + interval '1 hour');
insert into backup_runs (finished_at, kind, ok, bytes) values
  (now() - interval '2 days', 'scheduled', true, 1000),
  (now() - interval '1 day', 'scheduled', false, null),
  (now() - interval '1 hour', 'manual', true, 2000);

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$
declare r jsonb;
begin
  begin
    perform office_backups('wrong');
    raise exception 'FAIL: office_backups opened without a session';
  exception when insufficient_privilege then raise notice 'ok: office_backups needs the Back Office';
  end;
  r := office_backups('tok-b');
  if jsonb_array_length(r->'runs') <> 3 or (r->'runs'->0->>'kind') <> 'manual'
     or (r->>'lastOkAt')::timestamptz < now() - interval '2 hours' then
    raise exception 'FAIL: office_backups returned %', r;
  end if;
  raise notice 'ok: office_backups lists runs, newest first, with the last good time';
end $$;
reset role;
