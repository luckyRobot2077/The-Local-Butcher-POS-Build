# Database

## Local database (IndexedDB via Dexie) — implemented

Database name `local-butcher-pos`, local schema version **3** (`src/lib/db/db.ts`). Version 2 (Phase 3)
adds the purchasing tables below and indexes movements by batch and purchase; version 3 (Phase 4) adds
members and discount programs and indexes sales by member. Dexie upgrades older data in place.

| Table | Key / indexes | Contents |
|---|---|---|
| `categories` | id, sortOrder | Pork, Beef, Chicken, Salmon by default |
| `products` | id, categoryId, name, active, sku, barcode | Master data, `price`/`cost` in centavos, `stockQty` projection, `version`, `serverVersion` (last synced) |
| `productImages` | id, productId, uploadStatus | Compressed JPEG blobs (≤800 px), `pending` until uploaded |
| `productRevisions` | id, productId, at | Before/after of changed fields per version |
| `priceChanges` | id, productId, at | Price/cost change log with user and reason |
| `sales` | id, &receiptNo, createdAt, businessDate, syncStatus, customerId | Sale headers; member sales carry `customerId` and a `memberNo` snapshot |
| `saleItems` | id, saleId, productId | Price/cost/name snapshots, gross, discounts, net |
| `payments` | id, saleId | Method, amount, tendered, change, GCash reference |
| `inventoryMovements` | id, productId, type, at, refId, batchId, purchaseId | Append-only stock ledger; `remote` marks rows downloaded from other devices |
| `suppliers` | id, name | Supplier directory |
| `purchases` | id, supplierId, receivedAt | Supplier deliveries; only `paymentStatus` changes later |
| `purchaseItems` | id, purchaseId, productId, batchId | Quantity, unit cost, line cost |
| `batches` | id, productId, purchaseId, useBy | One per purchase line: code, received, use-by, storage note, initial quantity, cost |
| `remoteSaleLines` | id, saleId, productId, at, customerId | Sale lines from other devices, for profit, movement and member reports |
| `members` | id, &memberNo, name, updatedAt | Members: number, name, birth year, gender, mobile (+639…), privacy consent time, promo consent and time, optional delivery address and landmark (only while `wantsDelivery`), active |
| `programs` | id, updatedAt | Discount programs: percent/fixed, whole sale or items (products, categories), members only, minimum purchase, dates, on/off |
| `outbox` | id, kind, status, entityId | Durable sync queue (sale, product, inventory_movement, product_image, supplier, purchase, purchase_payment, customer, promotion) |
| `auditLog` | id, action, at | Product edits, stock changes, discounts, prints |
| `config` | key | `device`, `settings`, `cashierName`, `managerPin` (hash), `receiptSeq`, `memberSeq`, `lastExportAt`, `cloud` (signed-in identity), `syncMeta` |

Future changes must add a new `this.version(n)` (with an upgrade function when data must change); never edit an existing version in place.

## Cloud database (Supabase PostgreSQL) — migrations written and tested locally

`supabase/migrations/`:

1. `20261021000001_initial_schema.sql` — all tables from spec §18: stores, staff_profiles (role +
   per-field product edit permissions + discount limit), devices, settings, cashier_shifts,
   cash_movements, categories, products, product_images, product_revisions, product_prices, suppliers,
   purchases, purchase_items, inventory_batches (with `parent_batch_id` for future carcass-to-cut
   conversion), inventory_movements (append-only ledger), customers (no tiers; separate marketing
   consent), promotions, promotion_rules, sales, sale_items, sale_discounts, payments, refunds,
   refund_items, expenses, audit_logs, sync_receipts, backup_manifests, schema_info; view `product_stock`.
   CHECK constraints enforce money arithmetic (e.g. `total = subtotal − discount_total`,
   `change = tendered − total`, `net = gross − discounts`) and movement signs. Triggers make sales,
   sale items, payments, the stock ledger, price history, refunds and audit logs immutable.
2. `20261021000002_security.sql` — RLS on every table, `anon` has no access, helper functions
   `current_staff()`, `has_role()`, `my_store()`, role policies, and **`sync_sale(payload)`**: an
   idempotent, atomic, security-definer function that writes a sale with items, payment and stock
   movements. Same payload twice → `duplicate`; different payload with the same id → rejected.

3. `20261022000003_device_sync.sql` (Phase 2) — `bootstrap_owner` (first account creates the store and
   becomes owner; refused once a store exists), `add_staff`, `whoami`, `register_device`, `sync_category`
   (merge by name), `sync_product` (version check, per-field permission check, revisions and price log),
   `sync_product_image`, `sync_movement` (owner/manager only, idempotent), `store_stock`, and a new
   `sync_sale` that also stores discount details in `sale_discounts`.
4. `20261022000004_storage.sql` (Phase 2) — private `product-images` bucket; staff can read their store's
   folder; only photo editors can upload; no overwrite or delete.

Tested on plain PostgreSQL 16 with a small stub of Supabase's `auth` and `storage` schemas:
`npm run test:db` runs `supabase/tests/schema_test.sql` and `supabase/tests/sync_test.sql`, each on a
fresh database with all migrations applied.

To apply to a real project later: `supabase link --project-ref <ref>` then `supabase db push`.

Timestamps are `timestamptz` (UTC). `business_date` is the Asia/Manila calendar date.

### Phase 3 — `20261023000005_inventory.sql`

- Columns: `suppliers.updated_at`; `purchases.notes`, `by_name`, `device_id`, `synced_at`, `updated_at`;
  `inventory_batches.store_id`, `purchase_id`, `synced_at`; indexes for the feed.
- Immutability: purchase lines and batches cannot change; a purchase may change only its payment status.
- Read policies: owner and manager read suppliers, purchases, purchase lines and batches (cashiers cannot).
- Functions (security definer, role checked inside): `require_manager()`, `sync_supplier(p)` (upsert,
  same-name merge), `sync_purchase(payload)` (purchase + batches + lines + `purchase` movements in one
  transaction; idempotent via `sync_receipts`; line cost must equal quantity × unit cost, half-up for kg),
  `set_purchase_payment(id, status)`, `sync_movement(m)` replaced to accept `batchId` and refuse
  `purchase` movements, `inventory_feed(since, device)` (other devices' suppliers, purchases, lines,
  batches, movements and sale lines changed after `since`, for owner/manager reports).

### Phase 4 — `20261024000006_members.sql`

- `customers`: `member_no` (unique per store), `gender`, `birth_year`, `privacy_consent_at`,
  `registered_by_name`, `device_id`, `updated_at`; mobile must be `+639XXXXXXXXX`; promo consent needs a
  mobile number. Direct inserts are closed; members are written only by `sync_customer(p)` (any staff;
  member number and registration time never change).
- `promotions` (discount programs): `description`, `scope` (order/items, items must be percent),
  `product_ids`, `category_ids`, `members_only`, `min_purchase`, `starts_on`, `ends_on`, `updated_at`.
  Written by `sync_promotion(p)` (owner/manager).
- `members_feed(since)`: members and programs changed since `since`, for every staff device.
- `sync_sale` replaced: stores `customer_id` (refused if the member is not in the cloud yet) and, for
  program discounts, `source = 'promotion'` with `promotion_id`. Payloads without these keys are stored as before.
- `inventory_feed` replaced: sale lines include `customer_id` for member history on owner/manager devices.

### `20261025000007_member_delivery.sql`

- `customers.wants_delivery`, `delivery_consent_at`, `delivery_address` (≤300), `delivery_landmark` (≤150);
  a check keeps the address only while `wants_delivery` is on.
- `sync_customer` and `members_feed` replaced to carry these fields. A payload without `wantsDelivery`
  (older app) leaves them unchanged; turning delivery off clears the address.


### `20261026000008_sync_digest_fix.sql`

- `sync_sale` and `sync_purchase` now use `search_path = public, extensions`. Supabase installs pgcrypto
  (`digest`) in the `extensions` schema, so before this every sale and purchase upload failed with
  "function digest(text, unknown) does not exist". The migration tests now install pgcrypto the same way.

### `20261027000009_back_office.sql`

Safe to run more than once (every statement is `create or replace` or a re-grant).

- `office_report(p_from date, p_to date) → jsonb`: everything the Back Office dashboard shows for a range
  of business dates (`p_from` null = from the first sale): totals (sales, transactions, average,
  discounts, cost of goods, gross profit, expenses, net operating profit), a daily series, sales and
  cost by category and product, payment method, cashier, hour and weekday (Asia/Manila), discounts by
  program/reason, expenses, member insights (active, repeat, new, member share, top members, age and
  gender), inventory (stock value at cost, purchases, waste, low stock) and recent sales.
  Owner and manager only (`require_manager()`), always limited to the caller's store.
- `office_sales_lines(p_from, p_to)`: every sale line with cost, for the CSV export (max 50,000 rows).
- `record_expense(p jsonb) → uuid` (upsert by id, so a retry is harmless) and `delete_expense(id)`;
  owner/manager only, both written to `audit_logs`.
- Line cost for kg products is `round(unit_cost × grams / 1000)`.
