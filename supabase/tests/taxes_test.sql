-- Behavioural tests for the tax setup, taxed sales and the tax report (migration 13).
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
reset role;
with st as (insert into stores (name) values ('Other Shop') returning id)
insert into staff_profiles (user_id, store_id, display_name, role)
select '00000000-0000-0000-0000-0000000000d1', id, 'Mia', 'owner' from st;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
do $$ begin
  perform register_device('20000000-0000-0000-0000-000000000009', 'ZZ99', 'Other');
end $$;

reset role;
insert into employees (id, store_id, employee_no, name, role, badge_hash)
select '50000000-0000-0000-0000-000000000001', store_id, 'E-0001', 'Josh', 'owner',
  encode(extensions.digest('badge-josh', 'sha256'), 'hex') from staff_profiles where display_name = 'Josh';
insert into office_sessions (token_hash, store_id, employee_id, expires_at)
select encode(extensions.digest('tok-josh', 'sha256'), 'hex'), store_id, id, now() + interval '1 hour'
from employees where employee_no = 'E-0001';
set role authenticated;


\set nonvat '{"sale":{"id":"70000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000001","cashierName":"Ana","createdAt":"2026-10-22T02:00:00Z","businessDate":"2026-10-22","subtotal":32400,"itemDiscountTotal":0,"orderDiscount":0,"discountTotal":0,"total":32400,"costTotal":26550,"paymentMethod":"cash","tendered":50000,"change":17600,"discountApprovedBy":null},"items":[{"id":"71000000-0000-0000-0000-000000000001","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":36000,"unitCost":29500,"qty":900,"gross":32400,"itemDiscount":0,"orderDiscountShare":0,"net":32400}],"payment":{"id":"72000000-0000-0000-0000-000000000001","method":"cash","amount":32400,"tendered":50000,"change":17600,"reference":null},"discounts":[]}'
\set vat '{"sale":{"id":"70000000-0000-0000-0000-000000000002","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000002","cashierName":"Ana","createdAt":"2026-11-02T02:00:00Z","businessDate":"2026-11-02","subtotal":47400,"itemDiscountTotal":0,"orderDiscount":0,"discountTotal":0,"total":47400,"costTotal":36550,"paymentMethod":"cash","tendered":50000,"change":2600,"discountApprovedBy":null,"taxMode":"vat","vatableSales":13393,"vatAmount":1607,"vatExemptSales":32400,"vatRateBp":1200},"items":[{"id":"71000000-0000-0000-0000-000000000002","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":36000,"unitCost":29500,"qty":900,"gross":32400,"itemDiscount":0,"orderDiscountShare":0,"net":32400,"taxClass":"exempt","vat":0},{"id":"71000000-0000-0000-0000-000000000003","lineNo":2,"productId":"40000000-0000-0000-0000-000000000002","productName":"Atchara","saleUnit":"piece","unitPrice":15000,"unitCost":10000,"qty":1,"gross":15000,"itemDiscount":0,"orderDiscountShare":0,"net":15000,"taxClass":"vatable","vat":1607}],"payment":{"id":"72000000-0000-0000-0000-000000000002","method":"cash","amount":47400,"tendered":50000,"change":2600,"reference":null},"discounts":[]}'
select set_config('test.nonvat', :'nonvat', false), set_config('test.vat', :'vat', false) \gset

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  perform sync_category('30000000-0000-0000-0000-000000000002', 'Condiments', 1);
  perform sync_product('{"id":"40000000-0000-0000-0000-000000000002","name":"Atchara","description":"","categoryId":"30000000-0000-0000-0000-000000000002","saleUnit":"piece","price":15000,"cost":10000,"minStockQty":0,"active":true}'::jsonb, null, null);
end $$;

-- Before any setup every device reads an empty setup (the app treats it as non-VAT).
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  if store_tax_settings() <> '{}'::jsonb then raise exception 'FAIL: empty setup %', store_tax_settings(); end if;
  raise notice 'ok: no tax setup yet';
end $$;

-- Only an unlocked owner saves it, and bad values are refused.
do $$ begin
  begin
    perform save_tax_settings('{"mode":"vat","tin":"123-456-789-00000","vatRateBp":1200,"percentageTaxBp":300}'::jsonb, 'nope');
    raise exception 'FAIL: saved without the Back Office';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: a locked Back Office cannot change taxes';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  begin
    perform save_tax_settings('{"mode":"vat","tin":"","vatRateBp":1200,"percentageTaxBp":300}'::jsonb, 'tok-josh');
    raise exception 'FAIL: VAT without a TIN';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform save_tax_settings('{"mode":"vat","tin":"123-456-789-00000","vatRateBp":1200,"percentageTaxBp":300,"categories":{"x":"zero"}}'::jsonb, 'tok-josh');
    raise exception 'FAIL: unknown class';
  exception when invalid_parameter_value then null;
  end;
  perform save_tax_settings('{"mode":"vat","tin":"123-456-789-00000","vatRateBp":1200,"percentageTaxBp":300,"categories":{"30000000-0000-0000-0000-000000000002":"vatable"}}'::jsonb, 'tok-josh');
  raise notice 'ok: owner saves the tax setup; bad values refused';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare j jsonb := store_tax_settings(); begin
  if j ->> 'mode' <> 'vat' or j ->> 'tin' <> '123-456-789-00000' or j -> 'categories' ->> '30000000-0000-0000-0000-000000000002' <> 'vatable'
     or j ->> 'updatedBy' <> 'Josh' then
    raise exception 'FAIL: cashier reads setup %', j;
  end if;
  raise notice 'ok: the cashier''s device reads the setup';
end $$;

-- An old-style sale counts as non-VAT; a VAT sale keeps its split; a wrong split is refused.
do $$ declare bad jsonb; begin
  perform sync_sale(current_setting('test.nonvat')::jsonb);
  perform sync_sale(current_setting('test.vat')::jsonb);
  if sync_sale(current_setting('test.vat')::jsonb) <> 'duplicate' then raise exception 'FAIL: VAT sale retry'; end if;
  bad := jsonb_set(jsonb_set(jsonb_set(jsonb_set(current_setting('test.vat')::jsonb,
    '{sale,id}', '"70000000-0000-0000-0000-000000000003"'), '{sale,receiptNo}', '"AB12-000003"'),
    '{items}', (select jsonb_agg(jsonb_set(i, '{id}', to_jsonb(gen_random_uuid()::text)))
                from jsonb_array_elements(current_setting('test.vat')::jsonb -> 'items') i)),
    '{sale,vatAmount}', '1600');
  bad := jsonb_set(bad, '{payment,id}', '"72000000-0000-0000-0000-000000000003"');
  begin
    perform sync_sale(bad);
    raise exception 'FAIL: wrong VAT split accepted';
  exception when check_violation then null;
  end;
  raise notice 'ok: taxed sales sync and wrong splits are refused';
end $$;

reset role;
do $$ begin
  if (select tax_mode from sales where id = '70000000-0000-0000-0000-000000000001') <> 'non_vat'
     or (select vat_amount from sales where id = '70000000-0000-0000-0000-000000000002') <> 1607
     or (select tax_class from sale_items where id = '71000000-0000-0000-0000-000000000003') <> 'vatable' then
    raise exception 'FAIL: stored tax details';
  end if;
  raise notice 'ok: tax details stored';
end $$;
set role authenticated;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare j jsonb; begin
  j := office_tax_report('2026-10-01', '2026-11-30', 'tok-josh');
  if jsonb_array_length(j -> 'months') <> 2
     or (j -> 'months' -> 0 ->> 'non_vat_sales')::bigint <> 32400
     or (j -> 'months' -> 1 ->> 'vat_amount')::bigint <> 1607
     or (j -> 'months' -> 1 ->> 'vat_exempt_sales')::bigint <> 32400
     or (j -> 'months' -> 1 ->> 'vatable_sales')::bigint <> 13393 then
    raise exception 'FAIL: tax report months %', j;
  end if;
  if (select (c ->> 'vat')::bigint from jsonb_array_elements(j -> 'categories') c where c ->> 'name' = 'Condiments') <> 1607 then
    raise exception 'FAIL: tax report categories %', j;
  end if;
  raise notice 'ok: tax report by month and category';
end $$;

-- Other stores never see this store's setup.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
do $$ begin
  if store_tax_settings() <> '{}'::jsonb then raise exception 'FAIL: other store sees the setup'; end if;
  raise notice 'ok: tax setup is per store';
end $$;
