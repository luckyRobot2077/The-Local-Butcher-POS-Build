"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "@/lib/db/db";
import { listCategories } from "@/lib/db/products";
import type { Product } from "@/lib/db/types";
import { formatPeso } from "@/domain/money";
import { formatQuantity, unitLabel } from "@/domain/quantity";
import { formatManila } from "@/domain/time";
import { Badge, Button, Modal } from "@/components/ui";
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
  const [open, setOpen] = useState<Open>(null);
  const catName = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c.name])), [categories]);
  const by = managerUnlocked ? `${cashierName || "unknown"} (manager PIN)` : cashierName || "unknown";

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          (catName.get(a.categoryId) ?? "").localeCompare(catName.get(b.categoryId) ?? "") ||
          a.name.localeCompare(b.name),
      );
  }, [products, search, catName]);

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
      <ul className="min-h-0 flex-1 divide-y divide-cream-200 overflow-y-auto bg-white">
        {list.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => setOpen({ type: "view", id: p.id })}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-cream-50"
              data-testid="product-row"
            >
              <ProductImage imageId={p.imageId} name={p.name} className="size-14 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{p.name}</span>
                  {!p.active && <Badge tone="neutral">Inactive</Badge>}
                  {p.isSample && <Badge tone="info">Sample</Badge>}
                </div>
                <div className="text-sm text-charcoal-500">
                  {catName.get(p.categoryId)} · {formatQuantity(p.saleUnit, p.stockQty)} in stock
                </div>
                <StockBadge product={p} />
              </div>
              <div className="text-right font-bold text-burgundy-700">
                {formatPeso(p.price)}
                <span className="text-xs text-charcoal-500">{unitLabel(p.saleUnit)}</span>
              </div>
            </button>
          </li>
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
  const history = useLiveQuery(
    async () => ({
      moves: (await getDb().inventoryMovements.where("productId").equals(product.id).sortBy("at"))
        .reverse()
        .slice(0, 20),
      prices: (await getDb().priceChanges.where("productId").equals(product.id).sortBy("at")).reverse().slice(0, 10),
    }),
    [product.id],
  );
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
          <dt className="text-charcoal-500">Price</dt>
          <dd className="font-bold">
            {formatPeso(product.price)}
            {unitLabel(product.saleUnit)}
          </dd>
          <dt className="text-charcoal-500">Cost</dt>
          <dd>
            {formatPeso(product.cost)}
            {unitLabel(product.saleUnit)}
          </dd>
          <dt className="text-charcoal-500">Stock</dt>
          <dd>
            {formatQuantity(product.saleUnit, product.stockQty)} <StockBadge product={product} />
          </dd>
          <dt className="text-charcoal-500">Low at</dt>
          <dd>{formatQuantity(product.saleUnit, product.minStockQty)}</dd>
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
