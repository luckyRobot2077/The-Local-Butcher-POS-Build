-- Behavioural tests for cashier shifts, sale start times and drawer openings (migration 11).
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

\set open '{"id":"90000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","openedAt":"2026-10-22T00:00:00Z","openedBy":"Ana","openedByEmployeeId":null,"openingFloat":100000,"closedAt":null,"closedBy":null,"countedCash":null,"expectedCash":null,"cashSales":null,"gcashSales":null,"saleCount":null,"note":null}'
\set closed '{"id":"90000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","openedAt":"2026-10-22T00:00:00Z","openedBy":"Ana","openedByEmployeeId":null,"openingFloat":100000,"closedAt":"2026-10-22T10:00:00Z","closedBy":"Ana","countedCash":132000,"expectedCash":132400,"cashSales":32400,"gcashSales":0,"saleCount":1,"note":"Short 4 pesos"}'
\set sale1 '{"sale":{"id":"70000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","receiptNo":"AB12-000001","cashierName":"Ana","createdAt":"2026-10-22T02:00:00Z","businessDate":"2026-10-22","subtotal":32400,"itemDiscountTotal":0,"orderDiscount":0,"discountTotal":0,"total":32400,"costTotal":26550,"paymentMethod":"cash","tendered":50000,"change":17600,"discountApprovedBy":null,"startedAt":"2026-10-22T01:58:30Z","shiftId":"90000000-0000-0000-0000-000000000001"},"items":[{"id":"71000000-0000-0000-0000-000000000001","lineNo":1,"productId":"40000000-0000-0000-0000-000000000001","productName":"Liempo","saleUnit":"kg","unitPrice":36000,"unitCost":29500,"qty":900,"gross":32400,"itemDiscount":0,"orderDiscountShare":0,"net":32400}],"payment":{"id":"72000000-0000-0000-0000-000000000001","method":"cash","amount":32400,"tendered":50000,"change":17600,"reference":null},"discounts":[]}'
\set nosale '{"id":"91000000-0000-0000-0000-000000000001","shiftId":"90000000-0000-0000-0000-000000000001","deviceId":"20000000-0000-0000-0000-000000000001","kind":"no_sale","at":"2026-10-22T03:00:00Z","by":"Ana","approvedBy":"Josh","reason":"Change for a customer"}'
select set_config('test.open', :'open', false), set_config('test.closed', :'closed', false),
  set_config('test.sale1', :'sale1', false), set_config('test.nosale', :'nosale', false) \gset

-- The cashier's device sends the shift, a sale in it and a no-sale opening; resending changes nothing.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare r text; begin
  r := sync_shift(current_setting('test.open')::jsonb);
  if r <> 'inserted' then raise exception 'FAIL: open shift %', r; end if;
  r := sync_shift(current_setting('test.open')::jsonb);
  if r <> 'unchanged' then raise exception 'FAIL: resent open shift %', r; end if;
  perform sync_sale(current_setting('test.sale1')::jsonb);
  if sync_sale(current_setting('test.sale1')::jsonb) <> 'duplicate' then raise exception 'FAIL: sale retry'; end if;
  r := sync_drawer_event(current_setting('test.nosale')::jsonb);
  if r <> 'inserted' then raise exception 'FAIL: no sale %', r; end if;
  r := sync_drawer_event(current_setting('test.nosale')::jsonb);
  if r <> 'duplicate' then raise exception 'FAIL: no sale retry %', r; end if;
  raise notice 'ok: shift, sale and no-sale opening sync once each';
end $$;

reset role;
do $$ begin
  if (select started_at from sales where id = '70000000-0000-0000-0000-000000000001') <> '2026-10-22T01:58:30Z'
     or (select shift_id from sales where id = '70000000-0000-0000-0000-000000000001') <> '90000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: sale start time or shift not stored';
  end if;
  raise notice 'ok: the sale keeps when it started and its shift';
end $$;
set role authenticated;

-- The Back Office sees the open shift with the sales synced so far.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare j jsonb; sh jsonb; begin
  j := office_shifts('2026-10-22', '2026-10-22', 'tok-josh');
  sh := j -> 'shifts' -> 0;
  if jsonb_array_length(j -> 'shifts') <> 1 or sh ->> 'closed_at' is not null or (sh ->> 'cash_sales')::bigint <> 32400
     or (sh ->> 'sale_count')::int <> 1 or sh ->> 'device_code' <> 'AB12'
     or sh -> 'sales' -> 0 ->> 'receipt_no' <> 'AB12-000001' or sh -> 'sales' -> 0 ->> 'started_at' is null
     or sh -> 'events' -> 0 ->> 'reason' <> 'Change for a customer' or sh -> 'events' -> 0 ->> 'approved_by' <> 'Josh' then
    raise exception 'FAIL: open shift in the Back Office %', j;
  end if;
  raise notice 'ok: Back Office shows the open shift, its sale times and the no-sale opening';
end $$;

-- Closing is written once; a later different close is ignored.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare r text; begin
  r := sync_shift(current_setting('test.closed')::jsonb);
  if r <> 'closed' then raise exception 'FAIL: close %', r; end if;
  r := sync_shift(jsonb_set(current_setting('test.closed')::jsonb, '{countedCash}', '999999'));
  if r <> 'unchanged' then raise exception 'FAIL: second close %', r; end if;
  raise notice 'ok: a shift closes once';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ declare sh jsonb; begin
  sh := office_shifts('2026-10-22', '2026-10-22', 'tok-josh') -> 'shifts' -> 0;
  if (sh ->> 'counted_cash')::bigint <> 132000 or (sh ->> 'expected_cash')::bigint <> 132400
     or sh ->> 'closed_by' <> 'Ana' or sh ->> 'note' <> 'Short 4 pesos' then
    raise exception 'FAIL: closed shift %', sh;
  end if;
  if jsonb_array_length(office_shifts('2026-10-23', '2026-10-30', 'tok-josh') -> 'shifts') <> 0
     or jsonb_array_length(office_shifts(null, '2026-10-30', 'tok-josh') -> 'shifts') <> 1 then
    raise exception 'FAIL: date filter';
  end if;
  raise notice 'ok: Back Office shows the cash count and filters by date';
end $$;

-- Without a Back Office session, or from another store, nothing is shown or written.
do $$ begin
  begin
    perform office_shifts('2026-10-22', '2026-10-22', 'wrong');
    raise exception 'FAIL: shifts without a session';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: shifts need a Back Office session';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
do $$ begin
  begin
    perform sync_shift(jsonb_set(current_setting('test.open')::jsonb, '{deviceId}', '"20000000-0000-0000-0000-000000000009"'));
    raise exception 'FAIL: other store wrote into a shift';
  exception when insufficient_privilege then null;
  end;
  begin
    perform sync_drawer_event(jsonb_set(current_setting('test.nosale')::jsonb, '{id}', '"91000000-0000-0000-0000-000000000009"'));
    raise exception 'FAIL: other store added a drawer opening';
  exception when foreign_key_violation then null;
  end;
  raise notice 'ok: another store cannot touch these shifts';
end $$;

-- Running the migration again keeps everything.
reset role;
\ir ../migrations/20261029000011_shifts.sql
do $$ begin
  if (select count(*) from cashier_shifts) <> 1 or (select count(*) from drawer_events) <> 1 then
    raise exception 'FAIL: re-running the migration lost data';
  end if;
  raise notice 'ok: migration 11 can run twice';
end $$;
