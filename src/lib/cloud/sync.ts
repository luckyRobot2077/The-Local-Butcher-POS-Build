import type { PaymentRecord, SaleItemRecord, SaleRecord } from "@/domain/checkout";
import type { AppliedDiscountInput } from "@/domain/cart";
import type { DiscountProgram } from "@/domain/programs";
import type { Gender } from "@/domain/members";
import { getDb, type PosDatabase } from "@/lib/db/db";
import { nowIso } from "@/lib/db/ids";
import { MEMBER_VISITS_KEY, type ServerVisitCounts } from "@/lib/db/members";
import { setEmployees, type LocalEmployee } from "@/lib/staff/employees";
import type {
  InventoryBatch,
  InventoryMovement,
  Member,
  MovementType,
  OutboxEntry,
  PaymentStatus,
  Product,
  Purchase,
  PurchaseItem,
  Supplier,
} from "@/lib/db/types";
import { CloudRejection, CloudUnavailable, type CloudApi } from "./api";
import { getCloudIdentity, getSyncMeta, patchSyncMeta } from "./identity";

/**
 * Pushes the device outbox to Supabase and pulls the shared catalog back.
 *
 * Order matters because of foreign keys on the server:
 *   categories → products → photos → suppliers → purchases → payment
 *   status → stock movements → members → discount programs → sales →
 *   pull → members feed → inventory feed.
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
  suppliers: number;
  purchases: number;
  members: number;
  programs: number;
  failed: number;
  conflicts: number;
  pulledProducts: number;
  /** Records from other devices downloaded by the inventory feed. */
  pulledRecords: number;
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
    suppliers: 0,
    purchases: 0,
    members: 0,
    programs: 0,
    failed: 0,
    conflicts: 0,
    pulledProducts: 0,
    pulledRecords: 0,
  };
  await patchSyncMeta({ lastAttemptAt: nowIso(), running: true }, db);
  try {
    await pushCategories(api, db, report);
    await pushProducts(api, db, report);
    await pushPhotos(api, db, identity.storeId, report);
    await pushSuppliers(api, db, report);
    await pushPurchases(api, db, device.deviceId, report);
    await pushPurchasePayments(api, db, report);
    await pushMovements(api, db, device.deviceId, report);
    await pushMembers(api, db, report);
    await pushPrograms(api, db, report);
    await pushSales(api, db, report);
    await pull(api, db, report);
    // Members and programs: a rejection (e.g. the database update not run yet) must not hold up sales.
    try {
      await pullMembersFeed(api, db, report);
      await patchSyncMeta({ membersFeedError: undefined }, db);
    } catch (e) {
      if (!(e instanceof CloudRejection)) throw e;
      await patchSyncMeta({ membersFeedError: e.message }, db);
    }
    // Visit counts and staff badges for the counter; an older database without them keeps what the device has.
    try {
      await pullMemberVisits(api, db);
      await pullEmployees(api, db);
    } catch (e) {
      if (!(e instanceof CloudRejection)) throw e;
      await patchSyncMeta({ membersFeedError: e.message }, db);
    }
    if (identity.role !== "cashier") {
      // Reports only: a rejection here (e.g. the database update not run yet) must not hold up sales.
      try {
        await pullInventoryFeed(api, db, device.deviceId, report);
        await patchSyncMeta({ feedError: undefined }, db);
      } catch (e) {
        if (!(e instanceof CloudRejection)) throw e;
        await patchSyncMeta({ feedError: e.message }, db);
      }
    }
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

export function supplierPayload(s: Supplier) {
  return { id: s.id, name: s.name, contact: s.contact ?? "", notes: s.notes ?? "", active: s.active };
}

async function pushSuppliers(api: CloudApi, db: PosDatabase, report: SyncReport) {
  const groups = groupBy(await pendingEntries(db, "supplier"), (e) => e.entityId);
  for (const [supplierId, entries] of groups) {
    const s = await db.suppliers.get(supplierId);
    if (!s) {
      await mark(db, entries, "sent", "Supplier no longer on this device");
      continue;
    }
    let serverId: string | undefined;
    const ok = await attempt(db, entries, report, async () => {
      serverId = await api.rpc<string>("sync_supplier", { p: supplierPayload(s) });
    });
    if (!ok || !serverId) continue;
    if (serverId !== supplierId) await remapSupplier(db, supplierId, serverId);
    await mark(db, entries, "sent");
    report.suppliers++;
  }
}

/** Another device already had a supplier with this name: use the cloud's record. */
export async function remapSupplier(db: PosDatabase, localId: string, serverId: string) {
  await db.transaction("rw", [db.suppliers, db.purchases], async () => {
    const local = await db.suppliers.get(localId);
    await db.suppliers.delete(localId);
    if (local && !(await db.suppliers.get(serverId))) await db.suppliers.add({ ...local, id: serverId });
    await db.purchases.where("supplierId").equals(localId).modify({ supplierId: serverId });
  });
}

/** The exact payload for sync_purchase: immutable fields only, so a retry hashes the same. */
export function purchasePayload(
  p: Purchase,
  items: PurchaseItem[],
  batches: InventoryBatch[],
  movements: InventoryMovement[],
  deviceId: string,
) {
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const moveByBatch = new Map(movements.map((m) => [m.batchId, m]));
  return {
    purchase: {
      id: p.id,
      supplierId: p.supplierId,
      receivedAt: p.receivedAt,
      reference: p.reference ?? "",
      notes: p.notes ?? "",
      totalCost: p.totalCost,
      by: p.by,
      deviceId: p.deviceId ?? deviceId,
    },
    lines: items
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => {
        const b = batchById.get(i.batchId);
        const m = moveByBatch.get(i.batchId);
        if (!b || !m) throw new CloudRejection("Purchase records incomplete on this device");
        return {
          itemId: i.id,
          batchId: b.id,
          movementId: m.id,
          productId: i.productId,
          qty: i.qty,
          unitCost: i.unitCost,
          lineCost: i.lineCost,
          batchCode: b.batchCode ?? "",
          useBy: b.useBy ?? "",
          storageNote: b.storageNote ?? "",
        };
      }),
  };
}

async function pushPurchases(api: CloudApi, db: PosDatabase, deviceId: string, report: SyncReport) {
  for (const entry of await pendingEntries(db, "purchase")) {
    const p = await db.purchases.get(entry.entityId);
    if (!p) {
      await mark(db, [entry], "failed", "Purchase missing on this device");
      report.failed++;
      continue;
    }
    const [items, batches, movements] = await Promise.all([
      db.purchaseItems.where("purchaseId").equals(p.id).toArray(),
      db.batches.where("purchaseId").equals(p.id).toArray(),
      db.inventoryMovements.where("purchaseId").equals(p.id).toArray(),
    ]);
    const ok = await attempt(db, [entry], report, async () => {
      await api.rpc<string>("sync_purchase", { payload: purchasePayload(p, items, batches, movements, deviceId) });
    });
    if (!ok) continue;
    await mark(db, [entry], "sent");
    report.purchases++;
  }
}

async function pushPurchasePayments(api: CloudApi, db: PosDatabase, report: SyncReport) {
  const groups = groupBy(await pendingEntries(db, "purchase_payment"), (e) => e.entityId);
  for (const [purchaseId, entries] of groups) {
    const p = await db.purchases.get(purchaseId);
    if (!p) {
      await mark(db, entries, "sent", "Purchase no longer on this device");
      continue;
    }
    const ok = await attempt(db, entries, report, async () => {
      await api.rpc<string>("set_purchase_payment", { p_id: p.id, p_status: p.paymentStatus });
    });
    if (ok) await mark(db, entries, "sent");
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
    batchId: m.batchId ?? "",
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

export function memberPayload(m: Member) {
  return {
    id: m.id,
    memberNo: m.memberNo,
    name: m.name,
    birthYear: m.birthYear,
    gender: m.gender,
    contactNumber: m.contactNumber ?? "",
    privacyConsentAt: m.privacyConsentAt,
    marketingConsent: m.marketingConsent,
    marketingConsentAt: m.marketingConsentAt ?? "",
    wantsDelivery: !!m.wantsDelivery,
    deliveryConsentAt: m.deliveryConsentAt ?? "",
    deliveryAddress: m.deliveryAddress ?? "",
    deliveryLandmark: m.deliveryLandmark ?? "",
    active: m.active,
    notes: m.notes ?? "",
    registeredAt: m.registeredAt,
    registeredBy: m.registeredBy,
    deviceId: m.deviceId ?? "",
  };
}

async function pushMembers(api: CloudApi, db: PosDatabase, report: SyncReport) {
  const groups = groupBy(await pendingEntries(db, "customer"), (e) => e.entityId);
  for (const [memberId, entries] of groups) {
    const m = await db.members.get(memberId);
    if (!m) {
      await mark(db, entries, "sent", "Member no longer on this device");
      continue;
    }
    const ok = await attempt(db, entries, report, async () => {
      await api.rpc<string>("sync_customer", { p: memberPayload(m) });
    });
    if (!ok) continue;
    await mark(db, entries, "sent");
    report.members++;
  }
}

export function programPayload(p: DiscountProgram) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    kind: p.input.kind,
    value: p.input.kind === "percent" ? p.input.basisPoints : p.input.amount,
    scope: p.scope,
    productIds: p.productIds,
    categoryIds: p.categoryIds,
    membersOnly: p.membersOnly,
    minPurchase: p.minPurchase,
    startsOn: p.startsOn ?? "",
    endsOn: p.endsOn ?? "",
    active: p.active,
    updatedBy: p.updatedBy,
  };
}

async function pushPrograms(api: CloudApi, db: PosDatabase, report: SyncReport) {
  const groups = groupBy(await pendingEntries(db, "promotion"), (e) => e.entityId);
  for (const [programId, entries] of groups) {
    const p = await db.programs.get(programId);
    if (!p) {
      await mark(db, entries, "sent", "Program no longer on this device");
      continue;
    }
    const ok = await attempt(db, entries, report, async () => {
      await api.rpc<string>("sync_promotion", { p: programPayload(p) });
    });
    if (!ok) continue;
    await mark(db, entries, "sent");
    report.programs++;
  }
}

/** Program discounts name their program; typed ones send nothing extra, so older payloads hash the same. */
function discountSource(d: AppliedDiscountInput) {
  return d.source === "promotion" ? { source: "promotion", promotionId: d.promotionId ?? null } : {};
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
        ...discountSource(i.discount!),
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
            ...discountSource(sale.orderDiscountDetail),
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
      // Only present on member sales, so sales made before Phase 4 keep the same payload.
      ...(sale.customerId ? { customerId: sale.customerId } : {}),
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

/** Stock not yet reflected on the server: unsynced sales, purchases and manual movements. */
export async function localPendingDeltas(db: PosDatabase): Promise<Map<string, number>> {
  const unsyncedSales = new Set((await db.sales.toArray()).filter((s) => s.syncStatus !== "synced").map((s) => s.id));
  const unsent = new Set(
    (await db.outbox.where("kind").anyOf("inventory_movement", "purchase").toArray())
      .filter((e) => e.status !== "sent")
      .map((e) => e.entityId),
  );
  const out = new Map<string, number>();
  for (const m of await db.inventoryMovements.toArray()) {
    if (m.remote) continue;
    const pending =
      m.type === "sale"
        ? !!m.refId && unsyncedSales.has(m.refId)
        : m.purchaseId
          ? unsent.has(m.purchaseId)
          : unsent.has(m.id);
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

/* ------------------------------------------------------------------ inventory feed */

interface InventoryFeed {
  now: string;
  suppliers: {
    id: string;
    name: string;
    contact: string | null;
    notes: string | null;
    active: boolean;
    updated_at: string;
  }[];
  purchases: {
    id: string;
    supplier_id: string;
    received_at: string;
    reference: string | null;
    notes: string | null;
    payment_status: PaymentStatus;
    total_cost: number;
    by_name: string | null;
    device_id: string | null;
  }[];
  purchase_items: {
    id: string;
    purchase_id: string;
    product_id: string;
    batch_id: string;
    qty: number;
    unit_cost: number;
    line_cost: number;
  }[];
  batches: {
    id: string;
    product_id: string;
    purchase_id: string | null;
    batch_code: string | null;
    received_at: string;
    use_by: string | null;
    storage_note: string | null;
    initial_qty: number;
    unit_cost: number;
  }[];
  movements: {
    id: string;
    product_id: string;
    batch_id: string | null;
    type: MovementType;
    qty_delta: number;
    unit_cost: number;
    ref_type: string | null;
    ref_id: string | null;
    reason: string | null;
    batch_code: string | null;
    use_by: string | null;
    by_name: string | null;
    at: string;
  }[];
  sale_lines: {
    id: string;
    sale_id: string;
    product_id: string;
    qty: number;
    net: number;
    cost: number;
    at: string;
    customer_id?: string | null;
  }[];
}

/** Overlap between feed downloads, so rows committed late are not missed (ids make it idempotent). */
const FEED_OVERLAP_MS = 10 * 60_000;

/**
 * Downloads what other devices recorded (purchases, batches, stock
 * movements and sale lines) so this device's inventory reports cover the
 * whole store. Owner and manager devices only.
 */
async function pullInventoryFeed(api: CloudApi, db: PosDatabase, deviceId: string, report: SyncReport) {
  const { feedCursor } = await getSyncMeta(db);
  const since = feedCursor ? new Date(Date.parse(feedCursor) - FEED_OVERLAP_MS).toISOString() : null;
  const feed = await api.rpc<InventoryFeed>("inventory_feed", { p_since: since, p_device: deviceId });
  const dirty = new Set(
    (await db.outbox.where("kind").anyOf("supplier", "purchase_payment").toArray())
      .filter((e) => e.status !== "sent")
      .map((e) => e.entityId),
  );
  const tables = [
    db.suppliers,
    db.purchases,
    db.purchaseItems,
    db.batches,
    db.inventoryMovements,
    db.remoteSaleLines,
    db.sales,
  ];
  await db.transaction("rw", tables, async () => {
    let n = 0;
    for (const s of feed.suppliers) {
      if (dirty.has(s.id)) continue;
      await db.suppliers.put({
        id: s.id,
        name: s.name,
        contact: s.contact ?? undefined,
        notes: s.notes ?? undefined,
        active: s.active,
        updatedAt: s.updated_at,
      });
      n++;
    }
    for (const p of feed.purchases) {
      const local = await db.purchases.get(p.id);
      if (local) {
        if (!dirty.has(p.id) && local.paymentStatus !== p.payment_status) {
          await db.purchases.update(p.id, { paymentStatus: p.payment_status });
          n++;
        }
        continue;
      }
      await db.purchases.add({
        id: p.id,
        supplierId: p.supplier_id,
        receivedAt: p.received_at,
        reference: p.reference ?? undefined,
        notes: p.notes ?? undefined,
        paymentStatus: p.payment_status,
        totalCost: Number(p.total_cost),
        by: p.by_name ?? "",
        deviceId: p.device_id ?? undefined,
        remote: true,
      });
      n++;
    }
    for (const i of feed.purchase_items) {
      if (await db.purchaseItems.get(i.id)) continue;
      await db.purchaseItems.add({
        id: i.id,
        purchaseId: i.purchase_id,
        productId: i.product_id,
        batchId: i.batch_id,
        qty: Number(i.qty),
        unitCost: Number(i.unit_cost),
        lineCost: Number(i.line_cost),
      });
    }
    for (const b of feed.batches) {
      if (await db.batches.get(b.id)) continue;
      await db.batches.add({
        id: b.id,
        productId: b.product_id,
        purchaseId: b.purchase_id ?? undefined,
        batchCode: b.batch_code ?? undefined,
        receivedAt: b.received_at,
        useBy: b.use_by ?? undefined,
        storageNote: b.storage_note ?? undefined,
        initialQty: Number(b.initial_qty),
        unitCost: Number(b.unit_cost),
      });
    }
    for (const m of feed.movements) {
      if (await db.inventoryMovements.get(m.id)) continue;
      await db.inventoryMovements.add({
        id: m.id,
        productId: m.product_id,
        type: m.type,
        qtyDelta: Number(m.qty_delta),
        unitCost: Number(m.unit_cost),
        refType: m.ref_type === "sale" ? "sale" : undefined,
        refId: m.ref_id ?? undefined,
        purchaseId: m.ref_type === "purchase" ? (m.ref_id ?? undefined) : undefined,
        batchId: m.batch_id ?? undefined,
        reason: m.reason ?? undefined,
        batchCode: m.batch_code ?? undefined,
        useBy: m.use_by ?? undefined,
        by: m.by_name ?? "",
        at: m.at,
        remote: true,
      });
      n++;
    }
    for (const l of feed.sale_lines) {
      if (await db.sales.get(l.sale_id)) continue;
      await db.remoteSaleLines.put({
        id: l.id,
        saleId: l.sale_id,
        productId: l.product_id,
        qty: Number(l.qty),
        net: Number(l.net),
        cost: Number(l.cost),
        at: l.at,
        customerId: l.customer_id ?? undefined,
      });
    }
    report.pulledRecords += n;
  });
  await patchSyncMeta({ feedCursor: feed.now }, db);
}

/* ------------------------------------------------------------------ members feed */

interface MembersFeed {
  now: string;
  customers: {
    id: string;
    member_no: string;
    name: string;
    birth_year: number;
    gender: Gender;
    contact_number: string | null;
    privacy_consent_at: string;
    marketing_consent: boolean;
    marketing_consent_at: string | null;
    /** Missing until migration 7 is run. */
    wants_delivery?: boolean;
    delivery_consent_at?: string | null;
    delivery_address?: string | null;
    delivery_landmark?: string | null;
    active: boolean;
    notes: string | null;
    registered_at: string;
    registered_by: string | null;
    device_id: string | null;
    updated_at: string;
  }[];
  promotions: {
    id: string;
    name: string;
    description: string | null;
    kind: "percent" | "fixed";
    value: number;
    scope: "order" | "items";
    product_ids: string[];
    category_ids: string[];
    members_only: boolean;
    min_purchase: number;
    starts_on: string | null;
    ends_on: string | null;
    active: boolean;
    updated_by: string | null;
    updated_at: string;
  }[];
}

/** Downloads members and discount programs saved on other devices (every staff role). */
interface ServerEmployee {
  id: string;
  employee_no: string;
  name: string;
  role: LocalEmployee["role"];
  active: boolean;
  badge_hash: string;
  pin_salt: string | null;
  pin_hash: string | null;
  pin_iterations: number | null;
  totp_secret: string | null;
}

async function pullEmployees(api: CloudApi, db: PosDatabase) {
  const feed = await api.rpc<{ employees: ServerEmployee[] }>("employees_feed", {});
  await setEmployees(
    feed.employees.map((e) => ({
      id: e.id,
      employeeNo: e.employee_no,
      name: e.name,
      role: e.role,
      active: e.active,
      badgeHash: e.badge_hash,
      pin:
        e.pin_salt && e.pin_hash && e.pin_iterations
          ? { salt: e.pin_salt, hash: e.pin_hash, iterations: Number(e.pin_iterations) }
          : undefined,
      totpSecret: e.totp_secret ?? undefined,
    })),
    db,
  );
}

async function pullMemberVisits(api: CloudApi, db: PosDatabase) {
  const rows = await api.rpc<{ customer_id: string; visits: number; last_at: string }[]>("member_visits", {});
  const counts: ServerVisitCounts["counts"] = {};
  for (const r of rows) counts[r.customer_id] = { visits: Number(r.visits), lastAt: r.last_at };
  await db.config.put({ key: MEMBER_VISITS_KEY, value: { at: nowIso(), counts } satisfies ServerVisitCounts });
}

async function pullMembersFeed(api: CloudApi, db: PosDatabase, report: SyncReport) {
  const { membersCursor } = await getSyncMeta(db);
  const since = membersCursor ? new Date(Date.parse(membersCursor) - FEED_OVERLAP_MS).toISOString() : null;
  const feed = await api.rpc<MembersFeed>("members_feed", { p_since: since });
  const dirty = new Set(
    (await db.outbox.where("kind").anyOf("customer", "promotion").toArray())
      .filter((e) => e.status !== "sent")
      .map((e) => e.entityId),
  );
  await db.transaction("rw", [db.members, db.programs], async () => {
    for (const c of feed.customers) {
      if (dirty.has(c.id)) continue; // this device's edit wins until it is sent
      const local = await db.members.get(c.id);
      await db.members.put({
        id: c.id,
        memberNo: c.member_no,
        name: c.name,
        birthYear: Number(c.birth_year),
        gender: c.gender,
        contactNumber: c.contact_number ?? undefined,
        privacyConsentAt: c.privacy_consent_at,
        marketingConsent: c.marketing_consent,
        marketingConsentAt: c.marketing_consent_at ?? undefined,
        wantsDelivery: c.wants_delivery ?? local?.wantsDelivery,
        deliveryConsentAt:
          c.wants_delivery === undefined ? local?.deliveryConsentAt : (c.delivery_consent_at ?? undefined),
        deliveryAddress: c.wants_delivery === undefined ? local?.deliveryAddress : (c.delivery_address ?? undefined),
        deliveryLandmark: c.wants_delivery === undefined ? local?.deliveryLandmark : (c.delivery_landmark ?? undefined),
        active: c.active,
        notes: c.notes ?? undefined,
        registeredAt: c.registered_at,
        registeredBy: c.registered_by ?? "",
        deviceId: c.device_id ?? undefined,
        updatedAt: c.updated_at,
        remote: local ? local.remote : true,
      });
      report.pulledRecords++;
    }
    for (const p of feed.promotions) {
      if (dirty.has(p.id)) continue;
      await db.programs.put({
        id: p.id,
        name: p.name,
        description: p.description ?? "",
        input:
          p.kind === "percent"
            ? { kind: "percent", basisPoints: Number(p.value) }
            : { kind: "fixed", amount: Number(p.value) },
        scope: p.scope,
        productIds: p.product_ids ?? [],
        categoryIds: p.category_ids ?? [],
        membersOnly: p.members_only,
        minPurchase: Number(p.min_purchase),
        startsOn: p.starts_on ?? undefined,
        endsOn: p.ends_on ?? undefined,
        active: p.active,
        updatedAt: p.updated_at,
        updatedBy: p.updated_by ?? "",
        remote: true,
      });
      report.pulledRecords++;
    }
  });
  await patchSyncMeta({ membersCursor: feed.now }, db);
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
