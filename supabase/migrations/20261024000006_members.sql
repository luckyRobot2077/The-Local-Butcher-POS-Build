-- Phase 4: members (no tiers) and discount programs. As in earlier phases,
-- every write goes through a SECURITY DEFINER function that checks the
-- caller's role itself.

-- ---------------------------------------------------------------- members
alter table customers add column member_no text;
alter table customers add column gender text check (gender in ('female', 'male', 'other', 'undisclosed'));
alter table customers add column birth_year integer check (birth_year between 1900 and 2100);
alter table customers add column privacy_consent_at timestamptz;
alter table customers add column registered_by_name text;
alter table customers add column device_id uuid references devices (id);
alter table customers add column updated_at timestamptz not null default now();
-- Mobile numbers are stored as +639XXXXXXXXX (the app normalises them).
alter table customers add constraint customers_contact_format
  check (contact_number is null or contact_number ~ '^\+639[0-9]{9}$') not valid;
alter table customers add constraint customers_promo_needs_number
  check (not marketing_consent or contact_number is not null) not valid;
create unique index customers_member_no_idx on customers (store_id, member_no);
create index customers_store_updated_idx on customers (store_id, updated_at);
create index sales_customer_idx on sales (customer_id);

-- Members are written only through sync_customer below.
drop policy staff_add_customers on customers;
revoke insert, update, delete on customers from authenticated;

-- ---------------------------------------------------------------- discount programs
alter table promotions add column description text check (length(description) <= 200);
alter table promotions add column scope text not null default 'order' check (scope in ('order', 'items'));
alter table promotions add column product_ids uuid[] not null default '{}';
alter table promotions add column category_ids uuid[] not null default '{}';
alter table promotions add column members_only boolean not null default false;
alter table promotions add column min_purchase bigint not null default 0 check (min_purchase >= 0);
alter table promotions add column starts_on date;
alter table promotions add column ends_on date;
alter table promotions add column updated_by_name text;
alter table promotions add column updated_at timestamptz not null default now();
alter table promotions add constraint promotions_items_percent check (scope <> 'items' or kind = 'percent');
alter table promotions add constraint promotions_dates check (ends_on is null or starts_on is null or ends_on >= starts_on);
alter table promotions add constraint promotions_name_len check (length(name) between 1 and 40) not valid;
create index promotions_store_updated_idx on promotions (store_id, updated_at);

-- ---------------------------------------------------------------- sync_customer
-- Any active staff member may register or edit a member. Upsert by id; the
-- member number and registration time never change after the first save.
create function sync_customer(p jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_id uuid := (p ->> 'id')::uuid;
  v_no text := upper(trim(p ->> 'memberNo'));
  v_contact text := nullif(p ->> 'contactNumber', '');
  v_promo boolean := coalesce((p ->> 'marketingConsent')::boolean, false);
  cur customers;
begin
  if coalesce(p ->> 'privacyConsentAt', '') = '' then
    raise exception 'a member needs their privacy consent recorded' using errcode = '22023';
  end if;
  if v_no !~ '^M-[A-Z0-9]{4}-[0-9]{4,}$' then
    raise exception 'member number % is not valid', v_no using errcode = '22023';
  end if;
  if (p ->> 'gender') not in ('female', 'male', 'other', 'undisclosed') then
    raise exception 'gender % is not valid', p ->> 'gender' using errcode = '22023';
  end if;
  if v_contact is not null and v_contact !~ '^\+639[0-9]{9}$' then
    raise exception 'mobile number must look like +639XXXXXXXXX' using errcode = '22023';
  end if;
  if v_promo and v_contact is null then
    raise exception 'promo messages need a mobile number' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer:' || v_id::text));
  select * into cur from customers where id = v_id;
  if found then
    if cur.store_id <> me.store_id then
      raise exception 'member belongs to another store' using errcode = '42501';
    end if;
    if cur.member_no is distinct from v_no then
      raise exception 'member numbers cannot change' using errcode = '22023';
    end if;
    update customers set
      name = trim(p ->> 'name'),
      birth_year = (p ->> 'birthYear')::int,
      gender = p ->> 'gender',
      contact_number = v_contact,
      marketing_consent = v_promo,
      marketing_consent_at = nullif(p ->> 'marketingConsentAt', '')::timestamptz,
      active = coalesce((p ->> 'active')::boolean, true),
      notes = nullif(p ->> 'notes', ''),
      updated_at = now()
    where id = v_id and (name, birth_year, gender, contact_number, marketing_consent, marketing_consent_at, active, notes)
      is distinct from (trim(p ->> 'name'), (p ->> 'birthYear')::int, p ->> 'gender', v_contact, v_promo,
        nullif(p ->> 'marketingConsentAt', '')::timestamptz, coalesce((p ->> 'active')::boolean, true),
        nullif(p ->> 'notes', ''));
    return v_id;
  end if;

  if exists (select 1 from customers where store_id = me.store_id and member_no = v_no) then
    raise exception 'member number % is already used', v_no using errcode = '23505';
  end if;
  if not exists (select 1 from devices d where d.id = (p ->> 'deviceId')::uuid and d.store_id = me.store_id) then
    raise exception 'device not registered for this store' using errcode = '42501';
  end if;
  insert into customers (id, store_id, member_no, name, birth_year, gender, contact_number, registered_at,
    privacy_consent_at, marketing_consent, marketing_consent_at, active, notes, registered_by_name, device_id)
  values (v_id, me.store_id, v_no, trim(p ->> 'name'), (p ->> 'birthYear')::int, p ->> 'gender', v_contact,
    (p ->> 'registeredAt')::timestamptz, (p ->> 'privacyConsentAt')::timestamptz, v_promo,
    nullif(p ->> 'marketingConsentAt', '')::timestamptz, coalesce((p ->> 'active')::boolean, true),
    nullif(p ->> 'notes', ''), p ->> 'registeredBy', (p ->> 'deviceId')::uuid);
  return v_id;
end $$;

-- ---------------------------------------------------------------- sync_promotion
-- Owners and managers set up discount programs. Upsert by id.
create function sync_promotion(p jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_manager();
  v_id uuid := (p ->> 'id')::uuid;
  v_kind discount_kind := (p ->> 'kind')::discount_kind;
  v_products uuid[] := array(select jsonb_array_elements_text(coalesce(p -> 'productIds', '[]'::jsonb)))::uuid[];
  v_categories uuid[] := array(select jsonb_array_elements_text(coalesce(p -> 'categoryIds', '[]'::jsonb)))::uuid[];
begin
  if (p ->> 'value')::bigint <= 0 then
    raise exception 'a program needs a discount above zero' using errcode = '22023';
  end if;
  if exists (select 1 from promotions where id = v_id and store_id <> me.store_id) then
    raise exception 'program belongs to another store' using errcode = '42501';
  end if;
  insert into promotions (id, store_id, name, description, kind, value, scope, product_ids, category_ids, members_only,
    min_purchase, starts_on, ends_on, active, updated_by_name, updated_at)
  values (v_id, me.store_id, trim(p ->> 'name'), nullif(p ->> 'description', ''), v_kind, (p ->> 'value')::bigint,
    p ->> 'scope', v_products, v_categories, coalesce((p ->> 'membersOnly')::boolean, false),
    coalesce((p ->> 'minPurchase')::bigint, 0), nullif(p ->> 'startsOn', '')::date, nullif(p ->> 'endsOn', '')::date,
    coalesce((p ->> 'active')::boolean, true), p ->> 'updatedBy', now())
  on conflict (id) do update set
    name = excluded.name, description = excluded.description, kind = excluded.kind, value = excluded.value,
    scope = excluded.scope, product_ids = excluded.product_ids, category_ids = excluded.category_ids,
    members_only = excluded.members_only, min_purchase = excluded.min_purchase, starts_on = excluded.starts_on,
    ends_on = excluded.ends_on, active = excluded.active, updated_by_name = excluded.updated_by_name,
    updated_at = now();
  return v_id;
end $$;

-- ---------------------------------------------------------------- members_feed
-- Members and programs changed since p_since, for every staff device: the
-- counter needs both to scan cards and offer programs.
create function members_feed(p_since timestamptz) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_since timestamptz := coalesce(p_since, '-infinity'::timestamptz);
begin
  return jsonb_build_object(
    'now', now(),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'member_no', c.member_no, 'name', c.name,
        'birth_year', c.birth_year, 'gender', c.gender, 'contact_number', c.contact_number,
        'privacy_consent_at', c.privacy_consent_at, 'marketing_consent', c.marketing_consent,
        'marketing_consent_at', c.marketing_consent_at, 'active', c.active, 'notes', c.notes,
        'registered_at', c.registered_at, 'registered_by', c.registered_by_name, 'device_id', c.device_id,
        'updated_at', c.updated_at))
      from customers c
      where c.store_id = me.store_id and c.member_no is not null and c.updated_at > v_since), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'description', p.description, 'kind', p.kind,
        'value', p.value, 'scope', p.scope, 'product_ids', to_jsonb(p.product_ids),
        'category_ids', to_jsonb(p.category_ids), 'members_only', p.members_only, 'min_purchase', p.min_purchase,
        'starts_on', p.starts_on, 'ends_on', p.ends_on, 'active', p.active, 'updated_by', p.updated_by_name,
        'updated_at', p.updated_at))
      from promotions p where p.store_id = me.store_id and p.updated_at > v_since), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------- sales
-- sync_sale now also links the member and the discount program. Older
-- payloads without these keys are stored exactly as before.
create or replace function sync_sale(payload jsonb) returns text
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := current_staff();
  s jsonb := payload -> 'sale';
  v_sale_id uuid := (s ->> 'id')::uuid;
  v_device uuid := (s ->> 'deviceId')::uuid;
  v_customer uuid := nullif(s ->> 'customerId', '')::uuid;
  v_digest text := encode(digest(payload::text, 'sha256'), 'hex');
  existing sync_receipts;
  it jsonb;
  v_source text;
  v_promo uuid;
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

  if v_customer is not null and not exists (select 1 from customers where id = v_customer and store_id = me.store_id) then
    raise exception 'the member on sale % is not in the cloud yet', s ->> 'receiptNo' using errcode = '23503';
  end if;

  insert into sales (id, store_id, device_id, receipt_no, cashier_user, cashier_name, customer_id, created_at,
    business_date, subtotal, item_discount_total, order_discount, discount_total, total, cost_total, payment_method,
    tendered, change, discount_approved_by)
  values (v_sale_id, me.store_id, v_device, s ->> 'receiptNo', me.user_id, s ->> 'cashierName', v_customer,
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

  for it in select * from jsonb_array_elements(coalesce(payload -> 'discounts', '[]'::jsonb)) loop
    v_source := coalesce(it ->> 'source', 'manual');
    -- The program link is kept only if the program reached the cloud; the name stays in reason either way.
    v_promo := (select id from promotions
      where id = nullif(it ->> 'promotionId', '')::uuid and store_id = me.store_id);
    insert into sale_discounts (sale_id, sale_item_id, source, promotion_id, kind, value, amount, reason, approved_by)
    values (v_sale_id, nullif(it ->> 'saleItemId', '')::uuid, v_source, v_promo, (it ->> 'kind')::discount_kind,
      (it ->> 'value')::bigint, (it ->> 'amount')::bigint, it ->> 'reason',
      case when v_source = 'manual' then s ->> 'discountApprovedBy' end);
  end loop;

  insert into sync_receipts (entity, entity_id, device_id, payload_sha256) values ('sale', v_sale_id, v_device, v_digest);
  return 'inserted';
end $$;

-- ---------------------------------------------------------------- inventory feed
-- Same as migration 5, with the member on each sale line for purchase history.
create or replace function inventory_feed(p_since timestamptz, p_device uuid) returns jsonb
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
          else i.unit_cost * i.qty end, 'at', s.created_at, 'customer_id', s.customer_id))
      from sale_items i join sales s on s.id = i.sale_id
      where s.store_id = me.store_id and s.received_at > v_since and s.device_id is distinct from p_device), '[]'::jsonb)
  );
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'sync_customer(jsonb)', 'sync_promotion(jsonb)', 'members_feed(timestamptz)', 'sync_sale(jsonb)',
    'inventory_feed(timestamptz, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

update schema_info set value = '20261024000006' where key = 'schema_version';
