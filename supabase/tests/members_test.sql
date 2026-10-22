-- Behavioural tests for the Phase 4 member and discount program functions (migration 6).
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
  perform sync_product('{"id":"40000000-0000-0000-0000-000000000001","name":"Liempo","description":"","categoryId":"30000000-0000-0000-0000-000000000001","saleUnit":"kg","price":36000,"cost":29500,"minStockQty":2000,"active":true}'::jsonb, null, null);
end $$;

\set member '{"id":"80000000-0000-0000-0000-000000000001","memberNo":"M-AB12-0001","name":"Maria Santos","birthYear":1988,"gender":"female","contactNumber":"+639171234567","privacyConsentAt":"2026-10-22T01:00:00Z","marketingConsent":true,"marketingConsentAt":"2026-10-22T01:00:00Z","active":true,"notes":"","registeredAt":"2026-10-22T01:00:00Z","registeredBy":"Ana","deviceId":"20000000-0000-0000-0000-000000000001"}'
select set_config('test.member', :'member', false) \gset

-- Cashiers register members; a retry is harmless.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare r uuid; begin
  r := sync_customer(current_setting('test.member')::jsonb);
  r := sync_customer(current_setting('test.member')::jsonb);
  if (select count(*) from customers) <> 1 then raise exception 'FAIL: member not stored exactly once'; end if;
  if (select member_no || ' ' || gender || ' ' || birth_year from customers) <> 'M-AB12-0001 female 1988' then
    raise exception 'FAIL: member fields not stored';
  end if;
  if (select privacy_consent_at from customers) is null then raise exception 'FAIL: consent time missing'; end if;
  raise notice 'ok: cashier registers a member (retry is harmless)';
end $$;

-- Edits update the record; the member number cannot change.
do $$ begin
  perform sync_customer(jsonb_set(jsonb_set(current_setting('test.member')::jsonb, '{marketingConsent}', 'false'),
    '{contactNumber}', '""'));
  if (select marketing_consent from customers) or (select contact_number from customers) is not null then
    raise exception 'FAIL: consent withdrawal not stored';
  end if;
  raise notice 'ok: promo consent can be withdrawn';
end $$;
do $$ begin
  perform sync_customer(jsonb_set(current_setting('test.member')::jsonb, '{memberNo}', '"M-AB12-0009"'));
  raise exception 'FAIL: member number changed';
exception when invalid_parameter_value then raise notice 'ok: member numbers never change';
end $$;

-- Validation: bad mobile, promo without a number, no privacy consent, duplicate member number.
do $$ begin
  perform sync_customer(jsonb_set(jsonb_set(current_setting('test.member')::jsonb, '{id}', '"80000000-0000-0000-0000-000000000002"'),
    '{contactNumber}', '"0917"'));
  raise exception 'FAIL: bad mobile accepted';
exception when invalid_parameter_value then raise notice 'ok: mobile number format checked';
end $$;
do $$ begin
  perform sync_customer(jsonb_set(jsonb_set(current_setting('test.member')::jsonb, '{id}', '"80000000-0000-0000-0000-000000000002"'),
    '{contactNumber}', '""'));
  raise exception 'FAIL: promo consent without a number accepted';
exception when invalid_parameter_value then raise notice 'ok: promo messages need a number';
end $$;
do $$ begin
  perform sync_customer(jsonb_set(jsonb_set(current_setting('test.member')::jsonb, '{id}', '"80000000-0000-0000-0000-000000000002"'),
    '{privacyConsentAt}', '""'));
  raise exception 'FAIL: member without consent accepted';
exception when invalid_parameter_value then raise notice 'ok: privacy consent required';
end $$;
do $$ begin
  perform sync_customer(jsonb_set(current_setting('test.member')::jsonb, '{id}', '"80000000-0000-0000-0000-000000000002"'));
  raise exception 'FAIL: duplicate member number accepted';
exception when unique_violation then raise notice 'ok: member numbers are unique in the store';
end $$;

-- Direct table writes are closed; only the function writes members.
do $$ begin
  insert into customers (id, store_id, name, registered_at)
  values (gen_random_uuid(), (select store_id from staff_profiles limit 1), 'X', now());
  raise exception 'FAIL: direct insert allowed';
exception when insufficient_privilege then raise notice 'ok: no direct writes to customers';
end $$;

-- Programs: managers and owners only.
\set program '{"id":"90000000-0000-0000-0000-000000000001","name":"Senior Tuesday","description":"","kind":"percent","value":500,"scope":"order","productIds":[],"categoryIds":[],"membersOnly":true,"minPurchase":0,"startsOn":"","endsOn":"","active":true,"updatedBy":"Josh"}'
select set_config('test.program', :'program', false) \gset
do $$ begin
  perform sync_promotion(current_setting('test.program')::jsonb);
  raise exception 'FAIL: cashier created a program';
exception when insufficient_privilege then raise notice 'ok: cashier cannot create programs';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  perform sync_promotion(current_setting('test.program')::jsonb);
  perform sync_promotion(jsonb_set(current_setting('test.program')::jsonb, '{value}', '1000'));
  if (select count(*) from promotions) <> 1 or (select value from promotions) <> 1000 then
    raise exception 'FAIL: program upsert';
  end if;
  raise notice 'ok: owner creates and edits a program';
end $$;
do $$ begin
  perform sync_promotion(jsonb_set(jsonb_set(current_setting('test.program')::jsonb, '{id}', '"90000000-0000-0000-0000-000000000002"'),
    '{kind}', '"fixed"') || '{"scope":"items"}');
  raise exception 'FAIL: fixed item program accepted';
exception when check_violation then raise notice 'ok: item programs must be a percentage';
end $$;
do $$ begin
  perform sync_promotion(jsonb_set(jsonb_set(current_setting('test.program')::jsonb, '{id}', '"90000000-0000-0000-0000-000000000003"'),
    '{name}', '"Pork week"') || '{"scope":"items","categoryIds":["30000000-0000-0000-0000-000000000001"]}');
  if (select category_ids from promotions where id = '90000000-0000-0000-0000-000000000003')
     <> array['30000000-0000-0000-0000-000000000001']::uuid[] then
    raise exception 'FAIL: program categories not stored';
  end if;
  raise notice 'ok: item program stores its categories';
end $$;

-- The feed gives every staff device members and programs.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare f jsonb; f2 jsonb; begin
  f := members_feed(null);
  if jsonb_array_length(f -> 'customers') <> 1 or jsonb_array_length(f -> 'promotions') <> 2 then
    raise exception 'FAIL: feed returned % members, % programs', jsonb_array_length(f -> 'customers'),
      jsonb_array_length(f -> 'promotions');
  end if;
  if f -> 'customers' -> 0 ->> 'member_no' <> 'M-AB12-0001' then raise exception 'FAIL: feed member fields'; end if;
  f2 := members_feed((f ->> 'now')::timestamptz + interval '1 second');
  if jsonb_array_length(f2 -> 'customers') <> 0 then raise exception 'FAIL: feed cursor ignored'; end if;
  raise notice 'ok: members feed for staff devices, with a cursor';
end $$;

-- A member sale with a program discount: customer and program are linked.
\set sale '{"sale":{"id":"70000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000001","cashierName":"Ana","createdAt":"2026-10-22T02:00:00Z","businessDate":"2026-10-22","subtotal":36000,"itemDiscountTotal":0,"orderDiscount":3600,"discountTotal":3600,"total":32400,"costTotal":29500,"paymentMethod":"cash","tendered":32400,"change":0,"discountApprovedBy":null,"customerId":"80000000-0000-0000-0000-000000000001"},"items":[{"id":"71000000-0000-0000-0000-000000000001","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":36000,"unitCost":29500,"qty":1000,"gross":36000,"itemDiscount":0,"orderDiscountShare":3600,"net":32400}],"payment":{"id":"72000000-0000-0000-0000-000000000001","method":"cash","amount":32400,"tendered":32400,"change":0,"reference":null},"discounts":[{"saleItemId":null,"kind":"percent","value":1000,"amount":3600,"reason":"Senior Tuesday","source":"promotion","promotionId":"90000000-0000-0000-0000-000000000001"}]}'
select set_config('test.sale', :'sale', false) \gset
do $$ begin
  if sync_sale(current_setting('test.sale')::jsonb) <> 'inserted' then raise exception 'FAIL: member sale'; end if;
  if sync_sale(current_setting('test.sale')::jsonb) <> 'duplicate' then raise exception 'FAIL: member sale retry'; end if;
  if (select customer_id from sales) <> '80000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: sale not linked to the member';
  end if;
  if (select source || ' ' || promotion_id || ' ' || coalesce(approved_by, '-') from sale_discounts)
     <> 'promotion 90000000-0000-0000-0000-000000000001 -' then
    raise exception 'FAIL: program discount not linked';
  end if;
  raise notice 'ok: member sale links the member and the program';
end $$;

-- A sale naming a member the cloud does not have is refused, not stored without it.
do $$ begin
  perform sync_sale(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(current_setting('test.sale')::jsonb,
    '{sale,id}', '"70000000-0000-0000-0000-000000000002"'), '{sale,receiptNo}', '"AB12-000002"'),
    '{sale,customerId}', '"80000000-0000-0000-0000-0000000000ee"'),
    '{items,0,id}', '"71000000-0000-0000-0000-000000000002"'), '{payment,id}', '"72000000-0000-0000-0000-000000000002"'));
  raise exception 'FAIL: sale with unknown member accepted';
exception when foreign_key_violation then raise notice 'ok: sale with an unknown member is refused';
end $$;

-- Owner's inventory feed carries the member on each sale line.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare f jsonb; begin
  f := inventory_feed(null, '20000000-0000-0000-0000-0000000000ff');
  if f -> 'sale_lines' -> 0 ->> 'customer_id' <> '80000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: feed sale line has no member';
  end if;
  raise notice 'ok: inventory feed sale lines include the member';
end $$;

-- Another store's owner sees none of it.
reset role;
with st as (insert into stores (name) values ('Other Shop') returning id)
insert into staff_profiles (user_id, store_id, display_name, role)
select '00000000-0000-0000-0000-0000000000d1', id, 'Zed', 'owner' from st;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
do $$ declare f jsonb; begin
  f := members_feed(null);
  if jsonb_array_length(f -> 'customers') <> 0 or jsonb_array_length(f -> 'promotions') <> 0 then
    raise exception 'FAIL: other store sees members or programs';
  end if;
  if exists (select 1 from customers) then raise exception 'FAIL: other store can read customers'; end if;
  perform sync_customer(jsonb_set(current_setting('test.member')::jsonb, '{name}', '"Hijack"'));
  raise exception 'FAIL: other store edited a member';
exception when insufficient_privilege then raise notice 'ok: members stay inside their store';
end $$;

reset role;
do $$ begin
  if (select value from schema_info where key = 'schema_version') <> '20261024000006' then
    raise exception 'FAIL: schema version';
  end if;
  raise notice 'ok: schema version 20261024000006';
end $$;
