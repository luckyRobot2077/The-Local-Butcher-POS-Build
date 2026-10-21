import Dexie, { type EntityTable } from "dexie";
import type { PaymentRecord, SaleItemRecord, SaleRecord } from "@/domain/checkout";
import type {
  AuditEntry,
  Category,
  InventoryMovement,
  KeyValue,
  OutboxEntry,
  PriceChange,
  Product,
  ProductImage,
  ProductRevision,
} from "./types";

export const LOCAL_SCHEMA_VERSION = 1;

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

  constructor(name = "local-butcher-pos") {
    super(name);
    this.version(LOCAL_SCHEMA_VERSION).stores({
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
