/**
 * Quantities are integers in the product's base unit:
 *  - "kg" products: grams (1 kg = 1000 g)
 *  - "piece" products: whole pieces
 */
export type SaleUnit = "kg" | "piece";

/** 1,000 kg in grams, or 1,000 pieces: a sanity limit for one cart line. */
export const MAX_LINE_GRAMS = 1_000_000;
export const MAX_LINE_PIECES = 1_000;

export function isValidQuantity(unit: SaleUnit, qty: number): boolean {
  if (!Number.isSafeInteger(qty) || qty <= 0) return false;
  return unit === "kg" ? qty <= MAX_LINE_GRAMS : qty <= MAX_LINE_PIECES;
}

/** 1250 g -> "1.250 kg", 3 pieces -> "3 pc". */
export function formatQuantity(unit: SaleUnit, qty: number): string {
  if (unit === "piece") return `${qty} pc${qty === 1 ? "" : "s"}`;
  const sign = qty < 0 ? "-" : "";
  const abs = Math.abs(qty);
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")} kg`;
}

/** Label for a price, e.g. "/kg" or "/pc". */
export function unitLabel(unit: SaleUnit): string {
  return unit === "kg" ? "/kg" : "/pc";
}

/**
 * Parse weight typed by the cashier.
 * mode "kg": "1.25" -> 1250 g (max 3 decimals); mode "g": "1250" -> 1250 g.
 */
export function parseWeight(input: string, mode: "kg" | "g"): number | null {
  const s = input.trim().replace(/,/g, "");
  if (mode === "g") {
    if (!/^\d+$/.test(s)) return null;
    const g = Number(s);
    return isValidQuantity("kg", g) ? g : null;
  }
  if (!/^\d+(\.\d{0,3})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const g = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
  return isValidQuantity("kg", g) ? g : null;
}

export function parsePieces(input: string): number | null {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return isValidQuantity("piece", n) ? n : null;
}
