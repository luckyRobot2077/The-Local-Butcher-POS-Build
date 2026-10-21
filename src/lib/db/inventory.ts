import { z } from "zod";
import { lineCost } from "@/domain/checkout";
import { averageCost, WASTE_TYPES, type BatchRef, type LedgerEntry, type SaleLine } from "@/domain/inventory";
import { MAX_CENTAVOS } from "@/domain/money";
import { getDb, type PosDatabase } from "./db";
import { newId, nowIso } from "./ids";
import type { InventoryBatch, OutboxKind, PaymentStatus, Product, Purchase, PurchaseItem, Supplier } from "./types";

export class InventoryError extends Error {}

function enqueue(db: PosDatabase, kind: OutboxKind, entityId: string) {
  return db.outbox.add({ id: newId(), kind, entityId, createdAt: nowIso(), status: "pending", attempts: 0 });
}

/* ------------------------------------------------------------------ suppliers */

export const supplierInputSchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required").max(80),
  contact: z.string().trim().max(80),
  notes: z.string().trim().max(200),
  active: z.boolean(),
});
export type SupplierInput = z.infer<typeof supplierInputSchema>;

export async function listSuppliers(db = getDb()): Promise<Supplier[]> {
  return (await db.suppliers.toArray()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveSupplier(input: SupplierInput, by: string, id?: string, db = getDb()): Promise<Supplier> {
  const data = supplierInputSchema.parse(input);
  return db.transaction("rw", [db.suppliers, db.outbox, db.auditLog], async () => {
    const all = await db.suppliers.toArray();
    if (all.some((s) => s.id !== id && s.name.toLowerCase() === data.name.toLowerCase())) {
      throw new InventoryError("A supplier with that name already exists.");
    }
    const existing = id ? await db.suppliers.get(id) : undefined;
    if (id && !existing) throw new InventoryError("Supplier not found.");
    const at = nowIso();
    const supplier: Supplier = {
      id: existing?.id ?? newId(),
      name: data.name,
      contact: data.contact || undefined,
      notes: data.notes || undefined,
      active: data.active,
      updatedAt: at,
    };
    await db.suppliers.put(supplier);
    await enqueue(db, "supplier", supplier.id);
    await db.auditLog.add({
      id: newId(),
      action: existing ? "supplier.update" : "supplier.create",
      entity: "supplier",
      entityId: supplier.id,
      by,
      at,
    });
    return supplier;
  });
}

/* ------------------------------------------------------------------ purchases */

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const purchaseLineSchema = z.object({
  productId: z.string().min(1),
  /** Grams for kg products, pieces otherwise. */
  qty: z.number().int().positive().max(10_000_000),
  /** Cost per kg or per piece. */
  unitCost: z.number().int().min(0).max(MAX_CENTAVOS),
  batchCode: z.string().trim().max(40).optional(),
  useBy: z.string().regex(isoDate, "Use-by must be a date").optional().or(z.literal("")),
  storageNote: z.string().trim().max(80).optional(),
});

export const purchaseInputSchema = z.object({
  supplierId: z.string().min(1, "Choose a supplier"),
  /** When the goods arrived (ISO). Defaults to now. */
  receivedAt: z.string().datetime().optional(),
  reference: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(200).optional(),
  paymentStatus: z.enum(["unpaid", "partial", "paid"]),
  /** Update each product's cost to the weighted average of stock on hand and this delivery. */
  updateCosts: z.boolean(),
  lines: z.array(purchaseLineSchema).min(1, "Add at least one product"),
});
export type PurchaseInput = z.infer<typeof purchaseInputSchema>;

/**
 * Receives a supplier delivery in one transaction: the purchase, one batch
 * and one stock movement per line, the stock projection, and (optionally)
 * the products' average cost. Nothing here is edited later except the
 * payment status.
 */
export async function receivePurchase(input: PurchaseInput, by: string, db = getDb()): Promise<Purchase> {
  const data = purchaseInputSchema.parse(input);
  const receivedAt = data.receivedAt ?? nowIso();
  if (Date.parse(receivedAt) > Date.now() + 5 * 60_000) throw new InventoryError("Received time is in the future.");
  return db.transaction(
    "rw",
    [
      db.suppliers,
      db.products,
      db.productRevisions,
      db.priceChanges,
      db.inventoryMovements,
      db.purchases,
      db.purchaseItems,
      db.batches,
      db.outbox,
      db.auditLog,
      db.config,
    ],
    async () => {
      const supplier = await db.suppliers.get(data.supplierId);
      if (!supplier) throw new InventoryError("Supplier not found.");
      const device = (await db.config.get("device"))?.value as { deviceId: string } | undefined;
      const at = nowIso();
      const purchaseId = newId();
      let total = 0;
      const touched = new Map<string, { before: Product; after: Product }>();

      for (const line of data.lines) {
        const current = touched.get(line.productId)?.after ?? (await db.products.get(line.productId));
        if (!current) throw new InventoryError("Product not found.");
        const cost = lineCost(current.saleUnit, line.unitCost, line.qty);
        total += cost;
        const batch: InventoryBatch = {
          id: newId(),
          productId: current.id,
          purchaseId,
          batchCode: line.batchCode || undefined,
          receivedAt,
          useBy: line.useBy || undefined,
          storageNote: line.storageNote || undefined,
          initialQty: line.qty,
          unitCost: line.unitCost,
        };
        const item: PurchaseItem = {
          id: newId(),
          purchaseId,
          productId: current.id,
          batchId: batch.id,
          qty: line.qty,
          unitCost: line.unitCost,
          lineCost: cost,
        };
        await db.batches.add(batch);
        await db.purchaseItems.add(item);
        await db.inventoryMovements.add({
          id: newId(),
          productId: current.id,
          type: "purchase",
          qtyDelta: line.qty,
          unitCost: line.unitCost,
          batchId: batch.id,
          purchaseId,
          batchCode: batch.batchCode,
          useBy: batch.useBy,
          by,
          at: receivedAt,
        });
        const after: Product = {
          ...current,
          stockQty: current.stockQty + line.qty,
          cost: data.updateCosts ? averageCost(current.stockQty, current.cost, line.qty, line.unitCost) : current.cost,
        };
        touched.set(current.id, { before: touched.get(current.id)?.before ?? current, after });
      }

      for (const { before, after } of touched.values()) {
        if (after.cost !== before.cost) {
          after.version = before.version + 1;
          after.updatedAt = at;
          await db.productRevisions.add({
            id: newId(),
            productId: after.id,
            version: after.version,
            changedFields: ["cost"],
            before: { cost: before.cost },
            after: { cost: after.cost },
            by,
            at,
          });
          await db.priceChanges.add({
            id: newId(),
            productId: after.id,
            field: "cost",
            oldValue: before.cost,
            newValue: after.cost,
            by,
            at,
            reason: `Average cost after purchase from ${supplier.name}`,
          });
          await enqueue(db, "product", after.id);
        }
        await db.products.put(after);
      }

      const purchase: Purchase = {
        id: purchaseId,
        supplierId: supplier.id,
        receivedAt,
        reference: data.reference || undefined,
        notes: data.notes || undefined,
        paymentStatus: data.paymentStatus,
        totalCost: total,
        by,
        deviceId: device?.deviceId,
      };
      await db.purchases.add(purchase);
      await enqueue(db, "purchase", purchaseId);
      if (purchase.paymentStatus !== "unpaid") await enqueue(db, "purchase_payment", purchaseId);
      await db.auditLog.add({
        id: newId(),
        action: "purchase.receive",
        entity: "purchase",
        entityId: purchaseId,
        by,
        at,
        detail: { supplier: supplier.name, total, lines: data.lines.length },
      });
      return purchase;
    },
  );
}

export async function setPaymentStatus(purchaseId: string, status: PaymentStatus, by: string, db = getDb()) {
  await db.transaction("rw", [db.purchases, db.outbox, db.auditLog], async () => {
    const p = await db.purchases.get(purchaseId);
    if (!p) throw new InventoryError("Purchase not found.");
    if (p.paymentStatus === status) return;
    await db.purchases.update(purchaseId, { paymentStatus: status });
    await enqueue(db, "purchase_payment", purchaseId);
    const at = nowIso();
    await db.auditLog.add({
      id: newId(),
      action: "purchase.payment",
      entity: "purchase",
      entityId: purchaseId,
      by,
      at,
      detail: { from: p.paymentStatus, to: status },
    });
  });
}

/* ------------------------------------------------------------------ report data */

export interface InventoryData {
  products: Product[];
  ledger: LedgerEntry[];
  saleLines: SaleLine[];
  batches: InventoryBatch[];
  /** Waste recorded against each batch (positive quantity). */
  wasteByBatch: Map<string, number>;
  lastRestock: Map<string, string>;
}

/** Everything the inventory reports need, read from this device's database. */
export async function loadInventoryData(db = getDb()): Promise<InventoryData> {
  const [products, movements, sales, items, remoteLines, batches] = await Promise.all([
    db.products.toArray(),
    db.inventoryMovements.toArray(),
    db.sales.toArray(),
    db.saleItems.toArray(),
    db.remoteSaleLines.toArray(),
    db.batches.toArray(),
  ]);
  const saleAt = new Map(sales.map((s) => [s.id, s.createdAt]));
  const saleLines: SaleLine[] = [];
  for (const i of items) {
    const at = saleAt.get(i.saleId);
    if (at) {
      saleLines.push({
        productId: i.productId,
        at,
        qty: i.qty,
        net: i.net,
        cost: lineCost(i.saleUnit, i.unitCost, i.qty),
      });
    }
  }
  for (const r of remoteLines) {
    if (!saleAt.has(r.saleId))
      saleLines.push({ productId: r.productId, at: r.at, qty: r.qty, net: r.net, cost: r.cost });
  }
  const wasteByBatch = new Map<string, number>();
  const lastRestock = new Map<string, string>();
  for (const m of movements) {
    if (m.batchId && WASTE_TYPES.includes(m.type)) {
      wasteByBatch.set(m.batchId, (wasteByBatch.get(m.batchId) ?? 0) - m.qtyDelta);
    }
    if ((m.type === "purchase" || m.type === "delivery") && m.at > (lastRestock.get(m.productId) ?? "")) {
      lastRestock.set(m.productId, m.at);
    }
  }
  return {
    products,
    ledger: movements.map((m) => ({ productId: m.productId, type: m.type, qtyDelta: m.qtyDelta, at: m.at })),
    saleLines,
    batches,
    wasteByBatch,
    lastRestock,
  };
}

export function batchRefs(batches: InventoryBatch[]): Map<string, BatchRef[]> {
  const m = new Map<string, BatchRef[]>();
  for (const b of batches) m.set(b.productId, [...(m.get(b.productId) ?? []), b]);
  return m;
}
