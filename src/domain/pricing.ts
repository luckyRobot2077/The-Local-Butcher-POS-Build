import { type Centavos, assertCentavos, divRoundHalfUp } from "./money";
import { type SaleUnit, isValidQuantity } from "./quantity";

/**
 * Gross amount of one line before discounts.
 *
 * Rounding rule (documented in docs/PRD.md): for per-kg items,
 *   gross = round_half_up(unitPrice_per_kg_centavos × grams / 1000)
 * i.e. the exact amount rounded to the nearest centavo, with exact half
 * centavos rounding up. Per-piece items are unitPrice × pieces (exact).
 */
export function lineGross(unit: SaleUnit, unitPrice: Centavos, qty: number): Centavos {
  assertCentavos(unitPrice, "unit price");
  if (!isValidQuantity(unit, qty)) throw new RangeError(`invalid quantity ${qty} for unit ${unit}`);
  const gross = unit === "kg" ? divRoundHalfUp(unitPrice * qty, 1000) : unitPrice * qty;
  assertCentavos(gross, "line amount");
  return gross;
}
