-- One line per table in public: "rows.<table>=<count>". Used by the backup
-- manifest and to check a restore.
select string_agg(format('rows.%s=%s', t.relname,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.relname), false, true, '')))[1]::text),
  e'\n' order by t.relname)
from pg_class t join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public' and t.relkind = 'r';
