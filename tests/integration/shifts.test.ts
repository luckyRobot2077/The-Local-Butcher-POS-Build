import { afterEach, describe, expect, it } from "vitest";
import { PosDatabase } from "@/lib/db/db";
import { ensureDevice } from "@/lib/db/config";
import { ensureDefaultCategories, loadSampleCatalog } from "@/lib/db/seed";
import { completeSale } from "@/lib/db/sales";
import { closeShift, getOpenShift, openShift, recordNoSale, shiftSales } from "@/lib/db/shifts";
import { priceCart } from "@/domain/cart";
import { setCloudIdentity } from "@/lib/cloud/identity";
import { runSync, salePayload } from "@/lib/cloud/sync";
import { FakeCloud } from "./fake-cloud";

const dbs: PosDatabase[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});

async function device() {
  const db = new PosDatabase(`shifts-${Math.random()}`);
  dbs.push(db);
  await db.open();
  await ensureDevice(db);
  await ensureDefaultCategories(db);
  await loadSampleCatalog("Owner", db);
  return db;
}

async function sell(db: PosDatabase, method: "cash" | "gcash", startedAt?: string) {
  const p = (await db.products.where("name").equals("Liempo (Pork Belly)").first())!;
  const totals = priceCart({
    lines: [
      {
        lineId: crypto.randomUUID(),
        productId: p.id,
        productName: p.name,
        saleUnit: p.saleUnit,
        unitPrice: p.price,
        unitCost: p.cost,
        qty: 1000,
      },
    ],
  });
  return completeSale(
    {
      totals,
      payment: method === "cash" ? { method, tendered: totals.total } : { method },
      cashierName: "Ana",
      startedAt,
    },
    db,
  );
}

describe("cashier shifts", () => {
  it("links sales to the open shift and works out the cash at the close", async () => {
    const db = await device();
    const before = await sell(db, "cash");
    expect(before.shiftId).toBeUndefined();

    const shift = await openShift({ openingFloat: 100000, by: "Ana" }, db);
    expect(await openShift({ openingFloat: 5, by: "Ben" }, db)).toEqual(shift); // one open shift per device
    const started = new Date(Date.now() - 60_000).toISOString();
    const a = await sell(db, "cash", started);
    await sell(db, "gcash");
    expect(a).toMatchObject({ shiftId: shift.id, startedAt: started });
    await recordNoSale({ reason: "Change for a customer", by: "Ana", approvedBy: "Josh" }, db);

    const closed = await closeShift({ countedCash: 134000, by: "Ana", note: "Short ₱1" }, db);
    expect(closed).toMatchObject({
      saleCount: 2,
      cashSales: 35000,
      gcashSales: 35000,
      expectedCash: 135000,
      countedCash: 134000,
      note: "Short ₱1",
    });
    expect(await getOpenShift(db)).toBeUndefined();
    expect((await shiftSales(shift.id, db)).map((s) => s.id)).not.toContain(before.id);
    await expect(recordNoSale({ reason: "x", by: "Ana" }, db)).rejects.toThrow("Open a shift first");
    await expect(closeShift({ countedCash: 0, by: "Ana" }, db)).rejects.toThrow("No shift is open");
    expect((await sell(db, "cash")).shiftId).toBeUndefined();
  });

  it("syncs the shift before its sales, then the close and the drawer opening", async () => {
    const cloud = new FakeCloud();
    const db = await device();
    await setCloudIdentity(
      {
        userId: "u",
        email: "e",
        storeId: "store-1",
        storeName: "The Local Butcher",
        displayName: "Ana",
        role: "cashier",
        canEditPhotos: false,
        canEditDescriptions: false,
        canEditNames: false,
        canEditPrices: false,
        canEditCategories: false,
        discountLimitBp: 1000,
        deviceRegistered: true,
        confirmedAt: new Date().toISOString(),
      },
      db,
    );
    const shift = await openShift({ openingFloat: 100000, by: "Ana" }, db);
    const sale = await sell(db, "cash", new Date(Date.now() - 1000).toISOString());
    await recordNoSale({ reason: "Checking or counting cash", by: "Ana", approvedBy: "Manager PIN" }, db);
    const r = await runSync(cloud.api(), db);
    expect(r).toMatchObject({ shifts: 1, sales: 1, failed: 0 });
    const order = cloud.calls.filter((c) => /sync_(shift|sale|drawer)/.test(c));
    expect(order).toEqual(["sync_shift", "sync_sale", "sync_drawer_event"]);
    const sent = cloud.saleRows[0].sale as Record<string, unknown>;
    expect(sent).toMatchObject({ shiftId: shift.id, startedAt: sale.startedAt });

    await closeShift({ countedCash: 135000, by: "Ana" }, db);
    await runSync(cloud.api(), db);
    expect(cloud.shifts.get(shift.id)).toMatchObject({ countedCash: 135000, expectedCash: 135000 });
    expect([...cloud.drawerEvents.values()][0]).toMatchObject({ approvedBy: "Manager PIN" });
    expect(await db.outbox.where("status").anyOf("pending", "failed").count()).toBe(0);
  });

  it("keeps the payload of sales made before shifts unchanged", async () => {
    const db = await device();
    const sale = await sell(db, "cash");
    const items = await db.saleItems.where("saleId").equals(sale.id).toArray();
    const payment = (await db.payments.where("saleId").equals(sale.id).first())!;
    const payload = salePayload(sale, items, payment);
    expect(payload.sale).not.toHaveProperty("startedAt");
    expect(payload.sale).not.toHaveProperty("shiftId");
  });
});
