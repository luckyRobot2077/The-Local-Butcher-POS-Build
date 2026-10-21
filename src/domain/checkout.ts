import { type Centavos, assertCentavos, divRoundHalfUp } from "./money";
import { type CartTotals, type AppliedDiscountInput } from "./cart";
import { type SaleUnit } from "./quantity";
import { businessDate } from "./time";

export type PaymentMethod = "cash" | "gcash";

export type PaymentInput = { method: "cash"; tendered: Centavos } | { method: "gcash"; reference?: string };

export class CheckoutError extends Error {}

export interface PaymentRecord {
  id: string;
  saleId: string;
  method: PaymentMethod;
  /** Amount applied to the sale (never more than the total). */
  amount: Centavos;
  /** Cash handed over by the customer. Equals amount for GCash. */
  tendered: Centavos;
  change: Centavos;
  /** GCash reference typed by the cashier. Not verified automatically. */
  reference?: string;
}

export interface SaleItemRecord {
  id: string;
  saleId: string;
  lineNo: number;
  productId: string;
  /** Snapshots: changing the product later never changes this sale. */
  productName: string;
  saleUnit: SaleUnit;
  unitPrice: Centavos;
  unitCost: Centavos;
  qty: number;
  gross: Centavos;
  itemDiscount: Centavos;
  orderDiscountShare: Centavos;
  net: Centavos;
  discount?: AppliedDiscountInput;
}

export type SyncStatus = "pending" | "synced" | "failed";

export interface SaleRecord {
  /** Immutable globally unique id (UUID), also the sync idempotency key. */
  id: string;
  receiptNo: string;
  storeId: string;
  deviceId: string;
  cashierName: string;
  createdAt: string; // UTC ISO-8601
  businessDate: string; // YYYY-MM-DD in Asia/Manila
  status: "completed";
  subtotal: Centavos;
  itemDiscountTotal: Centavos;
  orderDiscount: Centavos;
  discountTotal: Centavos;
  total: Centavos;
  costTotal: Centavos;
  paymentMethod: PaymentMethod;
  tendered: Centavos;
  change: Centavos;
  orderDiscountDetail?: AppliedDiscountInput;
  discountApprovedBy?: string;
  customerId?: string;
  itemCount: number;
  syncStatus: SyncStatus;
  receiptPrintCount: number;
}

export function computeChange(total: Centavos, tendered: Centavos): Centavos {
  assertCentavos(total, "total");
  assertCentavos(tendered, "amount tendered");
  if (tendered < total) throw new CheckoutError("Amount tendered is less than the total.");
  return tendered - total;
}

export interface BuildSaleArgs {
  totals: CartTotals;
  payment: PaymentInput;
  orderDiscountDetail?: AppliedDiscountInput;
  discountApprovedBy?: string;
  saleId: string;
  receiptNo: string;
  storeId: string;
  deviceId: string;
  cashierName: string;
  now: Date;
  newId: () => string;
}

/** Cost of a line from its cost snapshot, using the same rounding rule as price. */
export function lineCost(unit: SaleUnit, unitCost: Centavos, qty: number): Centavos {
  return unit === "kg" ? divRoundHalfUp(unitCost * qty, 1000) : unitCost * qty;
}

export function buildSale(a: BuildSaleArgs): { sale: SaleRecord; items: SaleItemRecord[]; payment: PaymentRecord } {
  const { totals } = a;
  if (totals.lines.length === 0) throw new CheckoutError("The cart is empty.");
  if (!a.cashierName.trim()) throw new CheckoutError("No cashier is signed in on this device.");

  let tendered: Centavos;
  let change: Centavos;
  let reference: string | undefined;
  if (a.payment.method === "cash") {
    change = computeChange(totals.total, a.payment.tendered);
    tendered = a.payment.tendered;
  } else {
    tendered = totals.total;
    change = 0;
    reference = a.payment.reference?.trim() || undefined;
  }

  const items: SaleItemRecord[] = totals.lines.map((l, i) => ({
    id: a.newId(),
    saleId: a.saleId,
    lineNo: i + 1,
    productId: l.productId,
    productName: l.productName,
    saleUnit: l.saleUnit,
    unitPrice: l.unitPrice,
    unitCost: l.unitCost,
    qty: l.qty,
    gross: l.gross,
    itemDiscount: l.itemDiscount,
    orderDiscountShare: l.orderDiscountShare,
    net: l.net,
    discount: l.discount,
  }));

  const sale: SaleRecord = {
    id: a.saleId,
    receiptNo: a.receiptNo,
    storeId: a.storeId,
    deviceId: a.deviceId,
    cashierName: a.cashierName.trim(),
    createdAt: a.now.toISOString(),
    businessDate: businessDate(a.now),
    status: "completed",
    subtotal: totals.subtotal,
    itemDiscountTotal: totals.itemDiscountTotal,
    orderDiscount: totals.orderDiscount,
    discountTotal: totals.discountTotal,
    total: totals.total,
    costTotal: items.reduce((s, it) => s + lineCost(it.saleUnit, it.unitCost, it.qty), 0),
    paymentMethod: a.payment.method,
    tendered,
    change,
    orderDiscountDetail: a.orderDiscountDetail,
    discountApprovedBy: a.discountApprovedBy,
    itemCount: items.length,
    syncStatus: "pending",
    receiptPrintCount: 0,
  };

  const payment: PaymentRecord = {
    id: a.newId(),
    saleId: a.saleId,
    method: a.payment.method,
    amount: totals.total,
    tendered,
    change,
    reference,
  };

  return { sale, items, payment };
}

/** Receipt number: <device code>-<sequence>, e.g. "A1B2-000042". */
export function formatReceiptNo(deviceCode: string, seq: number): string {
  return `${deviceCode}-${String(seq).padStart(6, "0")}`;
}
