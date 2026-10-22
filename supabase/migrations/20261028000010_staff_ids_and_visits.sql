-- Employee IDs (QR badge + PIN; authenticator for owners and managers), Back Office
-- sessions, member visit counts at the counter, discount names in the sale-lines CSV.
-- Safe to run more than once: every statement replaces, re-creates or re-grants.

-- ---------------------------------------------------------------- member visits
-- How many sales each member has in the cloud, for the "visit #" shown when a
-- member card is scanned. Any active staff member of the store may read it.
create or replace function member_visits() returns table (customer_id uuid, visits integer, last_at timestamptz)
  language plpgsql stable security definer set search_path = public, extensions as $$
declare me staff_profiles := require_staff();
begin
  return query
  select s.customer_id, count(*)::integer, max(s.created_at)
  from sales s
  where s.store_id = me.store_id and s.customer_id is not null
  group by s.customer_id;
end $$;


-- ---------------------------------------------------------------- employee IDs
-- Each employee (owner to cashier) has an employee number, a QR badge and a
-- personal PIN. Owners and managers also link an authenticator app (TOTP).
-- The badge text is never stored: only its SHA-256. The PIN is hashed on the
-- device (PBKDF2) so devices can check it offline. Devices of the store
-- download these hashes and the authenticator secrets to work offline.
create table if not exists employees (
  id uuid primary key,
  store_id uuid not null references stores (id),
  employee_no text not null,
  name text not null check (length(name) between 1 and 40),
  role staff_role not null,
  active boolean not null default true,
  badge_hash text not null check (badge_hash ~ '^[0-9a-f]{64}$'),
  pin_salt text,
  pin_hash text,
  pin_iterations integer check (pin_iterations between 10000 and 10000000),
  totp_secret text check (totp_secret ~ '^[A-Z2-7]{16,64}$'),
  totp_confirmed_at timestamptz,
  totp_last_step bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (store_id, employee_no),
  unique (badge_hash)
);
alter table employees enable row level security;
revoke all on employees from anon, authenticated;

-- Back Office sessions opened with a badge and an authenticator code.
create table if not exists office_sessions (
  token_hash text primary key,
  store_id uuid not null references stores (id),
  employee_id uuid not null references employees (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table office_sessions enable row level security;
revoke all on office_sessions from anon, authenticated;

-- RFC 4648 base32 (authenticator secrets).
create or replace function base32_decode(s text) returns bytea
  language plpgsql immutable set search_path = public, extensions as $$
declare
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  bits text := '';
  v integer;
  out bytea := ''::bytea;
  i integer;
begin
  s := upper(replace(replace(s, ' ', ''), '=', ''));
  for i in 1 .. length(s) loop
    v := strpos(alphabet, substr(s, i, 1)) - 1;
    if v < 0 then raise exception 'not a base32 secret' using errcode = '22023'; end if;
    bits := bits || v::bit(5)::text;
  end loop;
  i := 1;
  while i + 7 <= length(bits) loop
    out := out || decode(lpad(to_hex(substr(bits, i, 8)::bit(8)::integer), 2, '0'), 'hex');
    i := i + 8;
  end loop;
  return out;
end $$;

-- RFC 6238 time-based code (30-second steps, 6 digits, HMAC-SHA1) as Google Authenticator makes it.
create or replace function totp_code(secret text, step bigint) returns text
  language plpgsql immutable set search_path = public, extensions as $$
declare
  h bytea := hmac(decode(lpad(to_hex(step), 16, '0'), 'hex'), base32_decode(secret), 'sha1');
  o integer := get_byte(h, 19) & 15;
  bin bigint;
begin
  bin := ((get_byte(h, o) & 127)::bigint << 24) | (get_byte(h, o + 1)::bigint << 16)
    | (get_byte(h, o + 2)::bigint << 8) | get_byte(h, o + 3)::bigint;
  return lpad((bin % 1000000)::text, 6, '0');
end $$;

-- Checks a code for the employee (one step of clock drift either way). A code
-- can be used once: the step is remembered so a seen code cannot be replayed.
create or replace function totp_accept(p_employee uuid, p_code text) returns boolean
  language plpgsql security definer set search_path = public, extensions as $$
declare
  e employees;
  now_step bigint := floor(extract(epoch from now()) / 30)::bigint;
  s bigint;
begin
  select * into e from employees where id = p_employee for update;
  if e.totp_secret is null or p_code !~ '^\d{6}$' then return false; end if;
  for s in now_step - 1 .. now_step + 1 loop
    if totp_code(e.totp_secret, s) = p_code and s > coalesce(e.totp_last_step, 0) then
      update employees set totp_last_step = s where id = e.id;
      return true;
    end if;
  end loop;
  return false;
end $$;

-- True while the store has no owner employee with a working authenticator:
-- the signed-in owner account may then set up the first owner ID.
create or replace function staff_setup_open(p_store uuid) returns boolean
  language sql stable security definer set search_path = public, extensions as $$
  select not exists (select 1 from employees where store_id = p_store and role = 'owner' and active
    and totp_confirmed_at is not null)
$$;

create or replace function office_status() returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare me staff_profiles := require_staff();
begin
  return jsonb_build_object('setupOpen', staff_setup_open(me.store_id), 'accountRole', me.role,
    'employees', (select count(*) from employees where store_id = me.store_id and active));
end $$;

-- The Back Office session behind p_token, for the signed-in account's store.
create or replace function require_office(p_token text) returns employees
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_staff();
  e employees;
begin
  select emp.* into e from office_sessions o join employees emp on emp.id = o.employee_id
  where o.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and o.expires_at > now()
    and o.store_id = me.store_id and emp.active and emp.role in ('owner', 'manager');
  if e.id is null then
    raise exception 'the Back Office is locked: scan your badge and enter your authenticator code' using errcode = '42501';
  end if;
  return e;
end $$;

-- Badge + authenticator code → a Back Office session (12 hours). Too many
-- wrong tries in 10 minutes locks the Back Office for the store for a while.
create or replace function office_unlock(p_badge text, p_code text) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_staff();
  e employees;
  v_token text := encode(gen_random_bytes(32), 'hex');
  v_fails integer;
begin
  select count(*) into v_fails from audit_logs
  where store_id = me.store_id and action = 'office_unlock_failed' and at > now() - interval '10 minutes';
  if v_fails >= 8 then
    return jsonb_build_object('error', 'Too many wrong tries. Wait 10 minutes and try again.');
  end if;
  select * into e from employees
  where badge_hash = encode(digest(coalesce(p_badge, ''), 'sha256'), 'hex') and store_id = me.store_id and active;
  if e.id is null or e.role not in ('owner', 'manager') or e.totp_confirmed_at is null
     or not totp_accept(e.id, trim(coalesce(p_code, ''))) then
    insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
    values (me.store_id, 'office_unlock_failed', 'employee', e.id, me.user_id, coalesce(e.name, me.display_name),
      jsonb_build_object('badgeKnown', e.id is not null));
    return jsonb_build_object('error', case
      when e.id is null then 'This badge is not known. Scan an owner or manager badge.'
      when e.role not in ('owner', 'manager') then 'Only owner and manager badges open the Back Office.'
      when e.totp_confirmed_at is null then 'This badge has no authenticator app linked yet.'
      else 'Wrong or used code. Wait for a new code in the authenticator app and try again.' end);
  end if;
  delete from office_sessions where expires_at < now();
  insert into office_sessions (token_hash, store_id, employee_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), me.store_id, e.id, now() + interval '12 hours');
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name)
  values (me.store_id, 'office_unlocked', 'employee', e.id, me.user_id, e.name);
  return jsonb_build_object('token', v_token, 'employeeId', e.id, 'employeeNo', e.employee_no, 'name', e.name,
    'role', e.role, 'expiresAt', now() + interval '12 hours');
end $$;

create or replace function office_lock(p_token text) returns void
  language sql security definer set search_path = public, extensions as $$
  delete from office_sessions where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

-- Owner (with an open Back Office) adds or edits an employee. While setup is
-- open, the signed-in owner account may create the first owner ID without a session.
-- Optional parts: badgeHash (new badge), pin {salt, hash, iterations}, totpSecret (new authenticator link).
create or replace function save_employee(p jsonb, p_token text) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_staff();
  actor text;
  v_id uuid := (p ->> 'id')::uuid;
  v_role staff_role := (p ->> 'role')::staff_role;
  v_name text := trim(coalesce(p ->> 'name', ''));
  v_no text;
  existing employees;
  e employees;
begin
  if p_token is null and staff_setup_open(me.store_id) and me.role = 'owner' and v_role = 'owner' then
    actor := me.display_name;
  else
    e := require_office(p_token);
    if e.role <> 'owner' then
      raise exception 'only the owner can add or change employees' using errcode = '42501';
    end if;
    actor := e.name;
  end if;
  if length(v_name) not between 1 and 40 then
    raise exception 'enter a name (up to 40 characters)' using errcode = '22023';
  end if;
  select * into existing from employees where id = v_id;
  if existing.id is not null and existing.store_id <> me.store_id then
    raise exception 'employee not found' using errcode = '42501';
  end if;
  if existing.id is null and p ->> 'badgeHash' is null then
    raise exception 'a new employee needs a badge' using errcode = '22023';
  end if;
  if existing.id is not null and existing.role = 'owner' and v_role <> 'owner' and not exists (
      select 1 from employees where store_id = me.store_id and role = 'owner' and active and id <> v_id) then
    raise exception 'the shop must keep at least one owner' using errcode = '22023';
  end if;
  if p ? 'pin' and coalesce(p -> 'pin' ->> 'hash', '') = '' then
    raise exception 'the PIN is missing' using errcode = '22023';
  end if;
  if existing.id is null then
    perform pg_advisory_xact_lock(hashtext('employee_no' || me.store_id::text));
    select 'E-' || lpad((coalesce(max(substr(employee_no, 3)::integer), 0) + 1)::text, 4, '0') into v_no
    from employees where store_id = me.store_id and employee_no ~ '^E-\d+$';
    insert into employees (id, store_id, employee_no, name, role, badge_hash, updated_by)
    values (v_id, me.store_id, coalesce(v_no, 'E-0001'), v_name, v_role, p ->> 'badgeHash', actor);
  end if;
  update employees set
    name = v_name,
    role = v_role,
    active = coalesce((p ->> 'active')::boolean, active),
    badge_hash = coalesce(p ->> 'badgeHash', badge_hash),
    pin_salt = case when p ? 'pin' then p -> 'pin' ->> 'salt' else pin_salt end,
    pin_hash = case when p ? 'pin' then p -> 'pin' ->> 'hash' else pin_hash end,
    pin_iterations = case when p ? 'pin' then (p -> 'pin' ->> 'iterations')::integer else pin_iterations end,
    totp_secret = case when v_role = 'cashier' then null when p ? 'totpSecret' then p ->> 'totpSecret' else totp_secret end,
    totp_confirmed_at = case when v_role = 'cashier' or p ? 'totpSecret' then null else totp_confirmed_at end,
    totp_last_step = case when v_role = 'cashier' or p ? 'totpSecret' then null else totp_last_step end,
    updated_at = now(),
    updated_by = actor
  where id = v_id
  returning * into e;
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
  values (me.store_id, case when existing.id is null then 'employee_added' else 'employee_changed' end, 'employee', v_id,
    me.user_id, actor, jsonb_build_object('employeeNo', e.employee_no, 'role', e.role, 'active', e.active,
      'newBadge', p ? 'badgeHash' and existing.id is not null, 'newPin', p ? 'pin', 'newAuthenticator', p ? 'totpSecret'));
  return jsonb_build_object('id', e.id, 'employeeNo', e.employee_no);
end $$;

-- Confirms the authenticator link with a code from the app (same rights as save_employee).
create or replace function confirm_totp(p_employee uuid, p_code text, p_token text) returns boolean
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me staff_profiles := require_staff();
  target employees;
  e employees;
begin
  select * into target from employees where id = p_employee and store_id = me.store_id;
  if target.id is null or target.totp_secret is null then
    raise exception 'set up the authenticator first' using errcode = '22023';
  end if;
  if not (p_token is null and staff_setup_open(me.store_id) and me.role = 'owner' and target.role = 'owner') then
    e := require_office(p_token);
    if e.role <> 'owner' then
      raise exception 'only the owner can link authenticator apps' using errcode = '42501';
    end if;
  end if;
  if not totp_accept(target.id, trim(coalesce(p_code, ''))) then
    return false;
  end if;
  update employees set totp_confirmed_at = now(), updated_at = now() where id = target.id;
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name)
  values (me.store_id, 'authenticator_linked', 'employee', target.id, me.user_id, target.name);
  return true;
end $$;

-- Employee list for the owner's Staff page (no secrets).
create or replace function office_employees(p_token text) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare e employees := require_office(p_token);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'employeeNo', employee_no, 'name', name, 'role', role,
      'active', active, 'hasPin', pin_hash is not null, 'authenticator', totp_confirmed_at is not null,
      'updatedAt', updated_at) order by active desc, employee_no), '[]'::jsonb)
    from employees where store_id = e.store_id);
end $$;

-- What devices download so staff can sign in at the counter offline: badge
-- and PIN hashes, and authenticator secrets of owners and managers.
create or replace function employees_feed() returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare me staff_profiles := require_staff();
begin
  return jsonb_build_object('now', now(), 'employees', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'employee_no', employee_no, 'name', name, 'role', role, 'active', active, 'badge_hash', badge_hash,
      'pin_salt', pin_salt, 'pin_hash', pin_hash, 'pin_iterations', pin_iterations,
      'totp_secret', case when totp_confirmed_at is not null and role in ('owner', 'manager') then totp_secret end,
      'updated_at', updated_at)), '[]'::jsonb)
    from employees where store_id = me.store_id));
end $$;

-- ---------------------------------------------------------------- Back Office functions need a session
-- Same reports as migration 9, now opened only with a badge and an authenticator code.
drop function if exists office_report(date, date);
drop function if exists record_expense(jsonb);
drop function if exists delete_expense(uuid);

create or replace function office_report(p_from date, p_to date, p_token text) returns jsonb
  language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me employees := require_office(p_token);
  v_from date := coalesce(p_from, (select min(business_date) from sales where store_id = me.store_id), p_to);
  v_to date := coalesce(p_to, (now() at time zone 'Asia/Manila')::date);
  v_days integer;
  v_out jsonb;
begin
  if v_from > v_to then
    raise exception 'the start date is after the end date' using errcode = '22023';
  end if;
  v_days := v_to - v_from + 1;
  if v_days > 3700 then
    v_from := v_to - 3699;
    v_days := 3700;
  end if;

  with
  s as (
    select * from sales where store_id = me.store_id and business_date between v_from and v_to
  ),
  li as (
    select i.*, s.business_date, s.customer_id, p.category_id,
      case when i.sale_unit = 'kg' then round(i.unit_cost * i.qty / 1000.0)::bigint else i.unit_cost * i.qty end as line_cost
    from sale_items i join s on s.id = i.sale_id left join products p on p.id = i.product_id
  ),
  e as (
    select * from expenses where store_id = me.store_id and spent_on between v_from and v_to
  ),
  stock as (
    select p.id, p.name, p.sale_unit, p.cost, p.min_stock_qty, c.name as category, coalesce(st.stock_qty, 0) as qty
    from products p
    join categories c on c.id = p.category_id
    left join store_stock() st on st.product_id = p.id
    where p.store_id = me.store_id and p.active
  ),
  mv as (
    select m.*, p.sale_unit from inventory_movements m join products p on p.id = m.product_id
    where m.store_id = me.store_id and (m.at at time zone 'Asia/Manila')::date between v_from and v_to
  ),
  member_sales as (
    select customer_id, count(*) as n, sum(total) as spent from s where customer_id is not null group by customer_id
  ),
  totals as (
    select count(*) as transactions, coalesce(sum(total), 0) as revenue, coalesce(sum(subtotal), 0) as gross_sales,
      coalesce(sum(discount_total), 0) as discounts, coalesce(sum(cost_total), 0) as cogs
    from s
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'days', v_days,
    'totals', (
      select jsonb_build_object(
        'revenue', t.revenue, 'grossSales', t.gross_sales, 'transactions', t.transactions,
        'average', case when t.transactions > 0 then round(t.revenue::numeric / t.transactions)::bigint else 0 end,
        'discounts', t.discounts, 'cogs', t.cogs, 'grossProfit', t.revenue - t.cogs,
        'expenses', (select coalesce(sum(amount), 0) from e),
        'netProfit', t.revenue - t.cogs - (select coalesce(sum(amount), 0) from e),
        'refunds', (select coalesce(sum(r.amount), 0) from refunds r join s on s.id = r.sale_id)
      ) from totals t
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', d.day::date, 'revenue', coalesce(x.revenue, 0), 'cogs', coalesce(x.cogs, 0),
        'transactions', coalesce(x.n, 0), 'discounts', coalesce(x.discounts, 0),
        'expenses', coalesce(y.amount, 0)) order by d.day), '[]'::jsonb)
      from generate_series(v_from, v_to, interval '1 day') d(day)
      left join (select business_date, sum(total) as revenue, sum(cost_total) as cogs, count(*) as n,
          sum(discount_total) as discounts from s group by business_date) x on x.business_date = d.day::date
      left join (select spent_on, sum(amount) as amount from e group by spent_on) y on y.spent_on = d.day::date
    ),
    'byCategory', (
      select coalesce(jsonb_agg(jsonb_build_object('name', name, 'revenue', revenue, 'cost', cost) order by revenue desc), '[]'::jsonb)
      from (select coalesce(c.name, 'Other') as name, sum(li.net) as revenue, sum(li.line_cost) as cost
        from li left join categories c on c.id = li.category_id group by 1) q
    ),
    'products', (
      select coalesce(jsonb_agg(jsonb_build_object('id', product_id, 'name', name, 'unit', sale_unit, 'qty', qty,
        'revenue', revenue, 'cost', cost, 'lines', lines) order by revenue desc), '[]'::jsonb)
      from (select li.product_id, max(li.product_name) as name, max(li.sale_unit::text) as sale_unit, sum(li.qty) as qty,
          sum(li.net) as revenue, sum(li.line_cost) as cost, count(*) as lines
        from li group by li.product_id) q
    ),
    'byPayment', (
      select coalesce(jsonb_agg(jsonb_build_object('method', payment_method, 'revenue', revenue, 'transactions', n)
        order by revenue desc), '[]'::jsonb)
      from (select payment_method, sum(total) as revenue, count(*) as n from s group by payment_method) q
    ),
    'byCashier', (
      select coalesce(jsonb_agg(jsonb_build_object('name', cashier_name, 'revenue', revenue, 'transactions', n,
        'discounts', discounts) order by revenue desc), '[]'::jsonb)
      from (select cashier_name, sum(total) as revenue, count(*) as n, sum(discount_total) as discounts
        from s group by cashier_name) q
    ),
    'byHour', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'revenue', coalesce(revenue, 0), 'transactions', coalesce(n, 0))
        order by h), '[]'::jsonb)
      from generate_series(0, 23) h
      left join (select extract(hour from created_at at time zone 'Asia/Manila')::int as hr, sum(total) as revenue,
          count(*) as n from s group by 1) q on q.hr = h
    ),
    'byWeekday', (
      select coalesce(jsonb_agg(jsonb_build_object('weekday', w, 'revenue', coalesce(revenue, 0),
        'transactions', coalesce(n, 0)) order by w), '[]'::jsonb)
      from generate_series(0, 6) w
      left join (select extract(dow from business_date)::int as dw, sum(total) as revenue, count(*) as n
        from s group by 1) q on q.dw = w
    ),
    'discounts', (
      select coalesce(jsonb_agg(jsonb_build_object('source', source, 'name', name, 'amount', amount, 'uses', uses)
        order by amount desc), '[]'::jsonb)
      from (select d.source, coalesce(pr.name, nullif(d.reason, ''), case when d.source = 'manual' then 'Manual discount'
            else 'Discount program' end) as name, sum(d.amount) as amount, count(distinct d.sale_id) as uses
        from sale_discounts d join s on s.id = d.sale_id left join promotions pr on pr.id = d.promotion_id
        group by 1, 2) q
    ),
    'expenses', (
      select jsonb_build_object(
        'byCategory', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'amount', amount)
            order by amount desc), '[]'::jsonb)
          from (select category, sum(amount) as amount from e group by category) q),
        'list', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'category', category, 'amount', amount,
            'spentOn', spent_on, 'note', note) order by spent_on desc, created_at desc), '[]'::jsonb)
          from (select * from e order by spent_on desc, created_at desc limit 500) q)
      )
    ),
    'members', (
      select jsonb_build_object(
        'total', (select count(*) from customers where store_id = me.store_id and active),
        'newInRange', (select count(*) from customers where store_id = me.store_id
          and (registered_at at time zone 'Asia/Manila')::date between v_from and v_to),
        'active', (select count(*) from member_sales),
        'repeat', (select count(*) from member_sales where n >= 2),
        'memberRevenue', (select coalesce(sum(total), 0) from s where customer_id is not null),
        'memberTransactions', (select count(*) from s where customer_id is not null),
        'promoOptIns', (select count(*) from customers where store_id = me.store_id and active and marketing_consent),
        'top', (select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'memberNo', c.member_no, 'visits', m.n,
            'spent', m.spent) order by m.spent desc), '[]'::jsonb)
          from (select * from member_sales order by spent desc limit 10) m join customers c on c.id = m.customer_id),
        'byGender', (select coalesce(jsonb_agg(jsonb_build_object('gender', g, 'members', n)), '[]'::jsonb)
          from (select coalesce(gender, 'undisclosed') as g, count(*) as n from customers
            where store_id = me.store_id and active group by 1) q),
        'byAge', (select coalesce(jsonb_agg(jsonb_build_object('band', band, 'members', n) order by band), '[]'::jsonb)
          from (select case when birth_year is null then 'Unknown'
                when extract(year from now()) - birth_year < 25 then 'Under 25'
                when extract(year from now()) - birth_year < 35 then '25-34'
                when extract(year from now()) - birth_year < 45 then '35-44'
                when extract(year from now()) - birth_year < 55 then '45-54'
                else '55+' end as band, count(*) as n
            from customers where store_id = me.store_id and active group by 1) q)
      )
    ),
    'inventory', (
      select jsonb_build_object(
        'stockValue', (select coalesce(sum(case when sale_unit = 'kg' then round(greatest(qty, 0) * cost / 1000.0)
            else greatest(qty, 0) * cost end), 0)::bigint from stock),
        'lowStock', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', sale_unit, 'qty', qty,
            'min', min_stock_qty, 'category', category) order by qty::numeric / greatest(min_stock_qty, 1)), '[]'::jsonb)
          from stock where min_stock_qty > 0 and qty <= min_stock_qty),
        'purchases', (select coalesce(sum(total_cost), 0) from purchases where store_id = me.store_id
          and (received_at at time zone 'Asia/Manila')::date between v_from and v_to),
        'losses', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'value', value, 'entries', n)
            order by value desc), '[]'::jsonb)
          from (select type, sum(case when sale_unit = 'kg' then round(-qty_delta * unit_cost / 1000.0)
              else -qty_delta * unit_cost end)::bigint as value, count(*) as n
            from mv where type in ('damage', 'spoilage', 'trim_loss') group by type) q)
      )
    ),
    'recent', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'receiptNo', receipt_no, 'at', created_at, 'total', total,
        'cashier', cashier_name, 'method', payment_method, 'member', customer_id is not null) order by created_at desc), '[]'::jsonb)
      from (select * from s order by created_at desc limit 15) q
    )
  ) into v_out;
  return v_out;
end $$;

create or replace function record_expense(p jsonb, p_token text) returns uuid
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me employees := require_office(p_token);
  v_id uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  v_amount bigint := (p ->> 'amount')::bigint;
  v_category text := p ->> 'category';
  v_on date := (p ->> 'spentOn')::date;
  v_note text := nullif(trim(coalesce(p ->> 'note', '')), '');
begin
  if v_amount is null or v_amount <= 0 or v_amount > 100000000000 then
    raise exception 'enter an amount above zero' using errcode = '22023';
  end if;
  if v_category not in ('utilities', 'rent', 'wages', 'packaging', 'transportation', 'repairs', 'other') then
    raise exception 'unknown expense category' using errcode = '22023';
  end if;
  if v_on is null or v_on > (now() at time zone 'Asia/Manila')::date + 1 then
    raise exception 'pick the date the money was spent' using errcode = '22023';
  end if;
  if length(v_note) > 200 then
    raise exception 'keep the note under 200 characters' using errcode = '22023';
  end if;
  if exists (select 1 from expenses where id = v_id and store_id <> me.store_id) then
    raise exception 'expense not found' using errcode = '42501';
  end if;

  insert into expenses (id, store_id, category, amount, spent_on, note, created_by)
  values (v_id, me.store_id, v_category, v_amount, v_on, v_note, auth.uid())
  on conflict (id) do update set category = excluded.category, amount = excluded.amount,
    spent_on = excluded.spent_on, note = excluded.note;

  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
  values (me.store_id, 'expense_saved', 'expense', v_id, auth.uid(), me.name,
    jsonb_build_object('category', v_category, 'amount', v_amount, 'spentOn', v_on));
  return v_id;
end $$;

create or replace function delete_expense(p_id uuid, p_token text) returns boolean
  language plpgsql security definer set search_path = public, extensions as $$
declare
  me employees := require_office(p_token);
  v_old expenses;
begin
  delete from expenses where id = p_id and store_id = me.store_id returning * into v_old;
  if not found then
    return false;
  end if;
  insert into audit_logs (store_id, action, entity, entity_id, by_user, by_name, detail)
  values (me.store_id, 'expense_deleted', 'expense', p_id, auth.uid(), me.name,
    jsonb_build_object('category', v_old.category, 'amount', v_old.amount, 'spentOn', v_old.spent_on));
  return true;
end $$;

-- ---------------------------------------------------------------- sale lines CSV
-- Adds which discount was given on each line: its own item discounts, then any
-- whole-order discount it shared in ("Suki 10% (whole sale)").
drop function if exists office_sales_lines(date, date);
drop function if exists office_sales_lines(date, date, text);
create function office_sales_lines(p_from date, p_to date, p_token text) returns table (
  business_date date, created_at timestamptz, receipt_no text, cashier text, payment_method text, member_no text,
  product text, category text, unit text, qty bigint, unit_price bigint, gross bigint, discount bigint, net bigint,
  cost bigint, item_discount bigint, order_discount_share bigint, discount_names text, discount_approved_by text
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me employees := require_office(p_token);
begin
  return query
  with named as (
    select d.sale_id, d.sale_item_id,
      coalesce(pr.name, nullif(d.reason, ''), case when d.source = 'manual' then 'Manual discount' else 'Discount program' end)
        || ' ' || case when d.kind = 'percent' then trim(trailing '.' from trim(trailing '0' from (d.value / 100.0)::numeric(10, 2)::text)) || '%'
          else '₱' || to_char(d.value / 100.0, 'FM999,999,990.00') end as label
    from sale_discounts d
    join sales s on s.id = d.sale_id
    left join promotions pr on pr.id = d.promotion_id
    where s.store_id = me.store_id and s.business_date between p_from and p_to
  )
  select s.business_date, s.created_at, s.receipt_no, s.cashier_name, s.payment_method::text, c.member_no,
    i.product_name, coalesce(cat.name, 'Other'), i.sale_unit::text, i.qty, i.unit_price, i.gross,
    i.item_discount + i.order_discount_share, i.net,
    case when i.sale_unit = 'kg' then round(i.unit_cost * i.qty / 1000.0)::bigint else i.unit_cost * i.qty end,
    i.item_discount, i.order_discount_share,
    nullif(concat_ws('; ',
      (select string_agg(n.label, ', ') from named n where n.sale_item_id = i.id),
      case when i.order_discount_share > 0 then
        (select string_agg(n.label || ' (whole sale)', ', ') from named n where n.sale_id = s.id and n.sale_item_id is null)
      end), ''),
    case when i.item_discount + i.order_discount_share > 0 then s.discount_approved_by end
  from sales s
  join sale_items i on i.sale_id = s.id
  left join customers c on c.id = s.customer_id
  left join products p on p.id = i.product_id
  left join categories cat on cat.id = p.category_id
  where s.store_id = me.store_id and s.business_date between p_from and p_to
  order by s.created_at, i.line_no
  limit 50000;
end $$;

-- Internal helpers: not callable through the API.
revoke all on function base32_decode(text) from public, anon, authenticated;
revoke all on function totp_code(text, bigint) from public, anon, authenticated;
revoke all on function totp_accept(uuid, text) from public, anon, authenticated;
revoke all on function staff_setup_open(uuid) from public, anon, authenticated;
revoke all on function require_office(text) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'member_visits()', 'office_sales_lines(date, date, text)', 'office_report(date, date, text)',
    'record_expense(jsonb, text)', 'delete_expense(uuid, text)', 'office_status()', 'office_unlock(text, text)',
    'office_lock(text)', 'save_employee(jsonb, text)', 'confirm_totp(uuid, text, text)', 'office_employees(text)',
    'employees_feed()'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

update schema_info set value = '20261028000010' where key = 'schema_version';
