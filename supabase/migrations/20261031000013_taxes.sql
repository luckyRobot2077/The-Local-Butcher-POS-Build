-- Product taxes (0.9.0). The owner sets in the Back Office whether the shop
-- is VAT-registered, its TIN, and which categories and products are VATable
-- or VAT-exempt; devices download it on sync. Sales now carry their tax
-- details, and the Back Office gets a tax report (VAT, or 3% percentage tax
-- for a non-VAT shop). Not tax advice: confirm the setup with an accountant.
-- Safe to run more than once: every statement replaces, re-creates or re-grants.

-- ---------------------------------------------------------------- tables
alter table sales add column if not exists tax_mode text not null default 'non_vat'
  check (tax_mode in ('non_vat', 'vat'));
alter table sales add column if not exists vatable_sales bigint check (vatable_sales >= 0);
alter table sales add column if not exists vat_amount bigint check (vat_amount >= 0);
alter table sales add column if not exists vat_exempt_sales bigint check (vat_exempt_sales >= 0);
alter table sales add column if not exists vat_rate_bp integer check (vat_rate_bp between 0 and 5000);
do $$ begin
  alter table sales add constraint sales_vat_split check (
    tax_mode <> 'vat' or (vatable_sales is not null and vat_amount is not null and vat_exempt_sales is not null
      and vatable_sales + vat_amount + vat_exempt_sales = total));
exception when duplicate_object then null;
end $$;
alter table sale_items add column if not exists tax_class text check (tax_class in ('vatable', 'exempt'));
alter table sale_items add column if not exists vat bigint not null default 0 check (vat >= 0 and vat <= net);

-- ---------------------------------------------------------------- tax setup
-- The setup lives in settings.data -> 'tax'. Every signed-in staff member's
-- device reads it; only the owner changes it, from an unlocked Back Office.
create or replace function store_tax_settings() returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_staff();
begin
  return coalesce((select data -> 'tax' from settings where store_id = me.store_id), '{}'::jsonb);
end $$;

create or replace function save_tax_settings(p jsonb, p_token text) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  e employees := require_office(p_token);
  v_tax jsonb;
  v_key text;
  v_val text;
begin
  if e.role <> 'owner' then
    raise exception 'only the owner can change the tax setup' using errcode = '42501';
  end if;
  if coalesce(p ->> 'mode', '') not in ('non_vat', 'vat') then
    raise exception 'choose VAT-registered or not VAT-registered' using errcode = '22023';
  end if;
  if coalesce(p ->> 'tin', '') !~ '^[0-9 -]{0,20}$' then
    raise exception 'the TIN can only have digits and dashes' using errcode = '22023';
  end if;
  if p ->> 'mode' = 'vat' and length(regexp_replace(p ->> 'tin', '[^0-9]', '', 'g')) < 9 then
    raise exception 'a VAT-registered shop must enter its TIN (at least 9 digits)' using errcode = '22023';
  end if;
  if length(coalesce(p ->> 'registeredName', '')) > 80 or length(coalesce(p ->> 'registeredAddress', '')) > 160 then
    raise exception 'the registered name or address is too long' using errcode = '22023';
  end if;
  if coalesce((p ->> 'vatRateBp')::integer, -1) not between 0 and 5000
     or coalesce((p ->> 'percentageTaxBp')::integer, -1) not between 0 and 5000 then
    raise exception 'tax rates must be between 0%% and 50%%' using errcode = '22023';
  end if;
  for v_key, v_val in
    select key, value from jsonb_each_text(coalesce(p -> 'categories', '{}'::jsonb))
    union all select key, value from jsonb_each_text(coalesce(p -> 'products', '{}'::jsonb))
  loop
    if v_val not in ('vatable', 'exempt') then
      raise exception 'unknown tax class %', v_val using errcode = '22023';
    end if;
  end loop;

  v_tax := jsonb_build_object(
    'mode', p ->> 'mode',
    'tin', trim(coalesce(p ->> 'tin', '')),
    'registeredName', trim(coalesce(p ->> 'registeredName', '')),
    'registeredAddress', trim(coalesce(p ->> 'registeredAddress', '')),
    'vatRateBp', (p ->> 'vatRateBp')::integer,
    'percentageTaxBp', (p ->> 'percentageTaxBp')::integer,
    'categories', coalesce(p -> 'categories', '{}'::jsonb),
    'products', coalesce(p -> 'products', '{}'::jsonb),
    'updatedAt', now(),
    'updatedBy', e.name);
  insert into settings (store_id, data, updated_at) values (e.store_id, jsonb_build_object('tax', v_tax), now())
  on conflict (store_id) do update set data = settings.data || jsonb_build_object('tax', v_tax), updated_at = now();
  insert into audit_logs (store_id, action, entity, by_user, by_name, detail)
  values (e.store_id, 'settings.tax', 'settings', auth.uid(), e.name,
    jsonb_build_object('mode', v_tax ->> 'mode', 'tin', v_tax ->> 'tin'));
  return v_tax;
end $$;

-- ---------------------------------------------------------------- sales
-- Same as migration 11, plus the tax details: the shop's tax mode, each line's
-- class and VAT, and for VAT-registered sales the VATable / VAT / exempt split.
-- Sales from older app versions send none of it and count as non-VAT.
create or replace function sync_sale(payload jsonb) returns text
  language plpgsql security definer set search_path = public, extensions as $$
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
  v_mode text := coalesce(nullif(s ->> 'taxMode', ''), 'non_vat');
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
    tendered, change, discount_approved_by, started_at, shift_id, tax_mode, vatable_sales, vat_amount,
    vat_exempt_sales, vat_rate_bp)
  values (v_sale_id, me.store_id, v_device, s ->> 'receiptNo', me.user_id, s ->> 'cashierName', v_customer,
    (s ->> 'createdAt')::timestamptz, (s ->> 'businessDate')::date, (s ->> 'subtotal')::bigint,
    (s ->> 'itemDiscountTotal')::bigint, (s ->> 'orderDiscount')::bigint, (s ->> 'discountTotal')::bigint,
    (s ->> 'total')::bigint, (s ->> 'costTotal')::bigint, (s ->> 'paymentMethod')::payment_method,
    (s ->> 'tendered')::bigint, (s ->> 'change')::bigint, s ->> 'discountApprovedBy',
    nullif(s ->> 'startedAt', '')::timestamptz,
    -- Linked only if the shift reached the cloud, so a sale is never held up by its shift.
    (select id from cashier_shifts where id = nullif(s ->> 'shiftId', '')::uuid and store_id = me.store_id),
    v_mode,
    case when v_mode = 'vat' then (s ->> 'vatableSales')::bigint end,
    case when v_mode = 'vat' then (s ->> 'vatAmount')::bigint end,
    case when v_mode = 'vat' then (s ->> 'vatExemptSales')::bigint end,
    case when v_mode = 'vat' then (s ->> 'vatRateBp')::integer end);

  for it in select * from jsonb_array_elements(payload -> 'items') loop
    insert into sale_items (id, sale_id, line_no, product_id, product_name, sale_unit, unit_price, unit_cost, qty, gross,
      item_discount, order_discount_share, net, tax_class, vat)
    values ((it ->> 'id')::uuid, v_sale_id, (it ->> 'lineNo')::int, (it ->> 'productId')::uuid, it ->> 'productName',
      (it ->> 'saleUnit')::sale_unit, (it ->> 'unitPrice')::bigint, (it ->> 'unitCost')::bigint, (it ->> 'qty')::bigint,
      (it ->> 'gross')::bigint, (it ->> 'itemDiscount')::bigint, (it ->> 'orderDiscountShare')::bigint,
      (it ->> 'net')::bigint, nullif(it ->> 'taxClass', ''),
      case when v_mode = 'vat' then coalesce((it ->> 'vat')::bigint, 0) else 0 end);
    insert into inventory_movements (id, store_id, product_id, type, qty_delta, unit_cost, ref_type, ref_id, by_user,
      by_name, at, device_id)
    values (gen_random_uuid(), me.store_id, (it ->> 'productId')::uuid, 'sale', -(it ->> 'qty')::bigint,
      (it ->> 'unitCost')::bigint, 'sale', v_sale_id, me.user_id, s ->> 'cashierName',
      (s ->> 'createdAt')::timestamptz, v_device);
  end loop;

  if coalesce((select sum(net) from sale_items where sale_id = v_sale_id), -1) <> (s ->> 'total')::bigint then
    raise exception 'sale % items do not add up to the total', v_sale_id using errcode = '23514';
  end if;
  if v_mode = 'vat' and coalesce((select sum(vat) from sale_items where sale_id = v_sale_id), -1)
      <> (s ->> 'vatAmount')::bigint then
    raise exception 'sale % line VAT does not add up to the VAT', v_sale_id using errcode = '23514';
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

-- ---------------------------------------------------------------- Back Office
-- Tax totals by month (Manila business dates) and by category. Quarters and
-- the percentage tax are added up from the months in the app.
create or replace function office_tax_report(p_from date, p_to date, p_token text) returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me employees := require_office(p_token);
  v_from date := coalesce(p_from, (select min(business_date) from sales where store_id = me.store_id), p_to);
  v_to date := coalesce(p_to, (now() at time zone 'Asia/Manila')::date);
begin
  if v_from > v_to then
    raise exception 'the start date is after the end date' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'months', coalesce((select jsonb_agg(m order by m.month) from (
      select to_char(business_date, 'YYYY-MM') as month,
        count(*)::int as sales,
        sum(total)::bigint as gross,
        coalesce(sum(total) filter (where tax_mode = 'non_vat'), 0)::bigint as non_vat_sales,
        coalesce(sum(vatable_sales) filter (where tax_mode = 'vat'), 0)::bigint as vatable_sales,
        coalesce(sum(vat_amount) filter (where tax_mode = 'vat'), 0)::bigint as vat_amount,
        coalesce(sum(vat_exempt_sales) filter (where tax_mode = 'vat'), 0)::bigint as vat_exempt_sales
      from sales where store_id = me.store_id and business_date between v_from and v_to
      group by 1) m), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(c order by c.gross desc) from (
      select p.category_id, coalesce(cat.name, 'Unknown') as name,
        sum(i.net)::bigint as gross,
        coalesce(sum(i.net) filter (where s.tax_mode = 'vat' and i.tax_class = 'vatable'), 0)::bigint as vatable_gross,
        coalesce(sum(i.vat), 0)::bigint as vat,
        coalesce(sum(i.net) filter (where s.tax_mode = 'vat' and i.tax_class = 'exempt'), 0)::bigint as exempt_gross,
        coalesce(sum(i.net) filter (where s.tax_mode = 'non_vat'), 0)::bigint as non_vat_gross
      from sale_items i join sales s on s.id = i.sale_id
        left join products p on p.id = i.product_id left join categories cat on cat.id = p.category_id
      where s.store_id = me.store_id and s.business_date between v_from and v_to
      group by 1, 2) c), '[]'::jsonb));
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'store_tax_settings()', 'save_tax_settings(jsonb, text)', 'sync_sale(jsonb)', 'office_tax_report(date, date, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

select lock_down_anon();

update schema_info set value = '20261031000013' where key = 'schema_version';
