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
import { quickEntryQty, type QuickMode } from "@/domain/quick-entry";
import { applyProgram, describeProgram, isProgramCurrent } from "@/domain/programs";
import { businessDate, formatManila } from "@/domain/time";
import { memberVisitSummary } from "@/lib/db/members";
import { listPrograms } from "@/lib/db/programs";
import { Button, ErrorText, Modal } from "@/components/ui";
import { useMediaQuery } from "@/lib/use-media-query";
import { usePos } from "./pos-context";
import { ProductTile } from "./product-tile";
import { QuantityDialog } from "./quantity-dialog";
import { QuickEntry } from "./quick-entry";
import { DiscountDialog } from "./discount-dialog";
import { CheckoutDialog } from "./checkout-dialog";
import { ReceiptView } from "./receipt-view";
import { useRequestSync } from "./cloud-sync";
import { MemberPicker } from "./members/member-picker";

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
  | { type: "member" }
  | null;

export function SellScreen() {
  const { settings, cashierName, requestManager } = usePos();
  const requestSync = useRequestSync();
  const products = useLiveQuery(() => getDb().products.toArray(), []);
  const categories = useLiveQuery(() => listCategories(), []);
  const programs = useLiveQuery(() => listPrograms(), []);
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  // Restores an unfinished cart if the app was closed mid-sale. This screen
  // only renders in the browser (after the local database opens).
  const [cart, setCart] = useState<Cart>(loadCart);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [discountApprovedBy, setDiscountApprovedBy] = useState<string>();
  const [error, setError] = useState<string>();
  const [quickText, setQuickText] = useState("");
  const [quickMode, setQuickMode] = useState<QuickMode>("kg");
  const [quickMessage, setQuickMessage] = useState<{ tone: "info" | "error"; text: string }>();
  const landscape = useMediaQuery("(min-width: 1024px)");

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* storage unavailable: the cart just won't survive a reload */
    }
  }, [cart]);

  const policy = { allowItemAndOrderStacking: settings.allowItemAndOrderStacking };
  const productById = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const today = businessDate(new Date());
  const offered = (programs ?? []).filter((p) => isProgramCurrent(p, today));
  const program = cart.programId ? programs?.find((p) => p.id === cart.programId) : undefined;
  // The program is applied each time the cart is priced, so it is re-checked whenever the sale changes.
  const programResult = program
    ? applyProgram(cart, program, {
        today,
        hasMember: !!cart.member,
        categoryOf: (id) => productById.get(id)?.categoryId,
        policy,
      })
    : undefined;
  const effective = programResult?.ok ? programResult.cart : cart;
  const programNote = programResult && !programResult.ok ? programResult.reason : undefined;
  const orderProgram = programResult?.ok && program?.scope === "order";

  let totals: CartTotals | null = null;
  let cartError: string | undefined;
  try {
    totals = priceCart(effective, policy);
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

  function addProduct(p: Product, qty: number, fixedAmount?: number) {
    setCart((c) =>
      addLine(c, {
        lineId: crypto.randomUUID(),
        productId: p.id,
        productName: p.name,
        saleUnit: p.saleUnit,
        unitPrice: p.price,
        unitCost: p.cost,
        qty,
        fixedAmount,
      }),
    );
  }

  /** A number on the sell-screen numpad adds the tapped product straight away; otherwise ask. */
  function selectProduct(p: Product) {
    if (!quickText) {
      setQuickMessage(undefined);
      return setDialog({ type: "add", product: p });
    }
    const r = quickEntryQty(p, quickMode, quickText);
    if (!r.ok) return setQuickMessage({ tone: "error", text: r.reason });
    addProduct(p, r.qty, r.fixedAmount);
    setQuickText("");
    setQuickMessage({
      tone: "info",
      text: `Added ${r.fixedAmount !== undefined ? `${formatPeso(r.fixedAmount)} of ` : `${formatQuantity(p.saleUnit, r.qty)} `}${p.name}`,
    });
  }

  function resetSale() {
    setCart(emptyCart());
    setDiscountApprovedBy(undefined);
    setCartOpen(false);
  }

  if (products && products.length === 0) {
    return <EmptyCatalog />;
  }

  const quickEntry = (
    <QuickEntry
      column={landscape}
      text={quickText}
      mode={quickMode}
      message={quickMessage}
      onText={(t) => {
        setQuickText(t);
        setQuickMessage(undefined);
      }}
      onMode={setQuickMode}
    />
  );

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
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
              {visible.map((p) => (
                <ProductTile key={p.id} product={p} onSelect={() => selectProduct(p)} />
              ))}
            </div>
          )}
        </div>
      </section>

      {landscape && quickEntry}

      {/* Cart: side panel on tablets, bottom sheet on phones */}
      <aside
        className={`${
          cartOpen ? "fixed inset-0 z-30 flex" : "hidden"
        } flex-col bg-cream-50 md:static md:z-auto md:flex md:w-[22rem] md:border-l md:border-cream-300 xl:w-[24rem]`}
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
                    {l.fixedAmount !== undefined && `${formatPeso(l.fixedAmount)} worth · about `}
                    {formatQuantity(l.saleUnit, l.qty)} × {formatPeso(l.unitPrice)}
                    {unitLabel(l.saleUnit)}
                  </span>
                  {l.itemDiscount > 0 && (
                    <span className="font-bold text-charcoal-900">{formatPeso(l.gross - l.itemDiscount)}</span>
                  )}
                </div>
              </button>
              <div className="mt-1 flex items-center gap-2">
                {l.discount?.source === "promotion" ? (
                  <span className="text-xs font-semibold text-emerald-800">
                    {describeDiscount(l.discount.input)} · {l.discount.reason}
                  </span>
                ) : l.discount ? (
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
        {!landscape && quickEntry}
        {/* minmax(0,1fr): a long program name in the dropdown must not widen the panel. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-cream-300 bg-white p-3">
          <div className="flex items-center justify-between gap-2 text-sm" data-testid="sale-member">
            {cart.member ? (
              <>
                <span>
                  <span className="font-semibold">Member:</span> {cart.member.name}{" "}
                  <span className="font-mono text-xs text-charcoal-500">{cart.member.memberNo}</span>
                  <MemberVisits memberId={cart.member.id} />
                </span>
                <button
                  type="button"
                  className="text-xs font-semibold text-red-700 underline"
                  onClick={() => setCart((c) => ({ ...c, member: undefined }))}
                >
                  Remove
                </button>
              </>
            ) : (
              <button
                type="button"
                className="font-semibold text-burgundy-700 underline"
                onClick={() => setDialog({ type: "member" })}
                data-testid="add-member"
              >
                + Member card
              </button>
            )}
          </div>
          {(offered.length > 0 || program) && (
            <label className="grid gap-1 text-sm">
              <span className="font-semibold text-charcoal-700">Discount program</span>
              <select
                className="min-h-10 w-full min-w-0 truncate rounded-lg border border-cream-300 bg-white px-2"
                value={cart.programId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || undefined;
                  const next = programs?.find((p) => p.id === id);
                  // An order program takes the place of a typed order discount.
                  setCart((c) => ({
                    ...c,
                    programId: id,
                    orderDiscount: next?.scope === "order" ? undefined : c.orderDiscount,
                  }));
                }}
                data-testid="program-select"
              >
                <option value="">None</option>
                {offered.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({describeProgram(p)})
                  </option>
                ))}
                {program && !offered.includes(program) && (
                  <option value={program.id}>{program.name} (not running)</option>
                )}
              </select>
              {programNote && (
                <span className="text-xs font-semibold text-amber-800" data-testid="program-note">
                  {programNote}
                </span>
              )}
            </label>
          )}
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
                  {orderProgram ? (
                    <span className="font-semibold">{program?.name}</span>
                  ) : (
                    <button
                      type="button"
                      disabled={lineCount === 0}
                      className="font-semibold text-burgundy-700 underline disabled:text-charcoal-500 disabled:no-underline"
                      onClick={() => setDialog({ type: "orderDiscount" })}
                    >
                      {cart.orderDiscount ? `Order discount (${cart.orderDiscount.reason})` : "+ Order discount"}
                    </button>
                  )}
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
          onConfirm={(qty, fixedAmount) => {
            addProduct(dialog.product, qty, fixedAmount);
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
          initialAmount={editingLine.fixedAmount}
          confirmLabel="Update"
          onClose={() => setDialog(null)}
          onRemove={() => {
            setCart((c) => removeLine(c, editingLine.lineId));
            setDialog(null);
          }}
          onConfirm={(qty, fixedAmount) => {
            const next = updateLine(cart, editingLine.lineId, { qty, fixedAmount });
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
          eligibleAmount={priceCart(setOrderDiscount(effective, undefined), policy).orderDiscountEligible}
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
          orderDiscountDetail={effective.orderDiscount}
          member={cart.member}
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
      {dialog?.type === "member" && (
        <MemberPicker
          onClose={() => setDialog(null)}
          onPick={(m) => {
            setCart((c) => ({ ...c, member: { id: m.id, memberNo: m.memberNo, name: m.name } }));
            setDialog(null);
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

/** "Visit #6 · last came Oct 20": this sale counts as the next visit. */
function MemberVisits({ memberId }: { memberId: string }) {
  const summary = useLiveQuery(() => memberVisitSummary(memberId), [memberId]);
  if (!summary) return null;
  return (
    <span className="block text-xs text-charcoal-700" data-testid="member-visits">
      {summary.visits === 0 ? (
        <span className="font-semibold text-navy-800">First visit</span>
      ) : (
        <>
          <span className="font-semibold text-navy-800">Visit #{summary.visits + 1}</span>
          {summary.lastAt && <> · last came {formatManila(summary.lastAt).split(",").slice(0, 2).join(",")}</>}
        </>
      )}
    </span>
  );
}
