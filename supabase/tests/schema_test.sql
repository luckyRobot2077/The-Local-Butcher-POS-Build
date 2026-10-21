-- Behavioural tests for the migrations. Run by scripts/test-migrations.sh.
\set ON_ERROR_STOP on

insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'cashier@example.test');
insert into stores (id, name) values ('10000000-0000-0000-0000-000000000001', 'The Local Butcher');
insert into staff_profiles (user_id, store_id, display_name, role) values
  ('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'Owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001', 'Ana', 'cashier');
insert into devices (id, store_id, device_code) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'AB12');
insert into categories (id, store_id, name) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Pork');
insert into products (id, store_id, category_id, name, sale_unit, price, cost, created_at, updated_at) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
   'Liempo', 'kg', 35000, 29500, now(), now());

-- CHECK constraints reject impossible stock movements.
do $$ begin
  insert into inventory_movements (id, store_id, product_id, type, qty_delta, unit_cost, by_name, at)
  values (gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'spoilage', 500, 0, 'x', now());
  raise exception 'FAIL: positive spoilage accepted';
exception when check_violation then raise notice 'ok: positive spoilage rejected';
end $$;

-- Cashier session.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';

\set payload '{"sale":{"id":"50000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000001","cashierName":"Ana","createdAt":"2026-10-21T02:00:00Z","businessDate":"2026-10-21","subtotal":43750,"itemDiscountTotal":0,"orderDiscount":0,"discountTotal":0,"total":43750,"costTotal":36875,"paymentMethod":"cash","tendered":50000,"change":6250},"items":[{"id":"60000000-0000-0000-0000-000000000001","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":35000,"unitCost":29500,"qty":1250,"gross":43750,"itemDiscount":0,"orderDiscountShare":0,"net":43750}],"payment":{"id":"70000000-0000-0000-0000-000000000001","method":"cash","amount":43750,"tendered":50000,"change":6250}}'

-- psql variables are not expanded inside $$ blocks, so pass it as a setting.
select set_config('test.payload', :'payload', false) \gset

do $$ declare r text; begin
  r := sync_sale(current_setting('test.payload')::jsonb);
  if r <> 'inserted' then raise exception 'FAIL: first sync returned %', r; end if;
  r := sync_sale(current_setting('test.payload')::jsonb);
  if r <> 'duplicate' then raise exception 'FAIL: retry returned %', r; end if;
  raise notice 'ok: sync_sale is idempotent';
end $$;

do $$ begin
  perform sync_sale(jsonb_set(current_setting('test.payload')::jsonb, '{sale,cashierName}', '"Mallory"'));
  raise exception 'FAIL: conflicting payload accepted';
exception when unique_violation then raise notice 'ok: conflicting payload for same sale id rejected';
end $$;

do $$ begin
  -- total that does not match the items
  perform sync_sale(jsonb_set(jsonb_set(jsonb_set(jsonb_set(current_setting('test.payload')::jsonb,
    '{sale,id}', '"50000000-0000-0000-0000-000000000002"'), '{sale,receiptNo}', '"AB12-000002"'),
    '{items,0,id}', '"60000000-0000-0000-0000-000000000002"'), '{payment,id}', '"70000000-0000-0000-0000-000000000002"')
    || jsonb_build_object('items', jsonb_build_array(jsonb_set(current_setting('test.payload')::jsonb -> 'items' -> 0, '{net}', '40000'))));
  raise exception 'FAIL: unbalanced sale accepted';
exception when check_violation then raise notice 'ok: unbalanced sale rejected atomically';
end $$;

do $$ begin
  if (select count(*) from sales) <> 1 then raise exception 'FAIL: expected exactly one sale'; end if;
  if (select count(*) from payments) <> 1 then raise exception 'FAIL: expected one payment'; end if;
  raise notice 'ok: exactly one sale stored';
end $$;

-- Cashier cannot read the stock ledger or audit log, or write products.
do $$ begin
  if (select count(*) from inventory_movements) <> 0 then raise exception 'FAIL: cashier can read ledger'; end if;
  if (select count(*) from audit_logs) <> 0 then raise exception 'FAIL: cashier can read audit'; end if;
  raise notice 'ok: cashier cannot read ledger or audit log';
end $$;
do $$ begin
  update products set price = 1 where id = '40000000-0000-0000-0000-000000000001';
  if (select price from products where id = '40000000-0000-0000-0000-000000000001') = 1 then
    raise exception 'FAIL: cashier changed a price';
  end if;
  raise notice 'ok: cashier price update affected no rows';
end $$;
do $$ begin
  insert into sales (id, store_id, device_id, receipt_no, cashier_name, created_at, business_date, subtotal,
    item_discount_total, order_discount, discount_total, total, cost_total, payment_method, tendered, change)
  values (gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'X', 'x',
    now(), current_date, 0, 0, 0, 0, 0, 0, 'cash', 0, 0);
  raise exception 'FAIL: direct sale insert allowed';
exception when insufficient_privilege then raise notice 'ok: direct sale insert refused';
end $$;

-- Owner session: sees the ledger written by sync_sale; sales are immutable.
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  if (select stock_qty from product_stock where product_id = '40000000-0000-0000-0000-000000000001') <> -1250 then
    raise exception 'FAIL: ledger does not show the sale';
  end if;
  raise notice 'ok: sale reduced stock in the ledger';
end $$;
reset role;
do $$ begin
  update sales set total = 0;
  raise exception 'FAIL: sale was edited';
exception when raise_exception then raise notice 'ok: sales are immutable even for the database owner';
end $$;

-- Anonymous users see nothing.
set role anon;
do $$ begin
  perform 1 from products;
  raise exception 'FAIL: anon can read products';
exception when insufficient_privilege then raise notice 'ok: anon has no access';
end $$;
reset role;
