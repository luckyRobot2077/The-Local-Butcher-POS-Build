"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "@/lib/db/db";
import { listCategories } from "@/lib/db/products";
import { loadSampleCatalog } from "@/lib/db/seed";
import type { Product } from "@/lib/db/types";
import { formatPeso } from "@/domain/money";
import { formatQuantity, unitLabel } from "@/domain/quantity";
import {
  addLine,
  emptyCart,
  priceCart,
  removeLine,
  setOrderDiscount,
  updateLine,
  type Cart,
  type CartTotals,
} from "@/domain/cart";
import { describeDiscount } from "@/domain/discount";
import { Button, ErrorText, Modal } from "@/components/ui";
import { usePos } from "./pos-context";
import { ProductTile } from "./product-tile";
import { QuantityDialog } from "./quantity-dialog";
import { DiscountDialog } from "./discount-dialog";
import { CheckoutDialog } from "./checkout-dialog";
import { ReceiptView } from "./receipt-view";
import { useRequestSync } from "./cloud-sync";

const CART_KEY = "tlb-open-cart";

function loadCart(): Cart {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? (JSON.parse(raw) as Cart) : emptyCart();
  } catch {
    return emptyCart();
  }
}

type Dialog =
  | { type: "add"; product: Product }
  | { type: "edit"; lineId: string }
  | { type: "itemDiscount"; lineId: string }
  | { type: "orderDiscount" }
  | { type: "checkout" }
  | { type: "void" }
  | { type: "done"; saleId: string }
  | null;

export function SellScreen() {
  const { settings, cashierName, requestManager } = usePos();
  const requestSync = useRequestSync();
  const products = useLiveQuery(() => getDb().products.toArray(), []);
  const categories = useLiveQuery(() => listCategories(), []);
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  // Restores an unfinished cart if the app was closed mid-sale. This screen
  // only renders in the browser (after the local database opens).
  const [cart, setCart] = useState<Cart>(loadCart);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [discountApprovedBy, setDiscountApprovedBy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* storage unavailable: the cart just won't survive a reload */
    }
  }, [cart]);

  const policy = { allowItemAndOrderStacking: settings.allowItemAndOrderStacking };
  let totals: CartTotals | null = null;
  let cartError: string | undefined;
  try {
    totals = priceCart(cart, policy);
  } catch (e) {
    cartError = e instanceof Error ? e.message : String(e);
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => p.active)
      .filter((p) => category === "all" || p.categoryId === category)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku?.toLowerCase() === q || p.barcode === q)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, category, search]);

  const productById = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const lineCount = cart.lines.length;

  async function approveIfNeeded(next: Cart): Promise<boolean> {
    const t = priceCart(next, policy);
    if (t.maxDiscountBasisPoints <= settings.cashierDiscountLimitBp) return true;
    const ok = await requestManager(
      `This discount is above the cashier limit of ${settings.cashierDiscountLimitBp / 100}%. Manager approval is required.`,
    );
    if (ok) setDiscountApprovedBy("manager-pin");
    return ok;
  }

  async function startCheckout() {
    if (!totals) return;
    if (totals.maxDiscountBasisPoints > settings.cashierDiscountLimitBp && !(await approveIfNeeded(cart))) return;
    setDialog({ type: "checkout" });
  }

  function resetSale() {
    setCart(emptyCart());
    setDiscountApprovedBy(undefined);
    setCartOpen(false);
  }

  if (products && products.length === 0) {
    return <EmptyCatalog />;
  }

  const editingLine = dialog && "lineId" in dialog ? cart.lines.find((l) => l.lineId === dialog.lineId) : undefined;
  const pricedEditing = editingLine && totals?.lines.find((l) => l.lineId === editingLine.lineId);

  return (
    <div className="flex min-h-0 flex-1">
      {/* Catalog */}
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Products">
        <div className="grid gap-2 border-b border-cream-200 bg-cream-50 p-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product, SKU or barcode"
            aria-label="Search products"
            className="min-h-11 w-full rounded-xl border border-cream-300 bg-white px-3"
          />
          <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Categories">
            {[{ id: "all", name: "All" }, ...(categories ?? [])].map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={category === c.id}
                onClick={() => setCategory(c.id)}
                className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-semibold ${
                  category === c.id
                    ? "bg-burgundy-700 text-cream-50"
                    : "bg-white text-charcoal-700 border border-cream-300"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 pb-24 md:pb-2">
          {visible.length === 0 ? (
            <p className="p-6 text-center text-charcoal-500">No products match.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {visible.map((p) => (
                <ProductTile key={p.id} product={p} onSelect={() => setDialog({ type: "add", product: p })} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Cart: side panel on tablets, bottom sheet on phones */}
      <aside
        className={`${
          cartOpen ? "fixed inset-0 z-30 flex" : "hidden"
        } flex-col bg-cream-50 md:static md:z-auto md:flex md:w-[22rem] md:border-l md:border-cream-300 lg:w-[26rem]`}
        aria-label="Current sale"
      >
        <div className="flex items-center justify-between border-b border-cream-200 px-3 py-2">
          <h2 className="font-bold text-burgundy-800">Current sale</h2>
          <div className="flex gap-1">
            {lineCount > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setDialog({ type: "void" })}>
                Clear
              </Button>
            )}
            <Button variant="ghost" size="sm" className="md:hidden" onClick={() => setCartOpen(false)}>
              Close
            </Button>
          </div>
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-cream-200 overflow-y-auto" data-testid="cart-lines">
          {lineCount === 0 && <li className="p-6 text-center text-charcoal-500">Tap a product to add it.</li>}
          {totals?.lines.map((l) => (
            <li key={l.lineId} className="px-3 py-2">
              <button
                type="button"
                className="w-full text-left"
                onClick={() => setDialog({ type: "edit", lineId: l.lineId })}
              >
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">{l.productName}</span>
                  <span className={`font-bold ${l.itemDiscount ? "text-charcoal-500 line-through" : ""}`}>
                    {formatPeso(l.gross)}
                  </span>
                </div>
                <div className="flex justify-between gap-2 text-sm text-charcoal-500">
                  <span>
                    {formatQuantity(l.saleUnit, l.qty)} × {formatPeso(l.unitPrice)}
                    {unitLabel(l.saleUnit)}
                  </span>
                  {l.itemDiscount > 0 && (
                    <span className="font-bold text-charcoal-900">{formatPeso(l.gross - l.itemDiscount)}</span>
                  )}
                </div>
              </button>
              <div className="mt-1 flex items-center gap-2">
                {l.discount ? (
                  <button
                    type="button"
                    className="text-xs font-semibold text-emerald-800 underline"
                    onClick={() => setDialog({ type: "itemDiscount", lineId: l.lineId })}
                  >
                    {describeDiscount(l.discount.input) === "fixed"
                      ? `${formatPeso(l.itemDiscount)} off`
                      : describeDiscount(l.discount.input)}{" "}
                    · {l.discount.reason}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-xs font-semibold text-burgundy-700 underline"
                    onClick={() => setDialog({ type: "itemDiscount", lineId: l.lineId })}
                  >
                    + Item discount
                  </button>
                )}
                {(productById.get(l.productId)?.stockQty ?? 0) - l.qty < 0 && (
                  <span className="text-xs font-semibold text-amber-800">More than recorded stock</span>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="grid gap-2 border-t border-cream-300 bg-white p-3">
          <ErrorText>{cartError || error}</ErrorText>
          {totals && (
            <dl className="grid gap-1 text-sm">
              <div className="flex justify-between">
                <dt>Subtotal</dt>
                <dd>{formatPeso(totals.subtotal)}</dd>
              </div>
              {totals.itemDiscountTotal > 0 && (
                <div className="flex justify-between text-emerald-800">
                  <dt>Item discounts</dt>
                  <dd>-{formatPeso(totals.itemDiscountTotal)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between text-emerald-800">
                <dt>
                  <button
                    type="button"
                    disabled={lineCount === 0}
                    className="font-semibold text-burgundy-700 underline disabled:text-charcoal-500 disabled:no-underline"
                    onClick={() => setDialog({ type: "orderDiscount" })}
                  >
                    {cart.orderDiscount ? `Order discount (${cart.orderDiscount.reason})` : "+ Order discount"}
                  </button>
                </dt>
                {totals.orderDiscount > 0 && <dd>-{formatPeso(totals.orderDiscount)}</dd>}
              </div>
              <div className="flex justify-between pt-1 text-2xl font-bold text-burgundy-800">
                <dt>Total</dt>
                <dd data-testid="cart-total">{formatPeso(totals.total)}</dd>
              </div>
            </dl>
          )}
          <Button
            size="lg"
            variant="success"
            disabled={!totals || lineCount === 0}
            onClick={startCheckout}
            data-testid="checkout"
          >
            Checkout
          </Button>
        </div>
      </aside>

      {/* Phone cart bar */}
      {!cartOpen && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-cream-300 bg-white p-2 md:hidden">
          <Button size="lg" className="w-full" onClick={() => setCartOpen(true)} data-testid="open-cart">
            View sale · {lineCount} item{lineCount === 1 ? "" : "s"} · {totals ? formatPeso(totals.total) : "—"}
          </Button>
        </div>
      )}

      {dialog?.type === "add" && (
        <QuantityDialog
          title={dialog.product.name}
          saleUnit={dialog.product.saleUnit}
          unitPrice={dialog.product.price}
          confirmLabel="Add to sale"
          onClose={() => setDialog(null)}
          onConfirm={(qty) => {
            const p = dialog.product;
            setCart((c) =>
              addLine(c, {
                lineId: crypto.randomUUID(),
                productId: p.id,
                productName: p.name,
                saleUnit: p.saleUnit,
                unitPrice: p.price,
                unitCost: p.cost,
                qty,
              }),
            );
            setDialog(null);
          }}
        />
      )}
      {dialog?.type === "edit" && editingLine && (
        <QuantityDialog
          title={editingLine.productName}
          saleUnit={editingLine.saleUnit}
          unitPrice={editingLine.unitPrice}
          initialQty={editingLine.qty}
          confirmLabel="Update"
          onClose={() => setDialog(null)}
          onRemove={() => {
            setCart((c) => removeLine(c, editingLine.lineId));
            setDialog(null);
          }}
          onConfirm={(qty) => {
            const next = updateLine(cart, editingLine.lineId, { qty });
            try {
              priceCart(next, policy);
              setCart(next);
              setError(undefined);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
            setDialog(null);
          }}
        />
      )}
      {dialog?.type === "itemDiscount" && editingLine && pricedEditing && (
        <DiscountDialog
          title={`Discount: ${editingLine.productName}`}
          eligibleAmount={pricedEditing.gross}
          initial={editingLine.discount}
          onClose={() => setDialog(null)}
          onRemove={
            editingLine.discount
              ? () => {
                  setCart((c) => updateLine(c, editingLine.lineId, { discount: undefined }));
                  setDialog(null);
                }
              : undefined
          }
          onApply={async (input, reason) => {
            const next = updateLine(cart, editingLine.lineId, {
              discount: { input, reason: reason.trim(), source: "manual" },
            });
            try {
              if (!(await approveIfNeeded(next))) return;
              setCart(next);
              setError(undefined);
              setDialog(null);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setDialog(null);
            }
          }}
        />
      )}
      {dialog?.type === "orderDiscount" && totals && (
        <DiscountDialog
          title="Order discount"
          eligibleAmount={priceCart(setOrderDiscount(cart, undefined), policy).orderDiscountEligible}
          initial={cart.orderDiscount}
          onClose={() => setDialog(null)}
          onRemove={
            cart.orderDiscount
              ? () => {
                  setCart((c) => setOrderDiscount(c, undefined));
                  setDialog(null);
                }
              : undefined
          }
          onApply={async (input, reason) => {
            const next = setOrderDiscount(cart, { input, reason: reason.trim(), source: "manual" });
            try {
              if (!(await approveIfNeeded(next))) return;
              setCart(next);
              setError(undefined);
              setDialog(null);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setDialog(null);
            }
          }}
        />
      )}
      {dialog?.type === "checkout" && totals && (
        <CheckoutDialog
          totals={totals}
          cashierName={cashierName}
          orderDiscountDetail={cart.orderDiscount}
          discountApprovedBy={
            totals.maxDiscountBasisPoints > settings.cashierDiscountLimitBp ? discountApprovedBy : undefined
          }
          onClose={() => setDialog(null)}
          onCompleted={(saleId) => {
            resetSale();
            requestSync();
            setDialog({ type: "done", saleId });
          }}
        />
      )}
      {dialog?.type === "void" && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title="Clear this sale?"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDialog(null)}>
                Keep
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  resetSale();
                  setDialog(null);
                }}
              >
                Clear sale
              </Button>
            </div>
          }
        >
          <p>All items in the current, unpaid sale will be removed. Nothing has been charged or saved yet.</p>
        </Modal>
      )}
      {dialog?.type === "done" && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title="Sale saved"
          footer={
            <Button size="lg" className="w-full" onClick={() => setDialog(null)} data-testid="new-sale">
              New sale
            </Button>
          }
        >
          <p
            className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900"
            data-testid="sale-saved"
          >
            Saved on this device. It will sync to the cloud once cloud sync is set up.
          </p>
          <ReceiptView saleId={dialog.saleId} />
        </Modal>
      )}
    </div>
  );
}

function EmptyCatalog() {
  const { cashierName } = usePos();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="mx-auto grid max-w-lg gap-4 p-6 text-center">
      <h2 className="text-xl font-bold text-burgundy-800">No products yet</h2>
      <p className="text-charcoal-700">
        Add your products in the Products tab, or load the sample catalog to try the POS. Sample prices come from your
        break-even workbook and must be replaced with real prices before selling.
      </p>
      <ErrorText>{error}</ErrorText>
      <div className="grid gap-2 sm:grid-cols-2">
        <Link
          href="/pos/products"
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-burgundy-700 px-4 font-semibold text-cream-50"
        >
          Add products
        </Link>
        <Button
          variant="secondary"
          disabled={busy}
          data-testid="load-samples"
          onClick={async () => {
            setBusy(true);
            try {
              await loadSampleCatalog(cashierName || "setup");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Load sample products
        </Button>
      </div>
    </div>
  );
}
