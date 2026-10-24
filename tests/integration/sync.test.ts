import { afterEach, describe, expect, it } from "vitest";
import { PosDatabase } from "@/lib/db/db";
import { ensureDevice } from "@/lib/db/config";
import { DEFAULT_CATEGORIES, ensureDefaultCategories, loadSampleCatalog } from "@/lib/db/seed";
import { recordStockMovement, setProductImage, updateProduct } from "@/lib/db/products";
import { completeSale } from "@/lib/db/sales";
import { priceCart, type CartLine } from "@/domain/cart";
import { setCloudIdentity } from "@/lib/cloud/identity";
import { keepLocalVersion, retryFailed, runSync, takeServerVersion } from "@/lib/cloud/sync";
import { CloudUnavailable } from "@/lib/cloud/api";
import { FakeCloud } from "./fake-cloud";
import type { Product } from "@/lib/db/types";

const dbs: PosDatabase[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});

async function device(role: "owner" | "manager" | "cashier" = "owner") {
  const db = new PosDatabase(`sync-${Math.random()}`);
  dbs.push(db);
  await db.open();
  await ensureDevice(db);
  await ensureDefaultCategories(db);
  await setCloudIdentity(
    {
      userId: "u",
      email: "e",
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
  return db;
}

async function product(db: PosDatabase, name: string) {
  return (await db.products.where("name").equals(name).first())!;
}

function line(p: Product, qty: number): CartLine {
  return {
    lineId: crypto.randomUUID(),
    productId: p.id,
    productName: p.name,
    saleUnit: p.saleUnit,
    unitPrice: p.price,
    unitCost: p.cost,
    qty,
  };
}

async function sell(db: PosDatabase, p: Product, qty: number) {
  const totals = priceCart({ lines: [line(p, qty)] });
  return completeSale({ totals, payment: { method: "cash", tendered: totals.total }, cashierName: "Ana" }, db);
}

function input(p: Product) {
  return {
    name: p.name,
    description: p.description,
    categoryId: p.categoryId,
    saleUnit: p.saleUnit,
    price: p.price,
    cost: p.cost,
    minStockQty: p.minStockQty,
    active: p.active,
  };
}

describe("cloud sync", () => {
  it("pushes catalog, photos, stock and sales, then has nothing left to send", async () => {
    const cloud = new FakeCloud();
    const db = await device();
    await loadSampleCatalog("Owner", db);
    const belly = await product(db, "Liempo (Pork Belly)");
    await setProductImage(
      belly.id,
      { blob: new Blob([new Uint8Array([1, 2])]), mime: "image/jpeg", width: 1, height: 1 },
      "Owner",
      db,
    );
    await recordStockMovement(belly.id, "spoilage", -500, "Owner", { reason: "warm" }, db);
    const sale = await sell(db, await product(db, "Liempo (Pork Belly)"), 1250);

    const r = await runSync(cloud.api(), db);
    expect(r).toMatchObject({
      categories: DEFAULT_CATEGORIES.length,
      products: 16,
      photos: 1,
      sales: 1,
      failed: 0,
      conflicts: 0,
    });
    expect(await db.outbox.where("status").anyOf("pending", "failed").count()).toBe(0);
    expect((await db.sales.get(sale.id))!.syncStatus).toBe("synced");
    expect(cloud.saleRows).toHaveLength(1);
    expect(cloud.products.get(belly.id)!.image_id).toBeTruthy();
    // Server stock: 9000 opening - 500 spoilage - 1250 sold; local agrees after pull.
    expect(cloud.stockOf(belly.id)).toBe(7250);
    expect((await product(db, "Liempo (Pork Belly)")).stockQty).toBe(7250);

    cloud.calls = [];
    const again = await runSync(cloud.api(), db);
    expect(again).toMatchObject({ products: 0, sales: 0, photos: 0, pulledProducts: 0 });
    expect(cloud.calls.filter((c) => c.startsWith("sync_"))).toEqual([]);
  });

  it("keeps everything queued while offline and sends it when back online", async () => {
    const cloud = new FakeCloud();
    const db = await device();
    await loadSampleCatalog("Owner", db);
    const sale = await sell(db, await product(db, "Whole Chicken"), 2);

    cloud.offline = true;
    await expect(runSync(cloud.api(), db)).rejects.toBeInstanceOf(CloudUnavailable);
    expect((await db.sales.get(sale.id))!.syncStatus).toBe("pending");
    expect(await db.outbox.where("status").equals("failed").count()).toBe(0);
    expect((await product(db, "Whole Chicken")).stockQty).toBe(13);

    cloud.offline = false;
    await runSync(cloud.api(), db);
    expect((await db.sales.get(sale.id))!.syncStatus).toBe("synced");
    expect(cloud.saleRows).toHaveLength(1);
    expect((await product(db, "Whole Chicken")).stockQty).toBe(13);
  });

  it("does not duplicate a sale whose confirmation was lost", async () => {
    const cloud = new FakeCloud();
    const db = await device();
    await loadSampleCatalog("Owner", db);
    const sale = await sell(db, await product(db, "Kasim (Shoulder)"), 500);
    cloud.loseReplyOnce.add("sync_sale");
    await expect(runSync(cloud.api(), db)).rejects.toBeInstanceOf(CloudUnavailable);
    expect((await db.sales.get(sale.id))!.syncStatus).toBe("pending"); // device does not know it arrived
    // A reprint changes the local record but not the payload.
    await db.sales.update(sale.id, { receiptPrintCount: 1 });
    await runSync(cloud.api(), db);
    expect((await db.sales.get(sale.id))!.syncStatus).toBe("synced");
    expect(cloud.saleRows).toHaveLength(1);
  });

  it("shares one catalog between two devices and merges same-name categories", async () => {
    const cloud = new FakeCloud();
    const a = await device();
    const b = await device("cashier");
    await loadSampleCatalog("Owner", a);
    await runSync(cloud.api(), a);

    await runSync(cloud.api(), b);
    expect(await b.products.count()).toBe(16);
    expect(await b.categories.count()).toBe(DEFAULT_CATEGORIES.length); // B's own "Pork" etc. merged into A's
    const chickenB = await product(b, "Whole Chicken");
    expect((await b.categories.get(chickenB.categoryId))!.name).toBe("Chicken");
    expect(chickenB.stockQty).toBe(15);

    await sell(b, chickenB, 3);
    await runSync(cloud.api(), b);
    await runSync(cloud.api(), a);
    expect((await product(a, "Whole Chicken")).stockQty).toBe(12);
  });

  it("reports an edit conflict and lets the user keep either version", async () => {
    const cloud = new FakeCloud();
    const a = await device();
    const b = await device();
    await loadSampleCatalog("Owner", a);
    await runSync(cloud.api(), a);
    await runSync(cloud.api(), b);

    const pa = await product(a, "Pork Ribs");
    await updateProduct(pa.id, { ...input(pa), price: 28000 }, "Owner", { reason: "new supplier" }, a);
    const pb = await product(b, "Pork Ribs");
    await updateProduct(pb.id, { ...input(pb), description: "Spare ribs" }, "Owner", {}, b);

    await runSync(cloud.api(), a);
    const rb = await runSync(cloud.api(), b);
    expect(rb.conflicts).toBe(1);
    const failed = await b.outbox.where("status").equals("failed").toArray();
    expect(failed[0].lastError).toMatch(/another device/);
    // Pull did not overwrite B's unsent edit.
    expect((await product(b, "Pork Ribs")).description).toBe("Spare ribs");

    await keepLocalVersion(pb.id, b);
    await runSync(cloud.api(), b);
    expect(cloud.products.get(pb.id)!.description).toBe("Spare ribs");
    expect(cloud.products.get(pb.id)!.price).toBe(27000); // B's copy still had the old price: B won

    // Now the opposite choice on A.
    const pa2 = await product(a, "Pork Ribs");
    await updateProduct(pa2.id, { ...input(pa2), description: "A's text" }, "Owner", {}, a);
    expect((await runSync(cloud.api(), a)).conflicts).toBe(1);
    await takeServerVersion(pa2.id, a);
    expect((await product(a, "Pork Ribs")).description).toBe("Spare ribs");
    await runSync(cloud.api(), a);
    expect(await a.outbox.where("status").anyOf("pending", "failed").count()).toBe(0);
  });

  it("marks server rejections as failed until retried", async () => {
    const cloud = new FakeCloud();
    const db = await device();
    await loadSampleCatalog("Owner", db);
    await runSync(cloud.api(), db);
    const p = await product(db, "Pork Liver");
    await recordStockMovement(p.id, "delivery", 2000, "Ana", {}, db);
    cloud.deny.add("sync_movement");
    const r = await runSync(cloud.api(), db);
    expect(r.failed).toBe(1);
    const [f] = await db.outbox.where("status").equals("failed").toArray();
    expect(f.lastError).toMatch(/not allowed/);
    // Local stock still shows the delivery even though the server refused it.
    expect((await product(db, "Pork Liver")).stockQty).toBe(1300 + 2000);

    cloud.deny.clear();
    await retryFailed(db);
    await runSync(cloud.api(), db);
    expect(await db.outbox.where("status").equals("failed").count()).toBe(0);
    expect(cloud.stockOf(p.id)).toBe(3300);
  });
});

describe("tax setup sync", () => {
  it("downloads the Back Office tax setup and keeps it when the cloud is older", async () => {
    const { getTaxSettings } = await import("@/lib/db/config");
    const cloud = new FakeCloud();
    const db = await device();
    cloud.taxSettings = { mode: "vat", tin: "123-456-789-00000", categories: {}, products: {} };
    await runSync(cloud.api(), db);
    expect((await getTaxSettings(db)).mode).toBe("vat");
    cloud.deny.add("store_tax_settings");
    await runSync(cloud.api(), db);
    expect((await getTaxSettings(db)).tin).toBe("123-456-789-00000");
  });
});
