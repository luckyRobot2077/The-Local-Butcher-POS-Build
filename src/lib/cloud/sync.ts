import type { PaymentRecord, SaleItemRecord, SaleRecord } from "@/domain/checkout";
import { getDb, type PosDatabase } from "@/lib/db/db";
import { nowIso } from "@/lib/db/ids";
import type { InventoryMovement, OutboxEntry, Product } from "@/lib/db/types";
import { CloudRejection, CloudUnavailable, type CloudApi } from "./api";
import { getCloudIdentity, patchSyncMeta } from "./identity";

/**
 * Pushes the device outbox to Supabase and pulls the shared catalog back.
 *
 * Order matters because of foreign keys on the server:
 *   categories → products → photos → stock movements → sales → pull.
 *
 * Outcomes per outbox entry:
 *   - accepted or already there (idempotent) → status "sent"
 *   - rejected by the server (permissions, validation, conflict) → "failed"
 *     with the reason; not retried until someone presses Retry
 *   - network/server unavailable → stays "pending"; the run stops and the
 *     next run picks it up
 */

export interface SyncReport {
  categories: number;
  products: number;
  photos: number;
  movements: number;
  sales: number;
  failed: number;
  conflicts: number;
  pulledProducts: number;
}

interface ServerProduct {
  id: string;
  category_id: string;
  name: string;
  description: string;
  sku: string | null;
  barcode: string | null;
  sale_unit: "kg" | "piece";
  price: number;
  cost: number;
  min_stock_qty: number;
  active: boolean;
  image_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ServerImage {
  id: string;
  product_id: string;
  storage_path: string;
  mime: string;
  width: number;
  height: number;
}

type ProductResult =
  { status: "created" | "updated" | "unchanged"; version: number } | { status: "conflict"; server: ServerProduct };

let running: Promise<SyncReport> | null = null;

/** Runs one sync; concurrent callers share the same run. */
export function runSync(api: CloudApi, db: PosDatabase = getDb()): Promise<SyncReport> {
  if (!running) {
    running = doSync(api, db).finally(() => {
      running = null;
    });
  }
  return running;
}

async function doSync(api: CloudApi, db: PosDatabase): Promise<SyncReport> {
  const identity = await getCloudIdentity(db);
  if (!identity?.deviceRegistered) throw new Error("Sign in and register this device first.");
  const device = (await db.config.get("device"))?.value as { deviceId: string } | undefined;
  if (!device) throw new Error("Device not initialised.");
  const report: SyncReport = {
    categories: 0,
    products: 0,
    photos: 0,
    movements: 0,
    sales: 0,
    failed: 0,
    conflicts: 0,
    pulledProducts: 0,
  };
  await patchSyncMeta({ lastAttemptAt: nowIso(), running: true }, db);
  try {
    await pushCategories(api, db, report);
    await pushProducts(api, db, report);
    await pushPhotos(api, db, identity.storeId, report);
    await pushMovements(api, db, device.deviceId, report);
    await pushSales(api, db, report);
    await pull(api, db, report);
    await patchSyncMeta({ lastSyncAt: nowIso(), lastError: undefined, running: false }, db);
    return report;
  } catch (e) {
    await patchSyncMeta({ lastError: e instanceof Error ? e.message : String(e), running: false }, db);
    throw e;
  }
}

/* ------------------------------------------------------------------ helpers */

async function pendingEntries(db: PosDatabase, kind: OutboxEntry["kind"]): Promise<OutboxEntry[]> {
  const rows = await db.outbox.where("status").equals("pending").toArray();
  return rows.filter((r) => r.kind === kind).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function mark(
  db: PosDatabase,
  entries: OutboxEntry[],
  status: OutboxEntry["status"],
  lastError?: string,
  conflict?: Record<string, unknown>,
) {
  const at = nowIso();
  await db.outbox.bulkPut(
    entries.map((e) => ({ ...e, status, attempts: e.attempts + 1, lastAttemptAt: at, lastError, conflict })),
  );
}

/** Runs one push; returns false (and records failure) on a server rejection. Network errors propagate. */
async function attempt(
  db: PosDatabase,
  entries: OutboxEntry[],
  report: SyncReport,
  fn: () => Promise<void>,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof CloudUnavailable) throw e;
    const msg =
      e instanceof CloudRejection ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    await mark(db, entries, "failed", msg);
    report.failed += entries.length;
    return false;
  }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return m;
}

/* ------------------------------------------------------------------ push */

async function pushCategories(api: CloudApi, db: PosDatabase, report: SyncReport) {
  const cats = (await db.categories.toArray()).filter((c) => !c.synced);
  for (const c of cats) {
    let serverId: string;
    try {
      serverId = await api.rpc<string>("sync_category", { p_id: c.id, p_name: c.name, p_sort: c.sortOrder });
    } catch (e) {
      if (e instanceof CloudUnavailable) throw e;
      continue; // e.g. cashier may not create categories; products in it will report the problem
    }
    await remapCategory(db, c.id, serverId);
    report.categories++;
  }
}

/** Makes the local category use the server's id, moving its products along. */
export async function remapCategory(db: PosDatabase, localId: string, serverId: string) {
  await db.transaction("rw", [db.categories, db.products], async () => {
    const cat = await db.categories.get(localId);
    if (!cat) return;
    if (localId === serverId) {
      await db.categories.update(localId, { synced: true });
      return;
    }
    await db.categories.delete(localId);
    if (!(await db.categories.get(serverId))) await db.categories.add({ ...cat, id: serverId, synced: true });
    await db.products.where("categoryId").equals(localId).modify({ categoryId: serverId });
  });
}

export function productPayload(p: Product) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    categoryId: p.categoryId,
    sku: p.sku ?? "",
    barcode: p.barcode ?? "",
    saleUnit: p.saleUnit,
    price: p.price,
    cost: p.cost,
    minStockQty: p.minStockQty,
    active: p.active,
    imageId: p.imageId ?? "",
    createdAt: p.createdAt,
  };
}

async function pushProducts(api: CloudApi, db: PosDatabase, report: SyncReport) {
  const groups = groupBy(await pendingEntries(db, "product"), (e) => e.entityId);
  for (const [productId, entries] of groups) {
    const p = await db.products.get(productId);
    if (!p) {
      await mark(db, entries, "sent", "Product no longer on this device");
      continue;
    }
    const since = entries[0].createdAt;
    const reason = (await db.priceChanges.where("productId").equals(productId).toArray())
      .filter((c) => c.at >= since)
      .sort((a, b) => b.at.localeCompare(a.at))[0]?.reason;
    let result: ProductResult | undefined;
    const ok = await attempt(db, entries, report, async () => {
      result = await api.rpc<ProductResult>("sync_product", {
        p: productPayload(p),
        p_base_version: p.serverVersion ?? null,
        p_reason: reason ?? null,
      });
    });
    if (!ok || !result) continue;
    if (result.status === "conflict") {
      await mark(
        db,
        entries,
        "failed",
        "Changed on another device. Choose which version to keep.",
        result.server as unknown as Record<string, unknown>,
      );
      report.conflicts++;
      continue;
    }
    await db.products.update(productId, { serverVersion: result.version });
    await mark(db, entries, "sent");
    report.products++;
  }
}

async function pushPhotos(api: CloudApi, db: PosDatabase, storeId: string, report: SyncReport) {
  for (const entry of await pendingEntries(db, "product_image")) {
    const img = await db.productImages.get(entry.entityId);
    if (!img) {
      // Replaced or removed before it was uploaded: nothing to send.
      await mark(db, [entry], "sent", "Photo was replaced before upload");
      continue;
    }
    const product = await db.products.get(img.productId);
    const path = `${storeId}/${img.id}.jpg`;
    let version: number | undefined;
    const ok = await attempt(db, [entry], report, async () => {
      await api.upload(path, img.blob, img.mime);
      version = await api.rpc<number>("sync_product_image", {
        p_id: img.id,
        p_product_id: img.productId,
        p_path: path,
        p_mime: img.mime,
        p_width: img.width,
        p_height: img.height,
        p_make_current: product?.imageId === img.id,
      });
    });
    if (!ok) continue;
    await db.productImages.update(img.id, { uploadStatus: "uploaded" });
    if (product && version !== undefined) await db.products.update(product.id, { serverVersion: version });
    await mark(db, [entry], "sent");
    report.photos++;
  }
}

export function movementPayload(m: InventoryMovement, deviceId: string) {
  return {
    id: m.id,
    productId: m.productId,
    type: m.type,
    qtyDelta: m.qtyDelta,
    unitCost: m.unitCost,
    reason: m.reason ?? null,
    batchCode: m.batchCode ?? null,
    useBy: m.useBy ?? "",
    at: m.at,
    by: m.by,
    deviceId,
  };
}

async function pushMovements(api: CloudApi, db: PosDatabase, deviceId: string, report: SyncReport) {
  for (const entry of await pendingEntries(db, "inventory_movement")) {
    const m = await db.inventoryMovements.get(entry.entityId);
    if (!m) {
      await mark(db, [entry], "failed", "Movement missing on this device");
      report.failed++;
      continue;
    }
    const ok = await attempt(db, [entry], report, async () => {
      await api.rpc<string>("sync_movement", { m: movementPayload(m, deviceId) });
    });
    if (!ok) continue;
    await mark(db, [entry], "sent");
    report.movements++;
  }
}

/**
 * The exact payload for sync_sale. Only immutable fields are included so a
 * retry sends byte-identical content (the server compares a hash).
 */
export function salePayload(sale: SaleRecord, items: SaleItemRecord[], payment: PaymentRecord) {
  const discounts = [
    ...items
      .filter((i) => i.discount && i.itemDiscount > 0)
      .map((i) => ({
        saleItemId: i.id,
        kind: i.discount!.input.kind,
        value: i.discount!.input.kind === "percent" ? i.discount!.input.basisPoints : i.discount!.input.amount,
        amount: i.itemDiscount,
        reason: i.discount!.reason ?? null,
      })),
    ...(sale.orderDiscountDetail && sale.orderDiscount > 0
      ? [
          {
            saleItemId: null,
            kind: sale.orderDiscountDetail.input.kind,
            value:
              sale.orderDiscountDetail.input.kind === "percent"
                ? sale.orderDiscountDetail.input.basisPoints
                : sale.orderDiscountDetail.input.amount,
            amount: sale.orderDiscount,
            reason: sale.orderDiscountDetail.reason ?? null,
          },
        ]
      : []),
  ];
  return {
    sale: {
      id: sale.id,
      deviceId: sale.deviceId,
      receiptNo: sale.receiptNo,
      cashierName: sale.cashierName,
      createdAt: sale.createdAt,
      businessDate: sale.businessDate,
      subtotal: sale.subtotal,
      itemDiscountTotal: sale.itemDiscountTotal,
      orderDiscount: sale.orderDiscount,
      discountTotal: sale.discountTotal,
      total: sale.total,
      costTotal: sale.costTotal,
      paymentMethod: sale.paymentMethod,
      tendered: sale.tendered,
      change: sale.change,
      discountApprovedBy: sale.discountApprovedBy ?? null,
    },
    items: items
      .slice()
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((i) => ({
        id: i.id,
        lineNo: i.lineNo,
        productId: i.productId,
        productName: i.productName,
        saleUnit: i.saleUnit,
        unitPrice: i.unitPrice,
        unitCost: i.unitCost,
        qty: i.qty,
        gross: i.gross,
        itemDiscount: i.itemDiscount,
        orderDiscountShare: i.orderDiscountShare,
        net: i.net,
      })),
    payment: {
      id: payment.id,
      method: payment.method,
      amount: payment.amount,
      tendered: payment.tendered,
      change: payment.change,
      reference: payment.reference ?? null,
    },
    discounts,
  };
}

async function pushSales(api: CloudApi, db: PosDatabase, report: SyncReport) {
  for (const entry of await pendingEntries(db, "sale")) {
    const sale = await db.sales.get(entry.entityId);
    const items = await db.saleItems.where("saleId").equals(entry.entityId).toArray();
    const payment = await db.payments.where("saleId").equals(entry.entityId).first();
    if (!sale || !payment || items.length === 0) {
      await mark(db, [entry], "failed", "Sale records incomplete on this device");
      report.failed++;
      continue;
    }
    const ok = await attempt(db, [entry], report, async () => {
      await api.rpc<string>("sync_sale", { payload: salePayload(sale, items, payment) });
    });
    if (!ok) {
      await db.sales.update(sale.id, { syncStatus: "failed" });
      continue;
    }
    await db.transaction("rw", [db.sales, db.outbox], async () => {
      await db.sales.update(sale.id, { syncStatus: "synced" });
      await mark(db, [entry], "sent");
    });
    report.sales++;
  }
}

/* ------------------------------------------------------------------ pull */

function fromServer(sp: ServerProduct, local: Product | undefined): Product {
  return {
    id: sp.id,
    name: sp.name,
    description: sp.description,
    categoryId: sp.category_id,
    sku: sp.sku ?? undefined,
    barcode: sp.barcode ?? undefined,
    saleUnit: sp.sale_unit,
    price: Number(sp.price),
    cost: Number(sp.cost),
    minStockQty: Number(sp.min_stock_qty),
    active: sp.active,
    imageId: sp.image_id ?? undefined,
    createdAt: sp.created_at,
    updatedAt: sp.updated_at,
    stockQty: local?.stockQty ?? 0,
    version: Math.max(local?.version ?? 0, sp.version),
    serverVersion: sp.version,
    isSample: local?.isSample,
  };
}

/** Stock not yet reflected on the server: unsynced sales and unsent manual movements. */
async function localPendingDeltas(db: PosDatabase): Promise<Map<string, number>> {
  const unsyncedSales = new Set((await db.sales.toArray()).filter((s) => s.syncStatus !== "synced").map((s) => s.id));
  const unsentMoves = new Set(
    (await db.outbox.where("kind").equals("inventory_movement").toArray())
      .filter((e) => e.status !== "sent")
      .map((e) => e.entityId),
  );
  const out = new Map<string, number>();
  for (const m of await db.inventoryMovements.toArray()) {
    const pending = m.type === "sale" ? !!m.refId && unsyncedSales.has(m.refId) : unsentMoves.has(m.id);
    if (pending) out.set(m.productId, (out.get(m.productId) ?? 0) + m.qtyDelta);
  }
  return out;
}

async function pull(api: CloudApi, db: PosDatabase, report: SyncReport) {
  const [cats, products, images, stock] = await Promise.all([
    api.select<{ id: string; name: string; sort_order: number }>("categories", "id,name,sort_order"),
    api.select<ServerProduct>(
      "products",
      "id,category_id,name,description,sku,barcode,sale_unit,price,cost,min_stock_qty,active,image_id,version,created_at,updated_at",
    ),
    api.select<ServerImage>("product_images", "id,product_id,storage_path,mime,width,height"),
    api.rpc<{ product_id: string; stock_qty: number }[]>("store_stock", {}),
  ]);

  const dirty = new Set(
    (await db.outbox.where("kind").anyOf("product", "product_image").toArray())
      .filter((e) => e.status !== "sent")
      .map((e) => (e.kind === "product" ? e.entityId : "")),
  );
  for (const e of await db.outbox.where("kind").equals("product_image").toArray()) {
    if (e.status === "sent") continue;
    const img = await db.productImages.get(e.entityId);
    if (img) dirty.add(img.productId);
  }

  // Download photos we do not have yet (outside the database transaction).
  const imageById = new Map(images.map((i) => [i.id, i]));
  const downloads = new Map<string, Blob>();
  for (const sp of products) {
    if (!sp.image_id || dirty.has(sp.id)) continue;
    if (await db.productImages.get(sp.image_id)) continue;
    const meta = imageById.get(sp.image_id);
    if (!meta) continue;
    try {
      downloads.set(sp.image_id, await api.download(meta.storage_path));
    } catch {
      // Keep the current local photo; try again next sync.
    }
  }

  const pending = await localPendingDeltas(db);
  const serverStock = new Map(stock.map((s) => [s.product_id, Number(s.stock_qty)]));

  await db.transaction("rw", [db.categories, db.products, db.productImages], async () => {
    for (const c of cats) {
      await db.categories.put({ id: c.id, name: c.name, sortOrder: c.sort_order, synced: true });
    }
    for (const sp of products) {
      const local = await db.products.get(sp.id);
      if (!dirty.has(sp.id) && local?.serverVersion !== sp.version) {
        const next = fromServer(sp, local);
        if (sp.image_id && !(await db.productImages.get(sp.image_id))) {
          const blob = downloads.get(sp.image_id);
          const meta = imageById.get(sp.image_id)!;
          if (blob) {
            await db.productImages.add({
              id: sp.image_id,
              productId: sp.id,
              blob,
              mime: meta.mime,
              width: meta.width,
              height: meta.height,
              createdAt: nowIso(),
              uploadStatus: "uploaded",
            });
          } else {
            next.imageId = local?.imageId; // not downloaded yet
            next.serverVersion = local?.serverVersion; // so the next sync retries
          }
        }
        if (local?.imageId && local.imageId !== next.imageId) {
          const old = await db.productImages.get(local.imageId);
          if (old?.uploadStatus === "uploaded") await db.productImages.delete(old.id);
        }
        await db.products.put(next);
        report.pulledProducts++;
      }
      // Stock is always recomputed: server ledger plus what this device has not sent yet.
      const stockQty = (serverStock.get(sp.id) ?? 0) + (pending.get(sp.id) ?? 0);
      await db.products.update(sp.id, { stockQty });
    }
  });
}

/* ------------------------------------------------------------------ manual resolution */

/** Retry failed entries (e.g. after the owner grants a permission). */
export async function retryFailed(db: PosDatabase = getDb(), ids?: string[]) {
  const rows = (await db.outbox.where("status").equals("failed").toArray()).filter((r) => !ids || ids.includes(r.id));
  await db.outbox.bulkPut(
    rows.map((r) => ({ ...r, status: "pending" as const, lastError: undefined, conflict: undefined })),
  );
  const saleIds = rows.filter((r) => r.kind === "sale").map((r) => r.entityId);
  for (const id of saleIds) await db.sales.update(id, { syncStatus: "pending" });
}

/** Conflict: keep this device's version and overwrite the server's on the next sync. */
export async function keepLocalVersion(productId: string, db: PosDatabase = getDb()) {
  const rows = (await db.outbox.where("entityId").equals(productId).toArray()).filter(
    (r) => r.status === "failed" && r.conflict,
  );
  const serverVersion = Number(rows[0]?.conflict?.version);
  if (!Number.isFinite(serverVersion)) return;
  await db.transaction("rw", [db.products, db.outbox], async () => {
    await db.products.update(productId, { serverVersion });
    await db.outbox.bulkPut(
      rows.map((r) => ({ ...r, status: "pending" as const, lastError: undefined, conflict: undefined })),
    );
  });
}

/** Conflict: discard this device's edit and take the server's version. */
export async function takeServerVersion(productId: string, db: PosDatabase = getDb()) {
  const rows = (await db.outbox.where("entityId").equals(productId).toArray()).filter(
    (r) => r.status === "failed" && r.conflict,
  );
  const server = rows[0]?.conflict as unknown as ServerProduct | undefined;
  if (!server) return;
  await db.transaction("rw", [db.products, db.productImages, db.outbox], async () => {
    const local = await db.products.get(productId);
    const next = fromServer(server, local);
    if (server.image_id && !(await db.productImages.get(server.image_id))) {
      next.imageId = local?.imageId;
      next.serverVersion = (server.version ?? 1) - 1; // forces the next pull to fetch the photo
    }
    await db.products.put(next);
    await db.outbox.bulkPut(
      rows.map((r) => ({ ...r, status: "sent" as const, lastError: "Discarded in favour of the server version" })),
    );
  });
}
