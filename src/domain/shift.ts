import type { Centavos } from "./money";

/** A cashier shift on one device: opened with a starting cash float, closed with a cash count. */
export interface Shift {
  id: string;
  deviceId: string;
  openedAt: string; // UTC ISO-8601
  openedBy: string;
  openedByEmployeeId?: string;
  /** Cash in the drawer at the start (centavos). */
  openingFloat: Centavos;
  closedAt?: string;
  closedBy?: string;
  /** Cash counted at the close. */
  countedCash?: Centavos;
  /** Starting cash + cash sales, worked out at the close. */
  expectedCash?: Centavos;
  cashSales?: Centavos;
  gcashSales?: Centavos;
  saleCount?: number;
  note?: string;
}

export type DrawerEventKind = "no_sale";

/** The drawer opened without a sale ("no sale"), with the reason and who approved it. */
export interface DrawerEvent {
  id: string;
  shiftId: string;
  deviceId: string;
  kind: DrawerEventKind;
  at: string;
  by: string;
  approvedBy?: string;
  reason: string;
}

export const NO_SALE_REASONS = ["Change for a customer", "Checking or counting cash", "Correcting a mistake"] as const;

export interface ShiftSummary {
  saleCount: number;
  cashSales: Centavos;
  gcashSales: Centavos;
  expectedCash: Centavos;
  noSaleCount: number;
}

/** Totals of a shift's sales. A cash sale adds its total to the drawer (cash taken minus change). */
export function summariseShift(
  shift: Pick<Shift, "openingFloat">,
  sales: { paymentMethod: "cash" | "gcash"; total: Centavos }[],
  events: Pick<DrawerEvent, "kind">[] = [],
): ShiftSummary {
  const cashSales = sales.filter((s) => s.paymentMethod === "cash").reduce((t, s) => t + s.total, 0);
  const gcashSales = sales.filter((s) => s.paymentMethod === "gcash").reduce((t, s) => t + s.total, 0);
  return {
    saleCount: sales.length,
    cashSales,
    gcashSales,
    expectedCash: shift.openingFloat + cashSales,
    noSaleCount: events.filter((e) => e.kind === "no_sale").length,
  };
}

/** Counted minus expected: positive = over, negative = short. */
export function cashDifference(counted: Centavos, expected: Centavos): Centavos {
  return counted - expected;
}

export type TimelineEntry =
  | { at: string; type: "shift_open"; by: string; amount: Centavos }
  | { at: string; type: "sale_started"; receiptNo: string; by: string }
  | { at: string; type: "sale_paid"; receiptNo: string; by: string; amount: Centavos; method: "cash" | "gcash" }
  | { at: string; type: "no_sale"; by: string; approvedBy?: string; reason: string }
  | { at: string; type: "shift_close"; by: string; amount: Centavos; expected: Centavos };

/** Everything that happened in a shift, oldest first. */
export function shiftTimeline(
  shift: Shift,
  sales: {
    receiptNo: string;
    cashierName: string;
    startedAt?: string;
    createdAt: string;
    total: Centavos;
    paymentMethod: "cash" | "gcash";
  }[],
  events: DrawerEvent[],
): TimelineEntry[] {
  const out: TimelineEntry[] = [
    { at: shift.openedAt, type: "shift_open", by: shift.openedBy, amount: shift.openingFloat },
  ];
  for (const s of sales) {
    if (s.startedAt) out.push({ at: s.startedAt, type: "sale_started", receiptNo: s.receiptNo, by: s.cashierName });
    out.push({
      at: s.createdAt,
      type: "sale_paid",
      receiptNo: s.receiptNo,
      by: s.cashierName,
      amount: s.total,
      method: s.paymentMethod,
    });
  }
  for (const e of events) out.push({ at: e.at, type: "no_sale", by: e.by, approvedBy: e.approvedBy, reason: e.reason });
  if (shift.closedAt) {
    out.push({
      at: shift.closedAt,
      type: "shift_close",
      by: shift.closedBy ?? "",
      amount: shift.countedCash ?? 0,
      expected: shift.expectedCash ?? 0,
    });
  }
  // Stable: the open stays first and the close last when times are equal.
  const rank = (t: TimelineEntry["type"]) => (t === "shift_open" ? 0 : t === "shift_close" ? 2 : 1);
  return out.sort((a, b) => a.at.localeCompare(b.at) || rank(a.type) - rank(b.type));
}
