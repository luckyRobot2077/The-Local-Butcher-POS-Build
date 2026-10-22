import { type Centavos } from "./money";
import { type DiscountInput, describeDiscount } from "./discount";
import { type Cart, type StackingPolicy, DEFAULT_STACKING, priceCart } from "./cart";
import { lineGross } from "./pricing";
import { formatPeso } from "./money";

/**
 * A discount program set up by the owner or a manager (spec: promotions,
 * no membership tiers). At checkout the cashier only picks one from a
 * list; the program's own rules decide what it applies to, so no manager
 * PIN is needed when one is used.
 */
export interface DiscountProgram {
  id: string;
  name: string;
  description: string;
  input: DiscountInput;
  /**
   * "order": one discount on the whole sale (percent or fixed pesos).
   * "items": a percentage off each qualifying line.
   */
  scope: "order" | "items";
  /** For "items": qualifying products and categories. Both empty means every product. */
  productIds: string[];
  categoryIds: string[];
  /** Only when a member card is attached to the sale. */
  membersOnly: boolean;
  /** Smallest sale subtotal (before discounts) the program needs. 0 = none. */
  minPurchase: Centavos;
  /** First and last business day (YYYY-MM-DD, Manila), inclusive. */
  startsOn?: string;
  endsOn?: string;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
  remote?: boolean;
}

export class ProgramError extends Error {}

export function validateProgram(p: Pick<DiscountProgram, "name" | "input" | "scope" | "startsOn" | "endsOn">) {
  if (!p.name.trim()) throw new ProgramError("Give the program a name.");
  if (p.name.trim().length > 40) throw new ProgramError("Keep the name to 40 characters so it fits on receipts.");
  if (p.scope === "items" && p.input.kind !== "percent") {
    throw new ProgramError("Item programs must be a percentage. Use an order program for a fixed peso amount.");
  }
  if (p.input.kind === "percent" && (p.input.basisPoints <= 0 || p.input.basisPoints > 10_000)) {
    throw new ProgramError("The percentage must be more than 0% and at most 100%.");
  }
  if (p.input.kind === "fixed" && p.input.amount <= 0) throw new ProgramError("The amount must be more than zero.");
  if (p.startsOn && p.endsOn && p.endsOn < p.startsOn) throw new ProgramError("The end date is before the start date.");
}

/** Whether the program runs on this business day and is switched on. */
export function isProgramCurrent(p: DiscountProgram, today: string): boolean {
  return p.active && (!p.startsOn || p.startsOn <= today) && (!p.endsOn || p.endsOn >= today);
}

export interface ProgramContext {
  today: string;
  hasMember: boolean;
  /** Category of a product, for item programs limited to categories. */
  categoryOf: (productId: string) => string | undefined;
  policy?: StackingPolicy;
}

export type ProgramResult = { ok: true; cart: Cart } | { ok: false; reason: string };

function qualifies(p: DiscountProgram, productId: string, ctx: ProgramContext): boolean {
  if (p.productIds.length === 0 && p.categoryIds.length === 0) return true;
  if (p.productIds.includes(productId)) return true;
  const cat = ctx.categoryOf(productId);
  return !!cat && p.categoryIds.includes(cat);
}

/**
 * The cart with the program's discount applied, or the reason it cannot
 * be used on this sale. The stored cart is never changed: the program is
 * applied each time the cart is priced, so editing the sale re-checks it.
 *
 * - An order program takes the place of a typed order discount.
 * - An item program skips lines that already have a typed item discount.
 */
export function applyProgram(cart: Cart, p: DiscountProgram, ctx: ProgramContext): ProgramResult {
  if (!isProgramCurrent(p, ctx.today)) return { ok: false, reason: `${p.name} is not running today.` };
  if (p.membersOnly && !ctx.hasMember) return { ok: false, reason: `${p.name} is for members. Scan their card first.` };
  const subtotal = cart.lines.reduce((s, l) => s + lineGross(l.saleUnit, l.unitPrice, l.qty), 0);
  if (subtotal < p.minPurchase) {
    return { ok: false, reason: `${p.name} needs a purchase of at least ${formatPeso(p.minPurchase)}.` };
  }
  const applied = { input: p.input, source: "promotion" as const, promotionId: p.id, reason: p.name };

  if (p.scope === "order") {
    const next: Cart = { ...cart, orderDiscount: applied };
    const base = priceCart({ ...cart, orderDiscount: undefined }, ctx.policy ?? DEFAULT_STACKING);
    if (base.orderDiscountEligible === 0)
      return { ok: false, reason: "No items in this sale can take an order discount." };
    if (p.input.kind === "fixed" && p.input.amount > base.orderDiscountEligible) {
      return { ok: false, reason: `${p.name} is more than the items it would apply to.` };
    }
    return { ok: true, cart: next };
  }

  let matched = 0;
  const lines = cart.lines.map((l) => {
    if (l.discount || !qualifies(p, l.productId, ctx)) return l;
    matched++;
    return { ...l, discount: applied };
  });
  if (matched === 0) return { ok: false, reason: `No items in this sale qualify for ${p.name}.` };
  return { ok: true, cart: { ...cart, lines } };
}

/** One line for the program list, e.g. "10% off · members · min ₱500.00". */
export function describeProgram(p: DiscountProgram): string {
  const parts = [p.input.kind === "percent" ? describeDiscount(p.input) : `${formatPeso(p.input.amount)} off`];
  parts.push(
    p.scope === "order" ? "whole sale" : p.productIds.length || p.categoryIds.length ? "selected items" : "every item",
  );
  if (p.membersOnly) parts.push("members");
  if (p.minPurchase > 0) parts.push(`min ${formatPeso(p.minPurchase)}`);
  if (p.startsOn || p.endsOn) parts.push(`${p.startsOn ?? "…"} to ${p.endsOn ?? "…"}`);
  return parts.join(" · ");
}
