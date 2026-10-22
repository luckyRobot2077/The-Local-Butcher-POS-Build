# Changelog

## 0.4.0 — 2026-10-22 — Phase 4: members and discount programs

### Added
- POS → Members with Members, Discount programs and Insights tabs.
- Member registration: name, age (stored as birth year), gender, optional mobile number (normalised to
  +639…), required privacy consent and optional consent to promo texts. The member number
  (`M-<device>-<seq>`) and QR code are made on save; the card is drawn at ID-card size and can be printed
  or saved as a PNG.
- Camera QR scanner built into the app (the browser's barcode reader where available, jsQR otherwise),
  plus USB scanner or typed lookup by number, name or mobile.
- Members attached to sales (receipt shows the member number); purchase history per member.
- Discount programs: percent or pesos, whole sale or selected products/categories (percent), members
  only, minimum purchase, start/end dates, on/off. Cashiers pick one from a list at checkout; program
  discounts do not need the manager PIN. Receipts print the program name.
- Insights (manager PIN): members by gender and age band, member share of sales and revenue, top
  members, and a CSV of members who agreed to promo texts for an SMS provider.
- Supabase migration 6: member and program columns and checks, `sync_customer`, `sync_promotion`,
  `members_feed`, `sync_sale` with member and program, `inventory_feed` with the member per sale line.
- Local database schema version 3 (members, programs, sales by member).
- Tests: 13 unit tests, 7 database and sync tests, 18 PostgreSQL checks, 2 browser tests (one scans a QR
  code through Chromium's fake camera).

### Changed
- Typed discounts still need the manager PIN above the cashier limit; program discounts do not count
  toward that limit.

## 0.3.0 — 2026-10-23 — Phase 3: inventory management

### Added
- POS → Inventory (manager PIN) with Alerts, Receive, Purchases, Movement and Rules tabs.
- Supplier deliveries: one transaction writes the purchase, a batch per line (code, use-by, storage
  note), purchase stock movements and the stock projection, and optionally moves product cost to the
  weighted average. Payment status (not paid, partly, paid) is the only thing editable afterwards.
- Losses (spoilage, damage, trimming) can name the batch they came from.
- `src/domain/inventory.ts`: daily stock series, sales per day over in-stock days only, coverage,
  sell-through, days since last sale, 7-vs-28-day demand trend, wastage rate and trend, gross profit,
  classification within category and unit with configurable thresholds, batch estimates (earliest
  use-by sold first), expiry and movement alerts kept separate, order estimates capped by shelf life.
- Product details show last restock and batches on hand.
- Supabase migration 5: supplier, purchase and payment sync functions, batch-aware `sync_movement`,
  `inventory_feed` (other devices' purchases, batches, movements and sale lines for owner/manager
  reports), read policies, immutable purchase lines and batches.
- Local database schema version 2 (suppliers, purchases, purchase items, batches, sale lines from
  other devices); existing data is kept on upgrade.
- Tests: 12 analytics unit tests, 8 inventory database and sync tests, 17 PostgreSQL checks, 1 browser test.

### Changed
- A missing cloud function now reads "the cloud database needs an update" instead of a raw error, and a
  refused inventory download no longer stops sales from syncing.

## 0.2.0 — 2026-10-22 — Phase 2: cloud sync

### Added
- Supabase migrations 3 and 4: owner bootstrap, staff, device registration, catalog/photo/stock sync
  functions with server-side permission checks, sale discount details, private photo bucket.
- Sync engine (`src/lib/cloud`): outbox push with retry, idempotent sales, catalog and stock pull,
  photo upload/download, product version conflicts with keep-mine / use-cloud choices.
- Device tab: sign in, set up store as owner, add staff, sync status with retry; header badge for sync problems.
- Tests: 6 sync-engine tests, 1 browser test against a faked Supabase, 21 more PostgreSQL checks.

### Changed
- Signed-in staff name is used as the cashier name.
- "Not synced" count includes sales whose sync failed.

## 0.1.0 — 2026-10-21 — Phase 0 and Phase 1

### Added
- Next.js 16 / React 19 / Tailwind 4 / TypeScript project with brand design tokens.
- Domain rules in `src/domain`: centavo money, gram weights, documented half-up rounding, percent and
  fixed discounts with stacking policy and exact allocation, cart pricing, checkout and change,
  58 mm receipt renderer.
- Dexie (IndexedDB) local database: products, photos, revisions, price log, sales, items, payments,
  inventory ledger, sync outbox, audit log, device config.
- Atomic local checkout with sequential per-device receipt numbers.
- POS screens: Sell, Products (editing in POS mode with camera/gallery photos), History, Device.
- Manager PIN (PBKDF2) for product edits, stock changes, large discounts, settings and backups.
- Encrypted (AES-256-GCM) device backup export and verification.
- Hand-written service worker and web app manifest: installable, opens and sells offline.
- `/api/health` reachability probe; Online/Offline and unsynced count in the header.
- Supabase migrations: full schema, RLS, immutable financial tables, idempotent `sync_sale()`.
- Tests: 36 Vitest unit/integration tests, 4 Playwright end-to-end tests, 11 PostgreSQL checks.
- Documentation set in `docs/`.
