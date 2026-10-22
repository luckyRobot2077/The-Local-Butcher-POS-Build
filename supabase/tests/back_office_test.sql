-- Behavioural tests for the Phase 5 Back Office report and expenses (migration 9,
-- opened with a Back Office session since migration 10).
\set ON_ERROR_STOP on

insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'other-owner@example.test');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  perform bootstrap_owner('The Local Butcher', 'Josh');
  perform add_staff('cashier@example.test', 'Ana', 'cashier');
  perform register_device('20000000-0000-0000-0000-000000000001', 'AB12', 'Counter');
  perform sync_category('30000000-0000-0000-0000-000000000001', 'Pork', 0);
  perform sync_category('30000000-0000-0000-0000-000000000002', 'Condiments', 1);
  perform sync_product('{"id":"40000000-0000-0000-0000-000000000001","name":"Liempo","description":"","categoryId":"30000000-0000-0000-0000-000000000001","saleUnit":"kg","price":36000,"cost":29500,"minStockQty":2000,"active":true}'::jsonb, null, null);
  perform sync_product('{"id":"40000000-0000-0000-0000-000000000002","name":"Vinegar","description":"","categoryId":"30000000-0000-0000-0000-000000000002","saleUnit":"piece","price":5000,"cost":3000,"minStockQty":0,"active":true}'::jsonb, null, null);
end $$;

\set member '{"id":"80000000-0000-0000-0000-000000000001","memberNo":"M-AB12-0001","name":"Maria Santos","birthYear":1988,"gender":"female","contactNumber":"+639171234567","privacyConsentAt":"2026-10-22T01:00:00Z","marketingConsent":true,"marketingConsentAt":"2026-10-22T01:00:00Z","active":true,"notes":"","registeredAt":"2026-10-22T01:00:00Z","registeredBy":"Ana","deviceId":"20000000-0000-0000-0000-000000000001"}'
select set_config('test.member', :'member', false) \gset

-- Sale 1 (member, cash, 10% manual off 1 kg Liempo) on 22 Oct at 10:00 Manila.
\set sale1 '{"sale":{"id":"70000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000001","cashierName":"Ana","createdAt":"2026-10-22T02:00:00Z","businessDate":"2026-10-22","subtotal":36000,"itemDiscountTotal":0,"orderDiscount":3600,"discountTotal":3600,"total":32400,"costTotal":29500,"paymentMethod":"cash","tendered":32400,"change":0,"discountApprovedBy":"Josh","customerId":"80000000-0000-0000-0000-000000000001"},"items":[{"id":"71000000-0000-0000-0000-000000000001","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":36000,"unitCost":29500,"qty":1000,"gross":36000,"itemDiscount":0,"orderDiscountShare":3600,"net":32400}],"payment":{"id":"72000000-0000-0000-0000-000000000001","method":"cash","amount":32400,"tendered":32400,"change":0,"reference":null},"discounts":[{"saleItemId":null,"kind":"percent","value":1000,"amount":3600,"reason":"Suki","source":"manual"}]}'
-- Sale 2 (walk-in, GCash, 500 g Liempo + 2 Vinegar) on 23 Oct at 15:00 Manila.
\set sale2 '{"sale":{"id":"70000000-0000-0000-0000-000000000002","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000002","cashierName":"Ana","createdAt":"2026-10-23T07:00:00Z","businessDate":"2026-10-23","subtotal":28000,"itemDiscountTotal":0,"orderDiscount":0,"discountTotal":0,"total":28000,"costTotal":20750,"paymentMethod":"gcash","tendered":28000,"change":0,"discountApprovedBy":null},"items":[{"id":"71000000-0000-0000-0000-000000000002","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":36000,"unitCost":29500,"qty":500,"gross":18000,"itemDiscount":0,"orderDiscountShare":0,"net":18000},{"id":"71000000-0000-0000-0000-000000000003","lineNo":2,"productId":"40000000-0000-0000-0000-000000000002","productName":"Vinegar","saleUnit":"piece","unitPrice":5000,"unitCost":3000,"qty":2,"gross":10000,"itemDiscount":0,"orderDiscountShare":0,"net":10000}],"payment":{"id":"72000000-0000-0000-0000-000000000002","method":"gcash","amount":28000,"tendered":28000,"change":0,"reference":"123"},"discounts":[]}'
select set_config('test.sale1', :'sale1', false), set_config('test.sale2', :'sale2', false) \gset

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform sync_customer(current_setting('test.member')::jsonb);
  perform sync_sale(current_setting('test.sale1')::jsonb);
  perform sync_sale(current_setting('test.sale2')::jsonb);
end $$;

-- The owner's employee ID with an open Back Office session (badge + code are tested in staff_test).
reset role;
insert into employees (id, store_id, employee_no, name, role, badge_hash)
select '50000000-0000-0000-0000-000000000001', store_id, 'E-0001', 'Josh', 'owner',
  encode(extensions.digest('badge-josh', 'sha256'), 'hex') from staff_profiles where display_name = 'Josh';
insert into office_sessions (token_hash, store_id, employee_id, expires_at)
select encode(extensions.digest('tok-josh', 'sha256'), 'hex'), store_id, id, now() + interval '1 hour'
from employees where employee_no = 'E-0001';
set role authenticated;

-- Without an open Back Office session nobody sees the reports or records expenses.
do $$ begin
  perform office_report('2026-10-01', '2026-10-31', 'wrong-token');
  raise exception 'FAIL: cashier read the report';
exception when insufficient_privilege then raise notice 'ok: reports are for managers and owners';
end $$;
do $$ begin
  perform record_expense('{"category":"rent","amount":100000,"spentOn":"2026-10-22"}', null);
  raise exception 'FAIL: cashier recorded an expense';
exception when insufficient_privilege then raise notice 'ok: expenses are for managers and owners';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare id uuid; begin
  id := record_expense('{"id":"60000000-0000-0000-0000-000000000001","category":"wages","amount":50000,"spentOn":"2026-10-22","note":"Helper"}', 'tok-josh');
  id := record_expense('{"id":"60000000-0000-0000-0000-000000000001","category":"wages","amount":60000,"spentOn":"2026-10-22","note":"Helper"}', 'tok-josh');
  if (select count(*) || ' ' || sum(amount) from expenses) <> '1 60000' then
    raise exception 'FAIL: expense retry/update';
  end if;
  perform record_expense('{"category":"utilities","amount":2000,"spentOn":"2026-10-23"}', 'tok-josh');
  if (select count(*) from audit_logs where action = 'expense_saved') <> 3 then raise exception 'FAIL: expense audit'; end if;
  raise notice 'ok: expenses saved, updated by id and audited';
end $$;
do $$ begin
  perform record_expense('{"category":"rent","amount":0,"spentOn":"2026-10-22"}', 'tok-josh');
  raise exception 'FAIL: zero expense accepted';
exception when invalid_parameter_value then raise notice 'ok: expense amount checked';
end $$;
do $$ begin
  perform record_expense('{"category":"snacks","amount":100,"spentOn":"2026-10-22"}', 'tok-josh');
  raise exception 'FAIL: unknown category accepted';
exception when invalid_parameter_value then raise notice 'ok: expense category checked';
end $$;

do $$ declare r jsonb; t jsonb; begin
  r := office_report('2026-10-22', '2026-10-23', 'tok-josh');
  t := r -> 'totals';
  if (t ->> 'revenue')::bigint <> 60400 or (t ->> 'transactions')::int <> 2 or (t ->> 'cogs')::bigint <> 50250
     or (t ->> 'grossProfit')::bigint <> 10150 or (t ->> 'discounts')::bigint <> 3600
     or (t ->> 'expenses')::bigint <> 62000 or (t ->> 'netProfit')::bigint <> -51850 or (t ->> 'average')::bigint <> 30200 then
    raise exception 'FAIL: totals %', t;
  end if;
  if jsonb_array_length(r -> 'daily') <> 2 or (r -> 'daily' -> 1 ->> 'revenue')::bigint <> 28000
     or (r -> 'daily' -> 0 ->> 'expenses')::bigint <> 60000 then
    raise exception 'FAIL: daily %', r -> 'daily';
  end if;
  if r -> 'byCategory' -> 0 ->> 'name' <> 'Pork' or (r -> 'byCategory' -> 0 ->> 'revenue')::bigint <> 50400
     or (r -> 'byCategory' -> 0 ->> 'cost')::bigint <> 44250 or (r -> 'byCategory' -> 1 ->> 'cost')::bigint <> 6000 then
    raise exception 'FAIL: by category %', r -> 'byCategory';
  end if;
  if (r -> 'products' -> 0 ->> 'qty')::bigint <> 1500 or r -> 'products' -> 0 ->> 'name' <> 'Liempo' then
    raise exception 'FAIL: products %', r -> 'products';
  end if;
  if (select count(*) from jsonb_array_elements(r -> 'byPayment')) <> 2 then raise exception 'FAIL: payments'; end if;
  if (r -> 'byHour' -> 10 ->> 'transactions')::int <> 1 or (r -> 'byHour' -> 15 ->> 'revenue')::bigint <> 28000 then
    raise exception 'FAIL: hours use Manila time %', r -> 'byHour';
  end if;
  if r -> 'discounts' -> 0 ->> 'name' <> 'Suki' or (r -> 'discounts' -> 0 ->> 'amount')::bigint <> 3600 then
    raise exception 'FAIL: discounts %', r -> 'discounts';
  end if;
  if (r -> 'members' ->> 'memberRevenue')::bigint <> 32400 or (r -> 'members' ->> 'active')::int <> 1
     or (r -> 'members' ->> 'total')::int <> 1 or r -> 'members' -> 'top' -> 0 ->> 'memberNo' <> 'M-AB12-0001' then
    raise exception 'FAIL: members %', r -> 'members';
  end if;
  -- 1500 g sold from zero stock: Liempo is below its 2 kg minimum.
  if r -> 'inventory' -> 'lowStock' -> 0 ->> 'name' <> 'Liempo' then
    raise exception 'FAIL: low stock %', r -> 'inventory';
  end if;
  if jsonb_array_length(r -> 'expenses' -> 'list') <> 2 then raise exception 'FAIL: expense list'; end if;
  if jsonb_array_length(r -> 'recent') <> 2 then raise exception 'FAIL: recent'; end if;
  raise notice 'ok: report totals, trends, categories, hours, discounts, members, stock';

  r := office_report(null, '2026-10-23', 'tok-josh');
  if r ->> 'from' <> '2026-10-22' then raise exception 'FAIL: all history starts at the first sale'; end if;
  r := office_report('2026-10-23', '2026-10-23', 'tok-josh');
  if (r -> 'totals' ->> 'revenue')::bigint <> 28000 then raise exception 'FAIL: range filter'; end if;
  raise notice 'ok: date range and all history';

  if (select count(*) from office_sales_lines('2026-10-01', '2026-10-31', 'tok-josh')) <> 3 then raise exception 'FAIL: csv lines'; end if;
  if (select sum(cost) from office_sales_lines('2026-10-01', '2026-10-31', 'tok-josh')) <> 50250 then raise exception 'FAIL: csv cost'; end if;
  raise notice 'ok: sale lines for CSV';

  if not delete_expense('60000000-0000-0000-0000-000000000001', 'tok-josh') then raise exception 'FAIL: delete'; end if;
  if delete_expense('60000000-0000-0000-0000-000000000001', 'tok-josh') then raise exception 'FAIL: delete twice'; end if;
  raise notice 'ok: expenses can be deleted';
end $$;

-- Another store's owner sees nothing of this shop.
reset role;
with st as (insert into stores (name) values ('Other Shop') returning id)
insert into staff_profiles (user_id, store_id, display_name, role)
select '00000000-0000-0000-0000-0000000000d1', id, 'Zed', 'owner' from st;
insert into employees (id, store_id, employee_no, name, role, badge_hash)
select '50000000-0000-0000-0000-0000000000d1', store_id, 'E-0001', 'Zed', 'owner',
  encode(extensions.digest('badge-zed', 'sha256'), 'hex') from staff_profiles where display_name = 'Zed';
insert into office_sessions (token_hash, store_id, employee_id, expires_at)
select encode(extensions.digest('tok-zed', 'sha256'), 'hex'), store_id, id, now() + interval '1 hour'
from employees where name = 'Zed';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
do $$ begin
  perform office_report('2026-10-01', '2026-10-31', 'tok-josh');
  raise exception 'FAIL: another store used this shop''s session';
exception when insufficient_privilege then raise notice 'ok: a session only works for its own store';
end $$;
do $$ declare r jsonb; begin
  r := office_report('2026-10-01', '2026-10-31', 'tok-zed');
  if (r -> 'totals' ->> 'revenue')::bigint <> 0 or (r -> 'members' ->> 'total')::int <> 0 then
    raise exception 'FAIL: other store sees data';
  end if;
  if delete_expense('60000000-0000-0000-0000-000000000001', 'tok-zed') then raise exception 'FAIL: other store deleted expense'; end if;
  raise notice 'ok: reports and expenses stay within the store';
end $$;

-- Running the migration again is harmless.
reset role;
\ir ../migrations/20261027000009_back_office.sql
\ir ../migrations/20261027000009_back_office.sql
do $$ begin raise notice 'ok: migration 9 can be re-run'; end $$;
