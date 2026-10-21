-- Row Level Security and role helpers. Every table is closed by default;
-- policies open only what each role needs. Sales are written only through
-- the sync_sale() function, never directly by the browser.

create function current_staff() returns staff_profiles
  language sql stable security definer set search_path = public as $$
  select * from staff_profiles where user_id = auth.uid() and active
$$;

create function has_role(roles staff_role[]) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_profiles where user_id = auth.uid() and active and role = any (roles))
$$;

create function my_store() returns uuid
  language sql stable security definer set search_path = public as $$
  select store_id from staff_profiles where user_id = auth.uid() and active
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'stores','staff_profiles','devices','settings','cashier_shifts','cash_movements','categories','products',
    'product_images','product_revisions','product_prices','suppliers','purchases','inventory_batches','purchase_items',
    'inventory_movements','customers','promotions','promotion_rules','sales','sale_items','sale_discounts','payments',
    'refunds','refund_items','expenses','audit_logs','sync_receipts','backup_manifests','schema_info'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
  end loop;
end $$;

-- Staff can read their own store's operational data.
create policy staff_read_store on stores for select to authenticated using (id = my_store());
create policy staff_read_self on staff_profiles for select to authenticated
  using (user_id = auth.uid() or (store_id = my_store() and has_role(array['owner','manager']::staff_role[])));
create policy owner_manage_staff on staff_profiles for all to authenticated
  using (store_id = my_store() and has_role(array['owner']::staff_role[]))
  with check (store_id = my_store() and has_role(array['owner']::staff_role[]));

create policy staff_read_categories on categories for select to authenticated using (store_id = my_store());
create policy manager_write_categories on categories for all to authenticated
  using (store_id = my_store() and has_role(array['owner','manager']::staff_role[]))
  with check (store_id = my_store() and has_role(array['owner','manager']::staff_role[]));

create policy staff_read_products on products for select to authenticated using (store_id = my_store());
-- Product writes from managers/cashiers will go through an API route that
-- checks the per-field edit permissions; only owners may write directly.
create policy owner_write_products on products for all to authenticated
  using (store_id = my_store() and has_role(array['owner']::staff_role[]))
  with check (store_id = my_store() and has_role(array['owner']::staff_role[]));

create policy staff_read_images on product_images for select to authenticated
  using (exists (select 1 from products p where p.id = product_id and p.store_id = my_store()));
create policy staff_read_customers on customers for select to authenticated using (store_id = my_store());
create policy staff_add_customers on customers for insert to authenticated with check (store_id = my_store());
create policy staff_read_promotions on promotions for select to authenticated using (store_id = my_store());
create policy staff_read_settings on settings for select to authenticated using (store_id = my_store());

-- Financial data: staff see their own store's sales; reports are for owner/manager.
create policy staff_read_sales on sales for select to authenticated using (store_id = my_store());
create policy staff_read_sale_items on sale_items for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_id and s.store_id = my_store()));
create policy staff_read_payments on payments for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_id and s.store_id = my_store()));
create policy manager_read_movements on inventory_movements for select to authenticated
  using (store_id = my_store() and has_role(array['owner','manager']::staff_role[]));
create policy manager_read_expenses on expenses for select to authenticated
  using (store_id = my_store() and has_role(array['owner','manager']::staff_role[]));
create policy owner_read_audit on audit_logs for select to authenticated
  using (store_id = my_store() and has_role(array['owner']::staff_role[]));
create policy owner_backups on backup_manifests for all to authenticated
  using (store_id = my_store() and has_role(array['owner']::staff_role[]))
  with check (store_id = my_store() and has_role(array['owner']::staff_role[]));

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on staff_profiles, categories, products, customers, backup_manifests to authenticated;

-- ---------------------------------------------------------------- idempotent sale sync
-- Called by the authenticated sync API with one sale from a device outbox.
-- Repeating the same call returns 'duplicate' and writes nothing. A
-- different payload under an existing sale id is rejected as a conflict.
create function sync_sale(payload jsonb) returns text
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

  insert into sync_receipts (entity, entity_id, device_id, payload_sha256) values ('sale', v_sale_id, v_device, v_digest);
  return 'inserted';
end $$;

revoke all on function sync_sale(jsonb) from public, anon;
grant execute on function sync_sale(jsonb) to authenticated;
