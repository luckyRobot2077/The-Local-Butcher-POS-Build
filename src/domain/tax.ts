import { type Centavos, divRoundHalfUp } from "./money";

/**
 * Philippine sales taxes for a retail meat shop (NIRC as amended; see
 * docs/TAXES.md). Not tax advice: the owner confirms the setup with their
 * accountant.
 *
 * - "non_vat": the shop is not VAT-registered (gross sales up to ₱3M a
 *   year). Prices carry no VAT; the shop pays percentage tax (3%) on its
 *   gross quarterly sales, worked out in the Back Office.
 * - "vat": the shop is VAT-registered. Shelf prices include 12% VAT on
 *   VATable items; fresh meat and other food in its original state is
 *   VAT-exempt. Receipts and invoices split the two.
 */
export type TaxMode = "non_vat" | "vat";
export type TaxClass = "vatable" | "exempt";

export interface TaxSettings {
  mode: TaxMode;
  /** BIR Taxpayer Identification Number, e.g. 123-456-789-00000. */
  tin: string;
  /** Registered business name and address as on BIR Form 2303 (for invoices). */
  registeredName: string;
  registeredAddress: string;
  /** VAT rate in basis points (1200 = 12%). */
  vatRateBp: number;
  /** Percentage tax rate for non-VAT shops in basis points (300 = 3%). */
  percentageTaxBp: number;
  /** Category id → class. A category not listed is guessed from its name. */
  categories: Record<string, TaxClass>;
  /** Product id → class, overriding its category. */
  products: Record<string, TaxClass>;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  mode: "non_vat",
  tin: "",
  registeredName: "",
  registeredAddress: "",
  vatRateBp: 1200,
  percentageTaxBp: 300,
  categories: {},
  products: {},
};

export const TAX_MODE_LABEL: Record<TaxMode, string> = {
  non_vat: "Not VAT-registered (percentage tax)",
  vat: "VAT-registered",
};

export const TAX_CLASS_LABEL: Record<TaxClass, string> = { vatable: "VATable (12%)", exempt: "VAT-exempt" };

/** Fills missing fields of settings saved by an older version (or none at all). */
export function normalizeTaxSettings(raw: unknown): TaxSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<TaxSettings>;
  const classes = (v: unknown): Record<string, TaxClass> =>
    Object.fromEntries(
      Object.entries(v && typeof v === "object" ? v : {}).filter(([, c]) => c === "vatable" || c === "exempt"),
    ) as Record<string, TaxClass>;
  const bp = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5000 ? v : fallback;
  return {
    mode: r.mode === "vat" ? "vat" : "non_vat",
    tin: typeof r.tin === "string" ? r.tin : "",
    registeredName: typeof r.registeredName === "string" ? r.registeredName : "",
    registeredAddress: typeof r.registeredAddress === "string" ? r.registeredAddress : "",
    vatRateBp: bp(r.vatRateBp, DEFAULT_TAX_SETTINGS.vatRateBp),
    percentageTaxBp: bp(r.percentageTaxBp, DEFAULT_TAX_SETTINGS.percentageTaxBp),
    categories: classes(r.categories),
    products: classes(r.products),
    ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
    ...(r.updatedBy ? { updatedBy: r.updatedBy } : {}),
  };
}

/**
 * Starting guess for a category the owner has not set: condiments, sauces,
 * cooked food, drinks and supplies are VATable; meat, poultry, fish, eggs
 * and other fresh goods are exempt.
 */
export function guessCategoryClass(name: string): TaxClass {
  return /condiment|sauce|spice|season|marinat|side|dish|cook|ready|viand|ulam|drink|beverage|snack|process|sausage|longganisa|tocino|hotdog|suppl|merch|charcoal|bag|container/i.test(
    name,
  )
    ? "vatable"
    : "exempt";
}

export function categoryClass(s: TaxSettings, category: { id: string; name: string } | undefined): TaxClass {
  if (!category) return "vatable";
  return s.categories[category.id] ?? guessCategoryClass(category.name);
}

export function productClass(
  s: TaxSettings,
  product: { id: string; categoryId: string },
  category: { id: string; name: string } | undefined,
): TaxClass {
  return s.products[product.id] ?? categoryClass(s, category);
}

/** VAT contained in a VAT-inclusive amount: amount × rate / (1 + rate). */
export function vatInInclusive(amount: Centavos, rateBp: number): Centavos {
  return divRoundHalfUp(amount * rateBp, 10_000 + rateBp);
}

export function percentageTaxDue(grossSales: Centavos, rateBp: number): Centavos {
  return divRoundHalfUp(grossSales * rateBp, 10_000);
}

export interface TaxLineInput {
  /** What the customer pays for the line after discounts (VAT-inclusive). */
  net: Centavos;
  taxClass: TaxClass;
}

export interface TaxBreakdown {
  mode: TaxMode;
  rateBp: number;
  /** Per input line: its class and the VAT inside it (0 when exempt or non-VAT). */
  lines: { taxClass: TaxClass; vat: Centavos }[];
  /** VATable sales without the VAT. */
  vatableSales: Centavos;
  vatAmount: Centavos;
  vatExemptSales: Centavos;
  /** vatableSales + vatAmount + vatExemptSales = the sum of the line nets. */
  total: Centavos;
}

/**
 * Splits VAT-inclusive line amounts into VATable sales, VAT and VAT-exempt
 * sales. VAT is worked out once on the VATable total (as the BIR computes
 * it) and spread over the lines so the line amounts add up exactly.
 * Non-VAT shops get no VAT lines at all.
 */
export function computeTax(lines: TaxLineInput[], mode: TaxMode, rateBp: number): TaxBreakdown {
  const total = lines.reduce((s, l) => s + l.net, 0);
  if (mode !== "vat") {
    return {
      mode,
      rateBp,
      lines: lines.map((l) => ({ taxClass: l.taxClass, vat: 0 })),
      vatableSales: 0,
      vatAmount: 0,
      vatExemptSales: 0,
      total,
    };
  }
  const vatableGross = lines.filter((l) => l.taxClass === "vatable").reduce((s, l) => s + l.net, 0);
  const vatAmount = vatInInclusive(vatableGross, rateBp);
  // Largest remainder: each VATable line gets its share of the VAT, rounded down,
  // then the leftover centavos go to the lines that lost the most to rounding.
  const shares = lines.map((l, i) => {
    if (l.taxClass !== "vatable" || vatableGross === 0) return { i, vat: 0, rem: 0 };
    const exact = l.net * vatAmount;
    return { i, vat: Math.floor(exact / vatableGross), rem: exact % vatableGross };
  });
  let left = vatAmount - shares.reduce((s, x) => s + x.vat, 0);
  for (const x of shares.filter((x) => lines[x.i].taxClass === "vatable").sort((a, b) => b.rem - a.rem || a.i - b.i)) {
    if (left <= 0) break;
    x.vat++;
    left--;
  }
  return {
    mode,
    rateBp,
    lines: lines.map((l, i) => ({ taxClass: l.taxClass, vat: shares[i].vat })),
    vatableSales: vatableGross - vatAmount,
    vatAmount,
    vatExemptSales: total - vatableGross,
    total,
  };
}

/** "2026-10-24" → "2026-Q4". */
export function quarterOf(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

export function formatRateBp(bp: number): string {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
}

/* ------------------------------------------------------------------ Back Office report */

export interface TaxReportMonth {
  month: string; // YYYY-MM
  sales: number;
  gross: Centavos;
  non_vat_sales: Centavos;
  vatable_sales: Centavos;
  vat_amount: Centavos;
  vat_exempt_sales: Centavos;
}

export interface TaxReportCategory {
  category_id: string | null;
  name: string;
  gross: Centavos;
  vatable_gross: Centavos;
  vat: Centavos;
  exempt_gross: Centavos;
  non_vat_gross: Centavos;
}

export interface TaxReport {
  from: string;
  to: string;
  months: TaxReportMonth[];
  categories: TaxReportCategory[];
}

export interface TaxPeriod {
  period: string;
  sales: number;
  gross: Centavos;
  nonVatSales: Centavos;
  /** Percentage tax on the non-VAT sales of the period. */
  percentageTax: Centavos;
  vatableSales: Centavos;
  vatAmount: Centavos;
  vatExemptSales: Centavos;
}

function toPeriod(period: string, ms: TaxReportMonth[], percentageTaxBp: number): TaxPeriod {
  const sum = (f: (m: TaxReportMonth) => number) => ms.reduce((s, m) => s + Number(f(m)), 0);
  const nonVatSales = sum((m) => m.non_vat_sales);
  return {
    period,
    sales: sum((m) => m.sales),
    gross: sum((m) => m.gross),
    nonVatSales,
    percentageTax: percentageTaxDue(nonVatSales, percentageTaxBp),
    vatableSales: sum((m) => m.vatable_sales),
    vatAmount: sum((m) => m.vat_amount),
    vatExemptSales: sum((m) => m.vat_exempt_sales),
  };
}

/** Months as reported, plus quarters (percentage tax is filed quarterly, BIR Form 2551Q). */
export function taxPeriods(r: TaxReport, percentageTaxBp: number): { months: TaxPeriod[]; quarters: TaxPeriod[] } {
  const byQuarter = new Map<string, TaxReportMonth[]>();
  for (const m of r.months) {
    const q = quarterOf(`${m.month}-01`);
    byQuarter.set(q, [...(byQuarter.get(q) ?? []), m]);
  }
  return {
    months: r.months.map((m) => toPeriod(m.month, [m], percentageTaxBp)),
    quarters: [...byQuarter].map(([q, ms]) => toPeriod(q, ms, percentageTaxBp)),
  };
}

export type TaxRangePreset = "quarter" | "lastQuarter" | "year" | "lastYear" | "all";
export const TAX_RANGE_PRESETS: { id: TaxRangePreset; label: string }[] = [
  { id: "quarter", label: "This quarter" },
  { id: "lastQuarter", label: "Last quarter" },
  { id: "year", label: "This year" },
  { id: "lastYear", label: "Last year" },
  { id: "all", label: "All time" },
];

/** Whole calendar quarters and years, as the BIR files them; `from` null means from the first sale. */
export function taxRange(preset: TaxRangePreset, today: string): { from: string | null; to: string } {
  const y = Number(today.slice(0, 4));
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const quarter = (year: number, qi: number) => {
    const startMonth = qi * 3 + 1;
    const endMonth = startMonth + 2;
    const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    const mm = (m: number) => String(m).padStart(2, "0");
    return { from: `${year}-${mm(startMonth)}-01`, to: `${year}-${mm(endMonth)}-${endDay}` };
  };
  switch (preset) {
    case "quarter":
      return { from: quarter(y, q).from, to: today };
    case "lastQuarter":
      return q === 0 ? quarter(y - 1, 3) : quarter(y, q - 1);
    case "year":
      return { from: `${y}-01-01`, to: today };
    case "lastYear":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "all":
      return { from: null, to: today };
  }
}
