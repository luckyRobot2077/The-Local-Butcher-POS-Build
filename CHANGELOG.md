# Changelog

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
