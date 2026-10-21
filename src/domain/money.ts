/**
 * Money is always an integer number of centavos (1 PHP = 100 centavos).
 * Never store or compare pesos as floating point numbers.
 */
export type Centavos = number;

/** Largest amount we accept anywhere in the app: ₱10,000,000.00. */
export const MAX_CENTAVOS = 1_000_000_000;

export function assertCentavos(value: number, label = "amount"): asserts value is Centavos {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a whole number of centavos, got ${value}`);
  }
  if (value < 0 || value > MAX_CENTAVOS) {
    throw new RangeError(`${label} is out of range: ${value}`);
  }
}

/**
 * Integer division of a non-negative numerator, rounding half up
 * (0.5 centavo and above rounds up). This is the single rounding rule
 * used for every money calculation in the system.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("divRoundHalfUp needs safe integers and a positive denominator");
  }
  if (numerator < 0) throw new RangeError("divRoundHalfUp numerator must not be negative");
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

const pesoFormatter = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 36050 -> "₱360.50". Negative values render as "-₱360.50". */
export function formatPeso(centavos: Centavos, withSymbol = true): string {
  const sign = centavos < 0 ? "-" : "";
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100);
  const cents = abs % 100;
  // Format the integer part with grouping, then append cents exactly (no float math).
  const whole = pesoFormatter.format(pesos).split(".")[0];
  return `${sign}${withSymbol ? "₱" : ""}${whole}.${String(cents).padStart(2, "0")}`;
}

/**
 * Parse user input such as "360", "360.5", "1,250.75", "₱ 99.90" into centavos.
 * Returns null when the input is not a valid non-negative peso amount
 * with at most two decimal places.
 */
export function parsePeso(input: string): Centavos | null {
  const cleaned = input.replace(/[₱,\s]/g, "").replace(/^PHP/i, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const value = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(value) || value > MAX_CENTAVOS) return null;
  return value;
}

/** Centavos to a plain input string, e.g. 36050 -> "360.50". */
export function centavosToInput(centavos: Centavos): string {
  return formatPeso(centavos, false).replace(/,/g, "");
}
