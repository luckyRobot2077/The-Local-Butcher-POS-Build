"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { ProductMetrics } from "@/domain/inventory";
import { formatPeso } from "@/domain/money";
import { formatQuantity } from "@/domain/quantity";
import { listCategories } from "@/lib/db/products";
import { Badge, Button } from "@/components/ui";
import { usePos } from "../pos-context";
import { CLASS_LABEL, CLASS_TONE, formatDays, formatPct, formatVelocity, useInventory } from "./use-inventory";

type SortKey = "velocity" | "coverage" | "sellThrough" | "profit" | "name";

export function MovementTab() {
  const { settings } = usePos();
  const [period, setPeriod] = useState<number>(settings.inventoryRules.periodDays);
  const rules = useMemo(() => ({ ...settings.inventoryRules, periodDays: period }), [settings.inventoryRules, period]);
  const view = useInventory(rules);
  const categories = useLiveQuery(() => listCategories(), []);
  const catName = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const [sort, setSort] = useState<SortKey>("velocity");

  const rows = useMemo(() => {
    const list = (view?.metrics ?? []).filter((m) => view?.productById.get(m.productId)?.active);
    const key: Record<SortKey, (m: ProductMetrics) => number | string> = {
      velocity: (m) => -m.velocity,
      coverage: (m) => m.coverageDays ?? Infinity,
      sellThrough: (m) => -(m.sellThroughPct ?? -1),
      profit: (m) => -m.grossProfit,
      name: (m) => m.name,
    };
    return [...list].sort((a, b) => {
      const x = key[sort](a);
      const y = key[sort](b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }, [view, sort]);

  if (!view) return <p className="text-charcoal-500">Loading…</p>;

  const totals = rows.reduce((a, m) => ({ revenue: a.revenue + m.revenue, cogs: a.cogs + m.cogs }), {
    revenue: 0,
    cogs: 0,
  });

  function exportCsv() {
    const header = [
      "Product",
      "Category",
      "Unit",
      "Class",
      "Stock",
      "Days available",
      "Net sold",
      "Sales per day",
      "Coverage days",
      "Sell-through %",
      "Days since last sale",
      "Demand trend %",
      "Received",
      "Wasted",
      "Wastage %",
      "Revenue (PHP)",
      "Cost of goods (PHP)",
      "Gross profit (PHP)",
    ];
    const qty = (unit: string, n: number) => (unit === "kg" ? (n / 1000).toFixed(3) : String(n));
    const lines = rows.map((m) =>
      [
        m.name,
        catName.get(m.categoryId) ?? "",
        m.saleUnit,
        CLASS_LABEL[m.movementClass],
        qty(m.saleUnit, m.stock),
        m.availableDays,
        qty(m.saleUnit, m.netSold),
        m.saleUnit === "kg" ? (m.velocity / 1000).toFixed(3) : m.velocity.toFixed(2),
        m.coverageDays?.toFixed(1) ?? "",
        m.sellThroughPct?.toFixed(1) ?? "",
        m.daysSinceLastSale ?? "",
        m.trendPct?.toFixed(1) ?? "",
        qty(m.saleUnit, m.received),
        qty(m.saleUnit, m.wasted),
        m.wastagePct?.toFixed(1) ?? "",
        (m.revenue / 100).toFixed(2),
        (m.cogs / 100).toFixed(2),
        (m.grossProfit / 100).toFixed(2),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `product-movement-${view!.today}-${period}d.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 30].map((d) => (
          <Button key={d} size="sm" variant={period === d ? "primary" : "secondary"} onClick={() => setPeriod(d)}>
            Last {d} days
          </Button>
        ))}
        <label className="ml-2 text-sm">
          Sort by{" "}
          <select
            className="min-h-9 rounded-lg border border-cream-300 bg-white px-2"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="velocity">Sales per day</option>
            <option value="coverage">Days of stock left</option>
            <option value="sellThrough">Sell-through</option>
            <option value="profit">Gross profit</option>
            <option value="name">Name</option>
          </select>
        </label>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={exportCsv}>
          Export CSV
        </Button>
      </div>
      <p className="text-xs text-charcoal-500">
        Sales per day counts only days the product was in stock, so running out does not make it look slow. Fast, normal
        and slow compare products in the same category and unit; groups with fewer than {rules.minGroupSize} products
        are not ranked. Revenue {formatPeso(totals.revenue)}, cost of goods {formatPeso(totals.cogs)}, gross profit{" "}
        {formatPeso(totals.revenue - totals.cogs)} for the period.
      </p>
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full min-w-[56rem] text-sm" data-testid="movement-table">
          <thead className="bg-cream-100 text-left text-charcoal-700">
            <tr>
              <th className="px-2 py-2">Product</th>
              <th>Class</th>
              <th>Sales per day</th>
              <th>Stock lasts</th>
              <th>Sell-through</th>
              <th>Last sale</th>
              <th>Trend</th>
              <th>Wastage</th>
              <th className="px-2 text-right">Gross profit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {rows.map((m) => (
              <tr key={m.productId}>
                <td className="px-2 py-2">
                  <span className="font-semibold">{m.name}</span>
                  <span className="block text-xs text-charcoal-500">
                    {catName.get(m.categoryId)} · {formatQuantity(m.saleUnit, m.stock)} in stock
                  </span>
                </td>
                <td>
                  <Badge tone={CLASS_TONE[m.movementClass]}>{CLASS_LABEL[m.movementClass]}</Badge>
                </td>
                <td>
                  {formatVelocity(m.saleUnit, m.velocity)}
                  <span className="block text-xs text-charcoal-500">{m.availableDays} days in stock</span>
                </td>
                <td>{formatDays(m.coverageDays)}</td>
                <td>{formatPct(m.sellThroughPct)}</td>
                <td>{m.daysSinceLastSale === null ? "never" : `${m.daysSinceLastSale} days ago`}</td>
                <td className={m.trendPct !== null && m.trendPct < 0 ? "text-red-700" : ""}>
                  {m.trendPct === null ? "—" : `${m.trendPct > 0 ? "+" : ""}${Math.round(m.trendPct)}%`}
                </td>
                <td>
                  {formatPct(m.wastagePct)}
                  {m.received > 0 && (
                    <span className="block text-xs text-charcoal-500">
                      {formatQuantity(m.saleUnit, m.wasted)} of {formatQuantity(m.saleUnit, m.received)} received
                    </span>
                  )}
                </td>
                <td className="px-2 text-right">
                  {formatPeso(m.grossProfit)}
                  <span className="block text-xs text-charcoal-500">on {formatPeso(m.revenue)} sales</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
