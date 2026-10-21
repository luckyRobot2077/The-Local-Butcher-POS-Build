# Offline operation and synchronization

## Offline (implemented, Phase 1)

- **App shell:** `public/sw.js` precaches `/pos`, `/pos/products`, `/pos/history`, `/pos/device`,
  `/office`, `/`, the manifest, icons, and every `/_next/static/...` asset those pages reference.
  Navigations are network-first (4 s timeout) with the cached page as fallback. Build assets are
  cache-first (they are content-hashed). `/api/*` is never cached.
- **Data:** everything the POS needs is in IndexedDB on the device. Product photos are stored as blobs,
  so they display offline.
- **Durability:** `completeSale()` writes header, items, payment, stock movements, stock projection and
  the outbox entry in one transaction; the UI only shows "Sale saved" after it commits. The unpaid cart
  is kept in `localStorage` so a reload mid-sale does not lose it.
- **Persistent storage:** the app calls `navigator.storage.persist()`; the Device screen shows the result.
- **Status:** the header shows Online/Offline from a real `/api/health` probe (every 30 s, on focus,
  and on network events) rather than `navigator.onLine` alone, and the number of unsynced sales.
- **Verified by test:** `tests/e2e/offline-sale.spec.ts` loads the app, cuts the network, reloads,
  completes a cash sale, closes the page, opens a new one still offline, and finds the sale and the
  reduced stock.

## Sync (designed, Phase 2 — not implemented)

1. Sale saved locally with an immutable UUID and an `outbox` row (`status: pending`). ✅ done
2. When the app is open and `/api/health` succeeds, a sync loop takes pending outbox rows oldest first.
3. `POST /api/sync/sale` with the Supabase session; the route validates the payload with Zod and calls
   `sync_sale(payload)` as the signed-in user. ✅ database function done and tested
4. The function is idempotent: `inserted` or `duplicate` both mean "safe to mark synced". A
   `23505` conflict (same id, different content) marks the row `failed` for manual review.
5. On success: `outbox.status = sent`, `sales.syncStatus = synced`. On network error: keep `pending`,
   back off (5 s → 5 min). On validation error: `failed` with `lastError`, shown on the status screen.
6. No reliance on background sync while the app is closed; sync runs on app open/focus.

### Conflict rules (planned)
- Sales, payments and stock movements are append-only; there is nothing to overwrite.
- Product edits carry `version`; the server accepts an edit only if the base version matches, otherwise
  the device shows both versions and asks a manager to choose. Price changes are never merged silently.
- Stale prices: a sale keeps the price used at the time; the server does not reprice.
- Offline cashier access: devices keep a signed-in session; after a configurable period offline, staff
  must reauthenticate online before new staff can sign in on that device.
- Promotions needing central usage checks are not redeemed offline (Phase 4).
