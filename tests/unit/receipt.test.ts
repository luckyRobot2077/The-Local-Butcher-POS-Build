import { describe, expect, it } from "vitest";
import { renderReceipt, wrap, leftRight, RECEIPT_WIDTH_58MM } from "@/domain/receipt";
import { priceCart } from "@/domain/cart";
import { buildSale } from "@/domain/checkout";

describe("receipt", () => {
  it("wraps long words and text", () => {
    expect(wrap("aaaa bbbb cccc", 9)).toEqual(["aaaa bbbb", "cccc"]);
    expect(wrap("abcdefghijk", 4)).toEqual(["abcd", "efgh", "ijk"]);
  });

  it("aligns left and right text", () => {
    const [line] = leftRight("Total", "₱10.00", 20);
    expect(line).toHaveLength(20);
    expect(line.endsWith("₱10.00")).toBe(true);
  });

  it("renders a 58mm receipt within width with discounts", () => {
    let n = 0;
    const totals = priceCart({
      lines: [
        {
          lineId: "1",
          productId: "p",
          productName: "Pork Belly (Liempo) premium skin-on cut for lechon kawali",
          saleUnit: "kg",
          unitPrice: 36000,
          unitCost: 29500,
          qty: 1250,
          discount: { input: { kind: "percent", basisPoints: 500 }, source: "manual" },
        },
      ],
      orderDiscount: undefined,
    });
    const { sale, items, payment } = buildSale({
      totals,
      payment: { method: "cash", tendered: 50000 },
      saleId: "0e5b8c3a-1111-4222-8333-444455556666",
      receiptNo: "A1B2-000007",
      storeId: "s",
      deviceId: "d",
      cashierName: "Ana",
      now: new Date("2026-10-21T02:00:00Z"),
      newId: () => `i${++n}`,
    });
    const lines = renderReceipt({
      header: {
        storeName: "The Local Butcher",
        tagline: "Where Quality Meets Affordability",
        businessLines: [],
        footer: "Salamat po!",
      },
      sale,
      items,
      payment,
    });
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(RECEIPT_WIDTH_58MM);
    const text = lines.join("\n");
    expect(text).toContain("NON-FISCAL TEST RECEIPT");
    expect(text).toContain("1.250 kg @ ₱360.00/kg");
    expect(text).toContain("-₱22.50"); // 5% of ₱450
    expect(text).toContain("₱427.50");
    expect(text).toContain("₱72.50"); // change from ₱500
    expect(text).toContain("A1B2-000007");
  });
});
