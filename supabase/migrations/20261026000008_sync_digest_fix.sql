-- Fix: on Supabase, pgcrypto (digest) is installed in the "extensions"
-- schema, but sync_sale and sync_purchase only looked in "public", so every
-- sale and purchase upload failed with "function digest(text, unknown) does
-- not exist". This lets them find it. Nothing else changes; safe to run twice.

alter function sync_sale(jsonb) set search_path = public, extensions;
alter function sync_purchase(jsonb) set search_path = public, extensions;

update schema_info set value = '20261026000008' where key = 'schema_version';
