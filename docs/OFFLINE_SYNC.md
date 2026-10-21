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

## Sync (implemented, Phase 2)

Code: `src/lib/cloud/sync.ts` (engine), `src/components/pos/cloud-sync.tsx` (triggers),
`supabase/migrations/2026102200000{3,4}_*.sql` (server side).

**Accounts.** Staff sign in with Supabase Auth (email + password) on the Device tab. The session is
kept on the device (supabase-js, `localStorage` key `tlb-auth`) so selling never needs a sign-in while
offline. On sign-in the device calls `whoami()` and `register_device()`; the device then belongs to the
server's store and the signed-in name becomes the cashier name on receipts.

**When it runs.** Only while the app is open: at start, every 60 s, when the app returns to the
foreground, when the network comes back, and right after each sale. Never during checkout; a sale is
complete once it is saved locally. One run at a time.

**Push order** (foreign keys): categories → products → photos → suppliers → purchases → purchase
payment status → manual stock movements → sales.

| Outbox kind | Server call | Idempotency |
|---|---|---|
| category (all unsynced) | `sync_category` | matched by name; device adopts the server id |
| product | `sync_product(p, base_version, reason)` | version check; `unchanged` if nothing differs |
| product_image | Storage upload `<store>/<image>.jpg` + `sync_product_image` | same image id is a no-op |
| supplier | `sync_supplier` | upsert by id; a new supplier with an existing name merges and the device adopts the server id |
| purchase | `sync_purchase(payload)` (purchase, batches, lines, purchase movements) | purchase id + SHA-256 of payload |
| purchase_payment | `set_purchase_payment` | sets the current status; repeating is harmless |
| inventory_movement | `sync_movement` | primary key on movement id |
| sale | `sync_sale(payload)` (header, items, payment, discounts, stock) | sale id + SHA-256 of payload |

The sale payload contains only immutable fields, so a retry is byte-identical (a reprint does not
change it). A reply lost on the network is retried and answered `duplicate`.

**Outcomes.** Accepted/duplicate → `sent` (sale → `synced`). Network trouble → stays `pending`, run stops.
Server rejection (permission, validation) → `failed` with the reason on the Device tab and a red
"sync problem" badge in the header; **Retry** puts it back in the queue (e.g. after the owner grants a
permission).

**Pull.** After pushing: categories, products and photo metadata (RLS limits these to the store), plus
`store_stock()`. A product with unsent local edits is never overwritten. Missing photos are downloaded
from Storage and kept for offline use. Local stock = server ledger + this device's unsent sales,
purchases and movements.

**Inventory feed (Phase 3, owner and manager devices).** After the pull, `inventory_feed(since, device)`
returns what other devices recorded: suppliers, purchases (including payment status changes), purchase
lines, batches, stock movements and sale lines. They are stored with `remote: true` so the inventory
reports on this device cover the whole store. The cursor is the server time of the last download minus
10 minutes; every row has a fixed id, so overlap never duplicates. If the feed is refused (for example
the database update has not been run), sales and stock still sync and the Device tab shows the reason.

### Conflict rules
- Sales, payments and stock movements are append-only; there is nothing to overwrite.
- Product edits carry `version`. If another device changed the product first, the server returns
  `conflict` with its copy and writes nothing; the Device tab offers **Keep this device's version**
  or **Use the cloud version**. Price changes are never merged silently.
- Same-name categories created on two devices merge into one.
- Stale prices: a sale keeps the price used at the time; the server does not reprice.
- Permissions are checked by the database: e.g. a cashier's price change is rejected even if the
  device's manager PIN was entered. Stock adjustments need a manager or owner account.

### Limits
- Revoking a device or a staff member stops future syncs, but a device that stays offline keeps
  selling with its cached session (by design, so the shop never stops). There is no forced
  re-authentication period yet.
- Load the sample catalog on one device only; samples loaded on two devices become duplicates.
- Promotions needing central usage checks are not redeemed offline (Phase 4).
