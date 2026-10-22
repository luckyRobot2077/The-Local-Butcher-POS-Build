import type { Centavos } from "@/domain/money";
import type { SaleUnit } from "@/domain/quantity";
import type { Gender } from "@/domain/members";

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  /** True once the cloud has confirmed this category (and its id). */
  synced?: boolean;
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
  /** Server version this device last synced; undefined until first sync. */
  serverVersion?: number;
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
  "sale" | "purchase" | "delivery" | "return" | "correction" | "damage" | "spoilage" | "trim_loss" | "other";

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
  /** Batch this movement belongs to: the batch received, or the batch wasted from. */
  batchId?: string;
  /** Set on movements created by receiving a supplier purchase. */
  purchaseId?: string;
  /** Recorded on another device and downloaded from the cloud. */
  remote?: boolean;
  by: string;
  at: string;
}

export interface Supplier {
  id: string;
  name: string;
  contact?: string;
  notes?: string;
  active: boolean;
  updatedAt: string;
}

export type PaymentStatus = "unpaid" | "partial" | "paid";

/** A supplier delivery. Its lines, batches and stock movements are immutable once saved. */
export interface Purchase {
  id: string;
  supplierId: string;
  receivedAt: string;
  reference?: string;
  notes?: string;
  paymentStatus: PaymentStatus;
  totalCost: Centavos;
  by: string;
  deviceId?: string;
  remote?: boolean;
}

export interface PurchaseItem {
  id: string;
  purchaseId: string;
  productId: string;
  batchId: string;
  qty: number;
  unitCost: Centavos;
  lineCost: Centavos;
}

/** A lot of perishable stock with its receiving and use-by dates. */
export interface InventoryBatch {
  id: string;
  productId: string;
  purchaseId?: string;
  batchCode?: string;
  receivedAt: string;
  useBy?: string;
  storageNote?: string;
  initialQty: number;
  unitCost: Centavos;
}

/** A sale line recorded on another device, downloaded for reports. */
export interface RemoteSaleLine {
  id: string;
  saleId: string;
  productId: string;
  qty: number;
  net: Centavos;
  cost: Centavos;
  at: string;
  /** Member on that sale, if any. */
  customerId?: string;
}

/** A registered store member (customers in the cloud). No tiers. */
export interface Member {
  id: string;
  /** Printed on the card under the QR code, e.g. M-A1B2-0007. Never changes. */
  memberNo: string;
  name: string;
  /** Stored instead of age so it stays right in later years. */
  birthYear: number;
  gender: Gender;
  /** +639XXXXXXXXX, optional. */
  contactNumber?: string;
  /** When the member agreed to the store keeping their details. Required. */
  privacyConsentAt: string;
  /** Agreed to member-only promo messages (SMS). Optional and can be withdrawn. */
  marketingConsent: boolean;
  marketingConsentAt?: string;
  /** Wants home deliveries and agreed to the store keeping their address. Optional. */
  wantsDelivery?: boolean;
  deliveryConsentAt?: string;
  /** House/unit, street, barangay, city. Only kept while wantsDelivery is on. */
  deliveryAddress?: string;
  /** Landmark or directions for the rider. */
  deliveryLandmark?: string;
  active: boolean;
  notes?: string;
  registeredAt: string;
  registeredBy: string;
  deviceId?: string;
  updatedAt: string;
  /** Registered on another device and downloaded from the cloud. */
  remote?: boolean;
}

export type OutboxKind =
  | "sale"
  | "product"
  | "inventory_movement"
  | "product_image"
  | "supplier"
  | "purchase"
  | "purchase_payment"
  | "customer"
  | "promotion"
  | "shift"
  | "drawer_event";

export interface OutboxEntry {
  id: string;
  kind: OutboxKind;
  entityId: string;
  createdAt: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
  /** For a product edit rejected because the server changed: the server's copy. */
  conflict?: Record<string, unknown>;
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
