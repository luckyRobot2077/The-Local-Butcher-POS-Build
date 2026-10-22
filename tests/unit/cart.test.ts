import { describe, expect, it } from "vitest";
import { addLine, emptyCart, priceCart, removeLine, setOrderDiscount, updateLine, type CartLine } from "@/domain/cart";
import { allocateProportionally, discountAmount, DiscountError } from "@/domain/discount";
import { buildSale, computeChange, CheckoutError } from "@/domain/checkout";

const belly = (qty: number, id = "l1"): CartLine => ({
  lineId: id,
  productId: "p-belly",
  productName: "Liempo / Pork Belly",
  saleUnit: "kg",
  unitPrice: 35000,
  unitCost: 29500,
  qty,
});
const chicken = (qty: number, id = "l2"): CartLine => ({
  lineId: id,
  productId: "p-chicken",
  productName: "Whole Chicken",
  saleUnit: "piece",
  unitPrice: 19500,
  unitCost: 16000,
  qty,
});

describe("discounts", () => {
  it("applies percentage discounts", () => {
    expect(discountAmount({ kind: "percent", basisPoints: 1000 }, 50000)).toBe(5000); // 10% of ₱500
    expect(discountAmount({ kind: "percent", basisPoints: 10000 }, 50000)).toBe(50000);
    expect(discountAmount({ kind: "percent", basisPoints: 0 }, 50000)).toBe(0);
  });
  it("applies fixed discounts", () => {
    expect(discountAmount({ kind: "fixed", amount: 5000 }, 50000)).toBe(5000); // ₱50 off ₱500
  });
  it("rejects discounts over 100% or over the amount", () => {
    expect(() => discountAmount({ kind: "percent", basisPoints: 10001 }, 50000)).toThrow(DiscountError);
    expect(() => discountAmount({ kind: "percent", basisPoints: -1 }, 50000)).toThrow(DiscountError);
    expect(() => discountAmount({ kind: "fixed", amount: 50001 }, 50000)).toThrow(DiscountError);
  });
  it("allocates exactly with largest remainder", () => {
    const parts = allocateProportionally(100, [1000, 1000, 1000]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    expect(allocateProportionally(0, [10, 20])).toEqual([0, 0]);
  });
});

describe("cart", () => {
  it("adds, merges piece items, updates and removes", () => {
    let c = addLine(emptyCart(), chicken(1, "a"));
    c = addLine(c, chicken(2, "b"));
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0].qty).toBe(3);
    c = addLine(c, belly(500, "c"));
    c = addLine(c, belly(250, "d"));
    expect(c.lines).toHaveLength(3); // weighed packs stay separate
    c = updateLine(c, "c", { qty: 1000 });
    expect(c.lines.find((l) => l.lineId === "c")?.qty).toBe(1000);
    c = removeLine(c, "d");
    expect(c.lines).toHaveLength(2);
  });

  it("totals weight and piece items", () => {
    const t = priceCart({ lines: [belly(1250), chicken(2)] });
    expect(t.subtotal).toBe(43750 + 39000);
    expect(t.total).toBe(82750);
    expect(t.discountTotal).toBe(0);
  });

  it("applies item and order discounts without stacking by default", () => {
    const lines = [
      {
        ...belly(1000),
        discount: { input: { kind: "percent" as const, basisPoints: 1000 }, source: "manual" as const },
      },
      chicken(2),
    ];
    const t = priceCart(setOrderDiscount({ lines }, { input: { kind: "fixed", amount: 5000 }, source: "manual" }));
    expect(t.lines[0].itemDiscount).toBe(3500);
    expect(t.lines[0].orderDiscountShare).toBe(0); // already discounted, not stacked
    expect(t.lines[1].orderDiscountShare).toBe(5000);
    expect(t.total).toBe(35000 + 39000 - 3500 - 5000);
    expect(t.lines.reduce((a, l) => a + l.net, 0)).toBe(t.total);
  });

  it("stacks when the policy allows it", () => {
    const lines = [
      {
        ...belly(1000),
        discount: { input: { kind: "percent" as const, basisPoints: 1000 }, source: "manual" as const },
      },
      chicken(2),
    ];
    const t = priceCart(
      setOrderDiscount({ lines }, { input: { kind: "percent", basisPoints: 1000 }, source: "manual" }),
      {
        allowItemAndOrderStacking: true,
      },
    );
    expect(t.orderDiscountEligible).toBe(31500 + 39000);
    expect(t.orderDiscount).toBe(7050);
    expect(t.lines.reduce((a, l) => a + l.net, 0)).toBe(t.total);
  });

  it("never produces a negative total", () => {
    const t = priceCart(
      setOrderDiscount({ lines: [chicken(1)] }, { input: { kind: "percent", basisPoints: 10000 }, source: "manual" }),
    );
    expect(t.total).toBe(0);
    expect(() =>
      priceCart(
        setOrderDiscount({ lines: [chicken(1)] }, { input: { kind: "fixed", amount: 19501 }, source: "manual" }),
      ),
    ).toThrow(DiscountError);
  });

  it("reports the largest discount rate for approval checks", () => {
    const t = priceCart(
      setOrderDiscount({ lines: [chicken(1)] }, { input: { kind: "fixed", amount: 3900 }, source: "manual" }),
    );
    expect(t.maxDiscountBasisPoints).toBe(2000); // ₱39 of ₱195 = 20%
  });
});

describe("checkout", () => {
  it("calculates cash change", () => {
    expect(computeChange(82750, 100000)).toBe(17250);
    expect(computeChange(82750, 82750)).toBe(0);
    expect(() => computeChange(82750, 82749)).toThrow(CheckoutError);
  });

  it("builds a sale with price snapshots", () => {
    let n = 0;
    const totals = priceCart({ lines: [belly(1250), chicken(2)] });
    const { sale, items, payment } = buildSale({
      totals,
      payment: { method: "cash", tendered: 100000 },
      saleId: "sale-1",
      receiptNo: "A1B2-000001",
      storeId: "store",
      deviceId: "dev",
      cashierName: "Ana",
      now: new Date("2026-10-21T16:30:00Z"),
      newId: () => `id-${++n}`,
    });
    expect(sale.total).toBe(82750);
    expect(sale.change).toBe(17250);
    expect(sale.businessDate).toBe("2026-10-22"); // 00:30 in Manila
    expect(sale.costTotal).toBe(36875 + 32000);
    expect(items[0].unitPrice).toBe(35000);
    expect(items[0].productName).toBe("Liempo / Pork Belly");
    expect(payment.amount).toBe(82750);
  });

  it("refuses an empty cart and missing cashier", () => {
    const base = {
      payment: { method: "cash" as const, tendered: 0 },
      saleId: "s",
      receiptNo: "r",
      storeId: "x",
      deviceId: "d",
      now: new Date(),
      newId: () => "i",
    };
    expect(() => buildSale({ ...base, totals: priceCart(emptyCart()), cashierName: "Ana" })).toThrow(CheckoutError);
    expect(() =>
      buildSale({
        ...base,
        totals: priceCart({ lines: [chicken(1)] }),
        payment: { method: "cash", tendered: 19500 },
        cashierName: " ",
      }),
    ).toThrow(CheckoutError);
  });
});

describe("sold by peso amount", () => {
  it("charges exactly the amount typed and works out the weight to cut", async () => {
    const { gramsForAmount } = await import("@/domain/pricing");
    const { renderReceipt } = await import("@/domain/receipt");
    // ₱100 of ₱350/kg liempo: 285.7 g, so cut about 286 g, charge ₱100.00 (not ₱99.75 or ₱100.10).
    expect(gramsForAmount(35000, 10000)).toBe(286);
    expect(gramsForAmount(35000, 0)).toBeNull();
    const cart = addLine(emptyCart(), { ...belly(286), fixedAmount: 10000 });
    const t = priceCart(cart);
    expect(t.lines[0].gross).toBe(10000);
    expect(t.total).toBe(10000);
    // With a 10% item discount it is 10% of ₱100.
    const disc = updateLine(cart, "l1", {
      discount: { input: { kind: "percent", basisPoints: 1000 }, source: "manual" },
    });
    expect(priceCart(disc).total).toBe(9000);
    // Changing it to a typed weight goes back to price × weight.
    expect(priceCart(updateLine(cart, "l1", { qty: 500, fixedAmount: undefined })).total).toBe(17500);

    let n = 0;
    const sale = buildSale({
      totals: t,
      payment: { method: "cash", tendered: 10000 },
      saleId: "sale-1",
      receiptNo: "A1B2-000001",
      storeId: "store",
      deviceId: "dev",
      cashierName: "Ana",
      now: new Date("2026-10-22T02:00:00Z"),
      newId: () => `id-${++n}`,
    });
    expect(sale.items[0].gross).toBe(10000);
    const lines = renderReceipt({
      header: { storeName: "The Local Butcher", businessLines: [], footer: "" },
      sale: sale.sale,
      items: sale.items,
      payment: sale.payment,
    });
    expect(lines.join("\n")).toMatch(/~0\.286 kg @ ₱350\.00\/kg +₱100\.00/);
  });
});
