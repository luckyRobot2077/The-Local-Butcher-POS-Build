import { type Centavos, assertCentavos, divRoundHalfUp } from "./money";

/**
 * A discount as entered or configured. Percentages are stored as basis
 * points (1% = 100 bp) so they stay integers: 12.5% = 1250 bp.
 */
export type DiscountInput = { kind: "percent"; basisPoints: number } | { kind: "fixed"; amount: Centavos };

export class DiscountError extends Error {}

export function validateDiscount(d: DiscountInput, eligibleAmount: Centavos): void {
  assertCentavos(eligibleAmount, "eligible amount");
  if (d.kind === "percent") {
    if (!Number.isSafeInteger(d.basisPoints) || d.basisPoints < 0 || d.basisPoints > 10_000) {
      throw new DiscountError("Percentage discount must be between 0% and 100%.");
    }
  } else {
    if (!Number.isSafeInteger(d.amount) || d.amount < 0) {
      throw new DiscountError("Fixed discount must be a positive amount.");
    }
    if (d.amount > eligibleAmount) {
      throw new DiscountError("Fixed discount cannot be more than the amount it applies to.");
    }
  }
}

/** Discount amount in centavos for an eligible amount. Never exceeds it. */
export function discountAmount(d: DiscountInput, eligibleAmount: Centavos): Centavos {
  validateDiscount(d, eligibleAmount);
  if (d.kind === "fixed") return d.amount;
  return Math.min(eligibleAmount, divRoundHalfUp(eligibleAmount * d.basisPoints, 10_000));
}

/**
 * Discount as a share of the amount, in basis points, used to compare
 * against the cashier's discount limit (rounded up so 10.01% > 10%).
 */
export function effectiveBasisPoints(discount: Centavos, eligibleAmount: Centavos): number {
  if (eligibleAmount <= 0) return discount > 0 ? 10_000 : 0;
  return Math.ceil((discount * 10_000) / eligibleAmount);
}

/**
 * Split an order-level discount across lines in proportion to their
 * amounts, using largest-remainder so the parts add up exactly.
 * Needed so every sale item keeps its own net amount for reporting,
 * refunds and profit calculations.
 */
export function allocateProportionally(total: Centavos, weights: Centavos[]): Centavos[] {
  assertCentavos(total, "allocation total");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (total > sum) throw new DiscountError("Cannot allocate more than the sum of the lines.");
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w, i) => ({ i, floor: Math.floor((total * w) / sum), rem: (total * w) % sum }));
  let left = total - raw.reduce((a, r) => a + r.floor, 0);
  const order = [...raw].sort((a, b) => b.rem - a.rem || a.i - b.i);
  const out = raw.map((r) => r.floor);
  for (const r of order) {
    if (left <= 0) break;
    out[r.i] += 1;
    left -= 1;
  }
  return out;
}

export function describeDiscount(d: DiscountInput): string {
  if (d.kind === "percent") {
    const whole = Math.floor(d.basisPoints / 100);
    const frac = d.basisPoints % 100;
    return `${whole}${frac ? "." + String(frac).padStart(2, "0").replace(/0$/, "") : ""}% off`;
  }
  return "fixed";
}

/** Parse a typed percentage, "12.5" -> 1250 basis points. Null if not 0–100 with up to 2 decimals. */
export function parsePercent(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  const bp = Number(w) * 100 + Number(f.padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}
