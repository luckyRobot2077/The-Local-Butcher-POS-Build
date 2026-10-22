import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_SCHEMA_VERSION, PosDatabase } from "@/lib/db/db";
import { ensureDevice } from "@/lib/db/config";
import { ensureDefaultCategories, loadSampleCatalog } from "@/lib/db/seed";
import { ProductError, recordStockMovement } from "@/lib/db/products";
import {
  InventoryError,
  loadInventoryData,
  receivePurchase,
  saveSupplier,
  setPaymentStatus,
  type PurchaseInput,
} from "@/lib/db/inventory";
import { completeSale } from "@/lib/db/sales";
import { priceCart } from "@/domain/cart";
import { computeMetrics, DEFAULT_INVENTORY_RULES } from "@/domain/inventory";
import { businessDate } from "@/domain/time";
import { getSyncMeta, setCloudIdentity } from "@/lib/cloud/identity";
import { runSync } from "@/lib/cloud/sync";
import { FakeCloud } from "./fake-cloud";
import type { Product } from "@/lib/db/types";

const dbs: PosDatabase[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});

async function device(role: "owner" | "manager" | "cashier" = "owner", signedIn = true) {
  const db = new PosDatabase(`inv-${Math.random()}`);
  dbs.push(db);
  await db.open();
  await ensureDevice(db);
  await ensureDefaultCategories(db);
  if (signedIn) {
    await setCloudIdentity(
      {
        userId: role,
        email: `${role}@example.test`,
        storeId: "store-1",
        storeName: "The Local Butcher",
        displayName: role,
        role,
        canEditPhotos: true,
        canEditDescriptions: true,
        canEditNames: true,
        canEditPrices: true,
        canEditCategories: true,
        discountLimitBp: 1000,
        deviceRegistered: true,
        confirmedAt: new Date().toISOString(),
      },
      db,
    );
  }
  return db;
}

async function product(db: PosDatabase, name: string): Promise<Product> {
  return (await db.products.where("name").equals(name).first())!;
}

async function sell(db: PosDatabase, p: Product, qty: number) {
  const totals = priceCart({
    lines: [
      {
        lineId: crypto.randomUUID(),
        productId: p.id,
        productName: p.name,
        saleUnit: p.saleUnit,
        unitPrice: p.price,
        unitCost: p.cost,
        qty,
      },
    ],
  });
  return completeSale({ totals, payment: { method: "cash", tendered: totals.total }, cashierName: "Ana" }, db);
}

function purchase(
  supplierId: string,
  lines: PurchaseInput["lines"],
  extra: Partial<PurchaseInput> = {},
): PurchaseInput {
  return { supplierId, paymentStatus: "unpaid", updateCosts: true, lines, ...extra };
}

describe("receiving purchases", () => {
  it("adds stock, batches and an average cost in one transaction", async () => {
    const db = await device("owner", false);
    await loadSampleCatalog("Owner", db);
    const belly = await product(db, "Liempo (Pork Belly)");
    const chicken = await product(db, "Whole Chicken");
    const supplier = await saveSupplier(
      { name: "Jun's Farm", contact: "", notes: "", active: true },
      "Owner",
      undefined,
      db,
    );
    await db.outbox.clear();

    const p = await receivePurchase(
      purchase(supplier.id, [
        { productId: belly.id, qty: 12_345, unitCost: belly.cost + 2000, batchCode: "L-1", useBy: "2026-11-02" },
        { productId: chicken.id, qty: 10, unitCost: 21_000 },
      ]),
      "Ben",
      db,
    );
    const bellyLine = Math.round(((belly.cost + 2000) * 12_345) / 1000);
    expect(p.totalCost).toBe(bellyLine + 210_000);

    const after = await product(db, "Liempo (Pork Belly)");
    expect(after.stockQty).toBe(belly.stockQty + 12_345);
    // Weighted average of 9 kg at the old cost and 12.345 kg at +20 pesos.
    expect(after.cost).toBe(
      Math.round((belly.stockQty * belly.cost + 12_345 * (belly.cost + 2000)) / (belly.stockQty + 12_345)),
    );
    expect(after.version).toBe(belly.version + 1);
    expect((await db.priceChanges.where("productId").equals(belly.id).last())?.reason).toContain("Jun's Farm");

    const batches = await db.batches.where("purchaseId").equals(p.id).toArray();
    expect(batches).toHaveLength(2);
    expect(batches.find((b) => b.productId === belly.id)).toMatchObject({
      batchCode: "L-1",
      useBy: "2026-11-02",
      initialQty: 12_345,
    });
    const moves = await db.inventoryMovements.where("purchaseId").equals(p.id).toArray();
    expect(moves.map((m) => m.type)).toEqual(["purchase", "purchase"]);
    expect(moves.every((m) => m.batchId)).toBe(true);

    const kinds = (await db.outbox.toArray()).map((e) => e.kind).sort();
    // Cost changed on both products; purchase movements travel with the purchase, not on their own.
    expect(kinds).toEqual(["product", "product", "purchase"]);

    await setPaymentStatus(p.id, "paid", "Ben", db);
    expect((await db.purchases.get(p.id))?.paymentStatus).toBe("paid");
    expect((await db.outbox.toArray()).filter((e) => e.kind === "purchase_payment")).toHaveLength(1);
  });

  it("leaves costs alone when asked and rejects bad input", async () => {
    const db = await device("owner", false);
    await loadSampleCatalog("Owner", db);
    const belly = await product(db, "Liempo (Pork Belly)");
    const s = await saveSupplier({ name: "Farm", contact: "", notes: "", active: true }, "Owner", undefined, db);
    await receivePurchase(
      purchase(s.id, [{ productId: belly.id, qty: 1000, unitCost: 1 }], { updateCosts: false }),
      "Ben",
      db,
    );
    expect((await product(db, belly.name)).cost).toBe(belly.cost);

    await expect(
      receivePurchase(purchase("nope", [{ productId: belly.id, qty: 1, unitCost: 1 }]), "Ben", db),
    ).rejects.toThrow(InventoryError);
    await expect(
      receivePurchase(
        purchase(s.id, [{ productId: belly.id, qty: 1, unitCost: 1 }], {
          receivedAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        "Ben",
        db,
      ),
    ).rejects.toThrow("future");
    await expect(receivePurchase(purchase(s.id, []), "Ben", db)).rejects.toThrow();
    await expect(
      saveSupplier({ name: " farm ", contact: "", notes: "", active: true }, "Owner", undefined, db),
    ).rejects.toThrow("already exists");
    // Nothing from the failed attempts was written.
    expect(await db.purchases.count()).toBe(1);
  });

  it("records waste against the batch it came from", async () => {
    const db = await device("owner", false);
    await loadSampleCatalog("Owner", db);
    const belly = await product(db, "Liempo (Pork Belly)");
    const chicken = await product(db, "Whole Chicken");
    const s = await saveSupplier({ name: "Farm", contact: "", notes: "", active: true }, "Owner", undefined, db);
    const p = await receivePurchase(
      purchase(s.id, [
        { productId: belly.id, qty: 5000, unitCost: 30_000, batchCode: "B-7" },
        { productId: chicken.id, qty: 5, unitCost: 20_000 },
      ]),
      "Ben",
      db,
    );
    const [bellyBatch, chickenBatch] = await Promise.all([
      db.batches.where({ purchaseId: p.id, productId: belly.id }).first(),
      db.batches.where({ purchaseId: p.id, productId: chicken.id }).first(),
    ]);
    const m = await recordStockMovement(belly.id, "spoilage", -700, "Ben", { batchId: bellyBatch!.id }, db);
    expect(m).toMatchObject({ batchId: bellyBatch!.id, batchCode: "B-7" });
    await expect(
      recordStockMovement(belly.id, "spoilage", -1, "Ben", { batchId: chickenBatch!.id }, db),
    ).rejects.toThrow(ProductError);
    await expect(recordStockMovement(belly.id, "delivery", 1, "Ben", { batchId: bellyBatch!.id }, db)).rejects.toThrow(
      ProductError,
    );

    const data = await loadInventoryData(db);
    expect(data.wasteByBatch.get(bellyBatch!.id)).toBe(700);
    expect(data.lastRestock.get(belly.id)).toBeTruthy();
    const [metric] = computeMetrics({
      products: data.products.filter((x) => x.id === belly.id),
      ledger: data.ledger,
      saleLines: data.saleLines,
      asOf: businessDate(new Date()),
      rules: DEFAULT_INVENTORY_RULES,
    });
    expect(metric.received).toBe(9000 + 5000); // sample opening stock + this purchase
    expect(metric.wasted).toBe(700);
  });

  it("upgrades a Phase 1 database without losing data", async () => {
    const name = `upgrade-${Math.random()}`;
    const old = new Dexie(name);
    old.version(1).stores({
      categories: "id, sortOrder",
      products: "id, categoryId, name, active, sku, barcode, updatedAt",
      productImages: "id, productId, uploadStatus",
      productRevisions: "id, productId, at",
      priceChanges: "id, productId, at",
      sales: "id, &receiptNo, createdAt, businessDate, syncStatus",
      saleItems: "id, saleId, productId",
      payments: "id, saleId",
      inventoryMovements: "id, productId, type, at, refId",
      outbox: "id, kind, status, entityId, createdAt",
      auditLog: "id, action, at",
      config: "key",
    });
    await old.open();
    await old.table("inventoryMovements").add({ id: "m1", productId: "p", type: "delivery", qtyDelta: 5, at: "x" });
    old.close();

    const db = new PosDatabase(name);
    dbs.push(db);
    await db.open();
    expect(db.verno).toBe(LOCAL_SCHEMA_VERSION);
    expect(await db.inventoryMovements.get("m1")).toMatchObject({ qtyDelta: 5 });
    expect(await db.suppliers.count()).toBe(0);
  });
});

describe("inventory sync", () => {
  it("syncs supplier, purchase and payment once, and keeps stock right", async () => {
    const cloud = new FakeCloud();
    const db = await device("manager");
    await loadSampleCatalog("Owner", db);
    const belly = await product(db, "Liempo (Pork Belly)");
    const s = await saveSupplier({ name: "Jun's Farm", contact: "", notes: "", active: true }, "Ben", undefined, db);
    const p = await receivePurchase(
      purchase(s.id, [{ productId: belly.id, qty: 4321, unitCost: 31_000, useBy: "2026-11-01" }], {
        paymentStatus: "partial",
      }),
      "Ben",
      db,
    );

    // The purchase is rejected once (e.g. permission not granted yet): stock must still include it.
    cloud.deny.add("sync_purchase");
    const r1 = await runSync(cloud.api(), db);
    expect(r1).toMatchObject({ suppliers: 1, purchases: 0, failed: 2 }); // purchase + its payment status
    expect((await product(db, belly.name)).stockQty).toBe(9000 + 4321);

    cloud.deny.clear();
    await db.outbox.where("status").equals("failed").modify({ status: "pending" });
    const r2 = await runSync(cloud.api(), db);
    expect(r2).toMatchObject({ purchases: 1, failed: 0 });
    expect(cloud.purchases.get(p.id)?.paymentStatus).toBe("partial");
    expect(cloud.stockOf(belly.id)).toBe(9000 + 4321);
    expect((await product(db, belly.name)).stockQty).toBe(9000 + 4321);
    expect(await db.outbox.where("status").anyOf("pending", "failed").count()).toBe(0);

    // A lost reply does not create a second purchase.
    await db.outbox.where("kind").equals("purchase").modify({ status: "pending" });
    cloud.loseReplyOnce.add("sync_purchase");
    await expect(runSync(cloud.api(), db)).rejects.toThrow();
    await runSync(cloud.api(), db);
    expect(cloud.purchases.size).toBe(1);
    expect(cloud.stockOf(belly.id)).toBe(9000 + 4321);
  });

  it("merges a supplier created on two devices and shares records between them", async () => {
    const cloud = new FakeCloud();
    const owner = await device("owner");
    await loadSampleCatalog("Owner", owner);
    await runSync(cloud.api(), owner);
    const manager = await device("manager");
    await runSync(cloud.api(), manager); // gets the catalog

    const belly = await product(owner, "Liempo (Pork Belly)");
    const sOwner = await saveSupplier(
      { name: "Jun's Farm", contact: "", notes: "", active: true },
      "Josh",
      undefined,
      owner,
    );
    const sMgr = await saveSupplier(
      { name: "jun's farm", contact: "0917", notes: "", active: true },
      "Ben",
      undefined,
      manager,
    );
    await runSync(cloud.api(), owner);

    const p = await receivePurchase(
      purchase(sMgr.id, [{ productId: belly.id, qty: 2000, unitCost: 30_000, batchCode: "M-1" }]),
      "Ben",
      manager,
    );
    await recordStockMovement(belly.id, "spoilage", -250, "Ben", { reason: "drip loss" }, manager);
    const counterSale = await sell(owner, await product(owner, belly.name), 1000);
    await runSync(cloud.api(), manager);
    await runSync(cloud.api(), owner);
    await runSync(cloud.api(), manager);

    // The manager's supplier became the owner's record.
    expect(await manager.suppliers.get(sMgr.id)).toBeUndefined();
    expect((await manager.purchases.get(p.id))?.supplierId).toBe(sOwner.id);
    expect(cloud.suppliers.size).toBe(1);

    // Both devices agree on stock: 9000 + 2000 - 250 - 1000.
    for (const db of [owner, manager]) expect((await product(db, belly.name)).stockQty).toBe(9750);

    // The owner now has the manager's purchase, batch and waste for reports...
    expect((await owner.purchases.get(p.id))?.remote).toBe(true);
    expect(await owner.batches.where("purchaseId").equals(p.id).count()).toBe(1);
    const ownerData = await loadInventoryData(owner);
    expect(ownerData.ledger.filter((m) => m.productId === belly.id).reduce((a, m) => a + m.qtyDelta, 0)).toBe(9750);
    // ...and the manager has the owner's sale line, but no duplicate of anything.
    const mgrData = await loadInventoryData(manager);
    expect(mgrData.saleLines.filter((l) => l.productId === belly.id)).toHaveLength(1);
    expect(await manager.remoteSaleLines.where("saleId").equals(counterSale.id).count()).toBe(1);

    const before = await manager.inventoryMovements.count();
    await runSync(cloud.api(), manager);
    expect(await manager.inventoryMovements.count()).toBe(before);

    // A payment status change on one device reaches the other.
    await setPaymentStatus(p.id, "paid", "Josh", owner);
    await runSync(cloud.api(), owner);
    await runSync(cloud.api(), manager);
    expect((await manager.purchases.get(p.id))?.paymentStatus).toBe("paid");
  });

  it("keeps syncing sales when the inventory feed is refused", async () => {
    const cloud = new FakeCloud();
    const db = await device("owner");
    await loadSampleCatalog("Owner", db);
    const sale = await sell(db, await product(db, "Whole Chicken"), 1);
    cloud.deny.add("inventory_feed"); // e.g. the database update has not been run yet
    await runSync(cloud.api(), db);
    expect((await db.sales.get(sale.id))?.syncStatus).toBe("synced");
    expect((await getSyncMeta(db)).feedError).toContain("not allowed");
    expect((await getSyncMeta(db)).lastError).toBeUndefined();
    cloud.deny.clear();
    await runSync(cloud.api(), db);
    expect((await getSyncMeta(db)).feedError).toBeUndefined();
  });

  it("does not download the inventory feed on a cashier device", async () => {
    const cloud = new FakeCloud();
    const owner = await device("owner");
    await loadSampleCatalog("Owner", owner);
    await runSync(cloud.api(), owner);
    const cashier = await device("cashier");
    cloud.calls = [];
    await runSync(cloud.api(), cashier);
    expect(cloud.calls).not.toContain("inventory_feed");
  });
});
