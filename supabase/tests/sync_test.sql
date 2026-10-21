-- Behavioural tests for the Phase 2 sync functions (migration 3 and 4).
\set ON_ERROR_STOP on

insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'Cashier@Example.test');

-- Owner bootstraps the store.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select set_config('test.store', bootstrap_owner('The Local Butcher', 'Josh')::text, false) \gset
do $$ begin
  if (select role from whoami()) <> 'owner' then raise exception 'FAIL: bootstrap did not make an owner'; end if;
  raise notice 'ok: first user becomes owner';
end $$;

-- A second person cannot bootstrap another store.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  if (select has_store from whoami()) is not true then raise exception 'FAIL: whoami should report an existing store'; end if;
  perform bootstrap_owner('Mine now', 'Mallory');
  raise exception 'FAIL: second bootstrap allowed';
exception when insufficient_privilege then raise notice 'ok: second bootstrap refused';
end $$;
do $$ begin
  perform add_staff('owner@example.test', 'x', 'owner');
  raise exception 'FAIL: non-staff added staff';
exception when insufficient_privilege then raise notice 'ok: non-staff cannot add staff';
end $$;

-- Owner adds the cashier (email match is case-insensitive) and registers a device.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  perform add_staff('cashier@example.test', 'Ana', 'cashier');
  perform register_device('20000000-0000-0000-0000-000000000001', 'AB12', 'Counter tablet');
  perform register_device('20000000-0000-0000-0000-000000000001', 'AB12', 'Counter tablet'); -- repeat is fine
  raise notice 'ok: staff added, device registered idempotently';
end $$;
do $$ begin
  perform register_device('20000000-0000-0000-0000-000000000002', 'AB12', 'Clash');
  raise exception 'FAIL: duplicate device code accepted';
exception when unique_violation then raise notice 'ok: duplicate device code refused';
end $$;

-- Categories merge by name.
do $$ declare a uuid; begin
  a := sync_category('30000000-0000-0000-0000-000000000001', 'Pork', 0);
  if a <> '30000000-0000-0000-0000-000000000001' then raise exception 'FAIL: category not created'; end if;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare b uuid; begin
  b := sync_category('30000000-0000-0000-0000-0000000000ff', ' pork ', 0);
  if b <> '30000000-0000-0000-0000-000000000001' then raise exception 'FAIL: same-name category not merged'; end if;
  raise notice 'ok: categories with the same name merge';
end $$;
do $$ begin
  perform sync_category(gen_random_uuid(), 'Lamb', 5);
  raise exception 'FAIL: cashier created a category';
exception when insufficient_privilege then raise notice 'ok: cashier cannot create categories';
end $$;

-- Products.
\set prod '{"id":"40000000-0000-0000-0000-000000000001","name":"Liempo","description":"Belly","categoryId":"30000000-0000-0000-0000-000000000001","saleUnit":"kg","price":35000,"cost":29500,"minStockQty":2000,"active":true}'
select set_config('test.prod', :'prod', false) \gset
do $$ begin
  perform sync_product(current_setting('test.prod')::jsonb, null, null);
  raise exception 'FAIL: cashier created a product';
exception when insufficient_privilege then raise notice 'ok: cashier cannot create products';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare r jsonb; begin
  r := sync_product(current_setting('test.prod')::jsonb, null, null);
  if r ->> 'status' <> 'created' then raise exception 'FAIL: create returned %', r; end if;
  r := sync_product(jsonb_set(current_setting('test.prod')::jsonb, '{price}', '36000'), 1, 'Supplier increase');
  if r ->> 'status' <> 'updated' or (r ->> 'version')::int <> 2 then raise exception 'FAIL: owner price update %', r; end if;
  if (select reason from product_prices where field = 'price') <> 'Supplier increase' then
    raise exception 'FAIL: price reason not logged';
  end if;
  r := sync_product(jsonb_set(current_setting('test.prod')::jsonb, '{price}', '36000'), 2, null);
  if r ->> 'status' <> 'unchanged' then raise exception 'FAIL: no-op update returned %', r; end if;
  raise notice 'ok: owner creates and reprices with logged reason';
end $$;

-- Cashier: description edit refused until the owner grants it; prices always refused; stale edits conflict.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform sync_product(jsonb_set(jsonb_set(current_setting('test.prod')::jsonb, '{price}', '36000'),
    '{description}', '"Skin-on belly"'), 2, null);
  raise exception 'FAIL: cashier edited description without permission';
exception when insufficient_privilege then raise notice 'ok: cashier description edit refused without permission';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
update staff_profiles set can_edit_descriptions = true, can_edit_photos = true
  where user_id = '00000000-0000-0000-0000-0000000000c1';
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare r jsonb; begin
  r := sync_product(jsonb_set(jsonb_set(current_setting('test.prod')::jsonb, '{price}', '36000'),
    '{description}', '"Skin-on belly"'), 2, null);
  if r ->> 'status' <> 'updated' then raise exception 'FAIL: permitted description edit %', r; end if;
  raise notice 'ok: cashier description edit allowed after owner grants it';
end $$;
do $$ begin
  perform sync_product(jsonb_set(current_setting('test.prod')::jsonb, '{price}', '100'), 3, null);
  raise exception 'FAIL: cashier changed price';
exception when insufficient_privilege then raise notice 'ok: cashier price edit refused';
end $$;
do $$ declare r jsonb; begin
  r := sync_product(jsonb_set(current_setting('test.prod')::jsonb, '{description}', '"stale"'), 1, null);
  if r ->> 'status' <> 'conflict' or (r -> 'server' ->> 'version')::int <> 3 then
    raise exception 'FAIL: stale edit returned %', r;
  end if;
  raise notice 'ok: stale edit returns conflict with server copy';
end $$;

-- Photos: metadata row plus storage policy.
do $$ begin
  perform sync_product_image('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
    current_setting('test.store') || '/50000000-0000-0000-0000-000000000001.jpg', 'image/jpeg', 800, 600, true);
  if (select image_id from products) <> '50000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: photo not attached';
  end if;
  raise notice 'ok: permitted cashier photo attached to product';
end $$;
do $$ begin
  insert into storage.objects (bucket_id, name) values ('product-images', current_setting('test.store') || '/x.jpg');
  raise notice 'ok: photo upload allowed into own store folder';
end $$;
do $$ begin
  insert into storage.objects (bucket_id, name) values ('product-images', gen_random_uuid()::text || '/x.jpg');
  raise exception 'FAIL: upload into another store folder allowed';
exception when insufficient_privilege then raise notice 'ok: upload into another store folder refused';
end $$;

-- Stock movements.
\set mv '{"id":"60000000-0000-0000-0000-000000000001","productId":"40000000-0000-0000-0000-000000000001","type":"delivery","qtyDelta":10000,"unitCost":29500,"batchCode":"B1","useBy":"2026-10-25","at":"2026-10-21T01:00:00Z","by":"Josh"}'
select set_config('test.mv', :'mv', false) \gset
do $$ begin
  perform sync_movement(current_setting('test.mv')::jsonb);
  raise exception 'FAIL: cashier synced a stock adjustment';
exception when insufficient_privilege then raise notice 'ok: cashier stock adjustment refused';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  if sync_movement(current_setting('test.mv')::jsonb) <> 'inserted' then raise exception 'FAIL: movement insert'; end if;
  if sync_movement(current_setting('test.mv')::jsonb) <> 'duplicate' then raise exception 'FAIL: movement retry'; end if;
  raise notice 'ok: stock movement sync is idempotent';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  if (select stock_qty from store_stock() where product_id = '40000000-0000-0000-0000-000000000001') <> 10000 then
    raise exception 'FAIL: cashier cannot see stock';
  end if;
  raise notice 'ok: cashier sees stock levels through store_stock()';
end $$;
reset role;

-- A cashier's sale with an order discount, through the registered device.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
\set sale '{"sale":{"id":"70000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000001","cashierName":"Ana","createdAt":"2026-10-22T02:00:00Z","businessDate":"2026-10-22","subtotal":36000,"itemDiscountTotal":0,"orderDiscount":3600,"discountTotal":3600,"total":32400,"costTotal":29500,"paymentMethod":"cash","tendered":32400,"change":0,"discountApprovedBy":"manager-pin"},"items":[{"id":"71000000-0000-0000-0000-000000000001","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":36000,"unitCost":29500,"qty":1000,"gross":36000,"itemDiscount":0,"orderDiscountShare":3600,"net":32400}],"payment":{"id":"72000000-0000-0000-0000-000000000001","method":"cash","amount":32400,"tendered":32400,"change":0,"reference":null},"discounts":[{"saleItemId":null,"kind":"percent","value":1000,"amount":3600,"reason":"Suki"}]}'
select set_config('test.sale', :'sale', false) \gset
do $$ begin
  if sync_sale(current_setting('test.sale')::jsonb) <> 'inserted' then raise exception 'FAIL: sale'; end if;
  if sync_sale(current_setting('test.sale')::jsonb) <> 'duplicate' then raise exception 'FAIL: sale retry'; end if;
  if (select stock_qty from store_stock() where product_id = '40000000-0000-0000-0000-000000000001') <> 9000 then
    raise exception 'FAIL: sale did not reduce stock';
  end if;
  raise notice 'ok: cashier sale synced once, stock reduced';
end $$;
reset role;
do $$ begin
  if (select count(*) from sale_discounts where reason = 'Suki' and amount = 3600 and approved_by = 'manager-pin') <> 1 then
    raise exception 'FAIL: discount details not stored';
  end if;
  raise notice 'ok: discount details stored with the sale';
end $$;
