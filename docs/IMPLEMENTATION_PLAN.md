# Implementation plan and feature status

Legend: ✅ done and tested · 🟡 partial · ⬜ not started

## Phase 0 — Foundation ✅

| Item | Status |
|---|---|
| Next.js 16 + TypeScript + Tailwind 4 app | ✅ |
| Shared UI components (Button, Modal, Field, Badge, ErrorText) | ✅ |
| Database migrations and schemas (local Dexie v1; Supabase SQL) | ✅ (Supabase not yet applied to a real project) |
| Environment variables (`.env.example`) | ✅ (none needed yet) |
| PWA manifest and icons | ✅ (icons are a simple placeholder "LB" mark; replace with the real logo) |
| Documentation | ✅ |
| Testing and code quality (Vitest, Playwright, ESLint, Prettier, TypeScript, SQL tests) | ✅ |
| Git repository | 🟡 local repository initialised; not pushed to GitHub |

## Phase 1 — Functional offline POS ✅

| Item | Status |
|---|---|
| POS layout (tablet side-by-side, phone collapsible cart) | ✅ |
| Product catalog, category tabs, search (name/SKU/barcode) | ✅ |
| Photo and description editing in POS mode (camera, gallery, replace, remove, live tile preview, offline) | ✅ |
| Product registration and price management with price log and reason | ✅ |
| Weight/piece calculation (kg, g, peso amount) | ✅ |
| Cart operations (add, merge pieces, change qty, remove, clear/void before payment) | ✅ |
| Manual item and order discounts with limit and manager approval | ✅ (ahead of Phase 4) |
| Cash checkout with change; GCash manual record | ✅ |
| Local IndexedDB sales, atomic, with outbox | ✅ |
| Offline product caching (data and photos) | ✅ |
| Transaction history, search, reprint | ✅ |
| Receipt preview and browser printing | ✅ |
| Basic stock warnings and stock ledger adjustments | ✅ (ahead of Phase 3) |
| Encrypted device backup export and verification | ✅ (early safety net from Phase 7) |
| Installable Android PWA | ✅ built and tested in headless Chromium; **not yet tried on a real Android device** |

**Milestone met in automated test:** a cash sale is completed with the network cut, and is still there,
with stock reduced, after closing and reopening the app offline.

## Phase 2 — Cloud synchronization ✅ (live: confirmed by the owner on 2026-10-21, first sync with 0 problems)

| Item | Status |
|---|---|
| Supabase database (schema, RLS, functions) | ✅ migrations 1–4, tested on PostgreSQL 16 and run on the real project |
| Employee authentication (Supabase Auth email/password), owner bootstrap, add staff | ✅ |
| Device registration | ✅ |
| Durable outbox and sync engine with retry | ✅ |
| Idempotent sale sync (lost reply, retries) | ✅ |
| Product, category, photo and stock-movement upload; catalog and stock download | ✅ |
| Server-side permission checks (prices, names, photos, descriptions, categories, stock) | ✅ |
| Conflict handling (product versions, same-name categories, permission rejections) | ✅ |
| Sync status (Device tab + header badge) | ✅ |

**Milestone:** "a completed offline transaction appears exactly once in the cloud database after
reconnection" is met in the automated tests (fake cloud + PostgreSQL function tests + browser test with
a faked Supabase), and the owner's first real sync reported no problems.

Not yet: editing staff permissions in the app (owner can change `staff_profiles` in Supabase for now),
revoking devices from the app, forced re-authentication after long offline periods, cloud copy of
local settings (store name, receipt footer).

## Phase 3 — Inventory management ✅ (built and tested locally; migration 5 to be run on the real project)

| Item | Status |
|---|---|
| Supplier directory and supplier purchases (reference, notes, payment status) | ✅ |
| Stock movement ledger with purchase, delivery, return, spoilage, damage, trimming loss, correction | ✅ (ledger from Phase 1; purchases added) |
| Batch records: lot code, received, use-by, storage note; waste linked to its batch | ✅ |
| Cost tracking: line costs, purchase totals, optional weighted-average product cost, price log entry | ✅ |
| Low-stock, stockout-soon, excess-stock, no-sales, wastage, demand and use-by alerts (expiry separate) | ✅ |
| Fast / normal / slow / non-moving / new / too-few-to-compare classification, configurable | ✅ |
| Stock coverage, sell-through, days since last sale, demand trend, wastage rate, gross profit; CSV | ✅ |
| Order estimates (lead time, cover, safety stock, shelf life), never automatic orders | ✅ |
| Whole-store reports on owner/manager devices (inventory feed from other devices) | ✅ |

Not yet: carcass-to-cut conversion (the batch table keeps `parent_batch_id` for it), per-supplier lead
times, supplier returns, editing a purchase after the fact (use a correction), sales velocity targets
for small categories (they show "too few to compare" instead). Inventory rules are saved per device.

## Phase 4 — Members and discount programs ✅ (built and tested locally; migration 6 to be run on the real project)

| Item | Status |
|---|---|
| Member registration: name, age (stored as birth year), gender, optional mobile, privacy consent | ✅ |
| Member number and QR code made on save; ID-card-size card to print or save as an image | ✅ |
| Camera QR scanner in the app (built-in barcode reader or jsQR), USB scanner and typed lookup | ✅ |
| Member attached to the sale; purchase history per member (this device, plus others on manager devices) | ✅ |
| Discount programs set up by owner/manager; cashier picks from a list, no PIN needed | ✅ |
| Program rules: percent or pesos, whole sale or selected products/categories, members only, minimum, dates | ✅ |
| Demographics and spending insights; opted-in contacts CSV for an SMS provider | ✅ |
| Members and programs available offline and synced to every device | ✅ |

Not yet: sending SMS from the app (needs an SMS provider account such as Semaphore), limits per member
(e.g. once a day), programs that need a central usage count, merging duplicate members, deleting a
member's data on request (switch the membership off for now and ask for removal in Supabase).

## Known gaps in Phase 1

- Without a cloud sign-in, staff identity is a typed cashier name plus the device manager PIN.
- No cashier shifts / cash float yet (Phase 5).
- No refunds of completed sales yet (they will be reversing records with approval).
- No split payment.
- Restoring from a backup file is not implemented (verification only).

## Next phases

| Phase | Scope | Needs from owner |
|---|---|---|
| 5a Back Office reports (done, 0.5.0) | Dashboards (Recharts), sales/profit/inventory/member reports, expenses, CSV | Run migration 9 |
| 5b Employee IDs (done, 0.6.0) | Badges + PIN at the POS, authenticator for owner/manager, Staff page | Run migration 10, set up owner ID |
| 5c Tablet and staff (next) | On-screen keypad and numpad, cashier shifts and cash count, audit history | — |
| 6 Printer | PT-210 test, BLE/Classic adapter or native bridge | The printer |
| 7 Backup & recovery | Cloud export, scheduled backups, restore wizard with staging | Off-site storage |
| 8 Hardening | Real-device, power/network tests, security review, BIR review | BIR details |
