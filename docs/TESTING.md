# Testing

## How to run

```bash
npm run typecheck
npm run lint
npm test              # Vitest: tests/unit + tests/integration (fake-indexeddb)
npm run build
npm run test:e2e      # Playwright against `next start` on port 3100 (uses the build)
npm run test:db       # PostgreSQL migration tests (needs initdb/pg_ctl/psql installed)
```

## What is covered

| Area | Tests |
|---|---|
| Money | rounding half up, peso parsing/formatting, no float error |
| Weights | kg/g parsing, formatting, invalid input |
| Pricing | per-kg rounding cases, per-piece, invalid quantities |
| Discounts | percent, fixed, >100% and over-amount rejected, exact allocation, stacking policy, no negative total, approval threshold |
| Checkout | change, short payment rejected, empty cart, missing cashier, price/cost snapshots, Manila business date |
| Receipt | width ≤ 32, wrapping, discounts, change, non-fiscal header |
| Local DB | atomic sale (rollback on failure), stock ledger equals projection, unique sequential receipt numbers under concurrency, price change keeps old sale price, version conflict, stock movement rules, photos replace/remove, reprint does not duplicate, all-or-nothing sample load |
| Backup | encrypt, verify, counts/totals round trip, photos included, PIN excluded, wrong passphrase, tampering |
| PIN | hash/verify |
| E2E | offline reload → sale → restart offline → sale and stock still there; reprint; phone layout sale; photo upload + description + price change with reason in POS mode; wrong PIN refused; discount above limit needs PIN |
| Cloud SQL | CHECK constraints, idempotent `sync_sale`, conflicting resubmission rejected, unbalanced sale rejected atomically, RLS (cashier vs owner vs anon), immutable sales; Phase 2: owner bootstrap only once, add staff, device registration, category merge, product create/update/conflict, field permissions (cashier price/description), photo attach and storage folder policy, idempotent movements, cashier stock view, discount details stored |
| Sync engine | full push and pull, nothing re-sent on the next run, offline keeps everything queued, lost reply does not duplicate a sale, two devices share one catalog and stock, edit conflict with both resolutions, rejection → failed → retry |
| Cloud E2E | sign-in (wrong and right password), device registration, sale synced exactly once across two runs, signed-in name becomes cashier (fake Supabase via request interception) |

## Not yet tested (needs hardware or accounts)

- Real Android device install and offline use (tested only in headless Chromium).
- Real PT-210 printing.
- The real Supabase project, Auth and Storage (SQL tested on plain PostgreSQL 16 with auth/storage stubs;
  the app tested against a faked Supabase API).
- Two physical devices syncing over the internet.
