-- Phase 3: supplier purchasing, batches and the inventory feed used for
-- movement analytics. Like Phase 2, every write goes through a SECURITY
-- DEFINER function that checks the caller's role itself.

-- ---------------------------------------------------------------- columns
alter table suppliers add column updated_at timestamptz not null default now();

alter table purchases add column notes text check (length(notes) <= 200);
alter table purchases add column by_name text;
alter table purchases add column device_id uuid references devices (id);
alter table purchases add column synced_at timestamptz not null default now();
alter table purchases add column updated_at timestamptz not null default now();

alter table inventory_batches add column store_id uuid references stores (id);
alter table inventory_batches add column purchase_id uuid references purchases (id);
alter table inventory_batches add column synced_at timestamptz not null default now();

create index purchases_store_updated_idx on purchases (store_id, updated_at);
create index inventory_batches_product_idx on inventory_batches (product_id);
create index inventory_movements_received_idx on inventory_movements (store_id, received_at);
create index sales_received_idx on sales (store_id, received_at);

-- ---------------------------------------------------------------- immutability
create trigger purchase_items_immutable before update or delete on purchase_items
  for each row execute function forbid_change();
create trigger inventory_batches_immutable before update or delete on inventory_batches
  for each row execute function forbid_change();

-- Only the payment status of a purchase may change after it is recorded.
create function purchases_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE'
    or (new.id, new.store_id, new.supplier_id, new.received_at, new.reference, new.notes, new.total_cost,
        new.created_by, new.by_name, new.device_id, new.synced_at)
       is distinct from
       (old.id, old.store_id, old.supplier_id, old.received_at, old.reference, old.notes, old.total_cost,
        old.created_by, old.by_name, old.device_id, old.synced_at) then
    raise exception 'purchases are immutable except for payment status' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger purchases_guard before update or delete on purchases for each row execute function purchases_guard();

-- ---------------------------------------------------------------- read access
create policy manager_read_suppliers on suppliers for select to authenticated
  using (store_id = my_store() and has_role(array['owner','manager']::staff_role[]));
create policy manager_read_purchases on purchases for select to authenticated
  using (store_id = my_store() and has_role(array['owner','manager']::staff_role[]));
create policy manager_read_purchase_items on purchase_items for select to authenticated
  using (exists (select 1 from purchases p where p.id = purchase_id and p.store_id = my_store())
    and has_role(array['owner','manager']::staff_role[]));
create policy manager_read_batches on inventory_batches for select to authenticated
  using (store_id = my_store() and has_role(array['owner','manager']::staff_role[]));

create function require_manager() returns staff_profiles
  language plpgsql stable security definer set search_path = public as $$
declare me staff_profiles := require_staff();
begin
  if me.role not in ('owner', 'manager') then
    raise exception 'this needs a manager or owner account' using errcode = '42501';
  end if;
  return me;
end $$;

-- ---------------------------------------------------------------- suppliers
-- Upsert by id. A new supplier whose name matches an existing one (ignoring
-- case) is merged into it; the caller remaps to the returned id.
create function sync_supplier(p jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_manager();
  v_id uuid := (p ->> 'id')::uuid;
  v_name text := trim(p ->> 'name');
  v_hit uuid;
begin
  perform pg_advisory_xact_lock(hashtext('supplier:' || me.store_id::text));
  if exists (select 1 from suppliers where id = v_id and store_id <> me.store_id) then
    raise exception 'supplier belongs to another store' using errcode = '42501';
  end if;
  if exists (select 1 from suppliers where id = v_id) then
    update suppliers set name = v_name, contact = nullif(p ->> 'contact', ''), notes = nullif(p ->> 'notes', ''),
      active = coalesce((p ->> 'active')::boolean, true), updated_at = now()
    where id = v_id and (name, contact, notes, active) is distinct from
      (v_name, nullif(p ->> 'contact', ''), nullif(p ->> 'notes', ''), coalesce((p ->> 'active')::boolean, true));
    return v_id;
  end if;
  select id into v_hit from suppliers where store_id = me.store_id and lower(name) = lower(v_name) limit 1;
  if v_hit is not null then
    return v_hit;
  end if;
  insert into suppliers (id, store_id, name, contact, notes, active)
  values (v_id, me.store_id, v_name, nullif(p ->> 'contact', ''), nullif(p ->> 'notes', ''),
    coalesce((p ->> 'active')::boolean, true));
  return v_id;
end $$;

-- ---------------------------------------------------------------- purchases
-- Records a supplier delivery with its lines, batches and stock movements in
-- one transaction. Idempotent like sync_sale: the same payload again returns
-- 'duplicate'; different content under the same id is rejected.
create function sync_purchase(payload jsonb) returns text
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_manager();
  p jsonb := payload -> 'purchase';
  v_id uuid := (p ->> 'id')::uuid;
  v_device uuid := (p ->> 'deviceId')::uuid;
  v_received timestamptz := (p ->> 'receivedAt')::timestamptz;
  v_digest text := encode(digest(payload::text, 'sha256'), 'hex');
  existing sync_receipts;
  ln jsonb;
  v_unit sale_unit;
  v_qty bigint;
  v_cost bigint;
  v_line bigint;
  v_total bigint := 0;
begin
  perform pg_advisory_xact_lock(hashtext('purchase:' || v_id::text));
  select * into existing from sync_receipts where entity = 'purchase' and entity_id = v_id;
  if found then
    if existing.payload_sha256 = v_digest then
      return 'duplicate';
    end if;
    raise exception 'purchase already synced with different content' using errcode = '23505';
  end if;
  if not exists (select 1 from devices d where d.id = v_device and d.store_id = me.store_id and d.revoked_at is null) then
    raise exception 'device not registered for this store' using errcode = '42501';
  end if;
  if not exists (select 1 from suppliers where id = (p ->> 'supplierId')::uuid and store_id = me.store_id) then
    raise exception 'supplier not synced yet' using errcode = '23503';
  end if;
  if jsonb_array_length(coalesce(payload -> 'lines', '[]'::jsonb)) = 0 then
    raise exception 'a purchase needs at least one line' using errcode = '22023';
  end if;

  insert into purchases (id, store_id, supplier_id, received_at, reference, notes, payment_status, total_cost,
    created_by, by_name, device_id)
  values (v_id, me.store_id, (p ->> 'supplierId')::uuid, v_received, nullif(p ->> 'reference', ''),
    nullif(p ->> 'notes', ''), 'unpaid', (p ->> 'totalCost')::bigint, me.user_id,
    coalesce(p ->> 'by', me.display_name), v_device);

  for ln in select * from jsonb_array_elements(payload -> 'lines') loop
    select sale_unit into v_unit from products where id = (ln ->> 'productId')::uuid and store_id = me.store_id;
    if not found then
      raise exception 'product not synced yet' using errcode = '23503';
    end if;
    v_qty := (ln ->> 'qty')::bigint;
    v_cost := (ln ->> 'unitCost')::bigint;
    v_line := case when v_unit = 'kg' then (v_cost * v_qty + 500) / 1000 else v_cost * v_qty end;
    if v_line <> (ln ->> 'lineCost')::bigint then
      raise exception 'line cost does not match quantity and unit cost' using errcode = '22023';
    end if;
    v_total := v_total + v_line;
    insert into inventory_batches (id, store_id, product_id, purchase_id, batch_code, received_at, use_by,
      storage_note, initial_qty, unit_cost)
    values ((ln ->> 'batchId')::uuid, me.store_id, (ln ->> 'productId')::uuid, v_id, nullif(ln ->> 'batchCode', ''),
      v_received, nullif(ln ->> 'useBy', '')::date, nullif(ln ->> 'storageNote', ''), v_qty, v_cost);
    insert into purchase_items (id, purchase_id, product_id, batch_id, qty, unit_cost, line_cost)
    values ((ln ->> 'itemId')::uuid, v_id, (ln ->> 'productId')::uuid, (ln ->> 'batchId')::uuid, v_qty, v_cost, v_line);
    insert into inventory_movements (id, store_id, product_id, batch_id, type, qty_delta, unit_cost, ref_type, ref_id,
      batch_code, use_by, by_user, by_name, at, device_id)
    values ((ln ->> 'movementId')::uuid, me.store_id, (ln ->> 'productId')::uuid, (ln ->> 'batchId')::uuid,
      'purchase', v_qty, v_cost, 'purchase', v_id, nullif(ln ->> 'batchCode', ''), nullif(ln ->> 'useBy', '')::date,
      me.user_id, coalesce(p ->> 'by', me.display_name), v_received, v_device);
  end loop;

  if v_total <> (p ->> 'totalCost')::bigint then
    raise exception 'purchase total does not match its lines' using errcode = '22023';
  end if;
  insert into sync_receipts (entity, entity_id, device_id, payload_sha256) values ('purchase', v_id, v_device, v_digest);
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
  values (me.store_id, 'purchase.receive', 'purchase', v_id, me.user_id, coalesce(p ->> 'by', me.display_name),
    jsonb_build_object('total', v_total, 'lines', jsonb_array_length(payload -> 'lines')));
  return 'inserted';
end $$;

create function set_purchase_payment(p_id uuid, p_status text) returns text
  language plpgsql security definer set search_path = public as $$
declare me staff_profiles := require_manager();
begin
  if p_status not in ('unpaid', 'partial', 'paid') then
    raise exception 'unknown payment status' using errcode = '22023';
  end if;
  update purchases set payment_status = p_status, updated_at = now()
  where id = p_id and store_id = me.store_id and payment_status is distinct from p_status;
  if not found and not exists (select 1 from purchases where id = p_id and store_id = me.store_id) then
    raise exception 'purchase not synced yet' using errcode = '23503';
  end if;
  return p_status;
end $$;

-- ---------------------------------------------------------------- stock movements
-- Replaces the Phase 2 version: waste can now name the batch it came from,
-- and purchase movements must come through sync_purchase.
create or replace function sync_movement(m jsonb) returns text
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_batch uuid := nullif(m ->> 'batchId', '')::uuid;
begin
  if me.role not in ('owner', 'manager') then
    raise exception 'stock adjustments need a manager or owner account' using errcode = '42501';
  end if;
  if (m ->> 'type') = 'sale' then
    raise exception 'sale movements are synced with their sale' using errcode = '22023';
  end if;
  if (m ->> 'type') = 'purchase' then
    raise exception 'purchase movements are synced with their purchase' using errcode = '22023';
  end if;
  if not exists (select 1 from products where id = (m ->> 'productId')::uuid and store_id = me.store_id) then
    raise exception 'product not synced yet' using errcode = '23503';
  end if;
  if v_batch is not null and not exists (
    select 1 from inventory_batches where id = v_batch and product_id = (m ->> 'productId')::uuid
      and store_id = me.store_id
  ) then
    raise exception 'batch not synced yet' using errcode = '23503';
  end if;
  insert into inventory_movements (id, store_id, product_id, batch_id, type, qty_delta, unit_cost, reason, batch_code,
    use_by, by_user, by_name, at, device_id)
  values ((m ->> 'id')::uuid, me.store_id, (m ->> 'productId')::uuid, v_batch, (m ->> 'type')::movement_type,
    (m ->> 'qtyDelta')::bigint, (m ->> 'unitCost')::bigint, m ->> 'reason', m ->> 'batchCode',
    nullif(m ->> 'useBy', '')::date, me.user_id, coalesce(m ->> 'by', me.display_name), (m ->> 'at')::timestamptz,
    nullif(m ->> 'deviceId', '')::uuid)
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;
  return 'inserted';
end $$;

-- ---------------------------------------------------------------- feed
-- Everything other devices recorded since p_since, for the owner's and
-- managers' inventory reports. Records from p_device itself are left out
-- because that device already has them.
create function inventory_feed(p_since timestamptz, p_device uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  me staff_profiles := require_manager();
  v_since timestamptz := coalesce(p_since, '-infinity'::timestamptz);
begin
  return jsonb_build_object(
    'now', now(),
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'contact', s.contact, 'notes', s.notes,
        'active', s.active, 'updated_at', s.updated_at))
      from suppliers s where s.store_id = me.store_id and s.updated_at > v_since), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'supplier_id', p.supplier_id, 'received_at', p.received_at,
        'reference', p.reference, 'notes', p.notes, 'payment_status', p.payment_status, 'total_cost', p.total_cost,
        'by_name', p.by_name, 'device_id', p.device_id))
      from purchases p where p.store_id = me.store_id and p.updated_at > v_since), '[]'::jsonb),
    'purchase_items', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'purchase_id', i.purchase_id, 'product_id', i.product_id,
        'batch_id', i.batch_id, 'qty', i.qty, 'unit_cost', i.unit_cost, 'line_cost', i.line_cost))
      from purchase_items i join purchases p on p.id = i.purchase_id
      where p.store_id = me.store_id and p.synced_at > v_since and p.device_id is distinct from p_device), '[]'::jsonb),
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'product_id', b.product_id, 'purchase_id', b.purchase_id,
        'batch_code', b.batch_code, 'received_at', b.received_at, 'use_by', b.use_by, 'storage_note', b.storage_note,
        'initial_qty', b.initial_qty, 'unit_cost', b.unit_cost))
      from inventory_batches b left join purchases p on p.id = b.purchase_id
      where b.store_id = me.store_id and b.synced_at > v_since and p.device_id is distinct from p_device), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'product_id', m.product_id, 'batch_id', m.batch_id,
        'type', m.type, 'qty_delta', m.qty_delta, 'unit_cost', m.unit_cost, 'ref_type', m.ref_type, 'ref_id', m.ref_id,
        'reason', m.reason, 'batch_code', m.batch_code, 'use_by', m.use_by, 'by_name', m.by_name, 'at', m.at))
      from inventory_movements m
      where m.store_id = me.store_id and m.received_at > v_since and m.device_id is distinct from p_device), '[]'::jsonb),
    'sale_lines', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'sale_id', i.sale_id, 'product_id', i.product_id, 'qty', i.qty,
        'net', i.net, 'cost', case when i.sale_unit = 'kg' then (i.unit_cost * i.qty + 500) / 1000
          else i.unit_cost * i.qty end, 'at', s.created_at))
      from sale_items i join sales s on s.id = i.sale_id
      where s.store_id = me.store_id and s.received_at > v_since and s.device_id is distinct from p_device), '[]'::jsonb)
  );
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'require_manager()', 'sync_supplier(jsonb)', 'sync_purchase(jsonb)', 'set_purchase_payment(uuid, text)',
    'sync_movement(jsonb)', 'inventory_feed(timestamptz, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

revoke all on function purchases_guard() from public, anon, authenticated;

update schema_info set value = '20261023000005' where key = 'schema_version';
