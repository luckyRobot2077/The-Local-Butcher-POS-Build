import Dexie, { type EntityTable } from "dexie";
import type { PaymentRecord, SaleItemRecord, SaleRecord } from "@/domain/checkout";
import type {
  AuditEntry,
  Category,
  InventoryBatch,
  InventoryMovement,
  KeyValue,
  OutboxEntry,
  PriceChange,
  Product,
  ProductImage,
  ProductRevision,
  Purchase,
  PurchaseItem,
  RemoteSaleLine,
  Supplier,
} from "./types";

export const LOCAL_SCHEMA_VERSION = 2;

export class PosDatabase extends Dexie {
  categories!: EntityTable<Category, "id">;
  products!: EntityTable<Product, "id">;
  productImages!: EntityTable<ProductImage, "id">;
  productRevisions!: EntityTable<ProductRevision, "id">;
  priceChanges!: EntityTable<PriceChange, "id">;
  sales!: EntityTable<SaleRecord, "id">;
  saleItems!: EntityTable<SaleItemRecord, "id">;
  payments!: EntityTable<PaymentRecord, "id">;
  inventoryMovements!: EntityTable<InventoryMovement, "id">;
  outbox!: EntityTable<OutboxEntry, "id">;
  auditLog!: EntityTable<AuditEntry, "id">;
  config!: EntityTable<KeyValue, "key">;
  suppliers!: EntityTable<Supplier, "id">;
  purchases!: EntityTable<Purchase, "id">;
  purchaseItems!: EntityTable<PurchaseItem, "id">;
  batches!: EntityTable<InventoryBatch, "id">;
  remoteSaleLines!: EntityTable<RemoteSaleLine, "id">;

  constructor(name = "local-butcher-pos") {
    super(name);
    this.version(1).stores({
      categories: "id, sortOrder",
      products: "id, categoryId, name, active, sku, barcode, updatedAt",
      productImages: "id, productId, uploadStatus",
      productRevisions: "id, productId, at",
      priceChanges: "id, productId, at",
      sales: "id, &receiptNo, createdAt, businessDate, syncStatus",
      saleItems: "id, saleId, productId",
      payments: "id, saleId",
      inventoryMovements: "id, productId, type, at, refId",
      outbox: "id, kind, status, entityId, createdAt",
      auditLog: "id, action, at",
      config: "key",
    });
    // Phase 3: purchasing, batches and sale lines from other devices.
    this.version(2).stores({
      inventoryMovements: "id, productId, type, at, refId, batchId, purchaseId",
      suppliers: "id, name",
      purchases: "id, supplierId, receivedAt",
      purchaseItems: "id, purchaseId, productId, batchId",
      batches: "id, productId, purchaseId, useBy",
      remoteSaleLines: "id, saleId, productId, at",
    });
  }
}

let instance: PosDatabase | null = null;

export function getDb(): PosDatabase {
  if (!instance) instance = new PosDatabase();
  return instance;
}

/** Tests use this to get a fresh, isolated database. */
export function setDbForTests(db: PosDatabase | null) {
  instance = db;
}
