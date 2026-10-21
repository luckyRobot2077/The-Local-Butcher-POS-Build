import type { Centavos } from "./money";
import type { SaleUnit } from "./quantity";
import { businessDate } from "./time";

/**
 * Inventory analytics (spec sections 10 and 11). Pure functions over the
 * stock ledger so they can be tested without a database.
 *
 * Quantities are integer grams (kg products) or whole pieces. Days are
 * Manila business dates (YYYY-MM-DD).
 */

export type LedgerType =
  "sale" | "purchase" | "delivery" | "return" | "correction" | "damage" | "spoilage" | "trim_loss" | "other";

export interface LedgerEntry {
  productId: string;
  type: LedgerType;
  qtyDelta: number;
  at: string;
  batchId?: string;
}

export interface SaleLine {
  productId: string;
  at: string;
  qty: number;
  /** Revenue after discounts. */
  net: Centavos;
  /** Cost of goods for this line. */
  cost: Centavos;
}

export interface ProductRef {
  id: string;
  name: string;
  categoryId: string;
  saleUnit: SaleUnit;
  stockQty: number;
  minStockQty: number;
  active: boolean;
}

export interface BatchRef {
  id: string;
  productId: string;
  batchCode?: string;
  receivedAt: string;
  useBy?: string;
  initialQty: number;
}

export interface InventoryRules {
  /** Main evaluation period in days (spec default 30; 7 is the short view). */
  periodDays: number;
  /** Top share of comparable products called fast-moving, in percent. */
  fastPct: number;
  /** Bottom share called slow-moving, in percent. */
  slowPct: number;
  /** Days of available selling history needed before ranking a product. */
  minHistoryDays: number;
  /** Consecutive available days without a sale that make a product non-moving. */
  nonMovingDays: number;
  /** Fewest comparable products (same category and unit) needed to rank by percentile. */
  minGroupSize: number;
  /** Demand change (last 7 days vs previous 28) that raises a trend alert, in percent. */
  trendPct: number;
  /** Fast movers with less stock coverage than this get a stockout alert. */
  stockoutDays: number;
  /** Slow movers with more coverage than this get an excess-stock alert. */
  excessCoverageDays: number;
  /** Warn this many days before a batch's use-by date. */
  useByWarnDays: number;
  /** Supplier lead time used by order estimates. */
  leadTimeDays: number;
  /** Days of sales an order estimate should cover after it arrives. */
  orderCoverDays: number;
  /** Extra days of sales kept as safety stock. */
  safetyDays: number;
}

export const DEFAULT_INVENTORY_RULES: InventoryRules = {
  periodDays: 30,
  fastPct: 25,
  slowPct: 25,
  minHistoryDays: 14,
  nonMovingDays: 7,
  minGroupSize: 4,
  trendPct: 25,
  stockoutDays: 3,
  excessCoverageDays: 14,
  useByWarnDays: 2,
  leadTimeDays: 1,
  orderCoverDays: 3,
  safetyDays: 1,
};

export const WASTE_TYPES: readonly LedgerType[] = ["damage", "spoilage", "trim_loss"];
export const RECEIPT_TYPES: readonly LedgerType[] = ["purchase", "delivery"];

/* ------------------------------------------------------------------ dates */

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/* ------------------------------------------------------------------ daily series */

export interface DayRow {
  date: string;
  opening: number;
  received: number;
  sold: number;
  returned: number;
  wasted: number;
  adjusted: number;
  closing: number;
  /** Had stock at some point, or sold something, that day. */
  available: boolean;
}

/**
 * One row per business date from `from` to `to` (inclusive) for a single
 * product. `entries` must be that product's ledger, in any order.
 */
export function dailySeries(entries: LedgerEntry[], from: string, to: string): DayRow[] {
  const byDay = new Map<string, LedgerEntry[]>();
  let opening = 0;
  for (const e of entries) {
    const day = businessDate(new Date(e.at));
    if (day < from) opening += e.qtyDelta;
    else if (day <= to) byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  const rows: DayRow[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const row: DayRow = {
      date,
      opening,
      received: 0,
      sold: 0,
      returned: 0,
      wasted: 0,
      adjusted: 0,
      closing: opening,
      available: false,
    };
    for (const e of byDay.get(date) ?? []) {
      if (e.type === "sale") row.sold -= e.qtyDelta;
      else if (e.type === "return") row.returned += e.qtyDelta;
      else if (RECEIPT_TYPES.includes(e.type)) row.received += e.qtyDelta;
      else if (WASTE_TYPES.includes(e.type)) row.wasted -= e.qtyDelta;
      else row.adjusted += e.qtyDelta;
      row.closing += e.qtyDelta;
    }
    row.available = row.opening > 0 || row.closing > 0 || row.received > 0 || row.sold > 0;
    rows.push(row);
    opening = row.closing;
  }
  return rows;
}

/* ------------------------------------------------------------------ metrics */

export type MovementClass = "fast" | "normal" | "slow" | "non_moving" | "new" | "unranked";

export interface ProductMetrics {
  productId: string;
  name: string;
  categoryId: string;
  saleUnit: SaleUnit;
  stock: number;
  /** Days in the period the product was available for sale. */
  availableDays: number;
  /** Available days used for the history threshold (at least minHistoryDays long). */
  historyDays: number;
  netSold: number;
  /** Net quantity sold per available day (grams or pieces). */
  velocity: number;
  opening: number;
  received: number;
  wasted: number;
  /** Days the current stock lasts at the current velocity; null when nothing sells. */
  coverageDays: number | null;
  /** Percent; null when there was nothing to sell. */
  sellThroughPct: number | null;
  lastSaleDate: string | null;
  daysSinceLastSale: number | null;
  /** Last 7 days vs preceding 28 days velocity change, percent. */
  trendPct: number | null;
  /** Wasted / received in the period, percent; null when nothing was received. */
  wastagePct: number | null;
  /** Last 7 days wastage rate minus the preceding 28 days rate, in percentage points. */
  wastageTrendPts: number | null;
  revenue: Centavos;
  cogs: Centavos;
  grossProfit: Centavos;
  nonMoving: boolean;
  movementClass: MovementClass;
}

function velocityOf(rows: DayRow[]): { velocity: number; days: number; netSold: number } {
  const avail = rows.filter((r) => r.available);
  const netSold = avail.reduce((a, r) => a + r.sold - r.returned, 0);
  return { velocity: avail.length ? netSold / avail.length : 0, days: avail.length, netSold };
}

function wasteRate(rows: DayRow[]): number | null {
  const received = rows.reduce((a, r) => a + r.received, 0);
  if (received <= 0) return null;
  return (rows.reduce((a, r) => a + r.wasted, 0) / received) * 100;
}

/**
 * Computes metrics for every product over the period ending on `asOf`, then
 * classifies them among comparable products (same category and unit).
 */
export function computeMetrics(args: {
  products: ProductRef[];
  ledger: LedgerEntry[];
  saleLines: SaleLine[];
  asOf: string;
  rules: InventoryRules;
}): ProductMetrics[] {
  const { rules, asOf } = args;
  const from = addDays(asOf, -(rules.periodDays - 1));
  const historyFrom = addDays(asOf, -(Math.max(rules.periodDays, rules.minHistoryDays) - 1));
  const trendFrom = addDays(asOf, -34);
  const earliest = [from, historyFrom, trendFrom].sort()[0];
  const ledgerBy = groupBy(args.ledger, (e) => e.productId);
  const linesBy = groupBy(args.saleLines, (l) => l.productId);

  const metrics = args.products.map((p): ProductMetrics => {
    const entries = ledgerBy.get(p.id) ?? [];
    const all = dailySeries(entries, earliest, asOf);
    const period = all.filter((r) => r.date >= from);
    const { velocity, days, netSold } = velocityOf(period);
    const historyDays = all.filter((r) => r.date >= historyFrom && r.available).length;
    const opening = period[0]?.opening ?? 0;
    const received = period.reduce((a, r) => a + r.received, 0);
    const wasted = period.reduce((a, r) => a + r.wasted, 0);

    const recent = velocityOf(all.filter((r) => r.date > addDays(asOf, -7)));
    const base = velocityOf(all.filter((r) => r.date <= addDays(asOf, -7) && r.date >= trendFrom));
    const trendPct =
      base.days >= 7 && base.velocity > 0 && recent.days > 0
        ? ((recent.velocity - base.velocity) / base.velocity) * 100
        : null;
    const recentWaste = wasteRate(all.filter((r) => r.date > addDays(asOf, -7)));
    const baseWaste = wasteRate(all.filter((r) => r.date <= addDays(asOf, -7) && r.date >= trendFrom));

    let lastSale: string | null = null;
    for (const e of entries) if (e.type === "sale" && (!lastSale || e.at > lastSale)) lastSale = e.at;
    const lastSaleDate = lastSale ? businessDate(new Date(lastSale)) : null;

    // Non-moving: the most recent available days, back to the last sale, number at least nonMovingDays.
    let quietDays = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const r = all[i];
      if (r.sold > 0) break;
      if (r.available) quietDays++;
    }

    const lines = (linesBy.get(p.id) ?? []).filter((l) => businessDate(new Date(l.at)) >= from);
    const revenue = lines.reduce((a, l) => a + l.net, 0);
    const cogs = lines.reduce((a, l) => a + l.cost, 0);
    const denom = opening + received;

    return {
      productId: p.id,
      name: p.name,
      categoryId: p.categoryId,
      saleUnit: p.saleUnit,
      stock: p.stockQty,
      availableDays: days,
      historyDays,
      netSold,
      velocity,
      opening,
      received,
      wasted,
      coverageDays: velocity > 0 ? Math.max(0, p.stockQty) / velocity : null,
      sellThroughPct: denom > 0 ? (netSold / denom) * 100 : null,
      lastSaleDate,
      daysSinceLastSale: lastSaleDate ? daysBetween(lastSaleDate, asOf) : null,
      trendPct,
      wastagePct: received > 0 ? (wasted / received) * 100 : null,
      wastageTrendPts: recentWaste !== null && baseWaste !== null ? recentWaste - baseWaste : null,
      revenue,
      cogs,
      grossProfit: revenue - cogs,
      nonMoving: quietDays >= rules.nonMovingDays,
      movementClass: "unranked",
    };
  });

  classify(metrics, rules);
  return metrics;
}

/** Assigns fast/normal/slow within each group of comparable products. */
export function classify(metrics: ProductMetrics[], rules: InventoryRules): void {
  const eligible: ProductMetrics[] = [];
  for (const m of metrics) {
    if (m.nonMoving) m.movementClass = "non_moving";
    else if (m.historyDays < rules.minHistoryDays) m.movementClass = "new";
    else {
      m.movementClass = "unranked";
      eligible.push(m);
    }
  }
  for (const group of groupBy(eligible, (m) => `${m.categoryId}|${m.saleUnit}`).values()) {
    if (group.length < rules.minGroupSize) continue;
    const sorted = [...group].sort((a, b) => b.velocity - a.velocity);
    const n = sorted.length;
    const fastCount = Math.round((n * rules.fastPct) / 100);
    const slowCount = Math.round((n * rules.slowPct) / 100);
    const fastMin = fastCount > 0 ? sorted[fastCount - 1].velocity : Infinity;
    const slowMax = slowCount > 0 ? sorted[n - slowCount].velocity : -Infinity;
    for (const m of group) {
      if (m.velocity >= fastMin && m.velocity > 0) m.movementClass = "fast";
      else if (m.velocity <= slowMax) m.movementClass = "slow";
      else m.movementClass = "normal";
    }
  }
}

/* ------------------------------------------------------------------ batches */

export interface BatchEstimate extends BatchRef {
  /** Estimated quantity of this batch still on hand. */
  remaining: number;
  /** Days until use-by (negative = past); null when no date was recorded. */
  daysLeft: number | null;
  /** Estimated days of sales needed to sell through this batch; null when nothing sells. */
  daysToSell: number | null;
  /** Expected to still have stock left on its use-by date. */
  atRisk: boolean;
}

/**
 * Estimates what is left of each batch, assuming the earliest use-by (then
 * oldest) stock is sold first. Waste recorded against a specific batch is
 * taken out of that batch. Stock beyond all batches is opening or
 * unbatched stock.
 */
export function estimateBatches(args: {
  batches: BatchRef[];
  stock: number;
  wasteByBatch: Map<string, number>;
  velocity: number;
  today: string;
}): BatchEstimate[] {
  const sellOrder = [...args.batches].sort(
    (a, b) =>
      (a.useBy ?? "9999-12-31").localeCompare(b.useBy ?? "9999-12-31") || a.receivedAt.localeCompare(b.receivedAt),
  );
  // Stock on hand sits in the batches that will be sold last.
  let left = Math.max(0, args.stock);
  const remaining = new Map<string, number>();
  for (const b of [...sellOrder].reverse()) {
    const cap = Math.max(0, b.initialQty - (args.wasteByBatch.get(b.id) ?? 0));
    const take = Math.min(cap, left);
    remaining.set(b.id, take);
    left -= take;
  }
  let ahead = 0;
  return sellOrder.map((b) => {
    const rem = remaining.get(b.id) ?? 0;
    const daysLeft = b.useBy ? daysBetween(args.today, b.useBy) : null;
    const daysToSell = args.velocity > 0 ? (ahead + rem) / args.velocity : null;
    ahead += rem;
    const atRisk = rem > 0 && daysLeft !== null && (daysToSell === null || daysToSell > daysLeft + 1);
    return { ...b, remaining: rem, daysLeft, daysToSell, atRisk };
  });
}

/* ------------------------------------------------------------------ alerts & orders */

export type AlertKind =
  | "low_stock"
  | "stockout_soon"
  | "excess_stock"
  | "no_sales"
  | "wastage_up"
  | "demand_down"
  | "demand_up"
  | "use_by"
  | "batch_at_risk";

export interface InventoryAlert {
  kind: AlertKind;
  productId: string;
  batchId?: string;
  severity: "high" | "medium" | "info";
}

/**
 * Movement alerts and expiry alerts are kept apart (spec 11): expiry is
 * about food safety, movement is about demand.
 */
export function buildAlerts(args: {
  products: ProductRef[];
  metrics: ProductMetrics[];
  batches: Map<string, BatchEstimate[]>;
  rules: InventoryRules;
}): { movement: InventoryAlert[]; expiry: InventoryAlert[] } {
  const { rules } = args;
  const byId = new Map(args.metrics.map((m) => [m.productId, m]));
  const movement: InventoryAlert[] = [];
  const expiry: InventoryAlert[] = [];
  for (const p of args.products) {
    if (!p.active) continue;
    const m = byId.get(p.id);
    if (p.minStockQty > 0 && p.stockQty <= p.minStockQty) {
      movement.push({ kind: "low_stock", productId: p.id, severity: p.stockQty <= 0 ? "high" : "medium" });
    }
    if (m) {
      if (m.movementClass === "fast" && m.coverageDays !== null && m.coverageDays < rules.stockoutDays) {
        movement.push({ kind: "stockout_soon", productId: p.id, severity: "high" });
      }
      if (m.movementClass === "slow" && m.coverageDays !== null && m.coverageDays > rules.excessCoverageDays) {
        movement.push({ kind: "excess_stock", productId: p.id, severity: "medium" });
      }
      if (m.movementClass === "non_moving") movement.push({ kind: "no_sales", productId: p.id, severity: "medium" });
      if (m.wastageTrendPts !== null && m.wastageTrendPts > 0 && m.wasted > 0) {
        movement.push({ kind: "wastage_up", productId: p.id, severity: "medium" });
      }
      if (m.trendPct !== null && m.trendPct <= -rules.trendPct) {
        movement.push({ kind: "demand_down", productId: p.id, severity: "medium" });
      }
      if (m.trendPct !== null && m.trendPct >= rules.trendPct) {
        movement.push({ kind: "demand_up", productId: p.id, severity: "info" });
      }
    }
    for (const b of args.batches.get(p.id) ?? []) {
      if (b.remaining <= 0 || b.daysLeft === null) continue;
      if (b.daysLeft <= rules.useByWarnDays) {
        expiry.push({ kind: "use_by", productId: p.id, batchId: b.id, severity: b.daysLeft < 0 ? "high" : "medium" });
      } else if (b.atRisk) {
        expiry.push({ kind: "batch_at_risk", productId: p.id, batchId: b.id, severity: "medium" });
      }
    }
  }
  return { movement, expiry };
}

export interface OrderEstimate {
  productId: string;
  /** Suggested quantity to order (grams or pieces). An estimate, never an order. */
  qty: number;
  coverDays: number;
}

/**
 * Suggests how much to order: sales velocity × (lead time + cover + safety)
 * minus current stock. When past batches show a shelf life, the cover is
 * shortened so the order can sell before its use-by date.
 */
export function estimateOrder(args: {
  metric: ProductMetrics;
  rules: InventoryRules;
  shelfLifeDays?: number | null;
}): OrderEstimate | null {
  const { metric: m, rules } = args;
  if (m.velocity <= 0 || m.movementClass === "non_moving") return null;
  let cover = rules.orderCoverDays;
  if (args.shelfLifeDays != null) cover = Math.max(1, Math.min(cover, args.shelfLifeDays - rules.leadTimeDays));
  const target = m.velocity * (rules.leadTimeDays + cover + rules.safetyDays);
  const qty = Math.ceil(target - Math.max(0, m.stock));
  if (qty <= 0) return null;
  return { productId: m.productId, qty: m.saleUnit === "kg" ? Math.ceil(qty / 100) * 100 : qty, coverDays: cover };
}

/** Median days between receiving and use-by across a product's batches. */
export function typicalShelfLife(batches: BatchRef[]): number | null {
  const lives = batches
    .filter((b) => b.useBy)
    .map((b) => daysBetween(businessDate(new Date(b.receivedAt)), b.useBy!))
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  if (lives.length === 0) return null;
  return lives[Math.floor((lives.length - 1) / 2)];
}

/** Weighted-average cost after receiving `qty` at `unitCost` on top of `stock` at `oldCost`. */
export function averageCost(stock: number, oldCost: Centavos, qty: number, unitCost: Centavos): Centavos {
  const onHand = Math.max(0, stock);
  if (onHand + qty <= 0) return unitCost;
  return Math.round((onHand * oldCost + qty * unitCost) / (onHand + qty));
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}
