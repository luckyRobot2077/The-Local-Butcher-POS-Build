import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVENTORY_RULES as RULES,
  addDays,
  averageCost,
  buildAlerts,
  computeMetrics,
  dailySeries,
  estimateBatches,
  estimateOrder,
  typicalShelfLife,
  type LedgerEntry,
  type ProductRef,
} from "@/domain/inventory";

/** Noon in Manila on a business date. */
const at = (d: string) => `${d}T04:00:00Z`;
const TODAY = "2026-10-30";

function product(id: string, extra: Partial<ProductRef> = {}): ProductRef {
  return { id, name: id, categoryId: "pork", saleUnit: "kg", stockQty: 0, minStockQty: 0, active: true, ...extra };
}

/** Receives `stock` on the first day, then sells `perDay` every day for `days` days ending today. */
function steadySeller(id: string, perDay: number, days: number, stock: number): LedgerEntry[] {
  const first = addDays(TODAY, -(days - 1));
  const out: LedgerEntry[] = [{ productId: id, type: "purchase", qtyDelta: stock, at: `${first}T00:30:00Z` }];
  for (let i = 0; i < days; i++)
    out.push({ productId: id, type: "sale", qtyDelta: -perDay, at: at(addDays(first, i)) });
  return out;
}

describe("dates", () => {
  it("adds days across months and counts between dates", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("daily series and sales velocity", () => {
  it("leaves out days the product was out of stock", () => {
    // 10 kg received on day 1, 2 kg sold on each of days 1–5, then out of stock for 5 days.
    const first = addDays(TODAY, -9);
    const ledger: LedgerEntry[] = [{ productId: "p", type: "purchase", qtyDelta: 10_000, at: `${first}T00:30:00Z` }];
    for (let i = 0; i < 5; i++)
      ledger.push({ productId: "p", type: "sale", qtyDelta: -2000, at: at(addDays(first, i)) });
    const rows = dailySeries(ledger, first, TODAY);
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => r.available)).toHaveLength(5);
    expect(rows[4].closing).toBe(0);

    const [m] = computeMetrics({
      products: [product("p")],
      ledger,
      saleLines: [],
      asOf: TODAY,
      rules: { ...RULES, periodDays: 10 },
    });
    expect(m.velocity).toBe(2000); // 10 kg / 5 available days, not / 10 days
    expect(m.availableDays).toBe(5);
    expect(m.sellThroughPct).toBe(100);
    expect(m.coverageDays).toBe(0);
    expect(m.daysSinceLastSale).toBe(5);
  });

  it("nets customer returns and measures coverage, sell-through and wastage", () => {
    const ledger = steadySeller("p", 1000, 10, 20_000);
    ledger.push({ productId: "p", type: "return", qtyDelta: 500, at: at(TODAY) });
    ledger.push({ productId: "p", type: "spoilage", qtyDelta: -1000, at: at(TODAY) });
    const [m] = computeMetrics({
      products: [product("p", { stockQty: 9500 })],
      ledger,
      saleLines: [
        { productId: "p", at: at(TODAY), qty: 1000, net: 35_000, cost: 29_000 },
        { productId: "p", at: at(addDays(TODAY, -40)), qty: 1000, net: 99_999, cost: 1 }, // outside the period
      ],
      asOf: TODAY,
      rules: RULES,
    });
    expect(m.netSold).toBe(9500);
    expect(m.velocity).toBe(950);
    expect(m.coverageDays).toBeCloseTo(10);
    expect(m.sellThroughPct).toBeCloseTo(47.5); // 9.5 kg of 20 kg
    expect(m.wastagePct).toBe(5); // 1 kg of 20 kg received
    expect(m.revenue).toBe(35_000);
    expect(m.grossProfit).toBe(6000);
  });

  it("reports the demand trend against the previous four weeks", () => {
    const ledger: LedgerEntry[] = [{ productId: "p", type: "purchase", qtyDelta: 1_000_000, at: at("2026-09-01") }];
    for (let i = 34; i >= 0; i--) {
      ledger.push({ productId: "p", type: "sale", qtyDelta: i < 7 ? -2000 : -1000, at: at(addDays(TODAY, -i)) });
    }
    const [m] = computeMetrics({
      products: [product("p", { stockQty: 1 })],
      ledger,
      saleLines: [],
      asOf: TODAY,
      rules: RULES,
    });
    expect(m.trendPct).toBeCloseTo(100);
  });
});

describe("movement classification", () => {
  it("ranks only among comparable products and needs enough history", () => {
    const ledger = [
      ...steadySeller("a", 4000, 30, 1_000_000),
      ...steadySeller("b", 3000, 30, 1_000_000),
      ...steadySeller("c", 2000, 30, 1_000_000),
      ...steadySeller("d", 1000, 30, 1_000_000),
      // Same category but sold by the piece: not compared with the kg products.
      ...steadySeller("chicken", 1, 30, 1000),
      // Only 5 days of history.
      ...steadySeller("new", 5000, 5, 1_000_000),
    ];
    // In stock for 10 days with no sale.
    ledger.push({ productId: "idle", type: "purchase", qtyDelta: 5000, at: at(addDays(TODAY, -9)) });
    const products = [
      product("a", { stockQty: 100_000 }),
      product("b", { stockQty: 100_000 }),
      product("c", { stockQty: 100_000 }),
      product("d", { stockQty: 100_000 }),
      product("chicken", { saleUnit: "piece", stockQty: 10 }),
      product("new", { stockQty: 100_000 }),
      product("idle", { stockQty: 5000 }),
    ];
    const ms = computeMetrics({ products, ledger, saleLines: [], asOf: TODAY, rules: RULES });
    const cls = Object.fromEntries(ms.map((m) => [m.productId, m.movementClass]));
    expect(cls).toEqual({
      a: "fast",
      b: "normal",
      c: "normal",
      d: "slow",
      chicken: "unranked",
      new: "new",
      idle: "non_moving",
    });
  });

  it("does not call a product non-moving for days it was out of stock", () => {
    // Sold out 20 days ago and nothing since: no available days without a sale.
    const ledger: LedgerEntry[] = [
      { productId: "p", type: "purchase", qtyDelta: 1000, at: `${addDays(TODAY, -21)}T00:30:00Z` },
      { productId: "p", type: "sale", qtyDelta: -1000, at: at(addDays(TODAY, -20)) },
    ];
    const [m] = computeMetrics({ products: [product("p")], ledger, saleLines: [], asOf: TODAY, rules: RULES });
    expect(m.nonMoving).toBe(false);
  });
});

describe("batches", () => {
  const batches = [
    { id: "old", productId: "p", receivedAt: at("2026-10-26"), useBy: "2026-10-31", initialQty: 5000 },
    { id: "new", productId: "p", receivedAt: at("2026-10-29"), useBy: "2026-11-04", initialQty: 5000 },
  ];

  it("assumes the earliest use-by stock sells first", () => {
    const est = estimateBatches({ batches, stock: 7000, wasteByBatch: new Map(), velocity: 1000, today: TODAY });
    expect(est.map((b) => [b.id, b.remaining])).toEqual([
      ["old", 2000],
      ["new", 5000],
    ]);
    expect(est[0].daysLeft).toBe(1);
    expect(est[0].atRisk).toBe(false); // 2 days of sales, use-by tomorrow (end of day)
  });

  it("takes waste recorded against a batch out of that batch", () => {
    const est = estimateBatches({
      batches,
      stock: 7000,
      wasteByBatch: new Map([["new", 1000]]),
      velocity: 1000,
      today: TODAY,
    });
    expect(est.map((b) => b.remaining)).toEqual([3000, 4000]);
    expect(est[0].atRisk).toBe(true); // 3 days to sell, 1 day left
  });

  it("raises expiry alerts separately from movement alerts", () => {
    const products = [product("p", { stockQty: 7000, minStockQty: 8000 })];
    const est = estimateBatches({ batches, stock: 7000, wasteByBatch: new Map(), velocity: 0, today: TODAY });
    const metrics = computeMetrics({ products, ledger: [], saleLines: [], asOf: TODAY, rules: RULES });
    const alerts = buildAlerts({ products, metrics, batches: new Map([["p", est]]), rules: RULES });
    expect(alerts.movement.map((a) => a.kind)).toEqual(["low_stock"]);
    expect(alerts.expiry.map((a) => [a.kind, a.batchId])).toEqual([
      ["use_by", "old"],
      ["batch_at_risk", "new"],
    ]);
  });

  it("finds the typical shelf life", () => {
    expect(typicalShelfLife(batches)).toBe(5);
    expect(typicalShelfLife([])).toBeNull();
  });
});

describe("order estimates and cost", () => {
  it("covers lead time, cover days and safety stock, minus stock on hand", () => {
    const [m] = computeMetrics({
      products: [product("p", { stockQty: 2000 })],
      ledger: steadySeller("p", 1000, 20, 22_000),
      saleLines: [],
      asOf: TODAY,
      rules: RULES,
    });
    // 1 kg/day × (1 + 3 + 1) days − 2 kg = 3 kg
    expect(estimateOrder({ metric: m, rules: RULES })).toEqual({ productId: "p", qty: 3000, coverDays: 3 });
    // A 2-day shelf life shortens the cover to 1 day: 1 × (1 + 1 + 1) − 2 = 1 kg
    expect(estimateOrder({ metric: m, rules: RULES, shelfLifeDays: 2 })?.qty).toBe(1000);
  });

  it("averages cost over stock on hand and the new delivery", () => {
    expect(averageCost(10_000, 29_000, 10_000, 31_000)).toBe(30_000);
    expect(averageCost(-500, 29_000, 1000, 31_000)).toBe(31_000); // negative stock counts as none
    expect(averageCost(0, 0, 0, 12_345)).toBe(12_345);
  });
});
