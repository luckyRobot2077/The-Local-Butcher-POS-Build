import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { PosDatabase } from "@/lib/db/db";
import { ensureDevice } from "@/lib/db/config";
import { ensureDefaultCategories, loadSampleCatalog } from "@/lib/db/seed";
import { completeSale } from "@/lib/db/sales";
import {
  findMemberByCode,
  memberHistory,
  memberVisitSummary,
  registerMember,
  saleFacts,
  updateMember,
} from "@/lib/db/members";
import { saveProgram, type ProgramInput } from "@/lib/db/programs";
import { priceCart, type Cart, type CartLine } from "@/domain/cart";
import { applyProgram } from "@/domain/programs";
import { memberQrPayload } from "@/domain/members";
import { setCloudIdentity } from "@/lib/cloud/identity";
import { runSync, salePayload } from "@/lib/cloud/sync";
import { FakeCloud } from "./fake-cloud";
import type { Product } from "@/lib/db/types";

const dbs: PosDatabase[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});

async function device(role: "owner" | "manager" | "cashier" = "owner") {
  const db = new PosDatabase(`members-${Math.random()}`);
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

const maria = {
  name: "Maria Santos",
  age: 38,
  gender: "female" as const,
  contactNumber: "0917 123 4567",
  privacyConsent: true as const,
  marketingConsent: true,
  notes: "",
};

const memberProgram: ProgramInput = {
  name: "Member 10%",
  description: "",
  input: { kind: "percent", basisPoints: 1000 },
  scope: "order",
  productIds: [],
  categoryIds: [],
  membersOnly: true,
  minPurchase: 0,
  active: true,
};

async function product(db: PosDatabase, name: string): Promise<Product> {
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

describe("members on the device", () => {
  it("registers members with unique numbers, birth year and consent", async () => {
    const db = await device();
    const device1 = (await db.config.get("device"))!.value as { deviceCode: string };
    const now = new Date("2026-10-22T02:00:00Z");
    const a = await registerMember(maria, "Ana", db, now);
    const b = await registerMember(
      { ...maria, name: "Jose", contactNumber: "", marketingConsent: false },
      "Ana",
      db,
      now,
    );
    expect(a.memberNo).toBe(`M-${device1.deviceCode}-0001`);
    expect(b.memberNo).toBe(`M-${device1.deviceCode}-0002`);
    expect(a).toMatchObject({ birthYear: 1988, contactNumber: "+639171234567", marketingConsent: true });
    expect(a.privacyConsentAt).toBe(now.toISOString());
    expect(a.marketingConsentAt).toBe(now.toISOString());
    expect(b.contactNumber).toBeUndefined();
    expect(await db.outbox.where("kind").equals("customer").count()).toBe(2);

    // Both ways of reading a card find the member.
    expect((await findMemberByCode(memberQrPayload(a.id), db))?.id).toBe(a.id);
    expect((await findMemberByCode(a.memberNo.toLowerCase(), db))?.id).toBe(a.id);

    await expect(
      registerMember({ ...maria, privacyConsent: false as unknown as true }, "Ana", db),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(registerMember({ ...maria, contactNumber: "" }, "Ana", db)).rejects.toBeInstanceOf(ZodError);
    await expect(registerMember({ ...maria, age: 15 }, "Ana", db)).rejects.toBeInstanceOf(ZodError);
  });

  it("withdrawing promo consent is recorded and keeps the member number", async () => {
    const db = await device();
    const a = await registerMember(maria, "Ana", db, new Date("2026-10-22T02:00:00Z"));
    const later = new Date("2026-11-01T02:00:00Z");
    const edited = await updateMember(
      a.id,
      { name: "Maria S.", gender: "female", contactNumber: "", marketingConsent: false, notes: "", active: true },
      "Ana",
      db,
      later,
    );
    expect(edited).toMatchObject({ memberNo: a.memberNo, birthYear: 1988, marketingConsent: false });
    expect(edited.contactNumber).toBeUndefined();
    expect(edited.marketingConsentAt).toBe(later.toISOString());
    expect(await db.auditLog.where("action").equals("member.update").count()).toBe(1);
  });

  it("a member sale with a program is saved, logged and shows in purchase history", async () => {
    const db = await device();
    await loadSampleCatalog("Owner", db);
    const m = await registerMember(maria, "Ana", db);
    const prog = await saveProgram(memberProgram, "Josh", undefined, db);
    const belly = await product(db, "Liempo (Pork Belly)");
    const cart: Cart = { lines: [line(belly, 1000)], programId: prog.id };
    const r = applyProgram(cart, prog, { today: "2026-10-22", hasMember: true, categoryOf: () => undefined });
    if (!r.ok) throw new Error(r.reason);
    const totals = priceCart(r.cart);
    const sale = await completeSale(
      {
        totals,
        payment: { method: "cash", tendered: totals.total },
        cashierName: "Ana",
        orderDiscountDetail: r.cart.orderDiscount,
        member: { id: m.id, memberNo: m.memberNo },
      },
      db,
    );
    expect(sale).toMatchObject({ customerId: m.id, memberNo: m.memberNo, orderDiscount: Math.round(belly.price / 10) });
    const audit = await db.auditLog.where("action").equals("sale.discount").first();
    expect(audit?.detail).toMatchObject({ programs: [prog.id] });

    const h = await memberHistory(m.id, db);
    expect(h.visits).toHaveLength(1);
    expect(h.totalSpent).toBe(sale.total);
    expect((await saleFacts("2000-01-01T00:00:00Z", db))[0]).toMatchObject({ customerId: m.id, total: sale.total });
  });
});

describe("home delivery address", () => {
  it("is kept only while the member wants deliveries, and syncs to other devices", async () => {
    const cloud = new FakeCloud();
    const owner = await device("owner");
    const at = new Date("2026-10-22T02:00:00Z");
    await expect(
      registerMember({ ...maria, wantsDelivery: true, deliveryAddress: " " }, "Ana", owner),
    ).rejects.toBeInstanceOf(ZodError);
    const m = await registerMember(
      {
        ...maria,
        wantsDelivery: true,
        deliveryAddress: "12 Mabini St, Brgy San Isidro, Quezon City",
        deliveryLandmark: "green gate",
      },
      "Ana",
      owner,
      at,
    );
    expect(m).toMatchObject({
      wantsDelivery: true,
      deliveryConsentAt: at.toISOString(),
      deliveryLandmark: "green gate",
    });

    await runSync(cloud.api(), owner);
    const counter = await device("cashier");
    await runSync(cloud.api(), counter);
    expect((await counter.members.get(m.id))?.deliveryAddress).toBe("12 Mabini St, Brgy San Isidro, Quezon City");

    // Unticking delivery removes the address everywhere.
    const off = await updateMember(
      m.id,
      {
        name: m.name,
        gender: m.gender,
        contactNumber: "0917 123 4567",
        marketingConsent: true,
        wantsDelivery: false,
        deliveryAddress: "12 Mabini St",
        notes: "",
        active: true,
      },
      "Ana",
      counter,
    );
    expect(off.wantsDelivery).toBe(false);
    expect(off.deliveryAddress).toBeUndefined();
    expect(off.deliveryLandmark).toBeUndefined();
    await runSync(cloud.api(), counter);
    await runSync(cloud.api(), owner);
    expect((await owner.members.get(m.id))?.deliveryAddress).toBeUndefined();
  });

  it("keeps the local address when the cloud has not been updated yet", async () => {
    const cloud = new FakeCloud();
    const db = await device();
    const m = await registerMember({ ...maria, wantsDelivery: true, deliveryAddress: "12 Mabini St" }, "Ana", db);
    await runSync(cloud.api(), db);
    // Simulate a cloud before migration 7: the feed has no delivery fields.
    const row = cloud.customers.get(m.id)!;
    for (const k of ["wants_delivery", "delivery_consent_at", "delivery_address", "delivery_landmark"]) delete row[k];
    row.updated_at = new Date(Date.now() + 1000).toISOString();
    await runSync(cloud.api(), db);
    expect((await db.members.get(m.id))?.deliveryAddress).toBe("12 Mabini St");
  });
});

describe("members and programs sync", () => {
  it("sends members and programs before the sale, and other devices download them", async () => {
    const cloud = new FakeCloud();
    const owner = await device("owner");
    await loadSampleCatalog("Owner", owner);
    const m = await registerMember(maria, "Ana", owner);
    const prog = await saveProgram(memberProgram, "Josh", undefined, owner);
    const belly = await product(owner, "Liempo (Pork Belly)");
    const r = applyProgram({ lines: [line(belly, 1000)] }, prog, {
      today: "2026-10-22",
      hasMember: true,
      categoryOf: () => undefined,
    });
    if (!r.ok) throw new Error(r.reason);
    const totals = priceCart(r.cart);
    const sale = await completeSale(
      {
        totals,
        payment: { method: "cash", tendered: totals.total },
        cashierName: "Ana",
        orderDiscountDetail: r.cart.orderDiscount,
        member: { id: m.id, memberNo: m.memberNo },
      },
      owner,
    );

    const report = await runSync(cloud.api(), owner);
    expect(report).toMatchObject({ members: 1, programs: 1, sales: 1, failed: 0 });
    const calls = cloud.calls.filter((c) => c.startsWith("sync_"));
    expect(calls.indexOf("sync_customer")).toBeLessThan(calls.indexOf("sync_sale"));
    expect(calls.indexOf("sync_promotion")).toBeLessThan(calls.indexOf("sync_sale"));
    const sent = cloud.saleRows[0];
    expect((sent.sale as Record<string, unknown>).customerId).toBe(m.id);
    expect(sent.discounts).toEqual([
      expect.objectContaining({
        source: "promotion",
        promotionId: prog.id,
        reason: "Member 10%",
        amount: sale.orderDiscount,
      }),
    ]);

    // A cashier's tablet gets the member (to scan the card) and the program (for the list).
    const counter = await device("cashier");
    await runSync(cloud.api(), counter);
    expect((await findMemberByCode(memberQrPayload(m.id), counter))?.name).toBe("Maria Santos");
    expect((await counter.programs.get(prog.id))?.input).toEqual({ kind: "percent", basisPoints: 1000 });
    // The counter knows the member has been once, though the sale was made on another device.
    expect(await memberVisitSummary(m.id, counter)).toEqual({ visits: 1, lastAt: sale.createdAt });

    // A sale on the counter counts straight away, before it is uploaded.
    const plain = priceCart({ lines: [line(belly, 500)] });
    const second = await completeSale(
      {
        totals: plain,
        payment: { method: "cash", tendered: plain.total },
        cashierName: "Ana",
        member: { id: m.id, memberNo: m.memberNo },
      },
      counter,
    );
    expect(await memberVisitSummary(m.id, counter)).toEqual({ visits: 2, lastAt: second.createdAt });
    await runSync(cloud.api(), counter);
    expect((await memberVisitSummary(m.id, counter)).visits).toBe(2);

    // A manager's tablet also sees the member's purchase from the other device.
    const office = await device("manager");
    await runSync(cloud.api(), office);
    const h = await memberHistory(m.id, office);
    expect(h.visits).toHaveLength(2);
    expect(h.visits).toEqual(
      expect.arrayContaining([expect.objectContaining({ saleId: sale.id, total: sale.total, remote: true })]),
    );

    // Edits made on the counter flow back; nothing is sent twice.
    const local = (await counter.members.get(m.id))!;
    await updateMember(
      m.id,
      { name: local.name, gender: local.gender, contactNumber: "", marketingConsent: false, notes: "", active: true },
      "Ana",
      counter,
    );
    await runSync(cloud.api(), counter);
    expect(cloud.customers.get(m.id)?.marketing_consent).toBe(false);
    cloud.calls = [];
    await runSync(cloud.api(), owner);
    expect((await owner.members.get(m.id))?.marketingConsent).toBe(false);
    expect(cloud.calls.filter((c) => c.startsWith("sync_"))).toEqual([]);
  });

  it("a cashier account cannot publish programs; the sale still syncs", async () => {
    const cloud = new FakeCloud();
    cloud.deny.add("sync_promotion");
    const db = await device("cashier");
    await loadSampleCatalog("Owner", db);
    await runSync(cloud.api(), db); // catalog first, as the owner would have done
    await saveProgram({ ...memberProgram, membersOnly: false }, "Ana", undefined, db);
    const report = await runSync(cloud.api(), db);
    expect(report.failed).toBe(1);
    const failed = await db.outbox.where("status").equals("failed").toArray();
    expect(failed.map((f) => f.kind)).toEqual(["promotion"]);
  });

  it("keeps sale payloads of non-member sales unchanged, so old retries still match", async () => {
    const db = await device();
    await loadSampleCatalog("Owner", db);
    const belly = await product(db, "Liempo (Pork Belly)");
    const totals = priceCart({
      lines: [line(belly, 1000)],
      orderDiscount: { input: { kind: "percent", basisPoints: 500 }, source: "manual", reason: "Suki" },
    });
    const sale = await completeSale(
      {
        totals,
        payment: { method: "cash", tendered: totals.total },
        cashierName: "Ana",
        orderDiscountDetail: { input: { kind: "percent", basisPoints: 500 }, source: "manual", reason: "Suki" },
      },
      db,
    );
    const items = await db.saleItems.where("saleId").equals(sale.id).toArray();
    const payment = (await db.payments.where("saleId").equals(sale.id).first())!;
    const p = salePayload(sale, items, payment);
    expect("customerId" in p.sale).toBe(false);
    expect(Object.keys(p.discounts[0]).sort()).toEqual(["amount", "kind", "reason", "saleItemId", "value"]);
  });

  it("a members feed rejection is reported but does not stop sales syncing", async () => {
    const cloud = new FakeCloud();
    cloud.deny.add("members_feed");
    const db = await device("cashier");
    await loadSampleCatalog("Owner", db);
    await expect(runSync(cloud.api(), db)).resolves.toMatchObject({ failed: 0 });
    const meta = (await db.config.get("syncMeta"))!.value as { membersFeedError?: string; lastError?: string };
    expect(meta.membersFeedError).toMatch(/not allowed/);
    expect(meta.lastError).toBeUndefined();
  });
});
