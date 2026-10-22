# The Local Butcher POS

Offline-first point of sale for **The Local Butcher**, a neighborhood meat shop in the Philippines.
_Where Quality Meets Affordability._

It is a Next.js web app that installs on Android as a Progressive Web App. Sales are saved on the
device in IndexedDB first, so the shop can keep selling with no internet, and are sent to Supabase
(cloud database) whenever the app is open and online.

> **Status: Phases 0, 1 and 2 built (development).** Not production-ready. Receipts are
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
- **Cloud sync and staff sign-in (Phase 2):** owner sets up the store from the app, adds staff,
  each device registers itself; sales, products, photos and stock changes sync with retry, no
  duplicates, and conflict choices. Product permissions are enforced by the database.
- **Inventory (Phase 3, POS → Inventory, manager PIN):** receive supplier deliveries with cost, batch
  or lot code and use-by date (stock and average cost update in one step); suppliers and payment
  status; waste recorded against the batch it came from; alerts kept in two groups: use-by and food
  safety, and stock and demand (low stock, fast sellers running out, slow sellers overstocked, no
  sales, rising wastage, demand up or down); fast/normal/slow/non-moving classification among similar
  products, sales per day counted only on days in stock, stock coverage, sell-through, wastage rate,
  gross profit; suggested order quantities (estimates only); CSV export; adjustable thresholds.
- **Members and discount programs (Phase 4, POS → Members):** register a member with name, age
  (stored as birth year), gender, optional mobile number and recorded consent; the member number and
  QR code are made on save, and the ID-card-size card can be printed or saved as an image. At the
  counter the card is scanned with the device camera (no separate app), a USB scanner, or by typing
  the number, and every sale is logged to the member's history. Owners and managers set up discount
  programs (percent or pesos, whole sale or selected items, members only, minimum purchase, dates);
  the cashier just picks one from the **Discount program** list. Insights show members by gender and
  age, member share of sales and top members, and export the opted-in mobile numbers as CSV for an SMS
  provider. No tiers.
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
| `npm run test:e2e` | Playwright browser tests: offline tests on `next start` (run `npm run build` first), cloud test on `next dev` with a fake Supabase |
| `npm run test:db` | Applies `supabase/migrations` to a throwaway local PostgreSQL and runs SQL tests |
| `npm run check` | All of the above except `test:db` |

## Connecting Supabase (Phase 2)

1. Create a free project at [supabase.com](https://supabase.com) (region: Southeast Asia / Singapore).
2. **SQL Editor:** run every file in `supabase/migrations/` **in filename order**, each once.
3. **Authentication → Sign In / Providers:** turn **off** "Allow new users to sign up". Staff logins are
   created by the owner under **Authentication → Users → Add user**.
4. **Project Settings → API:** copy the Project URL and the anon (publishable) key into Vercel
   (**Settings → Environment Variables**) as `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   then **redeploy** (these values are built into the app).
5. Open the app → **Device** tab → sign in with the owner login → **Set up store as owner**. The first
   account to do this becomes the owner; it only works while the database has no store.
6. Owner adds staff on the Device tab (after creating their login in Supabase).

**Updating later:** when a new release adds a migration (for example `20261024000006_members.sql` in
Phase 4), run just that new file once in the SQL Editor. Until it is run, sales still sync and the
Device tab says the cloud database needs an update.

The service-role key is **not** used by the app today. If you add it to Vercel, keep it server-only.

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
| Cloud data, staff sign-in | Supabase project (URL and anon key in Vercel) | 2 |
| Receipt printing | The physical PT-210 printer for compatibility testing | 6 (test early) |
| Official receipts | BIR registration details, Permit to Use if required | Before fiscal use |
| Off-site backups | A storage location for scheduled backups | 7 |

## Project layout

```
src/domain/        Pure business rules: money, weights, pricing, discounts, cart, checkout, receipt
src/lib/db/        Dexie (IndexedDB) schema and repositories: products, sales, config, seed
src/lib/cloud/     Supabase client wrapper, account/session, sync engine
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
