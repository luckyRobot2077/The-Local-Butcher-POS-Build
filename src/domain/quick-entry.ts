import { parsePeso } from "./money";
import { gramsForAmount } from "./pricing";
import { parsePieces, parseWeight, type SaleUnit } from "./quantity";

/** What the sell-screen numpad's number means: kilograms (or pieces), grams, or pesos. */
export type QuickMode = "kg" | "g" | "peso";

export type QuickResult = { ok: true; qty: number; fixedAmount?: number } | { ok: false; reason: string };

/**
 * Turns a number typed on the sell-screen numpad into a cart quantity for the
 * product tapped next. Per-piece products take a whole number in the kg/pcs
 * mode; grams and pesos apply only to per-kg products.
 */
export function quickEntryQty(
  product: { name: string; saleUnit: SaleUnit; price: number },
  mode: QuickMode,
  text: string,
): QuickResult {
  if (product.saleUnit === "piece") {
    if (mode !== "kg") return { ok: false, reason: `${product.name} is sold by the piece. Switch to kg / pcs.` };
    const qty = parsePieces(text);
    return qty ? { ok: true, qty } : { ok: false, reason: "Enter a whole number of pieces." };
  }
  if (mode === "peso") {
    const amount = parsePeso(text);
    const qty = amount ? gramsForAmount(product.price, amount) : null;
    return qty && amount ? { ok: true, qty, fixedAmount: amount } : { ok: false, reason: "Enter a valid peso amount." };
  }
  const qty = parseWeight(text, mode);
  return qty ? { ok: true, qty } : { ok: false, reason: "Enter a valid weight (up to 3 decimals in kg)." };
}
