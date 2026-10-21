-- Phase 2: store bootstrap, device registration, staff management and the
-- sync functions for catalog, photos and stock movements. All functions
-- are SECURITY DEFINER and check the caller's staff profile themselves.

-- ---------------------------------------------------------------- helpers
create function require_staff() returns staff_profiles
  language plpgsql stable security definer set search_path = public as $$
declare me staff_profiles := current_staff();
begin
  if me.user_id is null then
    raise exception 'not an active staff member' using errcode = '42501';
  end if;
  return me;
end $$;

-- ---------------------------------------------------------------- bootstrap
-- The first signed-in user creates the store and becomes its owner. Works
-- only while no store exists, so later sign-ups cannot take over.
create function bootstrap_owner(p_store_name text, p_display_name text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare v_store uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('bootstrap_owner'));
  if exists (select 1 from stores) then
    raise exception 'this database already has a store; ask the owner to add you as staff' using errcode = '42501';
  end if;
  insert into stores (name) values (p_store_name) returning id into v_store;
  insert into staff_profiles (user_id, store_id, display_name, role, can_edit_photos, can_edit_descriptions,
    can_edit_names, can_edit_prices, can_edit_categories, discount_limit_bp)
  values (auth.uid(), v_store, p_display_name, 'owner', true, true, true, true, true, 10000);
  insert into settings (store_id, data, updated_by) values (v_store, '{}'::jsonb, auth.uid());
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name)
  values (v_store, 'store.bootstrap', 'store', v_store, auth.uid(), p_display_name);
  return v_store;
end $$;

-- Owner adds an existing Supabase Auth user (created in the dashboard) as staff.
create function add_staff(p_email text, p_display_name text, p_role staff_role) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_user uuid;
begin
  if me.role <> 'owner' then
    raise exception 'only the owner can add staff' using errcode = '42501';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'no user with that email; create it under Authentication > Users first' using errcode = 'P0002';
  end if;
  insert into staff_profiles (user_id, store_id, display_name, role,
    can_edit_photos, can_edit_descriptions, can_edit_names, can_edit_prices, can_edit_categories)
  values (v_user, me.store_id, p_display_name, p_role,
    p_role <> 'cashier', p_role <> 'cashier', p_role <> 'cashier', p_role <> 'cashier', p_role <> 'cashier')
  on conflict (user_id) do update set display_name = excluded.display_name, role = excluded.role, active = true
    where staff_profiles.store_id = me.store_id;
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
  values (me.store_id, 'staff.add', 'staff', v_user, me.user_id, me.display_name, jsonb_build_object('role', p_role));
  return v_user;
end $$;

-- Returns the caller's profile and store, for the app to show who is signed in.
create function whoami() returns table (user_id uuid, store_id uuid, store_name text, display_name text,
  role staff_role, can_edit_photos boolean, can_edit_descriptions boolean, can_edit_names boolean,
  can_edit_prices boolean, can_edit_categories boolean, discount_limit_bp integer, has_store boolean)
  language sql stable security definer set search_path = public as $$
  select p.user_id, p.store_id, s.name, p.display_name, p.role, p.can_edit_photos, p.can_edit_descriptions,
    p.can_edit_names, p.can_edit_prices, p.can_edit_categories, p.discount_limit_bp, true
  from staff_profiles p join stores s on s.id = p.store_id
  where p.user_id = auth.uid() and p.active
  union all
  select null, null, null, null, null, null, null, null, null, null, null, exists (select 1 from stores)
  where not exists (select 1 from staff_profiles where user_id = auth.uid() and active)
$$;

-- ---------------------------------------------------------------- devices
create function register_device(p_device_id uuid, p_device_code text, p_label text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  d devices;
begin
  select * into d from devices where id = p_device_id;
  if found then
    if d.store_id <> me.store_id then
      raise exception 'device belongs to another store' using errcode = '42501';
    end if;
    if d.revoked_at is not null then
      raise exception 'this device has been revoked by the owner' using errcode = '42501';
    end if;
    return me.store_id;
  end if;
  if exists (select 1 from devices where store_id = me.store_id and device_code = p_device_code) then
    raise exception 'device code already in use' using errcode = '23505';
  end if;
  insert into devices (id, store_id, device_code, label, registered_by)
  values (p_device_id, me.store_id, p_device_code, p_label, me.user_id);
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, device_id)
  values (me.store_id, 'device.register', 'device', p_device_id, me.user_id, me.display_name, p_device_id);
  return me.store_id;
end $$;

-- ---------------------------------------------------------------- catalog sync
-- Categories are matched by name so devices that each created "Pork" end
-- up with one category. Returns the server id the device must use.
create function sync_category(p_id uuid, p_name text, p_sort integer) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_id uuid;
begin
  select id into v_id from categories where store_id = me.store_id and lower(name) = lower(trim(p_name));
  if found then
    return v_id;
  end if;
  if not (me.role in ('owner', 'manager') or me.can_edit_categories) then
    raise exception 'not allowed to create categories' using errcode = '42501';
  end if;
  insert into categories (id, store_id, name, sort_order) values (p_id, me.store_id, trim(p_name), p_sort)
  on conflict (id) do nothing;
  return p_id;
end $$;

-- Creates or updates a product. p_base_version is the server version the
-- device last saw (null for a new product). If the server has moved on,
-- nothing is written and the current server row comes back as a conflict.
-- Field-level permissions are enforced here, not in the browser.
create function sync_product(p jsonb, p_base_version integer, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_id uuid := (p ->> 'id')::uuid;
  cur products;
  nxt products;
  changed text[] := '{}';
  f text;
  v_image uuid := nullif(p ->> 'imageId', '')::uuid;
begin
  if v_image is not null and not exists (select 1 from product_images where id = v_image) then
    v_image := null; -- photo not uploaded yet; sync_product_image will attach it
  end if;

  perform pg_advisory_xact_lock(hashtext(v_id::text));
  select * into cur from products where id = v_id;

  if not found then
    if not (me.role in ('owner', 'manager') or (me.can_edit_names and me.can_edit_prices)) then
      raise exception 'not allowed to create products' using errcode = '42501';
    end if;
    insert into products (id, store_id, category_id, name, description, sku, barcode, sale_unit, price, cost,
      min_stock_qty, active, image_id, version, created_at, updated_at)
    values (v_id, me.store_id, (p ->> 'categoryId')::uuid, p ->> 'name', coalesce(p ->> 'description', ''),
      nullif(p ->> 'sku', ''), nullif(p ->> 'barcode', ''), (p ->> 'saleUnit')::sale_unit, (p ->> 'price')::bigint,
      (p ->> 'cost')::bigint, (p ->> 'minStockQty')::bigint, (p ->> 'active')::boolean, v_image, 1,
      coalesce((p ->> 'createdAt')::timestamptz, now()), now())
    returning * into nxt;
    insert into product_revisions (id, product_id, version, changed_fields, before, after, by_user, by_name, at)
    values (gen_random_uuid(), v_id, 1, array['created'], null, to_jsonb(nxt), me.user_id, me.display_name, now());
    insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name)
    values (me.store_id, 'product.create', 'product', v_id, me.user_id, me.display_name);
    return jsonb_build_object('status', 'created', 'version', 1, 'imageAttached', v_image is not null);
  end if;

  if cur.store_id <> me.store_id then
    raise exception 'product belongs to another store' using errcode = '42501';
  end if;
  if p_base_version is distinct from cur.version then
    return jsonb_build_object('status', 'conflict', 'server', to_jsonb(cur));
  end if;

  nxt := cur;
  nxt.name := p ->> 'name';
  nxt.description := coalesce(p ->> 'description', '');
  nxt.category_id := (p ->> 'categoryId')::uuid;
  nxt.sku := nullif(p ->> 'sku', '');
  nxt.barcode := nullif(p ->> 'barcode', '');
  nxt.sale_unit := (p ->> 'saleUnit')::sale_unit;
  nxt.price := (p ->> 'price')::bigint;
  nxt.cost := (p ->> 'cost')::bigint;
  nxt.min_stock_qty := (p ->> 'minStockQty')::bigint;
  nxt.active := (p ->> 'active')::boolean;
  -- Keep a server photo the device has not uploaded a replacement for yet.
  if v_image is not null or nullif(p ->> 'imageId', '') is null then
    nxt.image_id := v_image;
  end if;

  if nxt.name is distinct from cur.name then changed := array_append(changed, 'name'); end if;
  if nxt.description is distinct from cur.description then changed := array_append(changed, 'description'); end if;
  if nxt.category_id is distinct from cur.category_id then changed := array_append(changed, 'categoryId'); end if;
  if nxt.sku is distinct from cur.sku then changed := array_append(changed, 'sku'); end if;
  if nxt.barcode is distinct from cur.barcode then changed := array_append(changed, 'barcode'); end if;
  if nxt.sale_unit is distinct from cur.sale_unit then changed := array_append(changed, 'saleUnit'); end if;
  if nxt.price is distinct from cur.price then changed := array_append(changed, 'price'); end if;
  if nxt.cost is distinct from cur.cost then changed := array_append(changed, 'cost'); end if;
  if nxt.min_stock_qty is distinct from cur.min_stock_qty then changed := array_append(changed, 'minStockQty'); end if;
  if nxt.active is distinct from cur.active then changed := array_append(changed, 'active'); end if;
  if nxt.image_id is distinct from cur.image_id then changed := array_append(changed, 'imageId'); end if;

  if cardinality(changed) = 0 then
    return jsonb_build_object('status', 'unchanged', 'version', cur.version);
  end if;

  if me.role <> 'owner' then
    foreach f in array changed loop
      if (f = 'imageId' and not me.can_edit_photos)
        or (f = 'description' and not me.can_edit_descriptions)
        or (f = 'name' and not me.can_edit_names)
        or (f in ('price', 'cost') and not me.can_edit_prices)
        or (f = 'categoryId' and not me.can_edit_categories)
        or (f in ('sku', 'barcode', 'saleUnit', 'minStockQty', 'active') and me.role <> 'manager') then
        raise exception 'not allowed to change %', f using errcode = '42501';
      end if;
    end loop;
  end if;

  nxt.version := cur.version + 1;
  nxt.updated_at := now();
  update products set category_id = nxt.category_id, name = nxt.name, description = nxt.description, sku = nxt.sku,
    barcode = nxt.barcode, sale_unit = nxt.sale_unit, price = nxt.price, cost = nxt.cost,
    min_stock_qty = nxt.min_stock_qty, active = nxt.active, image_id = nxt.image_id, version = nxt.version,
    updated_at = nxt.updated_at
  where id = v_id;

  insert into product_revisions (id, product_id, version, changed_fields, before, after, by_user, by_name, at)
  values (gen_random_uuid(), v_id, nxt.version, changed, to_jsonb(cur), to_jsonb(nxt), me.user_id, me.display_name, now());
  if nxt.price <> cur.price then
    insert into product_prices (id, product_id, field, old_value, new_value, reason, by_user, by_name, at)
    values (gen_random_uuid(), v_id, 'price', cur.price, nxt.price, p_reason, me.user_id, me.display_name, now());
  end if;
  if nxt.cost <> cur.cost then
    insert into product_prices (id, product_id, field, old_value, new_value, reason, by_user, by_name, at)
    values (gen_random_uuid(), v_id, 'cost', cur.cost, nxt.cost, p_reason, me.user_id, me.display_name, now());
  end if;
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
  values (me.store_id, 'product.update', 'product', v_id, me.user_id, me.display_name,
    jsonb_build_object('changed', changed, 'reason', p_reason));
  return jsonb_build_object('status', 'updated', 'version', nxt.version, 'imageAttached', nxt.image_id is not null);
end $$;

-- Records an uploaded photo. When p_make_current is true it becomes the
-- product's photo. Returns the product's current version.
create function sync_product_image(p_id uuid, p_product_id uuid, p_path text, p_mime text, p_width integer,
  p_height integer, p_make_current boolean) returns integer
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_version integer;
begin
  if not (me.role in ('owner', 'manager') or me.can_edit_photos) then
    raise exception 'not allowed to change photos' using errcode = '42501';
  end if;
  if not exists (select 1 from products where id = p_product_id and store_id = me.store_id) then
    raise exception 'product not synced yet' using errcode = '23503';
  end if;
  insert into product_images (id, product_id, storage_path, mime, width, height, created_at, created_by)
  values (p_id, p_product_id, p_path, p_mime, p_width, p_height, now(), me.user_id)
  on conflict (id) do nothing;
  if p_make_current then
    update products set image_id = p_id, version = version + 1, updated_at = now()
    where id = p_product_id and image_id is distinct from p_id;
  end if;
  -- The device stores this as its base version for the next edit.
  select version into v_version from products where id = p_product_id;
  return v_version;
end $$;

-- Manual stock movement (delivery, spoilage, correction...). Idempotent by id.
create function sync_movement(m jsonb) returns text
  language plpgsql security definer set search_path = public as $$
declare me staff_profiles := require_staff();
begin
  if me.role not in ('owner', 'manager') then
    raise exception 'stock adjustments need a manager or owner account' using errcode = '42501';
  end if;
  if (m ->> 'type') = 'sale' then
    raise exception 'sale movements are synced with their sale' using errcode = '22023';
  end if;
  if not exists (select 1 from products where id = (m ->> 'productId')::uuid and store_id = me.store_id) then
    raise exception 'product not synced yet' using errcode = '23503';
  end if;
  insert into inventory_movements (id, store_id, product_id, type, qty_delta, unit_cost, reason, batch_code, use_by,
    by_user, by_name, at, device_id)
  values ((m ->> 'id')::uuid, me.store_id, (m ->> 'productId')::uuid, (m ->> 'type')::movement_type,
    (m ->> 'qtyDelta')::bigint, (m ->> 'unitCost')::bigint, m ->> 'reason', m ->> 'batchCode',
    nullif(m ->> 'useBy', '')::date, me.user_id, coalesce(m ->> 'by', me.display_name), (m ->> 'at')::timestamptz,
    nullif(m ->> 'deviceId', '')::uuid)
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;
  return 'inserted';
end $$;

-- Current stock for every product in the caller's store (cashiers cannot
-- read the ledger itself).
create function store_stock() returns table (product_id uuid, stock_qty bigint)
  language sql stable security definer set search_path = public as $$
  select m.product_id, sum(m.qty_delta)::bigint
  from inventory_movements m
  where m.store_id = (select store_id from staff_profiles where user_id = auth.uid() and active)
  group by m.product_id
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'require_staff()', 'bootstrap_owner(text, text)', 'add_staff(text, text, staff_role)', 'whoami()',
    'register_device(uuid, text, text)', 'sync_category(uuid, text, integer)', 'sync_product(jsonb, integer, text)',
    'sync_product_image(uuid, uuid, text, text, integer, integer, boolean)', 'sync_movement(jsonb)', 'store_stock()'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------- sales
-- sync_sale now also stores discount details sent by the device.
create or replace function sync_sale(payload jsonb) returns text
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := current_staff();
  s jsonb := payload -> 'sale';
  v_sale_id uuid := (s ->> 'id')::uuid;
  v_device uuid := (s ->> 'deviceId')::uuid;
  v_digest text := encode(digest(payload::text, 'sha256'), 'hex');
  existing sync_receipts;
  it jsonb;
begin
  if me.user_id is null then
    raise exception 'not an active staff member' using errcode = '42501';
  end if;
  if not exists (select 1 from devices d where d.id = v_device and d.store_id = me.store_id and d.revoked_at is null) then
    raise exception 'device not registered for this store' using errcode = '42501';
  end if;

  -- Serialise concurrent submissions of the same sale.
  perform pg_advisory_xact_lock(hashtext(v_sale_id::text));
  select * into existing from sync_receipts where entity = 'sale' and entity_id = v_sale_id;
  if found then
    if existing.payload_sha256 = v_digest then
      return 'duplicate';
    end if;
    raise exception 'sale % already synced with different content', v_sale_id using errcode = '23505';
  end if;

  insert into sales (id, store_id, device_id, receipt_no, cashier_user, cashier_name, created_at, business_date,
    subtotal, item_discount_total, order_discount, discount_total, total, cost_total, payment_method, tendered, change,
    discount_approved_by)
  values (v_sale_id, me.store_id, v_device, s ->> 'receiptNo', me.user_id, s ->> 'cashierName',
    (s ->> 'createdAt')::timestamptz, (s ->> 'businessDate')::date, (s ->> 'subtotal')::bigint,
    (s ->> 'itemDiscountTotal')::bigint, (s ->> 'orderDiscount')::bigint, (s ->> 'discountTotal')::bigint,
    (s ->> 'total')::bigint, (s ->> 'costTotal')::bigint, (s ->> 'paymentMethod')::payment_method,
    (s ->> 'tendered')::bigint, (s ->> 'change')::bigint, s ->> 'discountApprovedBy');

  for it in select * from jsonb_array_elements(payload -> 'items') loop
    insert into sale_items (id, sale_id, line_no, product_id, product_name, sale_unit, unit_price, unit_cost, qty, gross,
      item_discount, order_discount_share, net)
    values ((it ->> 'id')::uuid, v_sale_id, (it ->> 'lineNo')::int, (it ->> 'productId')::uuid, it ->> 'productName',
      (it ->> 'saleUnit')::sale_unit, (it ->> 'unitPrice')::bigint, (it ->> 'unitCost')::bigint, (it ->> 'qty')::bigint,
      (it ->> 'gross')::bigint, (it ->> 'itemDiscount')::bigint, (it ->> 'orderDiscountShare')::bigint,
      (it ->> 'net')::bigint);
    insert into inventory_movements (id, store_id, product_id, type, qty_delta, unit_cost, ref_type, ref_id, by_user,
      by_name, at, device_id)
    values (gen_random_uuid(), me.store_id, (it ->> 'productId')::uuid, 'sale', -(it ->> 'qty')::bigint,
      (it ->> 'unitCost')::bigint, 'sale', v_sale_id, me.user_id, s ->> 'cashierName',
      (s ->> 'createdAt')::timestamptz, v_device);
  end loop;

  if coalesce((select sum(net) from sale_items where sale_id = v_sale_id), -1) <> (s ->> 'total')::bigint then
    raise exception 'sale % items do not add up to the total', v_sale_id using errcode = '23514';
  end if;

  insert into payments (id, sale_id, method, amount, tendered, change, reference)
  values ((payload -> 'payment' ->> 'id')::uuid, v_sale_id, (payload -> 'payment' ->> 'method')::payment_method,
    (payload -> 'payment' ->> 'amount')::bigint, (payload -> 'payment' ->> 'tendered')::bigint,
    (payload -> 'payment' ->> 'change')::bigint, payload -> 'payment' ->> 'reference');

  -- Discount details (added in Phase 2; older payloads simply have none).
  for it in select * from jsonb_array_elements(coalesce(payload -> 'discounts', '[]'::jsonb)) loop
    insert into sale_discounts (sale_id, sale_item_id, source, kind, value, amount, reason, approved_by)
    values (v_sale_id, nullif(it ->> 'saleItemId', '')::uuid, 'manual', (it ->> 'kind')::discount_kind,
      (it ->> 'value')::bigint, (it ->> 'amount')::bigint, it ->> 'reason', s ->> 'discountApprovedBy');
  end loop;

  insert into sync_receipts (entity, entity_id, device_id, payload_sha256) values ('sale', v_sale_id, v_device, v_digest);
  return 'inserted';
end $$;


update schema_info set value = '20261022000003' where key = 'schema_version';
