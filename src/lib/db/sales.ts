import { buildSale, formatReceiptNo, type PaymentInput, type SaleRecord } from "@/domain/checkout";
import type { AppliedDiscountInput, CartTotals } from "@/domain/cart";
import { getDb } from "./db";
import { ensureDevice } from "./config";
import { newId, nowIso } from "./ids";
import { OPEN_SHIFT_KEY } from "./shifts";

export interface CompleteSaleArgs {
  totals: CartTotals;
  payment: PaymentInput;
  cashierName: string;
  orderDiscountDetail?: AppliedDiscountInput;
  discountApprovedBy?: string;
  /** Member card scanned for this sale. */
  member?: { id: string; memberNo: string };
  /** When the first item went into the cart. */
  startedAt?: string;
  now?: Date;
}

/**
 * Saves a completed sale atomically: header, items, payment, one stock
 * movement per line, the stock projection and the sync outbox entry are
 * written in a single IndexedDB transaction. If any write fails nothing is
 * saved and the error propagates, so the UI never reports an unsaved sale
 * as complete.
 */
export async function completeSale(args: CompleteSaleArgs, db = getDb()): Promise<SaleRecord> {
  const device = await ensureDevice(db);
  const saleId = newId();
  return db.transaction(
    "rw",
    [db.sales, db.saleItems, db.payments, db.inventoryMovements, db.products, db.outbox, db.config, db.auditLog],
    async () => {
      const seq = (((await db.config.get("receiptSeq"))?.value as number | undefined) ?? 0) + 1;
      await db.config.put({ key: "receiptSeq", value: seq });
      const now = args.now ?? new Date();
      const shiftId = (await db.config.get(OPEN_SHIFT_KEY))?.value as string | undefined;
      const { sale, items, payment } = buildSale({
        totals: args.totals,
        payment: args.payment,
        orderDiscountDetail: args.orderDiscountDetail,
        discountApprovedBy: args.discountApprovedBy,
        member: args.member,
        startedAt: args.startedAt,
        shiftId,
        saleId,
        receiptNo: formatReceiptNo(device.deviceCode, seq),
        storeId: device.storeId,
        deviceId: device.deviceId,
        cashierName: args.cashierName,
        now,
        newId,
      });
      await db.sales.add(sale);
      await db.saleItems.bulkAdd(items);
      await db.payments.add(payment);
      for (const it of items) {
        const product = await db.products.get(it.productId);
        await db.inventoryMovements.add({
          id: newId(),
          productId: it.productId,
          type: "sale",
          qtyDelta: -it.qty,
          unitCost: it.unitCost,
          refType: "sale",
          refId: sale.id,
          by: sale.cashierName,
          at: sale.createdAt,
        });
        if (product) await db.products.update(product.id, { stockQty: product.stockQty - it.qty });
      }
      // The sale's outbox entry carries its items, payment and stock movements.
      await db.outbox.add({
        id: newId(),
        kind: "sale",
        entityId: sale.id,
        createdAt: nowIso(),
        status: "pending",
        attempts: 0,
      });
      if (sale.discountTotal > 0) {
        await db.auditLog.add({
          id: newId(),
          action: "sale.discount",
          entity: "sale",
          entityId: sale.id,
          by: sale.cashierName,
          at: sale.createdAt,
          detail: {
            discountTotal: sale.discountTotal,
            approvedBy: args.discountApprovedBy,
            programs: [
              ...new Set(
                [args.orderDiscountDetail, ...items.map((i) => i.discount)]
                  .filter((d) => d?.source === "promotion")
                  .map((d) => d!.promotionId),
              ),
            ],
          },
        });
      }
      return sale;
    },
  );
}

export async function getSaleDetail(saleId: string, db = getDb()) {
  const sale = await db.sales.get(saleId);
  if (!sale) return null;
  const items = (await db.saleItems.where("saleId").equals(saleId).toArray()).sort((a, b) => a.lineNo - b.lineNo);
  const payment = await db.payments.where("saleId").equals(saleId).first();
  if (!payment) return null;
  return { sale, items, payment };
}

export async function listRecentSales(limit = 100, db = getDb()): Promise<SaleRecord[]> {
  return db.sales.orderBy("createdAt").reverse().limit(limit).toArray();
}

export async function findSales(query: string, db = getDb()): Promise<SaleRecord[]> {
  const q = query.trim().toLowerCase();
  if (!q) return listRecentSales(100, db);
  const all = await db.sales.orderBy("createdAt").reverse().toArray();
  return all.filter((s) => s.receiptNo.toLowerCase().includes(q) || s.id.toLowerCase().startsWith(q)).slice(0, 100);
}

/** Records that a receipt was printed. Never creates or changes the sale itself. */
export async function recordReceiptPrint(saleId: string, by: string, db = getDb()): Promise<void> {
  await db.transaction("rw", [db.sales, db.auditLog], async () => {
    const s = await db.sales.get(saleId);
    if (!s) return;
    await db.sales.update(saleId, { receiptPrintCount: s.receiptPrintCount + 1 });
    await db.auditLog.add({
      id: newId(),
      action: s.receiptPrintCount > 0 ? "receipt.reprint" : "receipt.print",
      entity: "sale",
      entityId: saleId,
      by,
      at: nowIso(),
    });
  });
}

export async function syncCounts(db = getDb()) {
  const [pending, failed] = await Promise.all([
    db.outbox.where("status").equals("pending").count(),
    db.outbox.where("status").equals("failed").count(),
  ]);
  const pendingSales = await db.sales.where("syncStatus").notEqual("synced").count();
  return { pending, failed, pendingSales };
}
