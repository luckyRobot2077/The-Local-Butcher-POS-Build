-- Cashier shifts and drawer openings: when a shift opened and closed, with the
-- starting cash and the cash count; when each sale started and was paid; and
-- each time the drawer was opened without a sale ("no sale").
-- Safe to run more than once: every statement replaces, re-creates or re-grants.

-- ---------------------------------------------------------------- tables
-- cashier_shifts and sales.shift_id exist since migration 1; the devices now
-- fill them. Names are kept as typed at the counter (badge sign-in or name).
alter table cashier_shifts add column if not exists opened_by_name text;
alter table cashier_shifts add column if not exists opened_by_employee uuid;
alter table cashier_shifts add column if not exists closed_by_name text;
alter table cashier_shifts add column if not exists cash_sales bigint;
alter table cashier_shifts add column if not exists gcash_sales bigint;
alter table cashier_shifts add column if not exists sale_count integer;
alter table cashier_shifts add column if not exists note text;
alter table cashier_shifts add column if not exists received_at timestamptz not null default now();
alter table cashier_shifts add column if not exists updated_at timestamptz not null default now();
create index if not exists cashier_shifts_store_opened on cashier_shifts (store_id, opened_at);
revoke all on cashier_shifts from anon, authenticated;

create table if not exists drawer_events (
  id uuid primary key,
  store_id uuid not null references stores (id),
  device_id uuid not null references devices (id),
  shift_id uuid not null references cashier_shifts (id),
  kind text not null check (kind in ('no_sale')),
  at timestamptz not null,
  by_name text not null,
  approved_by text,
  reason text not null check (length(reason) between 1 and 120),
  received_at timestamptz not null default now()
);
create index if not exists drawer_events_shift on drawer_events (shift_id);
alter table drawer_events enable row level security;
revoke all on drawer_events from anon, authenticated;

alter table sales add column if not exists started_at timestamptz;
create index if not exists sales_shift on sales (shift_id);

-- ---------------------------------------------------------------- sync from devices
-- Sent when a shift opens and again when it closes. The opening details never
-- change; the closing details are written once.
create or replace function sync_shift(p jsonb) returns text
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_staff();
  v_id uuid := (p ->> 'id')::uuid;
  v_device uuid := (p ->> 'deviceId')::uuid;
  existing cashier_shifts;
begin
  if not exists (select 1 from devices d where d.id = v_device and d.store_id = me.store_id and d.revoked_at is null) then
    raise exception 'device not registered for this store' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_id::text));
  select * into existing from cashier_shifts where id = v_id;
  if found and existing.store_id <> me.store_id then
    raise exception 'shift belongs to another store' using errcode = '42501';
  end if;
  if not found then
    if length(coalesce(p ->> 'openedBy', '')) not between 1 and 80 then
      raise exception 'shift has no cashier name' using errcode = '23514';
    end if;
    insert into cashier_shifts (id, store_id, device_id, opened_by, opened_by_name, opened_by_employee, opened_at,
      opening_float)
    values (v_id, me.store_id, v_device, me.user_id, p ->> 'openedBy', nullif(p ->> 'openedByEmployeeId', '')::uuid,
      (p ->> 'openedAt')::timestamptz, (p ->> 'openingFloat')::bigint);
  end if;
  if nullif(p ->> 'closedAt', '') is not null and (existing.closed_at is null) then
    update cashier_shifts set
      closed_at = (p ->> 'closedAt')::timestamptz,
      closed_by = me.user_id,
      closed_by_name = p ->> 'closedBy',
      counted_cash = (p ->> 'countedCash')::bigint,
      expected_cash = (p ->> 'expectedCash')::bigint,
      cash_sales = (p ->> 'cashSales')::bigint,
      gcash_sales = (p ->> 'gcashSales')::bigint,
      sale_count = (p ->> 'saleCount')::integer,
      note = left(nullif(p ->> 'note', ''), 200),
      updated_at = now()
    where id = v_id;
    return case when existing.id is null then 'inserted' else 'closed' end;
  end if;
  return case when existing.id is null then 'inserted' else 'unchanged' end;
end $$;

create or replace function sync_drawer_event(p jsonb) returns text
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_staff();
  v_shift uuid := (p ->> 'shiftId')::uuid;
begin
  if not exists (select 1 from cashier_shifts s where s.id = v_shift and s.store_id = me.store_id) then
    raise exception 'the shift of this drawer opening is not in the cloud yet' using errcode = '23503';
  end if;
  insert into drawer_events (id, store_id, device_id, shift_id, kind, at, by_name, approved_by, reason)
  select (p ->> 'id')::uuid, me.store_id, s.device_id, v_shift, p ->> 'kind', (p ->> 'at')::timestamptz,
    p ->> 'by', nullif(p ->> 'approvedBy', ''), p ->> 'reason'
  from cashier_shifts s where s.id = v_shift
  on conflict (id) do nothing;
  return case when found then 'inserted' else 'duplicate' end;
end $$;

-- Same as migration 6 (search path from migration 8), plus when the sale
-- started and which shift it belongs to.
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
    tendered, change, discount_approved_by, started_at, shift_id)
  values (v_sale_id, me.store_id, v_device, s ->> 'receiptNo', me.user_id, s ->> 'cashierName', v_customer,
    (s ->> 'createdAt')::timestamptz, (s ->> 'businessDate')::date, (s ->> 'subtotal')::bigint,
    (s ->> 'itemDiscountTotal')::bigint, (s ->> 'orderDiscount')::bigint, (s ->> 'discountTotal')::bigint,
    (s ->> 'total')::bigint, (s ->> 'costTotal')::bigint, (s ->> 'paymentMethod')::payment_method,
    (s ->> 'tendered')::bigint, (s ->> 'change')::bigint, s ->> 'discountApprovedBy',
    nullif(s ->> 'startedAt', '')::timestamptz,
    -- Linked only if the shift reached the cloud, so a sale is never held up by its shift.
    (select id from cashier_shifts where id = nullif(s ->> 'shiftId', '')::uuid and store_id = me.store_id));

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

-- ---------------------------------------------------------------- Back Office
-- Shifts opened between two dates (Manila), each with its sales and drawer
-- openings in time order. Open shifts show the sales synced so far.
create or replace function office_shifts(p_from date, p_to date, p_token text) returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare me employees := require_office(p_token);
begin
  return jsonb_build_object('shifts', coalesce((
    select jsonb_agg(row_to_json(x) order by x.opened_at desc) from (
      select sh.id, d.device_code, d.label as device_label, sh.opened_at, sh.opened_by_name as opened_by,
        sh.opening_float, sh.closed_at, sh.closed_by_name as closed_by, sh.counted_cash, sh.expected_cash, sh.note,
        coalesce(sh.cash_sales, (select coalesce(sum(s.total), 0) from sales s
          where s.shift_id = sh.id and s.payment_method = 'cash'))::bigint as cash_sales,
        coalesce(sh.gcash_sales, (select coalesce(sum(s.total), 0) from sales s
          where s.shift_id = sh.id and s.payment_method = 'gcash'))::bigint as gcash_sales,
        coalesce(sh.sale_count, (select count(*) from sales s where s.shift_id = sh.id))::integer as sale_count,
        coalesce((select jsonb_agg(jsonb_build_object('receipt_no', s.receipt_no, 'cashier', s.cashier_name,
            'started_at', s.started_at, 'paid_at', s.created_at, 'total', s.total, 'method', s.payment_method)
            order by s.created_at)
          from sales s where s.shift_id = sh.id and s.store_id = me.store_id), '[]'::jsonb) as sales,
        coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'at', e.at, 'by', e.by_name,
            'approved_by', e.approved_by, 'reason', e.reason) order by e.at)
          from drawer_events e where e.shift_id = sh.id), '[]'::jsonb) as events
      from cashier_shifts sh
      join devices d on d.id = sh.device_id
      where sh.store_id = me.store_id
        and (sh.opened_at at time zone 'Asia/Manila')::date between coalesce(p_from, '-infinity'::date) and p_to
      order by sh.opened_at desc
      limit 500
    ) x), '[]'::jsonb));
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'sync_shift(jsonb)', 'sync_drawer_event(jsonb)', 'sync_sale(jsonb)', 'office_shifts(date, date, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

update schema_info set value = '20261029000011' where key = 'schema_version';
