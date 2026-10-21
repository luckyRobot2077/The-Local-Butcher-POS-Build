import type { Centavos } from "@/domain/money";
import type { SaleUnit } from "@/domain/quantity";

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  sku?: string;
  barcode?: string;
  saleUnit: SaleUnit;
  /** Selling price per kg or per piece. */
  price: Centavos;
  /** Acquisition cost per kg or per piece. */
  cost: Centavos;
  /** Projection of the inventory ledger, in grams or pieces. Can go negative. */
  stockQty: number;
  /** Low-stock warning threshold, in grams or pieces. */
  minStockQty: number;
  active: boolean;
  imageId?: string;
  createdAt: string;
  updatedAt: string;
  /** Incremented on every edit; used for sync conflict detection in Phase 2. */
  version: number;
  isSample?: boolean;
}

export interface ProductImage {
  id: string;
  productId: string;
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  createdAt: string;
  /** Uploaded to Supabase Storage in Phase 2. */
  uploadStatus: "pending" | "uploaded";
}

export interface ProductRevision {
  id: string;
  productId: string;
  version: number;
  changedFields: string[];
  before: Partial<Product> | null;
  after: Partial<Product>;
  by: string;
  at: string;
}

export interface PriceChange {
  id: string;
  productId: string;
  field: "price" | "cost";
  oldValue: Centavos;
  newValue: Centavos;
  by: string;
  at: string;
  reason?: string;
}

export type MovementType =
  "sale" | "delivery" | "return" | "correction" | "damage" | "spoilage" | "trim_loss" | "other";

export interface InventoryMovement {
  id: string;
  productId: string;
  type: MovementType;
  /** Signed change in grams or pieces. */
  qtyDelta: number;
  /** Cost per unit for receipts; snapshot of product cost otherwise. */
  unitCost: Centavos;
  refType?: "sale";
  refId?: string;
  reason?: string;
  batchCode?: string;
  useBy?: string;
  by: string;
  at: string;
}

export type OutboxKind = "sale" | "product" | "inventory_movement" | "product_image";

export interface OutboxEntry {
  id: string;
  kind: OutboxKind;
  entityId: string;
  createdAt: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId?: string;
  by: string;
  at: string;
  detail?: Record<string, unknown>;
}

export interface KeyValue {
  key: string;
  value: unknown;
}
