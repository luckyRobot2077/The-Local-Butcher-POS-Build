# Database

## Local database (IndexedDB via Dexie) — implemented

Database name `local-butcher-pos`, local schema version **1** (`src/lib/db/db.ts`).

| Table | Key / indexes | Contents |
|---|---|---|
| `categories` | id, sortOrder | Pork, Beef, Chicken, Salmon by default |
| `products` | id, categoryId, name, active, sku, barcode | Master data, `price`/`cost` in centavos, `stockQty` projection, `version`, `serverVersion` (last synced) |
| `productImages` | id, productId, uploadStatus | Compressed JPEG blobs (≤800 px), `pending` until uploaded |
| `productRevisions` | id, productId, at | Before/after of changed fields per version |
| `priceChanges` | id, productId, at | Price/cost change log with user and reason |
| `sales` | id, &receiptNo, createdAt, businessDate, syncStatus | Sale headers |
| `saleItems` | id, saleId, productId | Price/cost/name snapshots, gross, discounts, net |
| `payments` | id, saleId | Method, amount, tendered, change, GCash reference |
| `inventoryMovements` | id, productId, type, at, refId | Append-only stock ledger |
| `outbox` | id, kind, status, entityId | Durable sync queue (sale, product, inventory_movement, product_image) |
| `auditLog` | id, action, at | Product edits, stock changes, discounts, prints |
| `config` | key | `device`, `settings`, `cashierName`, `managerPin` (hash), `receiptSeq`, `lastExportAt`, `cloud` (signed-in identity), `syncMeta` |

Future changes must add a new `this.version(n)` with an upgrade function; never edit version 1 in place.

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
