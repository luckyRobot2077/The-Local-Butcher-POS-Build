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

## Phase 2 — Cloud synchronization 🟡 (built and tested locally; waiting on the owner's Supabase project)

| Item | Status |
|---|---|
| Supabase database (schema, RLS, functions) | ✅ migrations 1–4, tested on PostgreSQL 16; 🟡 not yet run on the real project |
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
a faked Supabase). It still needs to be confirmed on the real Supabase project.

Not yet: editing staff permissions in the app (owner can change `staff_profiles` in Supabase for now),
revoking devices from the app, forced re-authentication after long offline periods, cloud copy of
local settings (store name, receipt footer).

## Known gaps in Phase 1

- Without a cloud sign-in, staff identity is a typed cashier name plus the device manager PIN.
- No cashier shifts / cash float yet (Phase 5).
- No refunds of completed sales yet (they will be reversing records with approval).
- No split payment.
- Back Office (`/office`) is a status page only.
- Restoring from a backup file is not implemented (verification only).

## Next phases

| Phase | Scope | Needs from owner |
|---|---|---|
| 3 Inventory (next) | Supplier purchases, batches, wastage, cost tracking, movement classification, coverage, sell-through | — |
| 4 Members & promotions | Member registration (no tiers), purchase history, promotions and rules, offline cache | — |
| 5 Back Office & staff | Dashboards (Recharts), reports, expenses, permissions UI, shifts, audit, CSV | — |
| 6 Printer | PT-210 test, BLE/Classic adapter or native bridge | The printer |
| 7 Backup & recovery | Cloud export, scheduled backups, restore wizard with staging | Off-site storage |
| 8 Hardening | Real-device, power/network tests, security review, BIR review | BIR details |
