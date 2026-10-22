import { describe, expect, it } from "vitest";
import { cashDifference, shiftTimeline, summariseShift, type Shift } from "@/domain/shift";
import { buildSale } from "@/domain/checkout";
import { priceCart } from "@/domain/cart";
import { officeShiftTimeline, shiftsCsv, type OfficeShift } from "@/domain/office";

const shift: Shift = {
  id: "s1",
  deviceId: "d1",
  openedAt: "2026-10-22T00:00:00.000Z",
  openedBy: "Ana",
  openingFloat: 100000,
};

describe("shift totals", () => {
  it("expects the starting cash plus cash sales in the drawer", () => {
    const sum = summariseShift(
      shift,
      [
        { paymentMethod: "cash", total: 32400 },
        { paymentMethod: "gcash", total: 27000 },
        { paymentMethod: "cash", total: 9000 },
      ],
      [{ kind: "no_sale" }],
    );
    expect(sum).toEqual({ saleCount: 3, cashSales: 41400, gcashSales: 27000, expectedCash: 141400, noSaleCount: 1 });
    expect(cashDifference(141000, 141400)).toBe(-400);
    expect(cashDifference(141400, 141400)).toBe(0);
  });

  it("puts open, sale start and payment, no-sale and close in time order", () => {
    const t = shiftTimeline(
      { ...shift, closedAt: "2026-10-22T10:00:00.000Z", closedBy: "Ana", countedCash: 132000, expectedCash: 132400 },
      [
        {
          receiptNo: "AB12-000001",
          cashierName: "Ana",
          startedAt: "2026-10-22T01:58:30.000Z",
          createdAt: "2026-10-22T02:00:00.000Z",
          total: 32400,
          paymentMethod: "cash",
        },
      ],
      [
        {
          id: "e1",
          shiftId: "s1",
          deviceId: "d1",
          kind: "no_sale",
          at: "2026-10-22T01:00:00.000Z",
          by: "Ana",
          approvedBy: "Josh",
          reason: "Change for a customer",
        },
      ],
    );
    expect(t.map((e) => e.type)).toEqual(["shift_open", "no_sale", "sale_started", "sale_paid", "shift_close"]);
  });
});

describe("sale start time", () => {
  it("is kept on the sale when it is before the payment", () => {
    const totals = priceCart({
      lines: [
        { lineId: "l", productId: "p", productName: "Liempo", saleUnit: "kg", unitPrice: 36000, unitCost: 0, qty: 500 },
      ],
    });
    const args = {
      totals,
      payment: { method: "cash" as const, tendered: 20000 },
      saleId: "s",
      receiptNo: "AB12-000001",
      storeId: "st",
      deviceId: "d",
      cashierName: "Ana",
      now: new Date("2026-10-22T02:00:00.000Z"),
      newId: () => crypto.randomUUID(),
    };
    const { sale } = buildSale({ ...args, startedAt: "2026-10-22T01:58:30.000Z", shiftId: "s1" });
    expect(sale).toMatchObject({ startedAt: "2026-10-22T01:58:30.000Z", shiftId: "s1" });
    // A clock that moved backwards cannot give a start after the payment.
    expect(buildSale({ ...args, startedAt: "2026-10-22T03:00:00.000Z" }).sale.startedAt).toBeUndefined();
  });
});

describe("Back Office shifts CSV", () => {
  it("has one row per time stamp, with the over/short at the close", () => {
    const sh: OfficeShift = {
      id: "s1",
      device_code: "AB12",
      device_label: "Counter",
      opened_at: "2026-10-22T00:00:00Z",
      opened_by: "Ana",
      opening_float: 100000,
      closed_at: "2026-10-22T10:00:00Z",
      closed_by: "Ana",
      counted_cash: 132000,
      expected_cash: 132400,
      note: "=short",
      cash_sales: 32400,
      gcash_sales: 0,
      sale_count: 1,
      sales: [
        {
          receipt_no: "AB12-000001",
          cashier: "Ana",
          started_at: "2026-10-22T01:58:30Z",
          paid_at: "2026-10-22T02:00:00Z",
          total: 32400,
          method: "cash",
        },
      ],
      events: [],
    };
    expect(officeShiftTimeline(sh)).toHaveLength(4);
    const lines = shiftsCsv([sh]).split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('"Event"');
    expect(lines[3]).toContain('"Sale paid"');
    expect(lines[2]).toMatch(/^"Oct 22, 2026, 09:58:30\sAM"/); // Manila time to the second
    expect(lines[3]).toContain('"324.00"');
    expect(lines[4]).toContain('"Shift closed"');
    expect(lines[4]).toContain('"-4"');
    expect(lines[4]).toContain(`"'=short"`); // spreadsheet formulas are neutralised
  });
});
