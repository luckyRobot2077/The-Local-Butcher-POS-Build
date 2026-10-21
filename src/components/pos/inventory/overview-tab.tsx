"use client";

import type { AlertKind, BatchEstimate, InventoryAlert, ProductMetrics } from "@/domain/inventory";
import { formatQuantity } from "@/domain/quantity";
import { Badge } from "@/components/ui";
import { usePos } from "../pos-context";
import { formatDays, formatPct, formatVelocity, useInventory, type InventoryView } from "./use-inventory";

const ALERT_TEXT: Record<AlertKind, string> = {
  low_stock: "Low stock",
  stockout_soon: "Fast seller running out",
  excess_stock: "Slow seller with too much stock",
  no_sales: "No sales while in stock",
  wastage_up: "Wastage increasing",
  demand_down: "Demand falling",
  demand_up: "Demand rising",
  use_by: "Use-by date close or passed",
  batch_at_risk: "May not sell before use-by",
};

export function OverviewTab() {
  const { settings } = usePos();
  const view = useInventory(settings.inventoryRules);
  if (!view) return <p className="text-charcoal-500">Loading…</p>;
  const { movement, expiry } = view.alerts;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl bg-white p-3 shadow-sm" data-testid="expiry-alerts">
        <h2 className="text-lg font-bold text-burgundy-800">Use-by and food safety</h2>
        <p className="text-xs text-charcoal-500">
          Based on batches you received with a use-by date. Always check the meat itself; sales numbers cannot tell you
          if it is safe to sell.
        </p>
        <AlertList alerts={expiry} view={view} empty="No batches near their use-by date." />
      </section>
      <section className="rounded-xl bg-white p-3 shadow-sm" data-testid="movement-alerts">
        <h2 className="text-lg font-bold text-burgundy-800">Stock and demand</h2>
        <AlertList alerts={movement} view={view} empty="Nothing needs attention." />
      </section>
      <section className="rounded-xl bg-white p-3 shadow-sm lg:col-span-2" data-testid="order-estimates">
        <h2 className="text-lg font-bold text-burgundy-800">Suggested order quantities (estimate)</h2>
        <p className="text-xs text-charcoal-500">
          Sales per day × ({settings.inventoryRules.leadTimeDays} day lead time + days to cover +{" "}
          {settings.inventoryRules.safetyDays} safety day), minus stock on hand. Shortened when past batches show a
          short shelf life. Nothing is ordered automatically.
        </p>
        {view.orders.length === 0 ? (
          <p className="mt-2 text-sm text-charcoal-500">No suggestions yet. They appear once products have sales.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-charcoal-500">
              <tr>
                <th className="py-1">Product</th>
                <th>Selling</th>
                <th>In stock</th>
                <th>Covers</th>
                <th className="text-right">Order about</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {view.orders.map((o) => {
                const p = view.productById.get(o.productId)!;
                const m = view.metricById.get(o.productId)!;
                return (
                  <tr key={o.productId}>
                    <td className="py-1 font-semibold">{p.name}</td>
                    <td>{formatVelocity(p.saleUnit, m.velocity)}</td>
                    <td>{formatQuantity(p.saleUnit, p.stockQty)}</td>
                    <td>{o.coverDays} days</td>
                    <td className="text-right font-bold">{formatQuantity(p.saleUnit, o.qty)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function AlertList({ alerts, view, empty }: { alerts: InventoryAlert[]; view: InventoryView; empty: string }) {
  if (alerts.length === 0) return <p className="mt-2 text-sm text-charcoal-500">{empty}</p>;
  const order = { high: 0, medium: 1, info: 2 };
  return (
    <ul className="mt-2 divide-y divide-cream-200 text-sm">
      {[...alerts]
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map((a) => {
          const p = view.productById.get(a.productId)!;
          const m = view.metricById.get(a.productId);
          const b = a.batchId ? view.batches.get(a.productId)?.find((x) => x.id === a.batchId) : undefined;
          return (
            <li key={`${a.kind}-${a.productId}-${a.batchId ?? ""}`} className="flex flex-wrap items-center gap-2 py-2">
              <Badge tone={a.severity === "high" ? "danger" : a.severity === "medium" ? "warn" : "info"}>
                {ALERT_TEXT[a.kind]}
              </Badge>
              <span className="font-semibold">{p.name}</span>
              <span className="text-charcoal-500">{detail(a, view, m, b)}</span>
            </li>
          );
        })}
    </ul>
  );
}

function detail(
  a: InventoryAlert,
  view: InventoryView,
  m: ProductMetrics | undefined,
  b: BatchEstimate | undefined,
): string {
  const p = view.productById.get(a.productId)!;
  const stock = formatQuantity(p.saleUnit, p.stockQty);
  switch (a.kind) {
    case "low_stock":
      return `${stock} left (low at ${formatQuantity(p.saleUnit, p.minStockQty)})`;
    case "stockout_soon":
    case "excess_stock":
      return `${stock}, lasts about ${formatDays(m?.coverageDays ?? null)}`;
    case "no_sales":
      return m?.lastSaleDate ? `last sale ${m.lastSaleDate}, ${stock} in stock` : `never sold, ${stock} in stock`;
    case "wastage_up":
      return `wastage ${formatPct(m?.wastagePct ?? null)} of received this period`;
    case "demand_down":
    case "demand_up":
      return `${formatPct(m?.trendPct ?? null)} vs the previous 4 weeks`;
    case "use_by":
    case "batch_at_risk": {
      if (!b || b.daysLeft === null) return "";
      const when =
        b.daysLeft < 0
          ? `use-by passed ${-b.daysLeft} day(s) ago`
          : b.daysLeft === 0
            ? "use by today"
            : `use by ${b.useBy}`;
      return `${b.batchCode ? `batch ${b.batchCode}, ` : ""}about ${formatQuantity(p.saleUnit, b.remaining)} left, ${when}`;
    }
  }
}
