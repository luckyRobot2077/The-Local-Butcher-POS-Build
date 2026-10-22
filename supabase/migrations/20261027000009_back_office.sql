-- Phase 5: Back Office reports and expenses.
-- Safe to run more than once: every statement replaces or re-grants.
-- Functions that may hash or generate ids use `public, extensions` because
-- Supabase keeps pgcrypto in the extensions schema.

-- ---------------------------------------------------------------- report
-- One call returns everything the Back Office dashboard shows for a date
-- range (business dates, Asia/Manila). p_from null means "from the first sale".
-- Line cost: kg lines store unit_cost per kg and qty in grams.
create or replace function office_report(p_from date, p_to date) returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_manager();
  v_from date := coalesce(p_from, (select min(business_date) from sales where store_id = me.store_id), p_to);
  v_to date := coalesce(p_to, (now() at time zone 'Asia/Manila')::date);
  v_days integer;
  v_out jsonb;
begin
  if v_from > v_to then
    raise exception 'the start date is after the end date' using errcode = '22023';
  end if;
  v_days := v_to - v_from + 1;
  if v_days > 3700 then
    v_from := v_to - 3699;
    v_days := 3700;
  end if;

  with
  s as (
    select * from sales where store_id = me.store_id and business_date between v_from and v_to
  ),
  li as (
    select i.*, s.business_date, s.customer_id, p.category_id,
      case when i.sale_unit = 'kg' then round(i.unit_cost * i.qty / 1000.0)::bigint else i.unit_cost * i.qty end as line_cost
    from sale_items i join s on s.id = i.sale_id left join products p on p.id = i.product_id
  ),
  e as (
    select * from expenses where store_id = me.store_id and spent_on between v_from and v_to
  ),
  stock as (
    select p.id, p.name, p.sale_unit, p.cost, p.min_stock_qty, c.name as category, coalesce(st.stock_qty, 0) as qty
    from products p
    join categories c on c.id = p.category_id
    left join store_stock() st on st.product_id = p.id
    where p.store_id = me.store_id and p.active
  ),
  mv as (
    select m.*, p.sale_unit from inventory_movements m join products p on p.id = m.product_id
    where m.store_id = me.store_id and (m.at at time zone 'Asia/Manila')::date between v_from and v_to
  ),
  member_sales as (
    select customer_id, count(*) as n, sum(total) as spent from s where customer_id is not null group by customer_id
  ),
  totals as (
    select count(*) as transactions, coalesce(sum(total), 0) as revenue, coalesce(sum(subtotal), 0) as gross_sales,
      coalesce(sum(discount_total), 0) as discounts, coalesce(sum(cost_total), 0) as cogs
    from s
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'days', v_days,
    'totals', (
      select jsonb_build_object(
        'revenue', t.revenue, 'grossSales', t.gross_sales, 'transactions', t.transactions,
        'average', case when t.transactions > 0 then round(t.revenue::numeric / t.transactions)::bigint else 0 end,
        'discounts', t.discounts, 'cogs', t.cogs, 'grossProfit', t.revenue - t.cogs,
        'expenses', (select coalesce(sum(amount), 0) from e),
        'netProfit', t.revenue - t.cogs - (select coalesce(sum(amount), 0) from e),
        'refunds', (select coalesce(sum(r.amount), 0) from refunds r join s on s.id = r.sale_id)
      ) from totals t
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', d.day::date, 'revenue', coalesce(x.revenue, 0), 'cogs', coalesce(x.cogs, 0),
        'transactions', coalesce(x.n, 0), 'discounts', coalesce(x.discounts, 0),
        'expenses', coalesce(y.amount, 0)) order by d.day), '[]'::jsonb)
      from generate_series(v_from, v_to, interval '1 day') d(day)
      left join (select business_date, sum(total) as revenue, sum(cost_total) as cogs, count(*) as n,
          sum(discount_total) as discounts from s group by business_date) x on x.business_date = d.day::date
      left join (select spent_on, sum(amount) as amount from e group by spent_on) y on y.spent_on = d.day::date
    ),
    'byCategory', (
      select coalesce(jsonb_agg(jsonb_build_object('name', name, 'revenue', revenue, 'cost', cost) order by revenue desc), '[]'::jsonb)
      from (select coalesce(c.name, 'Other') as name, sum(li.net) as revenue, sum(li.line_cost) as cost
        from li left join categories c on c.id = li.category_id group by 1) q
    ),
    'products', (
      select coalesce(jsonb_agg(jsonb_build_object('id', product_id, 'name', name, 'unit', sale_unit, 'qty', qty,
        'revenue', revenue, 'cost', cost, 'lines', lines) order by revenue desc), '[]'::jsonb)
      from (select li.product_id, max(li.product_name) as name, max(li.sale_unit::text) as sale_unit, sum(li.qty) as qty,
          sum(li.net) as revenue, sum(li.line_cost) as cost, count(*) as lines
        from li group by li.product_id) q
    ),
    'byPayment', (
      select coalesce(jsonb_agg(jsonb_build_object('method', payment_method, 'revenue', revenue, 'transactions', n)
        order by revenue desc), '[]'::jsonb)
      from (select payment_method, sum(total) as revenue, count(*) as n from s group by payment_method) q
    ),
    'byCashier', (
      select coalesce(jsonb_agg(jsonb_build_object('name', cashier_name, 'revenue', revenue, 'transactions', n,
        'discounts', discounts) order by revenue desc), '[]'::jsonb)
      from (select cashier_name, sum(total) as revenue, count(*) as n, sum(discount_total) as discounts
        from s group by cashier_name) q
    ),
    'byHour', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'revenue', coalesce(revenue, 0), 'transactions', coalesce(n, 0))
        order by h), '[]'::jsonb)
      from generate_series(0, 23) h
      left join (select extract(hour from created_at at time zone 'Asia/Manila')::int as hr, sum(total) as revenue,
          count(*) as n from s group by 1) q on q.hr = h
    ),
    'byWeekday', (
      select coalesce(jsonb_agg(jsonb_build_object('weekday', w, 'revenue', coalesce(revenue, 0),
        'transactions', coalesce(n, 0)) order by w), '[]'::jsonb)
      from generate_series(0, 6) w
      left join (select extract(dow from business_date)::int as dw, sum(total) as revenue, count(*) as n
        from s group by 1) q on q.dw = w
    ),
    'discounts', (
      select coalesce(jsonb_agg(jsonb_build_object('source', source, 'name', name, 'amount', amount, 'uses', uses)
        order by amount desc), '[]'::jsonb)
      from (select d.source, coalesce(pr.name, nullif(d.reason, ''), case when d.source = 'manual' then 'Manual discount'
            else 'Discount program' end) as name, sum(d.amount) as amount, count(distinct d.sale_id) as uses
        from sale_discounts d join s on s.id = d.sale_id left join promotions pr on pr.id = d.promotion_id
        group by 1, 2) q
    ),
    'expenses', (
      select jsonb_build_object(
        'byCategory', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'amount', amount)
            order by amount desc), '[]'::jsonb)
          from (select category, sum(amount) as amount from e group by category) q),
        'list', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'category', category, 'amount', amount,
            'spentOn', spent_on, 'note', note) order by spent_on desc, created_at desc), '[]'::jsonb)
          from (select * from e order by spent_on desc, created_at desc limit 500) q)
      )
    ),
    'members', (
      select jsonb_build_object(
        'total', (select count(*) from customers where store_id = me.store_id and active),
        'newInRange', (select count(*) from customers where store_id = me.store_id
          and (registered_at at time zone 'Asia/Manila')::date between v_from and v_to),
        'active', (select count(*) from member_sales),
        'repeat', (select count(*) from member_sales where n >= 2),
        'memberRevenue', (select coalesce(sum(total), 0) from s where customer_id is not null),
        'memberTransactions', (select count(*) from s where customer_id is not null),
        'promoOptIns', (select count(*) from customers where store_id = me.store_id and active and marketing_consent),
        'top', (select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'memberNo', c.member_no, 'visits', m.n,
            'spent', m.spent) order by m.spent desc), '[]'::jsonb)
          from (select * from member_sales order by spent desc limit 10) m join customers c on c.id = m.customer_id),
        'byGender', (select coalesce(jsonb_agg(jsonb_build_object('gender', g, 'members', n)), '[]'::jsonb)
          from (select coalesce(gender, 'undisclosed') as g, count(*) as n from customers
            where store_id = me.store_id and active group by 1) q),
        'byAge', (select coalesce(jsonb_agg(jsonb_build_object('band', band, 'members', n) order by band), '[]'::jsonb)
          from (select case when birth_year is null then 'Unknown'
                when extract(year from now()) - birth_year < 25 then 'Under 25'
                when extract(year from now()) - birth_year < 35 then '25-34'
                when extract(year from now()) - birth_year < 45 then '35-44'
                when extract(year from now()) - birth_year < 55 then '45-54'
                else '55+' end as band, count(*) as n
            from customers where store_id = me.store_id and active group by 1) q)
      )
    ),
    'inventory', (
      select jsonb_build_object(
        'stockValue', (select coalesce(sum(case when sale_unit = 'kg' then round(greatest(qty, 0) * cost / 1000.0)
            else greatest(qty, 0) * cost end), 0)::bigint from stock),
        'lowStock', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', sale_unit, 'qty', qty,
            'min', min_stock_qty, 'category', category) order by qty::numeric / greatest(min_stock_qty, 1)), '[]'::jsonb)
          from stock where min_stock_qty > 0 and qty <= min_stock_qty),
        'purchases', (select coalesce(sum(total_cost), 0) from purchases where store_id = me.store_id
          and (received_at at time zone 'Asia/Manila')::date between v_from and v_to),
        'losses', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'value', value, 'entries', n)
            order by value desc), '[]'::jsonb)
          from (select type, sum(case when sale_unit = 'kg' then round(-qty_delta * unit_cost / 1000.0)
              else -qty_delta * unit_cost end)::bigint as value, count(*) as n
            from mv where type in ('damage', 'spoilage', 'trim_loss') group by type) q)
      )
    ),
    'recent', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'receiptNo', receipt_no, 'at', created_at, 'total', total,
        'cashier', cashier_name, 'method', payment_method, 'member', customer_id is not null) order by created_at desc), '[]'::jsonb)
      from (select * from s order by created_at desc limit 15) q
    )
  ) into v_out;
  return v_out;
end $$;

-- Every sale line in a range, for the CSV export. (Migration 10 replaces it with
-- discount names; dropping first lets either file be re-run.)
drop function if exists office_sales_lines(date, date);
create function office_sales_lines(p_from date, p_to date) returns table (
  business_date date, created_at timestamptz, receipt_no text, cashier text, payment_method text, member_no text,
  product text, category text, unit text, qty bigint, unit_price bigint, gross bigint, discount bigint, net bigint,
  cost bigint
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me staff_profiles := require_manager();
begin
  return query
  select s.business_date, s.created_at, s.receipt_no, s.cashier_name, s.payment_method::text, c.member_no,
    i.product_name, coalesce(cat.name, 'Other'), i.sale_unit::text, i.qty, i.unit_price, i.gross,
    i.item_discount + i.order_discount_share, i.net,
    case when i.sale_unit = 'kg' then round(i.unit_cost * i.qty / 1000.0)::bigint else i.unit_cost * i.qty end
  from sales s
  join sale_items i on i.sale_id = s.id
  left join customers c on c.id = s.customer_id
  left join products p on p.id = i.product_id
  left join categories cat on cat.id = p.category_id
  where s.store_id = me.store_id and s.business_date between p_from and p_to
  order by s.created_at, i.line_no
  limit 50000;
end $$;

-- ---------------------------------------------------------------- expenses
-- Owners and managers record shop expenses (wages, rent, utilities...).
-- Passing an existing id updates it; a retry with the same id is harmless.
create or replace function record_expense(p jsonb) returns uuid
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_manager();
  v_id uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  v_amount bigint := (p ->> 'amount')::bigint;
  v_category text := p ->> 'category';
  v_on date := (p ->> 'spentOn')::date;
  v_note text := nullif(trim(coalesce(p ->> 'note', '')), '');
begin
  if v_amount is null or v_amount <= 0 or v_amount > 100000000000 then
    raise exception 'enter an amount above zero' using errcode = '22023';
  end if;
  if v_category not in ('utilities', 'rent', 'wages', 'packaging', 'transportation', 'repairs', 'other') then
    raise exception 'unknown expense category' using errcode = '22023';
  end if;
  if v_on is null or v_on > (now() at time zone 'Asia/Manila')::date + 1 then
    raise exception 'pick the date the money was spent' using errcode = '22023';
  end if;
  if length(v_note) > 200 then
    raise exception 'keep the note under 200 characters' using errcode = '22023';
  end if;
  if exists (select 1 from expenses where id = v_id and store_id <> me.store_id) then
    raise exception 'expense not found' using errcode = '42501';
  end if;

  insert into expenses (id, store_id, category, amount, spent_on, note, created_by)
  values (v_id, me.store_id, v_category, v_amount, v_on, v_note, me.user_id)
  on conflict (id) do update set category = excluded.category, amount = excluded.amount,
    spent_on = excluded.spent_on, note = excluded.note;

  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
  values (me.store_id, 'expense_saved', 'expense', v_id, me.user_id, me.display_name,
    jsonb_build_object('category', v_category, 'amount', v_amount, 'spentOn', v_on));
  return v_id;
end $$;

create or replace function delete_expense(p_id uuid) returns boolean
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_manager();
  v_old expenses;
begin
  delete from expenses where id = p_id and store_id = me.store_id returning * into v_old;
  if not found then
    return false;
  end if;
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
  values (me.store_id, 'expense_deleted', 'expense', p_id, me.user_id, me.display_name,
    jsonb_build_object('category', v_old.category, 'amount', v_old.amount, 'spentOn', v_old.spent_on));
  return true;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'office_report(date, date)', 'office_sales_lines(date, date)', 'record_expense(jsonb)', 'delete_expense(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

update schema_info set value = '20261027000009' where key = 'schema_version';
