# Product requirements (summary)

The master specification ("THE LOCAL BUTCHER POS", v1.0) is the source of truth. This page records
the binding owner rules and the business rules as implemented.

## Binding owner rules

1. **No membership tiers.** Every registered customer is simply a member. No Silver/Gold/VIP.
   Loyalty points, if ever added, are optional and off by default.
2. **Product photos and descriptions are edited in POS mode**, not the Back Office.
3. Offline cash selling and transaction integrity come first.
4. Build in phases; never present placeholders as working features.
5. Receipts are non-fiscal until BIR requirements are verified.

## Users

| Role | Today (Phase 1, single device) | Later (Phase 2+) |
|---|---|---|
| Owner / Manager | Knows the device **manager PIN** | Supabase account with server-side role |
| Cashier | Enters their name on the device | Supabase account, cashier role |

## Business rules as implemented

### Money and quantities
- Money is stored as **integer centavos**. No floating-point money anywhere.
- Weighed products store quantity as **integer grams**; piece products as whole pieces.
- **Rounding rule:** a per-kg line is `round_half_up(price_per_kg_centavos × grams ÷ 1000)`: the exact
  amount rounded to the nearest centavo, with exactly half a centavo rounding up. Example:
  ₱310.75/kg × 0.457 kg = ₱142.01275 → ₱142.01. All other divisions (percent discounts, line cost)
  use the same rule. Code: `src/domain/money.ts` `divRoundHalfUp`.
- "Peso amount" entry charges exactly ₱X and shows the weight it buys (₱X ÷ price per kg, to the nearest
  gram) so the cashier knows how much to cut. The receipt marks that weight with "~".

### Discounts (Phase 1: manual only)
- Percent (0–100%, stored as basis points; 12.5% = 1250) or fixed amount (cannot exceed what it applies to).
- Item-level and order-level. The total can never go negative.
- **Stacking:** by default an order discount applies only to lines without their own discount
  (setting: *Allow order discount on items that already have a discount*).
- Order discounts are split across lines proportionally (largest remainder) so every sale item keeps
  an exact net amount for profit and refund calculations.
- Each discount needs a reason. A discount above the **cashier limit** (default 10%) needs the manager PIN;
  the sale records `discountApprovedBy`. Discounts are written to the audit log.

### Sales
- Every sale gets an immutable UUID (the sync idempotency key) and a receipt number
  `<device code>-<sequence>`, e.g. `PME5-000042`.
- A sale is written in **one IndexedDB transaction** with its items, payment, stock movements and
  sync outbox entry. If anything fails, nothing is saved and the cashier sees "Sale NOT saved".
- Sale items keep snapshots of product name, unit, price and cost. Editing a product never changes
  past sales.
- GCash is recorded manually with an optional reference number. It is not verified automatically.
- Completed sales are never deleted. Refunds will be reversing records (later phase).

### Stock
- Stock changes only through ledger movements (`inventoryMovements`); the product's stock number
  is a projection of the ledger and is checked against it in tests.
- Selling more than recorded stock is allowed (the count may be wrong) but warned in the cart.

### Receipts
- Rendered as plain text for a 32-character line (58 mm paper), independent of the printer
  transport. Header says **NON-FISCAL TEST RECEIPT / Not an official receipt/invoice**.
