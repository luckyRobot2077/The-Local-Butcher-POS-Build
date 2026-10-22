"use client";

import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  addDays,
  buildAlerts,
  daysBetween,
  computeMetrics,
  estimateBatches,
  estimateOrder,
  typicalShelfLife,
  type BatchEstimate,
  type InventoryRules,
  type OrderEstimate,
  type ProductMetrics,
} from "@/domain/inventory";
import type { SaleUnit } from "@/domain/quantity";
import { businessDate } from "@/domain/time";
import { batchRefs, loadInventoryData } from "@/lib/db/inventory";

/** Period length for "all history": from the first stock entry on this device to today. */
export const ALL_HISTORY = 0;

/**
 * Live inventory analytics for this device's data, recomputed when the
 * ledger changes. A `periodDays` of ALL_HISTORY covers everything recorded.
 */
export function useInventory(periodRules: InventoryRules) {
  const data = useLiveQuery(() => loadInventoryData(), []);
  return useMemo(() => {
    if (!data) return undefined;
    const today = businessDate(new Date());
    let rules = periodRules;
    if (periodRules.periodDays === ALL_HISTORY) {
      const first = data.ledger.reduce((m, e) => (e.at < m ? e.at : m), new Date().toISOString());
      const firstDay = businessDate(new Date(first));
      rules = { ...periodRules, periodDays: Math.max(1, daysBetween(firstDay, today) + 1) };
    }
    const metrics = computeMetrics({
      products: data.products,
      ledger: data.ledger,
      saleLines: data.saleLines,
      asOf: today,
      rules,
    });
    const metricById = new Map(metrics.map((m) => [m.productId, m]));
    const refs = batchRefs(data.batches);
    const batches = new Map<string, BatchEstimate[]>();
    const orders: OrderEstimate[] = [];
    for (const p of data.products) {
      const m = metricById.get(p.id);
      const list = refs.get(p.id) ?? [];
      batches.set(
        p.id,
        estimateBatches({
          batches: list,
          stock: p.stockQty,
          wasteByBatch: data.wasteByBatch,
          velocity: m?.velocity ?? 0,
          today,
        }),
      );
      if (m && p.active) {
        const o = estimateOrder({ metric: m, rules, shelfLifeDays: typicalShelfLife(list) });
        if (o) orders.push(o);
      }
    }
    const alerts = buildAlerts({ products: data.products, metrics, batches, rules });
    return {
      today,
      products: data.products,
      productById: new Map(data.products.map((p) => [p.id, p])),
      metrics,
      metricById,
      batches,
      orders,
      alerts,
      lastRestock: data.lastRestock,
      periodDays: rules.periodDays,
      periodStart: addDays(today, -(rules.periodDays - 1)),
    };
  }, [data, periodRules]);
}

export type InventoryView = NonNullable<ReturnType<typeof useInventory>>;

export function formatVelocity(unit: SaleUnit, perDay: number): string {
  return unit === "kg" ? `${(perDay / 1000).toFixed(2)} kg/day` : `${perDay.toFixed(1)} pcs/day`;
}

export function formatDays(days: number | null): string {
  if (days === null) return "—";
  if (days >= 999) return "999+ days";
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} days`;
}

export function formatPct(pct: number | null): string {
  return pct === null ? "—" : `${Math.round(pct)}%`;
}

export const CLASS_LABEL: Record<ProductMetrics["movementClass"], string> = {
  fast: "Fast",
  normal: "Normal",
  slow: "Slow",
  non_moving: "No sales",
  new: "New / not enough data",
  unranked: "Too few to compare",
};

export const CLASS_TONE: Record<ProductMetrics["movementClass"], "ok" | "info" | "warn" | "danger" | "neutral"> = {
  fast: "ok",
  normal: "info",
  slow: "warn",
  non_moving: "danger",
  new: "neutral",
  unranked: "neutral",
};
