# Changelog

## 0.6.1 — 2026-10-23 — Tablet keypad and sell-screen numpad

### Added
- A numpad that stays on the sell screen on tablets. Pick kg / pcs, grams or ₱ amount, type the
  number, then tap a product: it goes straight into the sale ("2" then Whole Chicken adds 2 pcs;
  "₱ 100" then Pork Liver adds ₱100 worth). With nothing typed, tapping a product opens the weight
  window as before. On a landscape tablet the numpad is its own column between the products and
  the sale; held upright it sits under the sale. Phones keep the old layout.
- Big number keys inside the weight, cash received, discount, staff PIN and authenticator code
  windows, so the tablet's own keyboard no longer pops up over them.
- Every other number field in the POS (prices, costs, stock counts, manager PIN, inventory rules,
  program amounts, GCash reference, member age) opens the same number keys right under itself on a
  touch screen, with a Done key. Text fields (names, search, notes) still use the tablet keyboard,
  and a physical keyboard or barcode scanner still types into every field.

### Fixed
- A long discount program name made the sale panel wider than the screen (Total and Checkout ran
  off the right edge and the page scrolled sideways). The dropdown now cuts the name to fit.

### Changed
- Product tiles size themselves to the space left, so the grid stays readable next to the numpad.

## 0.6.0 — 2026-10-23 — Employee IDs, authenticator codes, member visits

### Added
- Employee IDs: every employee, owner to cashier, gets an employee number (E-0001…), a printed QR
  badge and a personal PIN. Once the shop has employees, the POS opens only after a badge scan
  (camera or handheld scanner) and the PIN; "Sign out" in the header hands the counter to the next
  person, and receipts carry the signed-in name. Five wrong PINs pause that badge for a minute.
- Google Authenticator for owners and managers. Price and cost changes, big discounts and other
  manager actions on the POS need an owner or manager badge plus the 6-digit code (each code works
  once). This works offline. Until someone links the app, the old manager PIN still works.
- Back Office now opens only with an owner or manager badge plus an authenticator code (12-hour
  session per browser tab, Lock button, 10-minute lockout after 8 wrong tries). The first time, the
  owner account walks through creating the owner ID, printing the badge and linking the app.
- Back Office → Staff (owner): add employees, set roles and PINs, issue new badges (the old one
  stops working), link or relink authenticator apps, deactivate.
- Sell screen: a scanned member shows "Visit #N · last came …", counting sales from every device.
- "Every sale line" CSV: which discount was given on each line (program or reason and its size,
  "whole sale" for order discounts), the item discount, the share of a whole-sale discount, and who
  approved it.
- Supabase migration 10 (`20261028000010_staff_ids_and_visits.sql`), safe to run twice.

### Security notes
- Badge QR text is never stored anywhere; the server and devices keep only its SHA-256.
- PINs are hashed on the device (PBKDF2-SHA256, 210,000 rounds). Devices of the shop download the
  PIN hashes and the owners'/managers' authenticator secrets so they can check them offline.

## 0.5.0 — 2026-10-22 — Back Office reports

### Added
- Back Office (`/office`): sign in with the owner or manager cloud account to see the whole shop's
  synced data, for Today, 7 days, 30 days, this month, last month, 1 year, all history or picked dates.
  - Sales, average sale, discounts, cost of goods, gross profit and margin, expenses and estimated net
    operating profit.
  - Charts: sales and gross profit over time (daily, weekly or monthly by range, with a table view),
    sales by category with margin, best sellers, busy hours, day of the week, cash vs GCash, sales by
    cashier, discounts given, members vs walk-ins, members by age.
  - Product profit table, inventory value, supplier purchases, waste and low stock, top members,
    recent sales.
  - Expenses: add wages, rent, utilities and other costs; they feed net profit.
  - CSV downloads: summary, daily sales, product sales, expenses and every sale line.
- Supabase migration 9 (`20261027000009_back_office.sql`), safe to run twice.

## 0.4.4 — 2026-10-22 — Sale sync fix

### Fixed
- Sales and supplier purchases could not upload to Supabase ("function digest(text, unknown) does not
  exist"): Supabase keeps pgcrypto in the `extensions` schema, which these functions did not search.
  Supabase migration 8 fixes it; nothing on the devices changes and the waiting items upload on retry.
- The migration tests now install pgcrypto in `extensions` like Supabase, so this is caught.

## 0.4.3 — 2026-10-22 — Prices on the product list, starter pictures, socials

### Added
- Products: selling price and cost are edited right on the list (manager PIN), with each product's
  margin (% and pesos per kg or piece), a category filter, and a summary of active products, low stock
  and average margin. The product's own editor no longer has price fields (only when adding a product).
- Starter pictures: flat illustrations of 16 common cuts, drawn for this app
  (`scripts/draw-product-art.py`, no outside images). "Add starter pictures" gives each product with no
  photo the one that fits its name; existing photos are never replaced.
- Categories Fresh Goods, Condiments and Side Dishes, added on every device at start-up.
- Inventory → Movement: "Last year" and "All history" periods, with the dates covered.
- Social media on member cards: Facebook page, TikTok account and WhatsApp number in Device → store
  settings, printed with small icons under the QR code. Empty ones are left off.

### Fixed
- Selling by peso amount charged a little less than typed (₱100 of ₱350/kg liempo came to ₱99.75).
  It now charges exactly the amount and shows the weight to cut (about 0.286 kg); the receipt marks
  that weight with "~".
- The "Saved." note in store settings disappeared straight away.

## 0.4.2 — 2026-10-22 — Brand theme and printing fixes

### Changed
- Colours now match The Local Butcher, Argao logo: butcher red, navy and cream. Navy header with a red
  stripe, the logo in the header and on the start page, and new app icons and favicon made from the
  logo. Fonts are unchanged. The original logo is kept in `docs/brand/`.
- Member card redesigned with the logo, a red "MEMBER" label, navy name, red member number and a navy
  band. The QR code and member number are unchanged.
- Receipts start with a grey version of the logo (thermal printers print it in black dots).

### Fixed
- Printing a member card gave two pages and cut the card off, because the card sat inside a dialog
  that clipped it. Cards now print from their own page at 85.6 × 54 mm with no margins: one card, one
  page.
- Receipts print the same way, on a page sized to 58 mm paper and the receipt's length, in a type size
  that fits a full 32-character line in the 48 mm printable width (long lines were cut off before).
- Tests: browser checks that the card prints as one 85.6 × 54 mm page and the receipt as one 58 mm
  page with nothing cut off.

## 0.4.1 — 2026-10-22 — Member delivery address

### Added
- Optional home delivery for members: a separate tick box (the customer wants deliveries and agrees the
  store keeps their address), then address and an optional landmark. Unticking it removes the address
  on every device. Shown on the member's details with a "Delivery" badge in the list.
- Supabase migration 7: delivery columns with a check that no address is kept without consent;
  `sync_customer` and `members_feed` updated. Devices on the previous app version keep the address
  when they edit a member.
- Tests: 2 database and sync tests, 6 PostgreSQL checks, browser test extended.

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
