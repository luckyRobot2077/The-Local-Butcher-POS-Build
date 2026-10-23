-- Like Supabase, pgcrypto lives in the "extensions" schema, not "public", so
-- functions with search_path = public cannot see digest() unless they say so.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Minimal stand-in for the parts of Supabase that the migrations use, so
-- they can be tested on plain PostgreSQL. Not used in production.
-- Roles are cluster-wide, so only create them once.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
-- Supabase's default grants: anon and authenticated get every new table,
-- sequence and function in public (row level security does the filtering).
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Storage stand-in (Supabase provides the real one).
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint,
  allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to authenticated;
grant select, insert on storage.objects to authenticated;
