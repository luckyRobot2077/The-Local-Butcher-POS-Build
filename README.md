# The Local Butcher POS

Offline-first point of sale for **The Local Butcher**, a neighborhood meat shop in the Philippines.
_Where Quality Meets Affordability._

It is a Next.js web app that installs on Android as a Progressive Web App. Sales are saved on the
device in IndexedDB, so the shop can keep selling with no internet. Cloud sync to Supabase is
planned for Phase 2.

> **Status: Phase 0 and Phase 1 done (development build).** Not production-ready. Receipts are
> **non-fiscal test receipts**; this system is not BIR-registered. See
> [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for what is done and what is pending.

## What works today

- **Selling (POS → Sell):** product tiles with photos, category tabs, search; weighed items by kg,
  grams or peso amount ("₱100 worth"); piece items; item and order discounts (percent or fixed) with
  a cashier limit and manager PIN override; cash with change, or manually recorded GCash; receipt
  preview and printing through the system print dialog.
- **Products (POS → Products):** add and edit products inside POS mode, including taking a photo
  with the camera or picking one from the gallery (resized to 800 px, stored offline), description,
  price and cost (each change logged with a reason; past sales keep their prices), low-stock level,
  and stock movements (deliveries with batch and use-by date, spoilage, damage, trimming loss,
  corrections). Editing needs the manager PIN; the owner can let cashiers edit photos and
  descriptions only.
- **History:** today's totals for this device, search by receipt number or transaction ID,
  reprint (marked REPRINT, never creates a new sale).
- **Device:** cashier name, store and receipt settings, manager PIN, storage status, and an
  **encrypted backup file** (AES-256-GCM) to copy to USB or an external drive, plus a checker
  that verifies a backup file.
- **Offline:** after one online visit the installed app opens, sells and keeps sales with no
  internet, including after closing and reopening.

## Quick start

Requirements: Node.js 20.9 or newer (developed on Node 22).

```bash
npm install
npm run dev          # http://localhost:3000/pos (no service worker in dev)
```

Production build (needed to test offline and install):

```bash
npm run build
npm start            # http://localhost:3000/pos
```

On first open the app asks for the cashier's name. With an empty catalog you can **Load sample
products** (prices from the break-even workbook; replace them with real prices). The first time
someone edits a product, the app asks them to create the **manager PIN**.

### Install on an Android phone or tablet

1. Deploy (see below) or serve over HTTPS. Service workers need HTTPS (or `localhost`).
2. Open `https://<your-site>/pos` in Chrome, wait a few seconds, then **⋮ → Add to Home screen /
   Install app**.
3. Open it once while online so it caches itself. After that it works offline.
4. In **Device**, check that storage shows **Persistent**.

## Checks

| Command | What it runs |
|---|---|
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint (Next.js rules) |
| `npm test` | Vitest unit and integration tests (fake IndexedDB) |
| `npm run test:e2e` | Playwright browser tests against `next start` (run `npm run build` first) |
| `npm run test:db` | Applies `supabase/migrations` to a throwaway local PostgreSQL and runs SQL tests |
| `npm run check` | All of the above except `test:db` |

## Deploying to Vercel

1. Push this repository to GitHub.
2. In Vercel, **Add New → Project**, import the repository. Framework: Next.js. No environment
   variables are needed for Phase 1.
3. Deploy, then open `/pos` on the shop's Android device and install it.

Nothing has been deployed yet from this workspace.

## External accounts and hardware the owner must provide

| Needed for | What | Phase |
|---|---|---|
| Hosting | Vercel account (free tier is enough to start) | Now |
| Source code | GitHub repository | Now |
| Cloud data, staff sign-in | Supabase project (URL, anon key, service-role key kept server-side) | 2 |
| Receipt printing | The physical PT-210 printer for compatibility testing | 6 (test early) |
| Official receipts | BIR registration details, Permit to Use if required | Before fiscal use |
| Off-site backups | A storage location for scheduled backups | 7 |

## Project layout

```
src/domain/        Pure business rules: money, weights, pricing, discounts, cart, checkout, receipt
src/lib/db/        Dexie (IndexedDB) schema and repositories: products, sales, config, seed
src/lib/           PIN hashing, image compression, encrypted backup, printer adapters
src/components/    UI primitives and POS screens
src/app/           Next.js routes: /pos, /pos/products, /pos/history, /pos/device, /office
public/sw.js       Service worker (offline app shell)
supabase/          SQL migrations and SQL tests for the cloud database
tests/             unit, integration and e2e tests
docs/              Specification-derived documentation
```

## Documentation

[PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE.md) ·
[Offline & sync](docs/OFFLINE_SYNC.md) · [Printer](docs/PRINTER_INTEGRATION.md) ·
[Backup & recovery](docs/BACKUP_RECOVERY.md) · [Implementation plan & status](docs/IMPLEMENTATION_PLAN.md) ·
[Testing](docs/TESTING.md) · [Changelog](CHANGELOG.md)
