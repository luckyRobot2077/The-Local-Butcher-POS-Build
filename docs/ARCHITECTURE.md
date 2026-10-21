# Architecture

```
 Android tablet/phone (installed PWA)                        Cloud (Phase 2+)
┌───────────────────────────────────────────────┐          ┌──────────────────────────┐
│ Next.js client app (React, Tailwind)           │          │ Vercel: Next.js routes    │
│   src/components/pos/*  (screens)              │  HTTPS   │   /api/health (now)       │
│   src/domain/*          (pure business rules)  │ ───────▶ │   /api/sync   (Phase 2)   │
│   src/lib/db/*          (Dexie repositories)   │          │            │              │
│ IndexedDB (Dexie): products, photos, sales,    │          │            ▼              │
│   ledger, outbox, config                       │          │ Supabase PostgreSQL + RLS │
│ Service worker (public/sw.js): app shell cache │          │   sync_sale() idempotent  │
└───────────────────────────────────────────────┘          └──────────────────────────┘
```

## Principles

- **The device is the system of record for a sale until it is synced.** Vercel is only needed to load
  or update the app and (Phase 2) to sync. A sale never waits on the network.
- **Business rules live in `src/domain`**, as pure TypeScript functions with unit tests. UI components
  call them; they never re-implement arithmetic.
- **Persistence lives in `src/lib/db`.** Every multi-record write is one Dexie transaction.
- **Supabase is the central source of truth after sync.** Financial rows there are immutable
  (triggers) and written through `sync_sale()`, not directly by the browser.

## Key modules

| Module | Responsibility |
|---|---|
| `domain/money.ts`, `quantity.ts`, `pricing.ts` | Centavos, grams, the rounding rule, parsing and formatting |
| `domain/discount.ts`, `cart.ts` | Discount validation and arithmetic, stacking policy, cart pricing |
| `domain/checkout.ts` | Change, sale/item/payment records with snapshots |
| `domain/receipt.ts` | Transport-independent 58 mm receipt text |
| `domain/inventory.ts` | Inventory analytics: daily series, velocity, coverage, sell-through, classification, batches, alerts, order estimates |
| `lib/db/db.ts` | Dexie schema (local schema version 2) |
| `lib/db/inventory.ts` | Suppliers, atomic purchase receiving with batches and average cost, report data loading |
| `lib/db/sales.ts` | Atomic `completeSale`, history, reprint logging |
| `lib/db/products.ts` | Product create/update with revisions and price log, photos, stock ledger |
| `lib/pin.ts` | Manager PIN (PBKDF2-SHA256, 210k iterations) |
| `lib/backup.ts` | Encrypted device backup and verification |
| `lib/printer/adapter.ts` | Printer adapter interface; browser print adapter |
| `components/pos/pos-context.tsx` | Device bootstrap, settings, cashier, manager unlock (5 min) |

## Technology choices and deviations

| Spec item | Choice | Note |
|---|---|---|
| Next.js App Router, TypeScript | Next.js 16.4, React 19.3 | `cacheComponents` on; POS pages are static shells that render client-side from IndexedDB |
| Tailwind | Tailwind CSS 4 | Brand tokens in `globals.css` (`burgundy`, `cream`, `charcoal`) |
| Dexie | Dexie 4 + dexie-react-hooks | Live queries keep screens in sync with the database |
| "Maintained Next.js-compatible PWA solution" | **Hand-written service worker** (`public/sw.js`, ~120 lines) | Avoids a plugin that lags Next.js 16/Turbopack. It precaches the POS routes and the build assets they reference. Revisit Serwist if needs grow. |
| Zod | Zod 4 | Product input and settings validation |
| Recharts | not yet | Back Office (Phase 5) |
| Vitest, Playwright | Vitest 5, Playwright 1.56 | |
| Supabase Auth/Storage | supabase-js 2, email/password, private bucket | Browser calls database functions directly with the user's session (RLS + SECURITY DEFINER checks), so no server API routes or service key are needed for sync |

## Security in Phase 1 (honest limits)

The manager PIN is a **local deterrent**, not real authorization: anyone with full access to the
device's browser storage could bypass it. Real authorization is in the database (Phase 2): every
sync function checks the signed-in staff member's role and per-field permissions, and RLS limits reads
to their store. The browser only holds the public anon key and the user's own session; the service-role
key is not used by the app.

## Technical risks

| Risk | Mitigation / status |
|---|---|
| Browser may evict IndexedDB data | Request persistent storage (shown on Device screen); encrypted backup export; cloud sync in Phase 2 |
| Clearing site data or uninstalling deletes unsynced sales | Same as above; warn staff; export daily until sync exists |
| PT-210 uses Bluetooth Classic, which Web Bluetooth cannot reach | Browser print works now; native Android bridge or RawBT-style app may be needed. Must test the real printer (docs/PRINTER_INTEGRATION.md) |
| Service worker serving stale app after deploy | Pages are network-first; assets are content-hashed; new SW activates on next load |
| Two devices editing the same product | Product `version` checked on save locally; server-side version conflict handling in Phase 2 |
| Device clock wrong | Sales carry device time; server records `received_at`; reconciliation reports in Phase 5 |
| BIR compliance | Receipts are labelled non-fiscal; fiscal numbering kept separate (`sales.fiscal_invoice_no`) |
