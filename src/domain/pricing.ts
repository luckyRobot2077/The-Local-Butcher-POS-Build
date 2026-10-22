import { type Centavos, assertCentavos, divRoundHalfUp } from "./money";
import { type SaleUnit, isValidQuantity } from "./quantity";
import type { CartLine } from "./cart";

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

/**
 * Grams that a peso amount buys ("₱100 worth"), to the nearest gram, so the
 * cashier knows how much to cut. Null when it comes to less than 1 g or
 * more than the line limit.
 */
export function gramsForAmount(unitPricePerKg: Centavos, amount: Centavos): number | null {
  if (!Number.isSafeInteger(amount) || amount <= 0 || unitPricePerKg <= 0) return null;
  const g = Math.round((amount * 1000) / unitPricePerKg);
  return isValidQuantity("kg", g) ? g : null;
}

/** A cart line's amount before discounts: the peso amount asked for, or price × quantity. */
export function cartLineGross(line: Pick<CartLine, "saleUnit" | "unitPrice" | "qty" | "fixedAmount">): Centavos {
  if (line.fixedAmount !== undefined) {
    assertCentavos(line.fixedAmount, "line amount");
    if (!isValidQuantity(line.saleUnit, line.qty)) throw new RangeError(`invalid quantity ${line.qty}`);
    return line.fixedAmount;
  }
  return lineGross(line.saleUnit, line.unitPrice, line.qty);
}
