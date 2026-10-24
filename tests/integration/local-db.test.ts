import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PosDatabase } from "@/lib/db/db";
import { loadSampleCatalog } from "@/lib/db/seed";
import {
  createProduct,
  ledgerStock,
  recordStockMovement,
  removeProductImage,
  setProductImage,
  updateProduct,
  ProductError,
} from "@/lib/db/products";
import { completeSale, getSaleDetail, recordReceiptPrint, syncCounts } from "@/lib/db/sales";
import { priceCart, type CartLine } from "@/domain/cart";
import { createBackup, verifyBackup, BackupVerifyError } from "@/lib/backup";
import { hashPin, verifyPin } from "@/lib/pin";
import { setPinRecord } from "@/lib/db/config";

let db: PosDatabase;
let n = 0;

beforeEach(async () => {
  db = new PosDatabase(`test-${++n}-${Math.random()}`);
  await db.open();
});
afterEach(async () => {
  await db.delete();
});

async function firstProduct(name: string) {
  return (await db.products.where("name").equals(name).first())!;
}

function lineFor(
  p: { id: string; name: string; saleUnit: "kg" | "piece"; price: number; cost: number },
  qty: number,
): CartLine {
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

describe("local database", () => {
  it("loads the sample catalog with opening stock in the ledger", async () => {
    const count = await loadSampleCatalog("Owner", db);
    expect(count).toBeGreaterThan(10);
    const belly = await firstProduct("Liempo (Pork Belly)");
    expect(belly.price).toBe(35000);
    expect(belly.stockQty).toBe(9000);
    expect(await ledgerStock(belly.id, db)).toBe(9000);
    await expect(loadSampleCatalog("Owner", db)).rejects.toThrow();
  });

  it("saves a cash sale atomically, reduces stock and queues it for sync", async () => {
    await loadSampleCatalog("Owner", db);
    const belly = await firstProduct("Liempo (Pork Belly)");
    const chicken = await firstProduct("Whole Chicken");
    const totals = priceCart({ lines: [lineFor(belly, 1250), lineFor(chicken, 2)] });
    const sale = await completeSale({ totals, payment: { method: "cash", tendered: 100000 }, cashierName: "Ana" }, db);

    expect(sale.total).toBe(43750 + 39000);
    expect(sale.change).toBe(100000 - 82750);
    const detail = await getSaleDetail(sale.id, db);
    expect(detail?.items).toHaveLength(2);
    expect(detail?.payment.amount).toBe(82750);
    expect((await firstProduct("Liempo (Pork Belly)")).stockQty).toBe(9000 - 1250);
    expect(await ledgerStock(belly.id, db)).toBe(9000 - 1250);
    expect((await firstProduct("Whole Chicken")).stockQty).toBe(13);
    expect(await db.outbox.where({ kind: "sale", entityId: sale.id }).count()).toBe(1);
    expect((await syncCounts(db)).pendingSales).toBe(1);
  });

  it("issues sequential, unique receipt numbers", async () => {
    await loadSampleCatalog("Owner", db);
    const chicken = await firstProduct("Whole Chicken");
    const totals = priceCart({ lines: [lineFor(chicken, 1)] });
    const pay = { method: "cash" as const, tendered: 20000 };
    const [a, b] = await Promise.all([
      completeSale({ totals, payment: pay, cashierName: "Ana" }, db),
      completeSale({ totals, payment: pay, cashierName: "Ana" }, db),
    ]);
    expect(a.receiptNo).not.toBe(b.receiptNo);
    expect([a.receiptNo, b.receiptNo].map((r) => r.slice(-6)).sort()).toEqual(["000001", "000002"]);
  });

  it("does not save anything when checkout fails", async () => {
    await loadSampleCatalog("Owner", db);
    const chicken = await firstProduct("Whole Chicken");
    const totals = priceCart({ lines: [lineFor(chicken, 1)] });
    await expect(
      completeSale({ totals, payment: { method: "cash", tendered: 100 }, cashierName: "Ana" }, db),
    ).rejects.toThrow();
    expect(await db.sales.count()).toBe(0);
    expect(await db.inventoryMovements.where("type").equals("sale").count()).toBe(0);
    expect((await firstProduct("Whole Chicken")).stockQty).toBe(15);
  });

  it("keeps historical sale prices when the product price changes, and logs the change", async () => {
    await loadSampleCatalog("Owner", db);
    const belly = await firstProduct("Liempo (Pork Belly)");
    const sale = await completeSale(
      {
        totals: priceCart({ lines: [lineFor(belly, 1000)] }),
        payment: { method: "cash", tendered: 35000 },
        cashierName: "Ana",
      },
      db,
    );
    const { id, stockQty, createdAt, updatedAt, version, imageId, isSample, ...input } = belly;
    void stockQty;
    void createdAt;
    void updatedAt;
    void imageId;
    void isSample;
    const updated = await updateProduct(
      id,
      { ...input, price: 36000 },
      "Owner",
      { reason: "Supplier increase", expectedVersion: version },
      db,
    );
    expect(updated.version).toBe(version + 1);
    const log = await db.priceChanges.where("productId").equals(id).toArray();
    expect(log).toEqual([
      expect.objectContaining({ oldValue: 35000, newValue: 36000, reason: "Supplier increase", by: "Owner" }),
    ]);
    const detail = await getSaleDetail(sale.id, db);
    expect(detail?.items[0].unitPrice).toBe(35000);
    expect(detail?.sale.total).toBe(35000);
    await expect(
      updateProduct(id, { ...input, price: 37000 }, "Owner", { expectedVersion: version }, db),
    ).rejects.toThrow(ProductError);
  });

  it("records stock movements through the ledger", async () => {
    const cat = { id: "c1", name: "Pork", sortOrder: 0 };
    await db.categories.add(cat);
    const p = await createProduct(
      {
        name: "Kasim",
        description: "",
        categoryId: "c1",
        saleUnit: "kg",
        price: 34000,
        cost: 26500,
        minStockQty: 2000,
        active: true,
      },
      "Owner",
      db,
    );
    await recordStockMovement(p.id, "delivery", 10000, "Owner", { batchCode: "B-1", useBy: "2026-10-25" }, db);
    await recordStockMovement(p.id, "spoilage", -500, "Owner", { reason: "Left out" }, db);
    await expect(recordStockMovement(p.id, "spoilage", 500, "Owner", {}, db)).rejects.toThrow(ProductError);
    await expect(recordStockMovement(p.id, "correction", -100, "Owner", {}, db)).rejects.toThrow(ProductError);
    await recordStockMovement(p.id, "correction", -100, "Owner", { reason: "Recount" }, db);
    expect((await db.products.get(p.id))!.stockQty).toBe(9400);
    expect(await ledgerStock(p.id, db)).toBe(9400);
  });

  it("stores, replaces and removes product photos offline", async () => {
    await loadSampleCatalog("Owner", db);
    const belly = await firstProduct("Liempo (Pork Belly)");
    const img1 = await setProductImage(
      belly.id,
      {
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
        mime: "image/jpeg",
        width: 10,
        height: 10,
      },
      "Owner",
      db,
    );
    const img2 = await setProductImage(
      belly.id,
      { blob: new Blob([new Uint8Array([4, 5])], { type: "image/jpeg" }), mime: "image/jpeg", width: 10, height: 10 },
      "Owner",
      db,
    );
    expect((await firstProduct("Liempo (Pork Belly)")).imageId).toBe(img2.id);
    expect(await db.productImages.get(img1.id)).toBeUndefined();
    expect(await db.outbox.where("kind").equals("product_image").count()).toBe(2);
    await removeProductImage(belly.id, "Owner", db);
    expect((await firstProduct("Liempo (Pork Belly)")).imageId).toBeUndefined();
    expect(await db.productImages.count()).toBe(0);
  });

  it("records reprints without creating sales", async () => {
    await loadSampleCatalog("Owner", db);
    const chicken = await firstProduct("Whole Chicken");
    const sale = await completeSale(
      {
        totals: priceCart({ lines: [lineFor(chicken, 1)] }),
        payment: { method: "gcash", reference: "1234" },
        cashierName: "Ana",
      },
      db,
    );
    await recordReceiptPrint(sale.id, "Ana", db);
    await recordReceiptPrint(sale.id, "Ana", db);
    expect(await db.sales.count()).toBe(1);
    expect((await db.sales.get(sale.id))!.receiptPrintCount).toBe(2);
    expect(await db.auditLog.where("action").equals("receipt.reprint").count()).toBe(1);
  });
});

describe("manager PIN", () => {
  it("hashes and verifies", async () => {
    const rec = await hashPin("4321");
    expect(await verifyPin("4321", rec)).toBe(true);
    expect(await verifyPin("1234", rec)).toBe(false);
    expect(await verifyPin("abc", rec)).toBe(false);
  });
});

describe("encrypted device backup", () => {
  it("round-trips record counts and totals, excludes the PIN, and detects tampering", async () => {
    await loadSampleCatalog("Owner", db);
    await setPinRecord(await hashPin("4321"), db);
    const chicken = await firstProduct("Whole Chicken");
    await setProductImage(
      chicken.id,
      { blob: new Blob([new Uint8Array([9, 8, 7])]), mime: "image/jpeg", width: 1, height: 1 },
      "Owner",
      db,
    );
    const sale = await completeSale(
      {
        totals: priceCart({ lines: [lineFor(chicken, 3)] }),
        payment: { method: "cash", tendered: 60000 },
        cashierName: "Ana",
      },
      db,
    );

    const { file, manifest } = await createBackup("correct horse", db);
    expect(manifest.counts.sales).toBe(1);
    expect(manifest.unsyncedSales).toBe(1);
    const raw = JSON.stringify(file);
    expect(raw).not.toContain("Whole Chicken"); // encrypted

    const { tables } = await verifyBackup(raw, "correct horse");
    expect((tables.sales as { id: string; total: number }[])[0]).toMatchObject({ id: sale.id, total: 58500 });
    expect(tables.productImages).toHaveLength(1);
    expect((tables.config as { key: string }[]).some((c) => c.key === "managerPin")).toBe(false);

    await expect(verifyBackup(raw, "wrong pass")).rejects.toThrow(BackupVerifyError);
    const tampered = { ...file, ciphertext: file.ciphertext.slice(0, -8) + "AAAAAAA=" };
    await expect(verifyBackup(JSON.stringify(tampered), "correct horse")).rejects.toThrow(BackupVerifyError);
  });
});

describe("sample catalog", () => {
  it("is loaded all-or-nothing", async () => {
    const db2 = new PosDatabase(`seed-${Math.random()}`);
    await db2.open();
    // Force a failure part-way through by making the table read-only for a moment.
    const orig = db2.inventoryMovements.add.bind(db2.inventoryMovements);
    let calls = 0;
    db2.inventoryMovements.add = ((...args: Parameters<typeof orig>) => {
      if (++calls === 5) throw new Error("simulated crash");
      return orig(...args);
    }) as typeof orig;
    await expect(loadSampleCatalog("Owner", db2)).rejects.toThrow("simulated crash");
    expect(await db2.products.count()).toBe(0);
    await db2.delete();
  });
});

describe("taxes on local sales", () => {
  it("taxes a VATable category once the shop is VAT-registered", async () => {
    const { setTaxSettings } = await import("@/lib/db/config");
    const { normalizeTaxSettings } = await import("@/domain/tax");
    await loadSampleCatalog("Owner", db);
    const belly = await firstProduct("Liempo (Pork Belly)");
    const chicken = await firstProduct("Whole Chicken");
    const chickenCat = chicken.categoryId;
    await setTaxSettings(
      normalizeTaxSettings({ mode: "vat", tin: "123456789", categories: { [chickenCat]: "vatable" } }),
      db,
    );
    const totals = priceCart({ lines: [lineFor(belly, 1000), lineFor(chicken, 1)] });
    const sale = await completeSale({ totals, payment: { method: "cash", tendered: 100000 }, cashierName: "Ana" }, db);
    expect(sale.taxMode).toBe("vat");
    expect(sale.vatExemptSales).toBe(35000);
    expect(sale.vatAmount).toBe(Math.floor((chicken.price * 1200 * 2 + 11200) / (11200 * 2)));
    const detail = await getSaleDetail(sale.id, db);
    expect(detail?.items.map((i) => i.taxClass)).toEqual(["exempt", "vatable"]);
  });

  it("records non-VAT sales by default", async () => {
    await loadSampleCatalog("Owner", db);
    const belly = await firstProduct("Liempo (Pork Belly)");
    const totals = priceCart({ lines: [lineFor(belly, 1000)] });
    const sale = await completeSale({ totals, payment: { method: "cash", tendered: 100000 }, cashierName: "Ana" }, db);
    expect(sale.taxMode).toBe("non_vat");
    expect(sale.vatAmount).toBeUndefined();
  });
});
