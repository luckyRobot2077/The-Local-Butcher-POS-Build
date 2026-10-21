import { type Centavos } from "./money";
import { type SaleUnit } from "./quantity";
import { lineGross } from "./pricing";
import {
  type DiscountInput,
  DiscountError,
  allocateProportionally,
  discountAmount,
  effectiveBasisPoints,
} from "./discount";

export interface AppliedDiscountInput {
  input: DiscountInput;
  /** "manual" for now; promotions arrive in Phase 4. */
  source: "manual";
  reason?: string;
}

export interface CartLine {
  lineId: string;
  productId: string;
  productName: string;
  saleUnit: SaleUnit;
  /** Price per kg or per piece at the moment the item was added. */
  unitPrice: Centavos;
  /** Cost per kg or per piece, snapshot for profit reporting. */
  unitCost: Centavos;
  /** Grams for kg products, pieces for piece products. */
  qty: number;
  discount?: AppliedDiscountInput;
}

export interface Cart {
  lines: CartLine[];
  orderDiscount?: AppliedDiscountInput;
}

export interface StackingPolicy {
  /**
   * When false (default) an order-level discount only applies to lines that
   * do not already carry their own item discount, preventing accidental
   * double discounts. When true it applies to every line's net amount.
   */
  allowItemAndOrderStacking: boolean;
}

export const DEFAULT_STACKING: StackingPolicy = { allowItemAndOrderStacking: false };

export interface PricedLine extends CartLine {
  gross: Centavos;
  itemDiscount: Centavos;
  orderDiscountShare: Centavos;
  net: Centavos;
}

export interface CartTotals {
  lines: PricedLine[];
  subtotal: Centavos;
  itemDiscountTotal: Centavos;
  orderDiscountEligible: Centavos;
  orderDiscount: Centavos;
  discountTotal: Centavos;
  total: Centavos;
  /** Largest single discount as basis points of what it applied to. */
  maxDiscountBasisPoints: number;
}

export function emptyCart(): Cart {
  return { lines: [] };
}

export function priceCart(cart: Cart, policy: StackingPolicy = DEFAULT_STACKING): CartTotals {
  let maxBp = 0;
  const step1 = cart.lines.map((line) => {
    const gross = lineGross(line.saleUnit, line.unitPrice, line.qty);
    const itemDiscount = line.discount ? discountAmount(line.discount.input, gross) : 0;
    if (line.discount) maxBp = Math.max(maxBp, effectiveBasisPoints(itemDiscount, gross));
    return { line, gross, itemDiscount, afterItem: gross - itemDiscount };
  });

  const eligibleMask = step1.map((s) => policy.allowItemAndOrderStacking || !s.line.discount);
  const eligibleAmounts = step1.map((s, i) => (eligibleMask[i] ? s.afterItem : 0));
  const orderDiscountEligible = eligibleAmounts.reduce((a, b) => a + b, 0);

  let orderDiscount = 0;
  if (cart.orderDiscount) {
    if (orderDiscountEligible === 0 && cart.lines.length > 0) {
      throw new DiscountError("No items are eligible for an order discount.");
    }
    orderDiscount = discountAmount(cart.orderDiscount.input, orderDiscountEligible);
    maxBp = Math.max(maxBp, effectiveBasisPoints(orderDiscount, orderDiscountEligible));
  }
  const shares = allocateProportionally(orderDiscount, eligibleAmounts);

  const lines: PricedLine[] = step1.map((s, i) => ({
    ...s.line,
    gross: s.gross,
    itemDiscount: s.itemDiscount,
    orderDiscountShare: shares[i] ?? 0,
    net: s.afterItem - (shares[i] ?? 0),
  }));

  const subtotal = lines.reduce((a, l) => a + l.gross, 0);
  const itemDiscountTotal = lines.reduce((a, l) => a + l.itemDiscount, 0);
  const discountTotal = itemDiscountTotal + orderDiscount;
  const total = subtotal - discountTotal;
  if (total < 0) throw new DiscountError("Total cannot be negative.");
  return {
    lines,
    subtotal,
    itemDiscountTotal,
    orderDiscountEligible,
    orderDiscount,
    discountTotal,
    total,
    maxDiscountBasisPoints: maxBp,
  };
}

/* ---------- Pure cart operations (return a new cart) ---------- */

export function addLine(cart: Cart, line: CartLine): Cart {
  // Piece items with no discount merge into one line; weighed items stay
  // separate because each weighing is its own pack.
  if (line.saleUnit === "piece" && !line.discount) {
    const idx = cart.lines.findIndex(
      (l) => l.productId === line.productId && l.saleUnit === "piece" && !l.discount && l.unitPrice === line.unitPrice,
    );
    if (idx >= 0) {
      const lines = [...cart.lines];
      lines[idx] = { ...lines[idx], qty: lines[idx].qty + line.qty };
      return { ...cart, lines };
    }
  }
  return { ...cart, lines: [...cart.lines, line] };
}

export function updateLine(cart: Cart, lineId: string, patch: Partial<Pick<CartLine, "qty" | "discount">>): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.lineId === lineId ? { ...l, ...patch } : l)),
  };
}

export function removeLine(cart: Cart, lineId: string): Cart {
  const lines = cart.lines.filter((l) => l.lineId !== lineId);
  return { ...cart, lines, orderDiscount: lines.length ? cart.orderDiscount : undefined };
}

export function setOrderDiscount(cart: Cart, discount: AppliedDiscountInput | undefined): Cart {
  return { ...cart, orderDiscount: discount };
}
