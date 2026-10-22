import { describe, expect, it } from "vitest";
import {
  addDays,
  bucketLabel,
  bucketTrend,
  grainFor,
  marginPct,
  presetRange,
  saleLinesCsv,
  toCsv,
  type DailyPoint,
} from "@/domain/office";

const day = (date: string, revenue: number, cogs = 0, expenses = 0): DailyPoint => ({
  date,
  revenue,
  cogs,
  transactions: revenue > 0 ? 1 : 0,
  discounts: 0,
  expenses,
});

describe("office date ranges", () => {
  it("builds presets from the Manila business date", () => {
    expect(presetRange("today", "2026-10-22")).toEqual({ from: "2026-10-22", to: "2026-10-22" });
    expect(presetRange("7d", "2026-10-22")).toEqual({ from: "2026-10-16", to: "2026-10-22" });
    expect(presetRange("30d", "2026-10-22").from).toBe("2026-09-23");
    expect(presetRange("month", "2026-10-22")).toEqual({ from: "2026-10-01", to: "2026-10-22" });
    expect(presetRange("lastMonth", "2026-03-05")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("lastMonth", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("year", "2026-10-22").from).toBe("2025-10-23");
    expect(presetRange("all", "2026-10-22")).toEqual({ from: null, to: "2026-10-22" });
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("trend grouping", () => {
  it("picks daily, weekly or monthly points by range length", () => {
    expect(grainFor(1)).toBe("day");
    expect(grainFor(62)).toBe("day");
    expect(grainFor(365)).toBe("week");
    expect(grainFor(900)).toBe("month");
  });

  it("adds days into Monday weeks and calendar months", () => {
    const daily = [
      day("2026-10-18", 100, 60),
      day("2026-10-19", 200, 100, 50),
      day("2026-10-25", 300),
      day("2026-11-01", 400),
    ];
    expect(bucketTrend(daily, "week").map((b) => [b.key, b.revenue, b.grossProfit, b.expenses])).toEqual([
      ["2026-10-12", 100, 40, 0],
      ["2026-10-19", 500, 400, 50],
      ["2026-10-26", 400, 400, 0],
    ]);
    expect(bucketTrend(daily, "month").map((b) => [b.key, b.revenue])).toEqual([
      ["2026-10-01", 600],
      ["2026-11-01", 400],
    ]);
    expect(bucketLabel("2026-10-19", "week")).toBe("Wk Oct 19");
    expect(bucketLabel("2026-10-01", "month")).toBe("Oct 2026");
    expect(bucketLabel("2026-10-05", "day")).toBe("Oct 5");
  });

  it("computes margins without dividing by zero", () => {
    expect(marginPct(36000, 29500)).toBe(18.1);
    expect(marginPct(0, 0)).toBeNull();
  });
});

describe("CSV files", () => {
  it("quotes values and defuses spreadsheet formulas", () => {
    expect(
      toCsv(
        ["A", "B"],
        [
          ['say "hi"', "=SUM(A1)"],
          [1, null],
        ],
      ),
    ).toBe('"A","B"\r\n"say ""hi""","\'=SUM(A1)"\r\n"1",""');
  });

  it("writes sale lines in pesos and kilograms with profit", () => {
    const csv = saleLinesCsv([
      {
        business_date: "2026-10-22",
        created_at: "2026-10-22T02:00:00+00:00",
        receipt_no: "AB12-000001",
        cashier: "Ana",
        payment_method: "cash",
        member_no: null,
        product: "Liempo",
        category: "Pork",
        unit: "kg",
        qty: 1250,
        unit_price: 36000,
        gross: 45000,
        discount: 0,
        net: 45000,
        cost: 36875,
        item_discount: 0,
        order_discount_share: 0,
        discount_names: null,
        discount_approved_by: null,
      },
      {
        business_date: "2026-10-22",
        created_at: "2026-10-22T02:05:00+00:00",
        receipt_no: "AB12-000002",
        cashier: "Ana",
        payment_method: "cash",
        member_no: "M-AB12-0001",
        product: "Vinegar",
        category: "Condiments",
        unit: "piece",
        qty: 2,
        unit_price: 5000,
        gross: 10000,
        discount: 1900,
        net: 8100,
        cost: 6000,
        item_discount: 1000,
        order_discount_share: 900,
        discount_names: "Dented bottle ₱10.00; Suki 10% (whole sale)",
        discount_approved_by: "Josh",
      },
    ]);
    const row = csv.split("\r\n")[1];
    expect(row).toContain('"1.250","360.00","450.00","0.00","","0.00","0.00","","450.00","368.75","81.25"');
    expect(csv.split("\r\n")[2]).toContain(
      '"19.00","Dented bottle ₱10.00; Suki 10% (whole sale)","10.00","9.00","Josh","81.00"',
    );
    expect(row).toContain("10:00");
  });
});
