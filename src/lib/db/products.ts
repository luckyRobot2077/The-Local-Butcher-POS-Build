import { z } from "zod";
import { MAX_CENTAVOS } from "@/domain/money";
import { getDb, type PosDatabase } from "./db";
import { newId, nowIso } from "./ids";
import type { Category, InventoryMovement, MovementType, Product, ProductImage } from "./types";

export const productInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500),
  categoryId: z.string().min(1, "Choose a category"),
  sku: z.string().trim().max(40).optional(),
  barcode: z.string().trim().max(40).optional(),
  saleUnit: z.enum(["kg", "piece"]),
  price: z.number().int().min(0).max(MAX_CENTAVOS),
  cost: z.number().int().min(0).max(MAX_CENTAVOS),
  minStockQty: z.number().int().min(0).max(10_000_000),
  active: z.boolean(),
});
export type ProductInput = z.infer<typeof productInputSchema>;

export class ProductError extends Error {}

const TRACKED_FIELDS = [
  "name",
  "description",
  "categoryId",
  "sku",
  "barcode",
  "saleUnit",
  "price",
  "cost",
  "minStockQty",
  "active",
  "imageId",
] as const;

function enqueue(db: PosDatabase, kind: "product" | "inventory_movement" | "product_image", entityId: string) {
  return db.outbox.add({ id: newId(), kind, entityId, createdAt: nowIso(), status: "pending", attempts: 0 });
}

export async function listCategories(db = getDb()): Promise<Category[]> {
  return db.categories.orderBy("sortOrder").toArray();
}

export async function addCategory(name: string, db = getDb()): Promise<Category> {
  const trimmed = name.trim();
  if (!trimmed) throw new ProductError("Category name is required.");
  const existing = await db.categories.toArray();
  if (existing.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new ProductError("That category already exists.");
  }
  const cat = { id: newId(), name: trimmed.slice(0, 40), sortOrder: existing.length };
  await db.categories.add(cat);
  return cat;
}

export async function createProduct(
  input: ProductInput,
  by: string,
  db = getDb(),
  opts: { initialStockQty?: number; isSample?: boolean } = {},
): Promise<Product> {
  const data = productInputSchema.parse(input);
  const at = nowIso();
  const product: Product = {
    ...data,
    sku: data.sku || undefined,
    barcode: data.barcode || undefined,
    id: newId(),
    stockQty: 0,
    createdAt: at,
    updatedAt: at,
    version: 1,
    isSample: opts.isSample,
  };
  await db.transaction(
    "rw",
    [db.products, db.productRevisions, db.inventoryMovements, db.outbox, db.auditLog],
    async () => {
      await db.products.add(product);
      await db.productRevisions.add({
        id: newId(),
        productId: product.id,
        version: 1,
        changedFields: ["created"],
        before: null,
        after: { ...product },
        by,
        at,
      });
      await enqueue(db, "product", product.id);
      await db.auditLog.add({ id: newId(), action: "product.create", entity: "product", entityId: product.id, by, at });
      if (opts.initialStockQty && opts.initialStockQty > 0) {
        await writeMovement(db, product, "delivery", opts.initialStockQty, by, at, { reason: "Opening stock" });
      }
    },
  );
  return (await db.products.get(product.id))!;
}

/**
 * Edits a product and records a revision. Price and cost changes also go
 * to the price-change log with the reason. Historical sales are never
 * touched because sale items store their own price snapshots.
 */
export async function updateProduct(
  id: string,
  input: ProductInput,
  by: string,
  opts: { reason?: string; expectedVersion?: number } = {},
  db = getDb(),
): Promise<Product> {
  const data = productInputSchema.parse(input);
  return db.transaction("rw", [db.products, db.productRevisions, db.priceChanges, db.outbox, db.auditLog], async () => {
    const before = await db.products.get(id);
    if (!before) throw new ProductError("Product not found.");
    if (opts.expectedVersion !== undefined && before.version !== opts.expectedVersion) {
      throw new ProductError("This product was changed elsewhere. Reload it and try again.");
    }
    const after: Product = {
      ...before,
      ...data,
      sku: data.sku || undefined,
      barcode: data.barcode || undefined,
    };
    const changed = TRACKED_FIELDS.filter((f) => before[f] !== after[f]);
    if (changed.length === 0) return before;
    if (before.saleUnit !== after.saleUnit && before.stockQty !== 0) {
      throw new ProductError("Set stock to zero before changing between kg and piece.");
    }
    const at = nowIso();
    after.version = before.version + 1;
    after.updatedAt = at;
    await db.products.put(after);
    const pick = (p: Product) => Object.fromEntries(changed.map((f) => [f, p[f]])) as Partial<Product>;
    await db.productRevisions.add({
      id: newId(),
      productId: id,
      version: after.version,
      changedFields: [...changed],
      before: pick(before),
      after: pick(after),
      by,
      at,
    });
    for (const field of ["price", "cost"] as const) {
      if (before[field] !== after[field]) {
        await db.priceChanges.add({
          id: newId(),
          productId: id,
          field,
          oldValue: before[field],
          newValue: after[field],
          by,
          at,
          reason: opts.reason?.trim() || undefined,
        });
      }
    }
    await enqueue(db, "product", id);
    await db.auditLog.add({
      id: newId(),
      action: "product.update",
      entity: "product",
      entityId: id,
      by,
      at,
      detail: { changed, reason: opts.reason },
    });
    return after;
  });
}

/** Stores a (compressed) photo for the product, replacing any previous one. */
export async function setProductImage(
  productId: string,
  image: { blob: Blob; mime: string; width: number; height: number },
  by: string,
  db = getDb(),
): Promise<ProductImage> {
  const rec: ProductImage = { id: newId(), productId, ...image, createdAt: nowIso(), uploadStatus: "pending" };
  await db.transaction("rw", [db.products, db.productImages, db.productRevisions, db.outbox, db.auditLog], async () => {
    const p = await db.products.get(productId);
    if (!p) throw new ProductError("Product not found.");
    await db.productImages.add(rec);
    if (p.imageId) await db.productImages.delete(p.imageId);
    const at = rec.createdAt;
    const version = p.version + 1;
    await db.products.update(productId, { imageId: rec.id, version, updatedAt: at });
    await db.productRevisions.add({
      id: newId(),
      productId,
      version,
      changedFields: ["imageId"],
      before: { imageId: p.imageId },
      after: { imageId: rec.id },
      by,
      at,
    });
    await enqueue(db, "product_image", rec.id);
    await enqueue(db, "product", productId);
    await db.auditLog.add({ id: newId(), action: "product.photo", entity: "product", entityId: productId, by, at });
  });
  return rec;
}

export async function removeProductImage(productId: string, by: string, db = getDb()): Promise<void> {
  await db.transaction("rw", [db.products, db.productImages, db.productRevisions, db.outbox, db.auditLog], async () => {
    const p = await db.products.get(productId);
    if (!p?.imageId) return;
    const at = nowIso();
    const version = p.version + 1;
    await db.productImages.delete(p.imageId);
    await db.products.update(productId, { imageId: undefined, version, updatedAt: at });
    await db.productRevisions.add({
      id: newId(),
      productId,
      version,
      changedFields: ["imageId"],
      before: { imageId: p.imageId },
      after: { imageId: undefined },
      by,
      at,
    });
    await enqueue(db, "product", productId);
    await db.auditLog.add({
      id: newId(),
      action: "product.photo_remove",
      entity: "product",
      entityId: productId,
      by,
      at,
    });
  });
}

async function writeMovement(
  db: PosDatabase,
  product: Product,
  type: MovementType,
  qtyDelta: number,
  by: string,
  at: string,
  extra: Partial<InventoryMovement> = {},
): Promise<InventoryMovement> {
  const m: InventoryMovement = {
    id: newId(),
    productId: product.id,
    type,
    qtyDelta,
    unitCost: product.cost,
    by,
    at,
    ...extra,
  };
  await db.inventoryMovements.add(m);
  const current = await db.products.get(product.id);
  await db.products.update(product.id, { stockQty: (current?.stockQty ?? 0) + qtyDelta });
  await enqueue(db, "inventory_movement", m.id);
  return m;
}

const INCREASE_TYPES: MovementType[] = ["delivery", "return"];
const DECREASE_TYPES: MovementType[] = ["damage", "spoilage", "trim_loss"];

/**
 * Records a manual stock movement. Deliveries and returns add stock;
 * damage, spoilage and trimming losses remove it; corrections and "other"
 * may go either way. Stock is never edited directly.
 */
export async function recordStockMovement(
  productId: string,
  type: Exclude<MovementType, "sale" | "purchase">,
  qtyDelta: number,
  by: string,
  extra: { reason?: string; batchCode?: string; useBy?: string; unitCost?: number; batchId?: string } = {},
  db = getDb(),
): Promise<InventoryMovement> {
  if (!Number.isSafeInteger(qtyDelta) || qtyDelta === 0) throw new ProductError("Enter a quantity.");
  if (INCREASE_TYPES.includes(type) && qtyDelta < 0) throw new ProductError("Deliveries and returns add stock.");
  if (DECREASE_TYPES.includes(type) && qtyDelta > 0) throw new ProductError("Losses remove stock.");
  if ((type === "correction" || type === "other") && !extra.reason?.trim()) {
    throw new ProductError("A reason is required for corrections.");
  }
  if (extra.batchId && !DECREASE_TYPES.includes(type)) throw new ProductError("Only losses can name a batch.");
  return db.transaction("rw", [db.products, db.inventoryMovements, db.outbox, db.auditLog, db.batches], async () => {
    const p = await db.products.get(productId);
    if (!p) throw new ProductError("Product not found.");
    const batch = extra.batchId ? await db.batches.get(extra.batchId) : undefined;
    if (extra.batchId && batch?.productId !== productId) throw new ProductError("That batch is not for this product.");
    const at = nowIso();
    const m = await writeMovement(db, p, type, qtyDelta, by, at, {
      reason: extra.reason?.trim() || undefined,
      useBy: extra.useBy || undefined,
      unitCost: extra.unitCost ?? p.cost,
      batchId: batch?.id,
      batchCode: batch?.batchCode ?? (extra.batchCode?.trim() || undefined),
    });
    await db.auditLog.add({
      id: newId(),
      action: `stock.${type}`,
      entity: "product",
      entityId: productId,
      by,
      at,
      detail: { qtyDelta, reason: extra.reason },
    });
    return m;
  });
}

/** Recomputes stock from the ledger; used to verify the projection. */
export async function ledgerStock(productId: string, db = getDb()): Promise<number> {
  const moves = await db.inventoryMovements.where("productId").equals(productId).toArray();
  return moves.reduce((a, m) => a + m.qtyDelta, 0);
}

export function isLowStock(p: Product): boolean {
  return p.minStockQty > 0 && p.stockQty <= p.minStockQty;
}
