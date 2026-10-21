-- Behavioural tests for the Phase 3 inventory functions (migration 5).
\set ON_ERROR_STOP on

insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'manager@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'cashier@example.test');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  perform bootstrap_owner('The Local Butcher', 'Josh');
  perform add_staff('manager@example.test', 'Ben', 'manager');
  perform add_staff('cashier@example.test', 'Ana', 'cashier');
  perform register_device('20000000-0000-0000-0000-000000000001', 'AB12', 'Counter');
  perform register_device('20000000-0000-0000-0000-000000000002', 'CD34', 'Back room');
  perform sync_category('30000000-0000-0000-0000-000000000001', 'Pork', 0);
  perform sync_product('{"id":"40000000-0000-0000-0000-000000000001","name":"Liempo","description":"","categoryId":"30000000-0000-0000-0000-000000000001","saleUnit":"kg","price":35000,"cost":29500,"minStockQty":2000,"active":true}'::jsonb, null, null);
  perform sync_product('{"id":"40000000-0000-0000-0000-000000000002","name":"Longganisa","description":"","categoryId":"30000000-0000-0000-0000-000000000001","saleUnit":"piece","price":2500,"cost":1500,"minStockQty":10,"active":true}'::jsonb, null, null);
end $$;

-- Suppliers: managers create, same name merges, cashiers refused.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ declare a uuid; b uuid; begin
  a := sync_supplier('{"id":"50000000-0000-0000-0000-000000000001","name":"Jun''s Farm","contact":"0917","notes":"","active":true}');
  if a <> '50000000-0000-0000-0000-000000000001' then raise exception 'FAIL: supplier not created'; end if;
  b := sync_supplier('{"id":"50000000-0000-0000-0000-0000000000ff","name":" jun''s farm ","contact":"","notes":"","active":true}');
  if b <> a then raise exception 'FAIL: same-name supplier not merged'; end if;
  perform sync_supplier('{"id":"50000000-0000-0000-0000-000000000001","name":"Jun''s Farm","contact":"0917 555","notes":"","active":true}');
  if (select contact from suppliers where id = a) <> '0917 555' then raise exception 'FAIL: supplier update'; end if;
  raise notice 'ok: suppliers upsert and merge by name';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform sync_supplier('{"id":"50000000-0000-0000-0000-000000000002","name":"X","active":true}');
  raise exception 'FAIL: cashier created a supplier';
exception when insufficient_privilege then raise notice 'ok: cashier cannot create suppliers';
end $$;
do $$ begin
  if exists (select 1 from suppliers) then raise exception 'FAIL: cashier can read suppliers'; end if;
  raise notice 'ok: cashier cannot read suppliers';
end $$;

-- A purchase: 12.345 kg of Liempo at 290.00/kg and 40 Longganisa at 15.00.
-- 29000 * 12345 / 1000 = 358005 centavos; 1500 * 40 = 60000.
\set purchase '{"purchase":{"id":"60000000-0000-0000-0000-000000000001","supplierId":"50000000-0000-0000-0000-000000000001","receivedAt":"2026-10-22T01:00:00Z","reference":"DR-1","notes":"","totalCost":418005,"by":"Ben","deviceId":"20000000-0000-0000-0000-000000000002"},"lines":[{"itemId":"61000000-0000-0000-0000-000000000001","batchId":"62000000-0000-0000-0000-000000000001","movementId":"63000000-0000-0000-0000-000000000001","productId":"40000000-0000-0000-0000-000000000001","qty":12345,"unitCost":29000,"lineCost":358005,"batchCode":"L-22","useBy":"2026-10-25","storageNote":"chiller"},{"itemId":"61000000-0000-0000-0000-000000000002","batchId":"62000000-0000-0000-0000-000000000002","movementId":"63000000-0000-0000-0000-000000000002","productId":"40000000-0000-0000-0000-000000000002","qty":40,"unitCost":1500,"lineCost":60000,"batchCode":"","useBy":"","storageNote":""}]}'
select set_config('test.purchase', :'purchase', false) \gset

do $$ begin
  perform sync_purchase(current_setting('test.purchase')::jsonb);
  raise exception 'FAIL: cashier recorded a purchase';
exception when insufficient_privilege then raise notice 'ok: cashier cannot record purchases';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ declare r text; begin
  r := sync_purchase(current_setting('test.purchase')::jsonb);
  if r <> 'inserted' then raise exception 'FAIL: purchase returned %', r; end if;
  r := sync_purchase(current_setting('test.purchase')::jsonb);
  if r <> 'duplicate' then raise exception 'FAIL: retry returned %', r; end if;
  if (select count(*) from purchases) <> 1 or (select count(*) from purchase_items) <> 2
     or (select count(*) from inventory_batches) <> 2 then
    raise exception 'FAIL: purchase rows not written exactly once';
  end if;
  if (select stock_qty from store_stock() where product_id = '40000000-0000-0000-0000-000000000001') <> 12345 then
    raise exception 'FAIL: purchase did not add stock';
  end if;
  if (select batch_id from inventory_movements where id = '63000000-0000-0000-0000-000000000001')
     <> '62000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: movement not linked to batch';
  end if;
  if (select use_by from inventory_batches where id = '62000000-0000-0000-0000-000000000001') <> '2026-10-25' then
    raise exception 'FAIL: use-by not stored';
  end if;
  raise notice 'ok: purchase writes batches, items and stock once (retry is a duplicate)';
end $$;

do $$ begin
  perform sync_purchase(jsonb_set(current_setting('test.purchase')::jsonb, '{purchase,reference}', '"DR-2"'));
  raise exception 'FAIL: changed purchase accepted';
exception when unique_violation then raise notice 'ok: different content under the same purchase id refused';
end $$;

do $$ declare bad jsonb := current_setting('test.purchase')::jsonb; begin
  bad := jsonb_set(bad, '{purchase,id}', '"60000000-0000-0000-0000-000000000009"');
  bad := jsonb_set(bad, '{lines,0,lineCost}', '358004');
  perform sync_purchase(bad);
  raise exception 'FAIL: wrong line cost accepted';
exception when invalid_parameter_value then raise notice 'ok: line cost must match quantity × cost';
end $$;
do $$ begin
  if exists (select 1 from purchases where id = '60000000-0000-0000-0000-000000000009') then
    raise exception 'FAIL: rejected purchase left rows behind';
  end if;
  raise notice 'ok: rejected purchase leaves nothing behind';
end $$;

-- Payment status may change; nothing else may.
do $$ begin
  perform set_purchase_payment('60000000-0000-0000-0000-000000000001', 'paid');
  if (select payment_status from purchases) <> 'paid' then raise exception 'FAIL: payment status'; end if;
  raise notice 'ok: payment status updates';
end $$;
reset role;
do $$ begin
  update purchases set total_cost = 1;
  raise exception 'FAIL: purchase total edited';
exception when raise_exception then raise notice 'ok: purchase totals are immutable';
end $$;
do $$ begin
  delete from inventory_batches;
  raise exception 'FAIL: batch deleted';
exception when raise_exception then raise notice 'ok: batches are immutable';
end $$;
set role authenticated;

-- Waste can name its batch; purchase movements cannot come through sync_movement.
do $$ declare r text; begin
  r := sync_movement('{"id":"64000000-0000-0000-0000-000000000001","productId":"40000000-0000-0000-0000-000000000001","type":"spoilage","qtyDelta":-500,"unitCost":29000,"reason":"warm","batchId":"62000000-0000-0000-0000-000000000001","at":"2026-10-23T02:00:00Z","by":"Ben","deviceId":"20000000-0000-0000-0000-000000000002"}');
  if (select batch_id from inventory_movements where id = '64000000-0000-0000-0000-000000000001')
     <> '62000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: waste batch not stored';
  end if;
  raise notice 'ok: waste can name its batch';
end $$;
do $$ begin
  perform sync_movement('{"id":"64000000-0000-0000-0000-000000000002","productId":"40000000-0000-0000-0000-000000000001","type":"spoilage","qtyDelta":-500,"unitCost":0,"batchId":"62000000-0000-0000-0000-000000000002","at":"2026-10-23T02:00:00Z"}');
  raise exception 'FAIL: batch of another product accepted';
exception when foreign_key_violation then raise notice 'ok: batch must belong to the product';
end $$;
do $$ begin
  perform sync_movement('{"id":"64000000-0000-0000-0000-000000000003","productId":"40000000-0000-0000-0000-000000000001","type":"purchase","qtyDelta":500,"unitCost":0,"at":"2026-10-23T02:00:00Z"}');
  raise exception 'FAIL: purchase movement accepted';
exception when invalid_parameter_value then raise notice 'ok: purchase movements only through sync_purchase';
end $$;

-- A sale from the counter device, then the feed for each device.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
\set sale '{"sale":{"id":"70000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000001","cashierName":"Ana","createdAt":"2026-10-23T03:00:00Z","businessDate":"2026-10-23","subtotal":35000,"itemDiscountTotal":0,"orderDiscount":0,"discountTotal":0,"total":35000,"costTotal":29000,"paymentMethod":"cash","tendered":50000,"change":15000,"discountApprovedBy":null},"items":[{"id":"71000000-0000-0000-0000-000000000001","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":35000,"unitCost":29000,"qty":1000,"gross":35000,"itemDiscount":0,"orderDiscountShare":0,"net":35000}],"payment":{"id":"72000000-0000-0000-0000-000000000001","method":"cash","amount":35000,"tendered":50000,"change":15000,"reference":null},"discounts":[]}'
select set_config('test.sale', :'sale', false) \gset
select sync_sale(current_setting('test.sale')::jsonb) \gset
do $$ begin
  perform inventory_feed(null, '20000000-0000-0000-0000-000000000001');
  raise exception 'FAIL: cashier read the inventory feed';
exception when insufficient_privilege then raise notice 'ok: cashier cannot read the inventory feed';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare f jsonb; begin
  -- The owner's counter device sees the manager's purchase and waste, not its own sale.
  f := inventory_feed(null, '20000000-0000-0000-0000-000000000001');
  if jsonb_array_length(f -> 'purchases') <> 1 or jsonb_array_length(f -> 'batches') <> 2
     or jsonb_array_length(f -> 'purchase_items') <> 2 then
    raise exception 'FAIL: feed purchases %', f;
  end if;
  if jsonb_array_length(f -> 'movements') <> 3 then raise exception 'FAIL: feed movements %', f -> 'movements'; end if;
  if jsonb_array_length(f -> 'sale_lines') <> 0 then raise exception 'FAIL: own sale lines in feed'; end if;
  if jsonb_array_length(f -> 'suppliers') <> 1 then raise exception 'FAIL: feed suppliers'; end if;

  -- The back-room device sees the sale (with its cost) but not its own purchase.
  f := inventory_feed(null, '20000000-0000-0000-0000-000000000002');
  if jsonb_array_length(f -> 'purchase_items') <> 0 or jsonb_array_length(f -> 'batches') <> 0 then
    raise exception 'FAIL: own purchase in feed';
  end if;
  if jsonb_array_length(f -> 'movements') <> 1 or (f -> 'movements' -> 0 ->> 'type') <> 'sale' then
    raise exception 'FAIL: expected only the sale movement, got %', f -> 'movements';
  end if;
  if (f -> 'sale_lines' -> 0 ->> 'cost')::bigint <> 29000 or (f -> 'sale_lines' -> 0 ->> 'net')::bigint <> 35000 then
    raise exception 'FAIL: sale line %', f -> 'sale_lines';
  end if;
  -- Payment status changes are visible to the other device (purchases filter by updated_at).
  if (f -> 'purchases' -> 0 ->> 'payment_status') <> 'paid' then raise exception 'FAIL: payment status in feed'; end if;

  -- Since a later time, nothing new.
  f := inventory_feed(now() + interval '1 minute', '20000000-0000-0000-0000-000000000001');
  if jsonb_array_length(f -> 'movements') <> 0 or jsonb_array_length(f -> 'purchases') <> 0 then
    raise exception 'FAIL: feed since now not empty';
  end if;
  raise notice 'ok: inventory feed returns other devices'' records and respects the cursor';
end $$;
