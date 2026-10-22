/**
 * Back Office report shapes (as returned by the `office_report` database
 * function) and the pure helpers the dashboard uses: date ranges, trend
 * grouping and CSV files. Money is centavos; kg quantities are grams.
 */
import type { Centavos } from "./money";
import { formatManila } from "./time";

export interface DailyPoint {
  date: string;
  revenue: Centavos;
  cogs: Centavos;
  transactions: number;
  discounts: Centavos;
  expenses: Centavos;
}

export interface OfficeReport {
  from: string;
  to: string;
  days: number;
  totals: {
    revenue: Centavos;
    grossSales: Centavos;
    transactions: number;
    average: Centavos;
    discounts: Centavos;
    cogs: Centavos;
    grossProfit: Centavos;
    expenses: Centavos;
    netProfit: Centavos;
    refunds: Centavos;
  };
  daily: DailyPoint[];
  byCategory: { name: string; revenue: Centavos; cost: Centavos }[];
  products: {
    id: string;
    name: string;
    unit: "kg" | "piece";
    qty: number;
    revenue: Centavos;
    cost: Centavos;
    lines: number;
  }[];
  byPayment: { method: "cash" | "gcash"; revenue: Centavos; transactions: number }[];
  byCashier: { name: string; revenue: Centavos; transactions: number; discounts: Centavos }[];
  byHour: { hour: number; revenue: Centavos; transactions: number }[];
  byWeekday: { weekday: number; revenue: Centavos; transactions: number }[];
  discounts: { source: "manual" | "promotion"; name: string; amount: Centavos; uses: number }[];
  expenses: {
    byCategory: { category: ExpenseCategory; amount: Centavos }[];
    list: { id: string; category: ExpenseCategory; amount: Centavos; spentOn: string; note: string | null }[];
  };
  members: {
    total: number;
    newInRange: number;
    active: number;
    repeat: number;
    memberRevenue: Centavos;
    memberTransactions: number;
    promoOptIns: number;
    top: { name: string; memberNo: string | null; visits: number; spent: Centavos }[];
    byGender: { gender: string; members: number }[];
    byAge: { band: string; members: number }[];
  };
  inventory: {
    stockValue: Centavos;
    lowStock: { id: string; name: string; unit: "kg" | "piece"; qty: number; min: number; category: string }[];
    purchases: Centavos;
    losses: { type: "damage" | "spoilage" | "trim_loss"; value: Centavos; entries: number }[];
  };
  recent: {
    id: string;
    receiptNo: string;
    at: string;
    total: Centavos;
    cashier: string;
    method: "cash" | "gcash";
    member: boolean;
  }[];
}

export const EXPENSE_CATEGORIES = [
  "wages",
  "rent",
  "utilities",
  "packaging",
  "transportation",
  "repairs",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_LABEL: Record<ExpenseCategory, string> = {
  wages: "Wages",
  rent: "Rent",
  utilities: "Utilities (power, water)",
  packaging: "Packaging and supplies",
  transportation: "Transportation",
  repairs: "Repairs",
  other: "Other",
};

export const LOSS_LABEL = { damage: "Damaged", spoilage: "Spoiled", trim_loss: "Trim loss" } as const;
export const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type RangePreset = "today" | "7d" | "30d" | "month" | "lastMonth" | "year" | "all" | "custom";
export const RANGE_PRESETS: { id: RangePreset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "year", label: "1 year" },
  { id: "all", label: "All history" },
  { id: "custom", label: "Pick dates" },
];

/** Adds days to a YYYY-MM-DD date (calendar arithmetic, no time zones). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive business-date range for a preset; `from` null means from the first sale. */
export function presetRange(
  preset: Exclude<RangePreset, "custom">,
  today: string,
): { from: string | null; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastMonth": {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
    }
    case "year":
      return { from: addDays(today, -364), to: today };
    case "all":
      return { from: null, to: today };
  }
}

export type Grain = "day" | "week" | "month";

/** Daily points for up to two months, weekly up to ~13 months, monthly beyond. */
export function grainFor(days: number): Grain {
  return days <= 62 ? "day" : days <= 400 ? "week" : "month";
}

/** Monday of the week containing a YYYY-MM-DD date. */
function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

export interface TrendPoint {
  /** First date of the bucket. */
  key: string;
  revenue: Centavos;
  grossProfit: Centavos;
  transactions: number;
  expenses: Centavos;
}

/** Groups the daily series into the grain's buckets. */
export function bucketTrend(daily: DailyPoint[], grain: Grain): TrendPoint[] {
  const out = new Map<string, TrendPoint>();
  for (const d of daily) {
    const key = grain === "day" ? d.date : grain === "week" ? weekStart(d.date) : `${d.date.slice(0, 8)}01`;
    const b = out.get(key) ?? { key, revenue: 0, grossProfit: 0, transactions: 0, expenses: 0 };
    b.revenue += d.revenue;
    b.grossProfit += d.revenue - d.cogs;
    b.transactions += d.transactions;
    b.expenses += d.expenses;
    out.set(key, b);
  }
  return [...out.values()];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Short axis label for a bucket: "Oct 22", "Wk Oct 20", "Oct 2026". */
export function bucketLabel(key: string, grain: Grain): string {
  const m = MONTHS[Number(key.slice(5, 7)) - 1];
  const day = Number(key.slice(8, 10));
  if (grain === "month") return `${m} ${key.slice(0, 4)}`;
  return grain === "week" ? `Wk ${m} ${day}` : `${m} ${day}`;
}

/** Long date label: "Oct 22, 2026". */
export function formatDate(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;
}

/** Margin in percent (one decimal), or null when there is no revenue. */
export function marginPct(revenue: Centavos, cost: Centavos): number | null {
  return revenue > 0 ? Math.round(((revenue - cost) * 1000) / revenue) / 10 : null;
}

/** Quantity for display: grams as kg with up to 3 decimals, pieces as whole numbers. */
export function formatQty(unit: "kg" | "piece", qty: number): string {
  return unit === "kg" ? `${(qty / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : `${qty} pc`;
}

/** Centavos as a plain peso number for spreadsheets ("1234.50"). */
export function csvPeso(centavos: Centavos): string {
  return (centavos / 100).toFixed(2);
}

/** RFC 4180 CSV: every value quoted, CRLF line ends. Leading = + - @ are escaped so spreadsheets do not run them. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

export function summaryCsv(r: OfficeReport): string {
  const t = r.totals;
  return toCsv(
    [
      "From",
      "To",
      "Sales (PHP)",
      "Transactions",
      "Average sale (PHP)",
      "Discounts (PHP)",
      "Cost of goods (PHP)",
      "Gross profit (PHP)",
      "Expenses (PHP)",
      "Net operating profit (PHP)",
    ],
    [
      [
        r.from,
        r.to,
        csvPeso(t.revenue),
        t.transactions,
        csvPeso(t.average),
        csvPeso(t.discounts),
        csvPeso(t.cogs),
        csvPeso(t.grossProfit),
        csvPeso(t.expenses),
        csvPeso(t.netProfit),
      ],
    ],
  );
}

export function dailyCsv(r: OfficeReport): string {
  return toCsv(
    [
      "Date",
      "Sales (PHP)",
      "Transactions",
      "Discounts (PHP)",
      "Cost of goods (PHP)",
      "Gross profit (PHP)",
      "Expenses (PHP)",
    ],
    r.daily.map((d) => [
      d.date,
      csvPeso(d.revenue),
      d.transactions,
      csvPeso(d.discounts),
      csvPeso(d.cogs),
      csvPeso(d.revenue - d.cogs),
      csvPeso(d.expenses),
    ]),
  );
}

export function productsCsv(r: OfficeReport): string {
  return toCsv(
    [
      "Product",
      "Unit",
      "Quantity sold",
      "Sales (PHP)",
      "Cost of goods (PHP)",
      "Gross profit (PHP)",
      "Margin %",
      "Times sold",
    ],
    r.products.map((p) => [
      p.name,
      p.unit,
      p.unit === "kg" ? (p.qty / 1000).toFixed(3) : p.qty,
      csvPeso(p.revenue),
      csvPeso(p.cost),
      csvPeso(p.revenue - p.cost),
      marginPct(p.revenue, p.cost) ?? "",
      p.lines,
    ]),
  );
}

export function expensesCsv(r: OfficeReport): string {
  return toCsv(
    ["Date", "Category", "Amount (PHP)", "Note"],
    r.expenses.list.map((e) => [e.spentOn, EXPENSE_LABEL[e.category], csvPeso(e.amount), e.note ?? ""]),
  );
}

export interface SaleLineRow {
  business_date: string;
  created_at: string;
  receipt_no: string;
  cashier: string;
  payment_method: string;
  member_no: string | null;
  product: string;
  category: string;
  unit: "kg" | "piece";
  qty: number;
  unit_price: Centavos;
  gross: Centavos;
  discount: Centavos;
  net: Centavos;
  cost: Centavos;
  /** From migration 10 on: the line's own discount, its share of a whole-sale discount, and their names. */
  item_discount?: Centavos;
  order_discount_share?: Centavos;
  discount_names?: string | null;
  discount_approved_by?: string | null;
}

export function saleLinesCsv(rows: SaleLineRow[]): string {
  return toCsv(
    [
      "Date",
      "Time",
      "Receipt",
      "Cashier",
      "Payment",
      "Member no.",
      "Product",
      "Category",
      "Unit",
      "Quantity",
      "Unit price (PHP)",
      "Gross (PHP)",
      "Discount (PHP)",
      "Discount given",
      "Item discount (PHP)",
      "Share of whole-sale discount (PHP)",
      "Discount approved by",
      "Net (PHP)",
      "Cost (PHP)",
      "Profit (PHP)",
    ],
    rows.map((l) => [
      l.business_date,
      formatManila(l.created_at),
      l.receipt_no,
      l.cashier,
      l.payment_method,
      l.member_no ?? "",
      l.product,
      l.category,
      l.unit,
      l.unit === "kg" ? (l.qty / 1000).toFixed(3) : l.qty,
      csvPeso(l.unit_price),
      csvPeso(l.gross),
      csvPeso(l.discount),
      l.discount_names ?? "",
      l.item_discount == null ? "" : csvPeso(l.item_discount),
      l.order_discount_share == null ? "" : csvPeso(l.order_discount_share),
      l.discount_approved_by ?? "",
      csvPeso(l.net),
      csvPeso(l.cost),
      csvPeso(l.net - l.cost),
    ]),
  );
}
