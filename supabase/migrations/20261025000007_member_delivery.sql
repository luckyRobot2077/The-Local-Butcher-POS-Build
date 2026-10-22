-- Optional home-delivery address for members. Kept only while the member
-- wants deliveries (their consent); turning it off removes the address.
-- Nothing is dropped or deleted: new columns, a check, and updated
-- versions of sync_customer and members_feed.

alter table customers add column wants_delivery boolean not null default false;
alter table customers add column delivery_consent_at timestamptz;
alter table customers add column delivery_address text check (length(delivery_address) <= 300);
alter table customers add column delivery_landmark text check (length(delivery_landmark) <= 150);
alter table customers add constraint customers_delivery_consent
  check ((wants_delivery and delivery_address is not null) or (not wants_delivery and delivery_address is null
    and delivery_landmark is null));

-- Same as migration 6, plus the delivery fields. A device still running the
-- previous app version sends no delivery keys; its edits leave them unchanged.
create or replace function sync_customer(p jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_id uuid := (p ->> 'id')::uuid;
  v_no text := upper(trim(p ->> 'memberNo'));
  v_contact text := nullif(p ->> 'contactNumber', '');
  v_promo boolean := coalesce((p ->> 'marketingConsent')::boolean, false);
  v_has_delivery boolean := p ? 'wantsDelivery';
  v_delivery boolean := coalesce((p ->> 'wantsDelivery')::boolean, false);
  v_address text := case when v_delivery then nullif(trim(p ->> 'deliveryAddress'), '') end;
  v_landmark text := case when v_delivery then nullif(trim(p ->> 'deliveryLandmark'), '') end;
  v_delivery_at timestamptz := case when v_delivery then
    coalesce(nullif(p ->> 'deliveryConsentAt', '')::timestamptz, now()) end;
  cur customers;
begin
  if coalesce(p ->> 'privacyConsentAt', '') = '' then
    raise exception 'a member needs their privacy consent recorded' using errcode = '22023';
  end if;
  if v_no !~ '^M-[A-Z0-9]{4}-[0-9]{4,}$' then
    raise exception 'member number % is not valid', v_no using errcode = '22023';
  end if;
  if (p ->> 'gender') not in ('female', 'male', 'other', 'undisclosed') then
    raise exception 'gender % is not valid', p ->> 'gender' using errcode = '22023';
  end if;
  if v_contact is not null and v_contact !~ '^\+639[0-9]{9}$' then
    raise exception 'mobile number must look like +639XXXXXXXXX' using errcode = '22023';
  end if;
  if v_promo and v_contact is null then
    raise exception 'promo messages need a mobile number' using errcode = '22023';
  end if;
  if v_delivery and v_address is null then
    raise exception 'home delivery needs an address' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer:' || v_id::text));
  select * into cur from customers where id = v_id;
  if found then
    if cur.store_id <> me.store_id then
      raise exception 'member belongs to another store' using errcode = '42501';
    end if;
    if cur.member_no is distinct from v_no then
      raise exception 'member numbers cannot change' using errcode = '22023';
    end if;
    if not v_has_delivery then
      v_delivery := cur.wants_delivery;
      v_address := cur.delivery_address;
      v_landmark := cur.delivery_landmark;
      v_delivery_at := cur.delivery_consent_at;
    end if;
    update customers set
      name = trim(p ->> 'name'),
      birth_year = (p ->> 'birthYear')::int,
      gender = p ->> 'gender',
      contact_number = v_contact,
      marketing_consent = v_promo,
      marketing_consent_at = nullif(p ->> 'marketingConsentAt', '')::timestamptz,
      wants_delivery = v_delivery,
      delivery_consent_at = v_delivery_at,
      delivery_address = v_address,
      delivery_landmark = v_landmark,
      active = coalesce((p ->> 'active')::boolean, true),
      notes = nullif(p ->> 'notes', ''),
      updated_at = now()
    where id = v_id and (name, birth_year, gender, contact_number, marketing_consent, marketing_consent_at,
        wants_delivery, delivery_consent_at, delivery_address, delivery_landmark, active, notes)
      is distinct from (trim(p ->> 'name'), (p ->> 'birthYear')::int, p ->> 'gender', v_contact, v_promo,
        nullif(p ->> 'marketingConsentAt', '')::timestamptz, v_delivery, v_delivery_at, v_address, v_landmark,
        coalesce((p ->> 'active')::boolean, true), nullif(p ->> 'notes', ''));
    return v_id;
  end if;

  if exists (select 1 from customers where store_id = me.store_id and member_no = v_no) then
    raise exception 'member number % is already used', v_no using errcode = '23505';
  end if;
  if not exists (select 1 from devices d where d.id = (p ->> 'deviceId')::uuid and d.store_id = me.store_id) then
    raise exception 'device not registered for this store' using errcode = '42501';
  end if;
  insert into customers (id, store_id, member_no, name, birth_year, gender, contact_number, registered_at,
    privacy_consent_at, marketing_consent, marketing_consent_at, wants_delivery, delivery_consent_at,
    delivery_address, delivery_landmark, active, notes, registered_by_name, device_id)
  values (v_id, me.store_id, v_no, trim(p ->> 'name'), (p ->> 'birthYear')::int, p ->> 'gender', v_contact,
    (p ->> 'registeredAt')::timestamptz, (p ->> 'privacyConsentAt')::timestamptz, v_promo,
    nullif(p ->> 'marketingConsentAt', '')::timestamptz, v_delivery, v_delivery_at, v_address, v_landmark,
    coalesce((p ->> 'active')::boolean, true), nullif(p ->> 'notes', ''), p ->> 'registeredBy',
    (p ->> 'deviceId')::uuid);
  return v_id;
end $$;

-- Same as migration 6, plus the delivery fields on each member.
create or replace function members_feed(p_since timestamptz) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  me staff_profiles := require_staff();
  v_since timestamptz := coalesce(p_since, '-infinity'::timestamptz);
begin
  return jsonb_build_object(
    'now', now(),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'member_no', c.member_no, 'name', c.name,
        'birth_year', c.birth_year, 'gender', c.gender, 'contact_number', c.contact_number,
        'privacy_consent_at', c.privacy_consent_at, 'marketing_consent', c.marketing_consent,
        'marketing_consent_at', c.marketing_consent_at, 'wants_delivery', c.wants_delivery,
        'delivery_consent_at', c.delivery_consent_at, 'delivery_address', c.delivery_address,
        'delivery_landmark', c.delivery_landmark, 'active', c.active, 'notes', c.notes,
        'registered_at', c.registered_at, 'registered_by', c.registered_by_name, 'device_id', c.device_id,
        'updated_at', c.updated_at))
      from customers c
      where c.store_id = me.store_id and c.member_no is not null and c.updated_at > v_since), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'description', p.description, 'kind', p.kind,
        'value', p.value, 'scope', p.scope, 'product_ids', to_jsonb(p.product_ids),
        'category_ids', to_jsonb(p.category_ids), 'members_only', p.members_only, 'min_purchase', p.min_purchase,
        'starts_on', p.starts_on, 'ends_on', p.ends_on, 'active', p.active, 'updated_by', p.updated_by_name,
        'updated_at', p.updated_at))
      from promotions p where p.store_id = me.store_id and p.updated_at > v_since), '[]'::jsonb)
  );
end $$;

-- create or replace keeps the grants set in migration 6.

update schema_info set value = '20261025000007' where key = 'schema_version';
