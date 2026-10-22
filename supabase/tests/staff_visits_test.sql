-- Behavioural tests for the member visits and discount names in the CSV (migration 10).
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
\set sale2 '{"sale":{"id":"70000000-0000-0000-0000-000000000002","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000002","cashierName":"Ana","createdAt":"2026-10-23T07:00:00Z","businessDate":"2026-10-23","subtotal":28000,"itemDiscountTotal":1000,"orderDiscount":0,"discountTotal":1000,"total":27000,"costTotal":20750,"paymentMethod":"gcash","tendered":27000,"change":0,"discountApprovedBy":"Josh","customerId":"80000000-0000-0000-0000-000000000001"},"items":[{"id":"71000000-0000-0000-0000-000000000002","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":36000,"unitCost":29500,"qty":500,"gross":18000,"itemDiscount":0,"orderDiscountShare":0,"net":18000},{"id":"71000000-0000-0000-0000-000000000003","lineNo":2,"productId":"40000000-0000-0000-0000-000000000002","productName":"Vinegar","saleUnit":"piece","unitPrice":5000,"unitCost":3000,"qty":2,"gross":10000,"itemDiscount":1000,"orderDiscountShare":0,"net":9000}],"payment":{"id":"72000000-0000-0000-0000-000000000002","method":"gcash","amount":27000,"tendered":27000,"change":0,"reference":"123"},"discounts":[{"saleItemId":"71000000-0000-0000-0000-000000000003","kind":"fixed","value":1000,"amount":1000,"reason":"Dented bottle","source":"manual"}]}'
select set_config('test.sale1', :'sale1', false), set_config('test.sale2', :'sale2', false) \gset

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform sync_customer(current_setting('test.member')::jsonb);
  perform sync_sale(current_setting('test.sale1')::jsonb);
  perform sync_sale(current_setting('test.sale2')::jsonb);
end $$;


do $$ declare v record; begin
  select * into v from member_visits();
  if v.customer_id <> '80000000-0000-0000-0000-000000000001' or v.visits <> 2 then
    raise exception 'FAIL: member visits %', v;
  end if;
  raise notice 'ok: cashier reads member visit counts';
end $$;


-- ---------------------------------------------------------------- authenticator codes
reset role;
do $$ begin
  -- RFC 6238 test secret "12345678901234567890" (SHA-1), last 6 digits of the published codes.
  if totp_code('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1) <> '287082'
     or totp_code('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 37037036) <> '081804'
     or totp_code('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 37037037) <> '050471'
     or totp_code('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 41152263) <> '005924' then
    raise exception 'FAIL: authenticator codes do not match RFC 6238';
  end if;
  raise notice 'ok: authenticator codes match RFC 6238 (Google Authenticator)';
end $$;
set role authenticated;

-- ---------------------------------------------------------------- first owner ID
\set owner '{"id":"50000000-0000-0000-0000-000000000001","name":"Josh","role":"owner","badgeHash":"1111111111111111111111111111111111111111111111111111111111111111","pin":{"salt":"c2FsdA==","hash":"aGFzaA==","iterations":210000},"totpSecret":"JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"}'
select set_config('test.owner', :'owner', false) \gset

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform save_employee(current_setting('test.owner')::jsonb, null);
  raise exception 'FAIL: cashier account created the owner ID';
exception when insufficient_privilege then raise notice 'ok: only the owner account can set up the first owner ID';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare r jsonb; begin
  if not (office_status() ->> 'setupOpen')::boolean then raise exception 'FAIL: setup should be open'; end if;
  r := save_employee(current_setting('test.owner')::jsonb, null);
  if r ->> 'employeeNo' <> 'E-0001' then raise exception 'FAIL: employee number %', r; end if;
  if confirm_totp('50000000-0000-0000-0000-000000000001', '000000', null) then raise exception 'FAIL: wrong code accepted'; end if;
  raise notice 'ok: owner ID created during setup; a wrong code does not link the app';
end $$;

-- Codes the authenticator app would show now and in the next 30 seconds.
reset role;
select set_config('test.code_now', totp_code('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', floor(extract(epoch from now()) / 30)::bigint), false),
  set_config('test.code_next', totp_code('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', floor(extract(epoch from now()) / 30)::bigint + 1), false) \gset
set role authenticated;

do $$ declare r jsonb; begin
  if not confirm_totp('50000000-0000-0000-0000-000000000001', current_setting('test.code_now'), null) then
    raise exception 'FAIL: right code refused';
  end if;
  if (office_status() ->> 'setupOpen')::boolean then raise exception 'FAIL: setup still open'; end if;
  raise notice 'ok: authenticator linked, setup closed';
  begin
    perform save_employee(jsonb_set(current_setting('test.owner')::jsonb, '{id}', '"50000000-0000-0000-0000-0000000000ff"'), null);
    raise exception 'FAIL: second setup allowed';
  exception when insufficient_privilege then raise notice 'ok: after setup, changes need an open Back Office';
  end;
  -- The badge text is "TLB-STAFF:test"; its SHA-256 is not the one stored, so it is refused.
  r := office_unlock('TLB-STAFF:test', current_setting('test.code_next'));
  if r ->> 'error' not like 'This badge is not known%' then raise exception 'FAIL: unknown badge %', r; end if;
  raise notice 'ok: unknown badge refused';
end $$;

-- Give the owner a badge we know the text of.
reset role;
update employees set badge_hash = encode(extensions.digest('TLB-STAFF:owner-badge', 'sha256'), 'hex')
where id = '50000000-0000-0000-0000-000000000001';
set role authenticated;

do $$ declare r jsonb; tok text; begin
  r := office_unlock('TLB-STAFF:owner-badge', current_setting('test.code_now'));
  if r ->> 'error' not like 'Wrong or used code%' then raise exception 'FAIL: replayed code accepted %', r; end if;
  raise notice 'ok: a code cannot be used twice';
  r := office_unlock('TLB-STAFF:owner-badge', current_setting('test.code_next'));
  tok := r ->> 'token';
  if tok is null or r ->> 'role' <> 'owner' then raise exception 'FAIL: unlock %', r; end if;
  perform set_config('test.token', tok, false);
  raise notice 'ok: badge + authenticator code open the Back Office';

  r := save_employee('{"id":"50000000-0000-0000-0000-000000000002","name":"Ana","role":"cashier","badgeHash":"2222222222222222222222222222222222222222222222222222222222222222","pin":{"salt":"c2FsdA==","hash":"YW5h","iterations":210000}}', tok);
  if r ->> 'employeeNo' <> 'E-0002' then raise exception 'FAIL: cashier number %', r; end if;
  r := save_employee('{"id":"50000000-0000-0000-0000-000000000003","name":"Mila","role":"manager","badgeHash":"3333333333333333333333333333333333333333333333333333333333333333","totpSecret":"KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU"}', tok);
  if r ->> 'employeeNo' <> 'E-0003' then raise exception 'FAIL: manager number %', r; end if;
  if jsonb_array_length(office_employees(tok)) <> 3 then raise exception 'FAIL: employee list'; end if;
  raise notice 'ok: owner adds a cashier and a manager (E-0002, E-0003)';

  begin
    perform save_employee('{"id":"50000000-0000-0000-0000-000000000001","name":"Josh","role":"manager"}', tok);
    raise exception 'FAIL: last owner demoted';
  exception when invalid_parameter_value then raise notice 'ok: the shop keeps at least one owner';
  end;
end $$;

-- Counter devices get badge and PIN hashes, and only linked authenticator secrets.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare f jsonb; begin
  f := employees_feed();
  if jsonb_array_length(f -> 'employees') <> 3 then raise exception 'FAIL: feed size'; end if;
  if (select count(*) from jsonb_array_elements(f -> 'employees') x where x ->> 'totp_secret' is not null) <> 1 then
    raise exception 'FAIL: only the linked owner secret should be sent %', f;
  end if;
  if (select x ->> 'pin_hash' from jsonb_array_elements(f -> 'employees') x where x ->> 'name' = 'Ana') <> 'YW5h' then
    raise exception 'FAIL: PIN hash missing';
  end if;
  raise notice 'ok: devices receive what they need to sign staff in offline';
  -- The owner's session also works on a counter device signed in with a cashier account.
  if office_report('2026-10-01', '2026-10-31', current_setting('test.token')) is null then raise exception 'FAIL: report'; end if;
  raise notice 'ok: an owner badge opens the Back Office on a counter device';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare names text[]; begin
  select array_agg(coalesce(discount_names, '-') order by receipt_no, product) into names
  from office_sales_lines('2026-10-01', '2026-10-31', current_setting('test.token'));
  if names <> array['Suki 10% (whole sale)', '-', 'Dented bottle ₱10.00'] then
    raise exception 'FAIL: discount names %', names;
  end if;
  if (select discount_approved_by from office_sales_lines('2026-10-01', '2026-10-31', current_setting('test.token')) where product = 'Vinegar') <> 'Josh' then
    raise exception 'FAIL: approver';
  end if;
  raise notice 'ok: sale lines name the discount given on each line';
end $$;

-- Manager sessions cannot manage staff; locking ends the session; repeated failures lock out.
reset role;
select set_config('test.mgr_code', totp_code('KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU', floor(extract(epoch from now()) / 30)::bigint), false) \gset
update employees set badge_hash = encode(extensions.digest('TLB-STAFF:mila', 'sha256'), 'hex'), totp_confirmed_at = now()
where name = 'Mila';
set role authenticated;
do $$ declare r jsonb; i int; begin
  r := office_unlock('TLB-STAFF:mila', current_setting('test.mgr_code'));
  if r ->> 'role' <> 'manager' then raise exception 'FAIL: manager unlock %', r; end if;
  begin
    perform save_employee('{"id":"50000000-0000-0000-0000-000000000004","name":"X","role":"cashier","badgeHash":"4444444444444444444444444444444444444444444444444444444444444444"}', r ->> 'token');
    raise exception 'FAIL: manager added staff';
  exception when insufficient_privilege then raise notice 'ok: only the owner manages staff';
  end;
  perform office_lock(r ->> 'token');
  begin
    perform office_report('2026-10-01', '2026-10-31', r ->> 'token');
    raise exception 'FAIL: locked session still works';
  exception when insufficient_privilege then raise notice 'ok: locking ends the session';
  end;
  for i in 1 .. 8 loop
    perform office_unlock('TLB-STAFF:mila', '123456');
  end loop;
  r := office_unlock('TLB-STAFF:mila', '123456');
  if r ->> 'error' not like 'Too many%' then raise exception 'FAIL: no lockout %', r; end if;
  raise notice 'ok: too many wrong tries lock the Back Office for a while';
end $$;

reset role;
\ir ../migrations/20261028000010_staff_ids_and_visits.sql
\ir ../migrations/20261028000010_staff_ids_and_visits.sql
do $$ begin raise notice 'ok: migration 10 can be re-run'; end $$;
