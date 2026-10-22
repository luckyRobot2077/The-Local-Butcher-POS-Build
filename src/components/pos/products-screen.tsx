"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "@/lib/db/db";
import { isLowStock, listCategories, updatePrices } from "@/lib/db/products";
import { addStarterPictures, productsMissingArt } from "@/lib/db/product-art";
import type { Product } from "@/lib/db/types";
import { centavosToInput, formatPeso, parsePeso } from "@/domain/money";
import { formatQuantity, unitLabel } from "@/domain/quantity";
import { businessDate, formatManila } from "@/domain/time";
import { estimateBatches, WASTE_TYPES } from "@/domain/inventory";
import { Badge, Button, ErrorText, Modal } from "@/components/ui";
import { NumberInput } from "@/components/keypad";
import { usePos } from "./pos-context";
import { ProductImage, StockBadge } from "./product-tile";
import { ProductEditor } from "./product-editor";
import { StockDialog } from "./stock-dialog";

type Open =
  | { type: "view"; id: string }
  | { type: "edit"; id?: string; mode: "full" | "limited" }
  | { type: "stock"; id: string }
  | null;

export function ProductsScreen() {
  const { cashierName, managerUnlocked, requestManager, settings } = usePos();
  const products = useLiveQuery(() => getDb().products.toArray(), []);
  const categories = useLiveQuery(() => listCategories(), []);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [picturesBusy, setPicturesBusy] = useState(false);
  const [picturesNote, setPicturesNote] = useState<string>();
  const [open, setOpen] = useState<Open>(null);
  const catName = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c.name])), [categories]);
  const by = managerUnlocked ? `${cashierName || "unknown"} (manager PIN)` : cashierName || "unknown";

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!categoryFilter || p.categoryId === categoryFilter))
      .sort(
        (a, b) =>
          (catName.get(a.categoryId) ?? "").localeCompare(catName.get(b.categoryId) ?? "") ||
          a.name.localeCompare(b.name),
      );
  }, [products, search, categoryFilter, catName]);

  const summary = useMemo(() => {
    const active = (products ?? []).filter((p) => p.active);
    const priced = active.filter((p) => p.price > 0);
    const margin = priced.length ? priced.reduce((a, p) => a + (p.price - p.cost) / p.price, 0) / priced.length : null;
    return {
      count: active.length,
      low: active.filter(isLowStock).length,
      margin,
      missingArt: productsMissingArt(products ?? []).length,
    };
  }, [products]);

  async function addPictures() {
    if (!(await requestManager("Adding product pictures needs manager approval."))) return;
    setPicturesBusy(true);
    setPicturesNote(undefined);
    try {
      const n = await addStarterPictures(by);
      setPicturesNote(`Added ${n} starter ${n === 1 ? "picture" : "pictures"}. Replace any with a real photo later.`);
    } catch (e) {
      setPicturesNote(e instanceof Error ? e.message : String(e));
    } finally {
      setPicturesBusy(false);
    }
  }

  const current = open && "id" in open && open.id ? products?.find((p) => p.id === open.id) : undefined;

  async function edit(id: string | undefined) {
    if (
      await requestManager(
        id ? "Editing product details and prices needs manager approval." : "Adding products needs manager approval.",
      )
    ) {
      setOpen({ type: "edit", id, mode: "full" });
    }
  }

  async function editPhoto(id: string) {
    if (settings.cashierCanEditPhotos && !managerUnlocked) return setOpen({ type: "edit", id, mode: "limited" });
    return edit(id);
  }

  async function adjust(id: string) {
    if (await requestManager("Stock adjustments need manager approval.")) setOpen({ type: "stock", id });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-cream-200 bg-cream-50 p-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products"
          aria-label="Search products"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-cream-300 bg-white px-3"
        />
        <Button onClick={() => edit(undefined)} data-testid="add-product">
          + Add product
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-cream-200 bg-cream-50 px-3 py-2 text-sm">
        <div className="flex gap-1 overflow-x-auto" role="group" aria-label="Filter by category">
          {[{ id: "", name: "All" }, ...(categories ?? [])].map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategoryFilter(c.id)}
              aria-pressed={categoryFilter === c.id}
              className={`min-h-9 shrink-0 rounded-full px-3 font-semibold ${
                categoryFilter === c.id
                  ? "bg-burgundy-700 text-cream-50"
                  : "border border-cream-300 bg-white text-charcoal-700"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
        {summary.missingArt > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={addPictures}
            disabled={picturesBusy}
            data-testid="add-pictures"
          >
            {picturesBusy ? "Adding pictures…" : `Add starter pictures (${summary.missingArt})`}
          </Button>
        )}
        {picturesNote && <span className="text-charcoal-700">{picturesNote}</span>}
        <p className="ml-auto text-charcoal-500" data-testid="product-summary">
          {summary.count} active · {summary.low} low on stock
          {summary.margin !== null && ` · average margin ${Math.round(summary.margin * 100)}%`}
        </p>
      </div>
      <div className="hidden grid-cols-[3.5rem_1fr_8rem_8rem_6rem] gap-3 border-b border-cream-200 bg-white px-3 py-1 text-xs font-semibold text-charcoal-500 md:grid">
        <span />
        <span>Product</span>
        <span>Selling price</span>
        <span>Cost</span>
        <span className="text-right">Margin</span>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-cream-200 overflow-y-auto bg-white">
        {list.map((p) => (
          <ProductRow
            key={p.id}
            product={p}
            category={catName.get(p.categoryId) ?? ""}
            by={by}
            onOpen={() => setOpen({ type: "view", id: p.id })}
            managerUnlocked={managerUnlocked}
            requestManager={() => requestManager("Changing prices needs manager approval.")}
          />
        ))}
        {products && list.length === 0 && <li className="p-6 text-center text-charcoal-500">No products.</li>}
      </ul>

      {open?.type === "view" && current && (
        <ProductDetails
          product={current}
          category={catName.get(current.categoryId) ?? ""}
          onClose={() => setOpen(null)}
          onEdit={() => edit(current.id)}
          onEditPhoto={() => editPhoto(current.id)}
          onAdjust={() => adjust(current.id)}
        />
      )}
      {open?.type === "edit" && (open.id === undefined || current) && (
        <ProductEditor
          product={current}
          mode={open.mode}
          by={by}
          onClose={() => setOpen(current ? { type: "view", id: current.id } : null)}
        />
      )}
      {open?.type === "stock" && current && (
        <StockDialog product={current} by={by} onClose={() => setOpen({ type: "view", id: current.id })} />
      )}
    </div>
  );
}

/** Margin on the selling price: under 10% is flagged, under 20% is a warning. */
function marginTone(pct: number) {
  return pct < 10 ? "text-red-700" : pct < 20 ? "text-amber-800" : "text-emerald-800";
}

/**
 * One product on the list, with its selling price and cost editable in
 * place. Changing them needs the manager PIN; the change goes to the price
 * history like any other price change.
 */
function ProductRow({
  product: p,
  category,
  by,
  onOpen,
  managerUnlocked,
  requestManager,
}: {
  product: Product;
  category: string;
  by: string;
  onOpen: () => void;
  managerUnlocked: boolean;
  requestManager: () => Promise<boolean>;
}) {
  const [price, setPrice] = useState(centavosToInput(p.price));
  const [cost, setCost] = useState(centavosToInput(p.cost));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [shown, setShown] = useState({ price: p.price, cost: p.cost });
  // Show the stored values again when they change elsewhere (sync, another screen).
  if (shown.price !== p.price || shown.cost !== p.cost) {
    setShown({ price: p.price, cost: p.cost });
    setPrice(centavosToInput(p.price));
    setCost(centavosToInput(p.cost));
  }

  const priceC = parsePeso(price);
  const costC = parsePeso(cost);
  const dirty = priceC !== p.price || costC !== p.cost;
  const marginBase = priceC ?? p.price;
  const marginPct = marginBase > 0 ? ((marginBase - (costC ?? p.cost)) / marginBase) * 100 : null;

  // Read-only until the manager PIN is given; tapping a price asks for it.
  async function unlock(e: React.FocusEvent<HTMLInputElement>) {
    if (managerUnlocked) return;
    const input = e.currentTarget;
    if (await requestManager()) {
      input.focus();
      input.select();
    }
  }

  function reset() {
    setPrice(centavosToInput(p.price));
    setCost(centavosToInput(p.cost));
    setReason("");
    setError(undefined);
  }

  async function save() {
    if (priceC === null) return setError("Enter a valid selling price.");
    if (costC === null) return setError("Enter a valid cost (0 if unknown).");
    setSaving(true);
    setError(undefined);
    try {
      await updatePrices(p, { price: priceC, cost: costC }, by, reason);
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const money = (label: string, value: string, set: (v: string) => void, testId: string) => (
    <label className="grid gap-0.5">
      <span className="text-xs text-charcoal-500 md:sr-only">{label}</span>
      <span className="flex min-h-10 items-center rounded-lg border border-cream-300 bg-cream-50 px-2 focus-within:border-burgundy-600 focus-within:bg-white">
        <span className="text-charcoal-500">₱</span>
        <NumberInput
          floating
          wrapperClassName="min-w-0 flex-1"
          className="w-full min-w-0 bg-transparent px-1 py-1 text-right font-semibold outline-none"
          value={value}
          readOnly={!managerUnlocked}
          aria-label={`${label} of ${p.name}`}
          onFocus={unlock}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") reset();
          }}
          data-testid={testId}
        />
        <span className="text-xs text-charcoal-500">{unitLabel(p.saleUnit)}</span>
      </span>
    </label>
  );

  return (
    <li className="px-3 py-2" data-testid="product-row" data-product={p.name}>
      <div className="grid grid-cols-[3.5rem_1fr] items-center gap-x-3 gap-y-2 md:grid-cols-[3.5rem_1fr_8rem_8rem_6rem]">
        <button type="button" onClick={onOpen} aria-label={`Open ${p.name}`} className="row-span-2 md:row-span-1">
          <ProductImage imageId={p.imageId} name={p.name} className="size-14 rounded-lg" />
        </button>
        <button type="button" onClick={onOpen} className="min-w-0 text-left" data-testid="product-open">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{p.name}</span>
            {!p.active && <Badge tone="neutral">Inactive</Badge>}
            {p.isSample && <Badge tone="info">Sample</Badge>}
          </div>
          <div className="text-sm text-charcoal-500">
            {category} · {formatQuantity(p.saleUnit, p.stockQty)} in stock
          </div>
          <StockBadge product={p} />
        </button>
        <div className="col-start-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2 md:contents">
          {money("Selling price", price, setPrice, "row-price")}
          {money("Cost", cost, setCost, "row-cost")}
          <div className="text-right text-sm" data-testid="row-margin">
            {marginPct !== null ? (
              <>
                <div className={`font-bold ${marginTone(marginPct)}`}>{Math.round(marginPct)}%</div>
                <div className="text-xs text-charcoal-500">
                  {formatPeso((priceC ?? p.price) - (costC ?? p.cost))}
                  {unitLabel(p.saleUnit)}
                </div>
              </>
            ) : (
              <span className="text-charcoal-500">—</span>
            )}
          </div>
        </div>
      </div>
      {dirty && (
        <div className="mt-2 flex flex-wrap items-center gap-2 md:ml-[4.25rem]">
          <input
            className="min-h-10 min-w-0 flex-1 rounded-lg border border-cream-300 bg-white px-2 text-sm"
            placeholder="Reason (optional), e.g. supplier price increase"
            value={reason}
            maxLength={120}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
            data-testid="row-reason"
          />
          <Button size="sm" variant="secondary" onClick={reset}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving} data-testid="row-save">
            {saving ? "Saving…" : "Save prices"}
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </li>
  );
}

function ProductDetails({
  product,
  category,
  onClose,
  onEdit,
  onEditPhoto,
  onAdjust,
}: {
  product: Product;
  category: string;
  onClose: () => void;
  onEdit: () => void;
  onEditPhoto: () => void;
  onAdjust: () => void;
}) {
  const history = useLiveQuery(async () => {
    const all = (await getDb().inventoryMovements.where("productId").equals(product.id).sortBy("at")).reverse();
    const waste = new Map<string, number>();
    for (const m of all)
      if (m.batchId && WASTE_TYPES.includes(m.type)) waste.set(m.batchId, (waste.get(m.batchId) ?? 0) - m.qtyDelta);
    const batches = estimateBatches({
      batches: await getDb().batches.where("productId").equals(product.id).toArray(),
      stock: product.stockQty,
      wasteByBatch: waste,
      velocity: 0,
      today: businessDate(new Date()),
    }).filter((b) => b.remaining > 0);
    return {
      moves: all.slice(0, 20),
      lastRestock: all.find((m) => m.type === "purchase" || m.type === "delivery")?.at,
      batches,
      prices: (await getDb().priceChanges.where("productId").equals(product.id).sortBy("at")).reverse().slice(0, 10),
    };
  }, [product.id, product.stockQty]);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={product.name}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onAdjust}>
            Adjust stock
          </Button>
          <Button variant="secondary" onClick={onEditPhoto} data-testid="edit-photo">
            Photo &amp; description
          </Button>
          <Button onClick={onEdit} data-testid="edit-product">
            Edit product
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <ProductImage imageId={product.imageId} name={product.name} className="aspect-[4/3] w-full rounded-xl" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-charcoal-500">Category</dt>
          <dd>{category}</dd>
          <dt className="text-charcoal-500">Stock</dt>
          <dd>
            {formatQuantity(product.saleUnit, product.stockQty)} <StockBadge product={product} />
          </dd>
          <dt className="text-charcoal-500">Low at</dt>
          <dd>{formatQuantity(product.saleUnit, product.minStockQty)}</dd>
          <dt className="text-charcoal-500">Last restock</dt>
          <dd>{history?.lastRestock ? formatManila(history.lastRestock) : "—"}</dd>
          {product.sku && (
            <>
              <dt className="text-charcoal-500">SKU</dt>
              <dd>{product.sku}</dd>
            </>
          )}
          <dt className="text-charcoal-500">Updated</dt>
          <dd>
            {formatManila(product.updatedAt)} · v{product.version}
          </dd>
        </dl>
      </div>
      {product.description && <p className="mt-3 text-charcoal-700">{product.description}</p>}
      {!!history?.batches.length && (
        <>
          <h3 className="mt-4 font-bold text-burgundy-800">Batches on hand (estimate)</h3>
          <ul className="mt-1 divide-y divide-cream-200 text-sm" data-testid="batches-on-hand">
            {history.batches.map((b) => (
              <li key={b.id} className="flex justify-between gap-2 py-1">
                <span>
                  {b.batchCode ? `Batch ${b.batchCode}` : "No batch code"} · received {formatManila(b.receivedAt)}
                  {b.useBy ? ` · use by ${b.useBy}` : ""}
                </span>
                <span className={b.daysLeft !== null && b.daysLeft < 0 ? "font-semibold text-red-700" : ""}>
                  ~{formatQuantity(product.saleUnit, b.remaining)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-charcoal-500">Assumes the earliest use-by stock sells first.</p>
        </>
      )}
      <h3 className="mt-4 font-bold text-burgundy-800">Stock history</h3>
      <ul className="mt-1 divide-y divide-cream-200 text-sm">
        {history?.moves.map((m) => (
          <li key={m.id} className="flex justify-between gap-2 py-1">
            <span>
              {formatManila(m.at)} · {m.type.replace("_", " ")}
              {m.batchCode ? ` · batch ${m.batchCode}` : ""}
              {m.useBy ? ` · use by ${m.useBy}` : ""}
              {m.reason ? ` · ${m.reason}` : ""}
            </span>
            <span className={m.qtyDelta < 0 ? "text-red-700" : "text-emerald-800"}>
              {m.qtyDelta > 0 ? "+" : ""}
              {formatQuantity(product.saleUnit, m.qtyDelta)}
            </span>
          </li>
        ))}
      </ul>
      {!!history?.prices.length && (
        <>
          <h3 className="mt-4 font-bold text-burgundy-800">Price history</h3>
          <ul className="mt-1 divide-y divide-cream-200 text-sm">
            {history.prices.map((c) => (
              <li key={c.id} className="py-1">
                {formatManila(c.at)} · {c.field}: {formatPeso(c.oldValue)} → {formatPeso(c.newValue)} · {c.by}
                {c.reason ? ` · “${c.reason}”` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
