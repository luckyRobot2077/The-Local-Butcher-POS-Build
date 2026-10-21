-- The Local Butcher POS: initial cloud schema (Supabase PostgreSQL).
-- Money is integer centavos (bigint). Weights are integer grams; piece
-- products use whole pieces in the same quantity columns.
-- Timestamps are timestamptz (UTC); business dates are Asia/Manila.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
create type staff_role as enum ('owner', 'manager', 'cashier');
create type sale_unit as enum ('kg', 'piece');
create type payment_method as enum ('cash', 'gcash');
create type movement_type as enum (
  'sale', 'delivery', 'purchase', 'return', 'correction', 'damage', 'spoilage', 'trim_loss', 'refund', 'other'
);
create type discount_kind as enum ('percent', 'fixed');

-- ---------------------------------------------------------------- store & staff
create table stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  timezone text not null default 'Asia/Manila',
  created_at timestamptz not null default now()
);

create table staff_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  store_id uuid not null references stores (id),
  display_name text not null check (length(display_name) between 1 and 40),
  role staff_role not null,
  -- Fine-grained product edit permissions granted by the owner.
  can_edit_photos boolean not null default false,
  can_edit_descriptions boolean not null default false,
  can_edit_names boolean not null default false,
  can_edit_prices boolean not null default false,
  can_edit_categories boolean not null default false,
  discount_limit_bp integer not null default 1000 check (discount_limit_bp between 0 and 10000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table devices (
  id uuid primary key,
  store_id uuid not null references stores (id),
  device_code text not null check (device_code ~ '^[A-Z0-9]{4}$'),
  label text,
  registered_by uuid references auth.users (id),
  registered_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (store_id, device_code)
);

create table settings (
  store_id uuid primary key references stores (id),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

create table cashier_shifts (
  id uuid primary key,
  store_id uuid not null references stores (id),
  device_id uuid not null references devices (id),
  opened_by uuid not null references auth.users (id),
  opened_at timestamptz not null,
  opening_float bigint not null check (opening_float >= 0),
  closed_by uuid references auth.users (id),
  closed_at timestamptz,
  counted_cash bigint check (counted_cash >= 0),
  expected_cash bigint,
  confirmed_by uuid references auth.users (id),
  check (closed_at is null or closed_at >= opened_at)
);

create table cash_movements (
  id uuid primary key,
  shift_id uuid not null references cashier_shifts (id),
  amount bigint not null check (amount <> 0),
  reason text not null check (length(reason) between 1 and 200),
  at timestamptz not null,
  by_user uuid not null references auth.users (id)
);

-- ---------------------------------------------------------------- catalog
create table categories (
  id uuid primary key,
  store_id uuid not null references stores (id),
  name text not null check (length(name) between 1 and 40),
  sort_order integer not null default 0,
  unique (store_id, name)
);

create table products (
  id uuid primary key,
  store_id uuid not null references stores (id),
  category_id uuid not null references categories (id),
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 500),
  sku text check (length(sku) <= 40),
  barcode text check (length(barcode) <= 40),
  sale_unit sale_unit not null,
  price bigint not null check (price between 0 and 1000000000),
  cost bigint not null check (cost between 0 and 1000000000),
  min_stock_qty bigint not null default 0 check (min_stock_qty >= 0),
  active boolean not null default true,
  image_id uuid,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (store_id, sku),
  unique (store_id, barcode)
);
create index products_category_idx on products (category_id);

create table product_images (
  id uuid primary key,
  product_id uuid not null references products (id),
  storage_path text not null unique,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_at timestamptz not null,
  created_by uuid references auth.users (id)
);
alter table products add constraint products_image_fk foreign key (image_id) references product_images (id);

create table product_revisions (
  id uuid primary key,
  product_id uuid not null references products (id),
  version integer not null,
  changed_fields text[] not null,
  before jsonb,
  after jsonb not null,
  by_user uuid references auth.users (id),
  by_name text not null,
  at timestamptz not null,
  device_id uuid references devices (id),
  unique (product_id, version)
);

create table product_prices (
  id uuid primary key,
  product_id uuid not null references products (id),
  field text not null check (field in ('price', 'cost')),
  old_value bigint not null check (old_value >= 0),
  new_value bigint not null check (new_value >= 0),
  reason text,
  by_user uuid references auth.users (id),
  by_name text not null,
  at timestamptz not null
);
create index product_prices_product_idx on product_prices (product_id, at desc);

-- ---------------------------------------------------------------- purchasing & inventory
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id),
  name text not null check (length(name) between 1 and 80),
  contact text,
  notes text,
  active boolean not null default true
);

create table purchases (
  id uuid primary key,
  store_id uuid not null references stores (id),
  supplier_id uuid not null references suppliers (id),
  received_at timestamptz not null,
  reference text,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'partial', 'paid')),
  total_cost bigint not null check (total_cost >= 0),
  created_by uuid references auth.users (id)
);

create table inventory_batches (
  id uuid primary key,
  product_id uuid not null references products (id),
  -- Source batch for carcass-to-cut conversion (later phase).
  parent_batch_id uuid references inventory_batches (id),
  batch_code text,
  received_at timestamptz not null,
  use_by date,
  storage_note text,
  initial_qty bigint not null check (initial_qty > 0),
  unit_cost bigint not null check (unit_cost >= 0)
);

create table purchase_items (
  id uuid primary key,
  purchase_id uuid not null references purchases (id),
  product_id uuid not null references products (id),
  batch_id uuid references inventory_batches (id),
  qty bigint not null check (qty > 0),
  unit_cost bigint not null check (unit_cost >= 0),
  line_cost bigint not null check (line_cost >= 0)
);

-- Append-only stock ledger. Current stock = sum(qty_delta).
create table inventory_movements (
  id uuid primary key,
  store_id uuid not null references stores (id),
  product_id uuid not null references products (id),
  batch_id uuid references inventory_batches (id),
  type movement_type not null,
  qty_delta bigint not null check (qty_delta <> 0),
  unit_cost bigint not null check (unit_cost >= 0),
  ref_type text,
  ref_id uuid,
  reason text,
  batch_code text,
  use_by date,
  by_user uuid references auth.users (id),
  by_name text not null,
  at timestamptz not null,
  device_id uuid references devices (id),
  received_at timestamptz not null default now(),
  check (type not in ('delivery', 'purchase', 'return') or qty_delta > 0),
  check (type not in ('sale', 'damage', 'spoilage', 'trim_loss') or qty_delta < 0),
  check (type not in ('correction', 'other') or reason is not null)
);
create index inventory_movements_product_idx on inventory_movements (product_id, at);

create view product_stock with (security_invoker = true) as
  select product_id, sum(qty_delta)::bigint as stock_qty, max(at) filter (where qty_delta > 0) as last_restock_at
  from inventory_movements group by product_id;

-- ---------------------------------------------------------------- customers & promotions (no tiers)
create table customers (
  id uuid primary key,
  store_id uuid not null references stores (id),
  name text not null check (length(name) between 1 and 80),
  contact_number text,
  birthday date,
  registered_at timestamptz not null,
  marketing_consent boolean not null default false,
  marketing_consent_at timestamptz,
  active boolean not null default true,
  notes text
);

create table promotions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id),
  name text not null,
  kind discount_kind not null,
  value bigint not null check (value >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  stackable boolean not null default false,
  requires_online_redemption boolean not null default false,
  active boolean not null default true,
  check (kind <> 'percent' or value <= 10000),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table promotion_rules (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references promotions (id) on delete cascade,
  members_only boolean not null default false,
  customer_id uuid references customers (id),
  product_id uuid references products (id),
  category_id uuid references categories (id),
  min_purchase bigint check (min_purchase >= 0),
  min_qty bigint check (min_qty > 0),
  max_uses_per_customer integer check (max_uses_per_customer > 0)
);

-- ---------------------------------------------------------------- sales (immutable)
create table sales (
  id uuid primary key, -- generated on the device; the sync idempotency key
  store_id uuid not null references stores (id),
  device_id uuid not null references devices (id),
  shift_id uuid references cashier_shifts (id),
  receipt_no text not null,
  cashier_user uuid references auth.users (id),
  cashier_name text not null,
  customer_id uuid references customers (id),
  created_at timestamptz not null,
  business_date date not null,
  subtotal bigint not null check (subtotal >= 0),
  item_discount_total bigint not null check (item_discount_total >= 0),
  order_discount bigint not null check (order_discount >= 0),
  discount_total bigint not null check (discount_total = item_discount_total + order_discount),
  total bigint not null check (total >= 0 and total = subtotal - discount_total),
  cost_total bigint not null check (cost_total >= 0),
  payment_method payment_method not null,
  tendered bigint not null check (tendered >= total),
  change bigint not null check (change = tendered - total),
  discount_approved_by text,
  -- Fiscal (BIR) invoice numbering is separate and not implemented yet.
  fiscal_invoice_no text,
  received_at timestamptz not null default now(),
  unique (store_id, receipt_no)
);
create index sales_business_date_idx on sales (store_id, business_date);

create table sale_items (
  id uuid primary key,
  sale_id uuid not null references sales (id),
  line_no integer not null check (line_no > 0),
  product_id uuid not null references products (id),
  product_name text not null,
  sale_unit sale_unit not null,
  unit_price bigint not null check (unit_price >= 0),
  unit_cost bigint not null check (unit_cost >= 0),
  qty bigint not null check (qty > 0),
  gross bigint not null check (gross >= 0),
  item_discount bigint not null check (item_discount between 0 and gross),
  order_discount_share bigint not null check (order_discount_share >= 0),
  net bigint not null check (net >= 0 and net = gross - item_discount - order_discount_share),
  unique (sale_id, line_no)
);
create index sale_items_product_idx on sale_items (product_id);

create table sale_discounts (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id),
  sale_item_id uuid references sale_items (id),
  source text not null check (source in ('manual', 'promotion')),
  promotion_id uuid references promotions (id),
  kind discount_kind not null,
  value bigint not null check (value >= 0),
  amount bigint not null check (amount >= 0),
  reason text,
  approved_by text
);

create table payments (
  id uuid primary key,
  sale_id uuid not null references sales (id),
  method payment_method not null,
  amount bigint not null check (amount >= 0),
  tendered bigint not null check (tendered >= amount),
  change bigint not null check (change = tendered - amount),
  reference text
);

create table refunds (
  id uuid primary key,
  sale_id uuid not null references sales (id),
  amount bigint not null check (amount > 0),
  reason text not null,
  approved_by uuid not null references auth.users (id),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null
);

create table refund_items (
  id uuid primary key,
  refund_id uuid not null references refunds (id),
  sale_item_id uuid not null references sale_items (id),
  qty bigint not null check (qty > 0),
  amount bigint not null check (amount >= 0),
  restock boolean not null default false
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id),
  category text not null check (category in ('utilities', 'rent', 'wages', 'packaging', 'transportation', 'repairs', 'other')),
  amount bigint not null check (amount > 0),
  spent_on date not null,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- audit, sync, backups
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id),
  action text not null,
  entity text not null,
  entity_id uuid,
  by_user uuid references auth.users (id),
  by_name text,
  at timestamptz not null default now(),
  device_id uuid references devices (id),
  detail jsonb
);
create index audit_logs_at_idx on audit_logs (store_id, at desc);

create table sync_receipts (
  entity text not null,
  entity_id uuid not null,
  device_id uuid not null references devices (id),
  payload_sha256 text not null,
  received_at timestamptz not null default now(),
  primary key (entity, entity_id)
);

create table backup_manifests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id),
  kind text not null check (kind in ('cloud_full', 'device', 'scheduled')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  schema_version text not null,
  counts jsonb not null,
  sha256 text not null,
  verified_at timestamptz
);

create table schema_info (
  key text primary key,
  value text not null
);
insert into schema_info values ('schema_version', '20261021000001');

-- ---------------------------------------------------------------- immutability
create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% rows are immutable; record a reversing entry instead', tg_table_name
    using errcode = 'P0001';
end $$;

create trigger sales_immutable before update or delete on sales for each row execute function forbid_change();
create trigger sale_items_immutable before update or delete on sale_items for each row execute function forbid_change();
create trigger payments_immutable before update or delete on payments for each row execute function forbid_change();
create trigger inventory_movements_immutable before update or delete on inventory_movements for each row execute function forbid_change();
create trigger product_prices_immutable before update or delete on product_prices for each row execute function forbid_change();
create trigger audit_logs_immutable before update or delete on audit_logs for each row execute function forbid_change();
create trigger refunds_immutable before update or delete on refunds for each row execute function forbid_change();
