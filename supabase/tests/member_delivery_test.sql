-- Behavioural tests for the member delivery address (migration 7).
\set ON_ERROR_STOP on

insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'cashier@example.test');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  perform bootstrap_owner('The Local Butcher', 'Josh');
  perform add_staff('cashier@example.test', 'Ana', 'cashier');
  perform register_device('20000000-0000-0000-0000-000000000001', 'AB12', 'Counter');
end $$;

\set member '{"id":"80000000-0000-0000-0000-000000000001","memberNo":"M-AB12-0001","name":"Maria Santos","birthYear":1988,"gender":"female","contactNumber":"+639171234567","privacyConsentAt":"2026-10-22T01:00:00Z","marketingConsent":false,"marketingConsentAt":"","wantsDelivery":true,"deliveryConsentAt":"2026-10-22T01:00:00Z","deliveryAddress":"12 Mabini St, Brgy San Isidro, Quezon City","deliveryLandmark":"green gate","active":true,"notes":"","registeredAt":"2026-10-22T01:00:00Z","registeredBy":"Ana","deviceId":"20000000-0000-0000-0000-000000000001"}'
select set_config('test.member', :'member', false) \gset

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ declare f jsonb; begin
  perform sync_customer(current_setting('test.member')::jsonb);
  if (select wants_delivery and delivery_address = '12 Mabini St, Brgy San Isidro, Quezon City'
        and delivery_landmark = 'green gate' and delivery_consent_at is not null from customers) is not true then
    raise exception 'FAIL: delivery address not stored';
  end if;
  f := members_feed(null);
  if f -> 'customers' -> 0 ->> 'delivery_address' is null or f -> 'customers' -> 0 ->> 'wants_delivery' <> 'true' then
    raise exception 'FAIL: feed has no delivery address';
  end if;
  raise notice 'ok: member with home delivery stored and shared with devices';
end $$;

-- A device on the previous app version sends no delivery keys: the address is kept.
do $$ begin
  perform sync_customer((current_setting('test.member')::jsonb - 'wantsDelivery' - 'deliveryConsentAt'
    - 'deliveryAddress' - 'deliveryLandmark') || '{"name":"Maria S."}');
  if (select name || '|' || delivery_address from customers) <> 'Maria S.|12 Mabini St, Brgy San Isidro, Quezon City' then
    raise exception 'FAIL: older app edit changed the address';
  end if;
  raise notice 'ok: edits from older app versions keep the address';
end $$;

-- Delivery needs an address.
do $$ begin
  perform sync_customer(jsonb_set(jsonb_set(current_setting('test.member')::jsonb, '{id}',
    '"80000000-0000-0000-0000-000000000002"'), '{deliveryAddress}', '" "') || '{"memberNo":"M-AB12-0002"}');
  raise exception 'FAIL: delivery without an address accepted';
exception when invalid_parameter_value then raise notice 'ok: home delivery needs an address';
end $$;

-- Turning delivery off removes the address and landmark, even if the device still sent them.
do $$ begin
  perform sync_customer(jsonb_set(current_setting('test.member')::jsonb, '{wantsDelivery}', 'false'));
  if (select wants_delivery or delivery_address is not null or delivery_landmark is not null
        or delivery_consent_at is not null from customers) then
    raise exception 'FAIL: address kept after delivery was turned off';
  end if;
  raise notice 'ok: turning delivery off removes the address';
end $$;

-- The table itself refuses an address without delivery consent.
reset role;
do $$ begin
  update customers set delivery_address = 'x';
  raise exception 'FAIL: address without consent accepted';
exception when check_violation then raise notice 'ok: no address stored without delivery consent';
end $$;

do $$ begin
  if (select value from schema_info where key = 'schema_version') <> '20261025000007' then
    raise exception 'FAIL: schema version';
  end if;
  raise notice 'ok: schema version 20261025000007';
end $$;
