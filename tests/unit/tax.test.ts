import { describe, expect, it } from "vitest";
import {
  computeTax,
  guessCategoryClass,
  normalizeTaxSettings,
  percentageTaxDue,
  productClass,
  taxPeriods,
  taxRange,
  vatInInclusive,
  DEFAULT_TAX_SETTINGS,
} from "@/domain/tax";
import { priceCart } from "@/domain/cart";
import { buildSale } from "@/domain/checkout";
import { renderReceipt, RECEIPT_WIDTH_58MM } from "@/domain/receipt";
import { salePayload } from "@/lib/cloud/sync";

describe("tax rules", () => {
  it("guesses fresh goods exempt and condiments or side dishes VATable", () => {
    for (const n of ["Pork", "Beef", "Chicken", "Salmon", "Fresh Goods", "Eggs"])
      expect(guessCategoryClass(n)).toBe("exempt");
    for (const n of ["Condiments", "Side Dishes", "Drinks", "Processed Meats", "Supplies"]) {
      expect(guessCategoryClass(n)).toBe("vatable");
    }
  });

  it("uses the product override, then the category setting, then the name guess", () => {
    const s = normalizeTaxSettings({ categories: { c1: "vatable" }, products: { p2: "exempt" } });
    const pork = { id: "c1", name: "Pork" };
    expect(productClass(s, { id: "p1", categoryId: "c1" }, pork)).toBe("vatable");
    expect(productClass(s, { id: "p2", categoryId: "c1" }, pork)).toBe("exempt");
    expect(productClass(s, { id: "p3", categoryId: "c9" }, { id: "c9", name: "Beef" })).toBe("exempt");
  });

  it("drops bad saved values", () => {
    const s = normalizeTaxSettings({ mode: "zero", vatRateBp: -5, categories: { a: "zero", b: "exempt" } });
    expect(s.mode).toBe("non_vat");
    expect(s.vatRateBp).toBe(1200);
    expect(s.categories).toEqual({ b: "exempt" });
    expect(normalizeTaxSettings(undefined)).toEqual(DEFAULT_TAX_SETTINGS);
  });

  it("works out VAT inside VAT-inclusive prices and the 3% percentage tax", () => {
    expect(vatInInclusive(11200, 1200)).toBe(1200);
    expect(vatInInclusive(15000, 1200)).toBe(1607); // 150 / 1.12 * 0.12 = 16.07
    expect(percentageTaxDue(1_000_000, 300)).toBe(30_000);
  });

  it("splits VATable and exempt lines and spreads the VAT exactly", () => {
    const t = computeTax(
      [
        { net: 32400, taxClass: "exempt" },
        { net: 5000, taxClass: "vatable" },
        { net: 5000, taxClass: "vatable" },
        { net: 3333, taxClass: "vatable" },
      ],
      "vat",
      1200,
    );
    expect(t.vatAmount).toBe(vatInInclusive(13333, 1200));
    expect(t.lines.reduce((s, l) => s + l.vat, 0)).toBe(t.vatAmount);
    expect(t.lines[0].vat).toBe(0);
    expect(t.vatExemptSales).toBe(32400);
    expect(t.vatableSales + t.vatAmount + t.vatExemptSales).toBe(t.total);
  });

  it("adds no VAT for a non-VAT shop", () => {
    const t = computeTax([{ net: 15000, taxClass: "vatable" }], "non_vat", 1200);
    expect(t.vatAmount).toBe(0);
    expect(t.lines[0]).toEqual({ taxClass: "vatable", vat: 0 });
  });

  it("uses whole calendar quarters", () => {
    expect(taxRange("lastQuarter", "2026-10-24")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(taxRange("lastQuarter", "2026-02-10")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(taxRange("quarter", "2026-10-24")).toEqual({ from: "2026-10-01", to: "2026-10-24" });
  });

  it("adds months into quarters with the percentage tax", () => {
    const m = (month: string, nonVat: number) => ({
      month,
      sales: 1,
      gross: nonVat,
      non_vat_sales: nonVat,
      vatable_sales: 0,
      vat_amount: 0,
      vat_exempt_sales: 0,
    });
    const { quarters } = taxPeriods(
      {
        from: "2026-07-01",
        to: "2026-10-31",
        months: [m("2026-07", 100000), m("2026-09", 50000), m("2026-10", 10000)],
        categories: [],
      },
      300,
    );
    expect(quarters.map((q) => [q.period, q.nonVatSales, q.percentageTax])).toEqual([
      ["2026-Q3", 150000, 4500],
      ["2026-Q4", 10000, 300],
    ]);
  });
});

describe("taxed sales", () => {
  function sale(mode: "vat" | "non_vat") {
    let n = 0;
    const totals = priceCart({
      lines: [
        {
          lineId: "1",
          productId: "pork",
          productName: "Liempo",
          saleUnit: "kg",
          unitPrice: 36000,
          unitCost: 29500,
          qty: 900,
        },
        {
          lineId: "2",
          productId: "atchara",
          productName: "Atchara",
          saleUnit: "piece",
          unitPrice: 15000,
          unitCost: 10000,
          qty: 1,
        },
      ],
    });
    return buildSale({
      totals,
      payment: { method: "cash", tendered: 50000 },
      tax: { mode, rateBp: 1200, classOf: (id) => (id === "pork" ? "exempt" : "vatable") },
      saleId: "0e5b8c3a-1111-4222-8333-444455556666",
      receiptNo: "A1B2-000008",
      storeId: "s",
      deviceId: "d",
      cashierName: "Ana",
      now: new Date("2026-10-24T02:00:00Z"),
      newId: () => `i${++n}`,
    });
  }
  const header = { storeName: "The Local Butcher", businessLines: [], footer: "", tin: "123-456-789-00000" };

  it("records the VAT split and prints it on a VAT receipt", () => {
    const { sale: s, items, payment } = sale("vat");
    expect(s).toMatchObject({ taxMode: "vat", vatAmount: 1607, vatableSales: 13393, vatExemptSales: 32400 });
    expect(items.map((i) => [i.taxClass, i.vat])).toEqual([
      ["exempt", 0],
      ["vatable", 1607],
    ]);
    const lines = renderReceipt({ header, sale: s, items, payment });
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(RECEIPT_WIDTH_58MM);
    const text = lines.join("\n");
    expect(text).toContain("VAT REG TIN 123-456-789-00000");
    expect(text).toMatch(/VATable Sales\s+₱133\.93/);
    expect(text).toMatch(/VAT \(12%\)\s+₱16\.07/);
    expect(text).toMatch(/VAT-Exempt Sales\s+₱324\.00/);
    expect(text).toMatch(/₱150\.00 V/);
    expect(text).toMatch(/₱324\.00 E/);
    const payload = salePayload(s, items, payment);
    expect(payload.sale).toMatchObject({ taxMode: "vat", vatAmount: 1607 });
    expect(payload.items[1]).toMatchObject({ taxClass: "vatable", vat: 1607 });
  });

  it("prints no VAT lines for a non-VAT shop", () => {
    const { sale: s, items, payment } = sale("non_vat");
    expect(s.vatAmount).toBeUndefined();
    const text = renderReceipt({ header, sale: s, items, payment }).join("\n");
    expect(text).toContain("NON-VAT REGISTERED");
    expect(text).toContain("TIN 123-456-789-00000");
    expect(text).not.toContain("VATable Sales");
  });
});
