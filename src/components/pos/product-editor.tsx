"use client";

import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { centavosToInput, formatPeso, parsePeso } from "@/domain/money";
import { formatQuantity, parsePieces, parseWeight, unitLabel, type SaleUnit } from "@/domain/quantity";
import {
  addCategory,
  createProduct,
  listCategories,
  productInputSchema,
  productToInput,
  removeProductImage,
  setProductImage,
  updateProduct,
} from "@/lib/db/products";
import type { Product } from "@/lib/db/types";
import { compressImage } from "@/lib/images";
import { useImageBlob } from "@/lib/hooks/use-image-url";
import { BlobImage } from "@/components/blob-image";
import { Badge, Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import { NumberInput } from "@/components/keypad";

type PendingPhoto =
  { kind: "keep" } | { kind: "remove" } | { kind: "new"; blob: Blob; mime: string; width: number; height: number };

/**
 * Create or edit a product inside POS mode.
 * mode "full": every field (manager approved).
 * mode "limited": photo and description only (cashier, when the owner allows it).
 */
export function ProductEditor({
  product,
  mode,
  by,
  onClose,
}: {
  product?: Product;
  mode: "full" | "limited";
  by: string;
  onClose: () => void;
}) {
  const categories = useLiveQuery(() => listCategories(), []);
  const currentImage = useImageBlob(product?.imageId);
  const full = mode === "full";

  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [chosenCategoryId, setCategoryId] = useState(product?.categoryId ?? "");
  const [saleUnit, setSaleUnit] = useState<SaleUnit>(product?.saleUnit ?? "kg");
  const [price, setPrice] = useState(product ? centavosToInput(product.price) : "");
  const [cost, setCost] = useState(product ? centavosToInput(product.cost) : "");
  const [minStock, setMinStock] = useState(
    product ? (product.saleUnit === "kg" ? String(product.minStockQty / 1000) : String(product.minStockQty)) : "",
  );
  const [openingStock, setOpeningStock] = useState("");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [barcode, setBarcode] = useState(product?.barcode ?? "");
  const [active, setActive] = useState(product?.active ?? true);
  const [photo, setPhoto] = useState<PendingPhoto>({ kind: "keep" });
  const [photoBusy, setPhotoBusy] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const categoryId = chosenCategoryId || categories?.[0]?.id || "";

  const priceC = parsePeso(price);
  const costC = parsePeso(cost);
  const parseQty = (s: string) => (s.trim() === "" ? 0 : saleUnit === "kg" ? parseWeight(s, "kg") : parsePieces(s));
  const minQty = parseQty(minStock);
  const openingQty = parseQty(openingStock);

  const previewBlob = photo.kind === "new" ? photo.blob : photo.kind === "remove" ? undefined : currentImage;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoBusy(true);
    setError(undefined);
    try {
      const c = await compressImage(file);
      setPhoto({ kind: "new", ...c });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that photo.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function save() {
    setError(undefined);
    if (priceC === null) return setError("Enter a valid selling price.");
    if (costC === null) return setError("Enter a valid cost (0 if unknown).");
    if (minQty === null) return setError("Enter a valid minimum stock.");
    if (openingQty === null) return setError("Enter a valid opening stock.");
    const input = {
      name,
      description,
      categoryId,
      saleUnit,
      price: priceC,
      cost: costC,
      minStockQty: minQty,
      active,
      sku: sku || undefined,
      barcode: barcode || undefined,
    };
    const parsed = productInputSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the form.");
    setSaving(true);
    try {
      let id = product?.id;
      if (!product) {
        const created = await createProduct(parsed.data, by, undefined, { initialStockQty: openingQty });
        id = created.id;
      } else {
        // Prices are changed on the product list. Limited mode can only change the description.
        const kept = productToInput(product);
        const data = full ? { ...parsed.data, price: kept.price, cost: kept.cost } : { ...kept, description };
        await updateProduct(product.id, data, by, { expectedVersion: product.version });
      }
      if (photo.kind === "new") await setProductImage(id!, photo, by);
      if (photo.kind === "remove") await removeProductImage(id!, by);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={product ? `Edit ${product.name}` : "New product"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || photoBusy} data-testid="save-product">
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        {/* Photo + live tile preview */}
        <div className="grid content-start gap-2">
          <div
            className="overflow-hidden rounded-xl border border-cream-300 bg-white shadow-sm"
            aria-label="Tile preview"
          >
            {previewBlob ? (
              <BlobImage blob={previewBlob} alt="Product photo preview" className="aspect-[4/3] w-full object-cover" />
            ) : (
              <div className="grid aspect-[4/3] w-full place-items-center bg-gradient-to-br from-burgundy-100 to-cream-200 text-3xl font-bold text-burgundy-700/60">
                {(name || "?").slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="p-2">
              <div className="line-clamp-2 text-sm font-semibold">{name || "Product name"}</div>
              <div className="font-bold text-burgundy-700">
                {priceC !== null ? formatPeso(priceC) : "₱—"}
                <span className="text-xs text-charcoal-500">{unitLabel(saleUnit)}</span>
              </div>
            </div>
          </div>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={onFile}
            data-testid="photo-camera"
          />
          <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onFile} data-testid="photo-gallery" />
          <Button variant="secondary" size="sm" onClick={() => cameraRef.current?.click()} disabled={photoBusy}>
            Take photo
          </Button>
          <Button variant="secondary" size="sm" onClick={() => galleryRef.current?.click()} disabled={photoBusy}>
            Choose from gallery
          </Button>
          {previewBlob && (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-700"
              onClick={() => setPhoto(product?.imageId ? { kind: "remove" } : { kind: "keep" })}
            >
              Remove photo
            </Button>
          )}
          {photoBusy && <p className="text-xs text-charcoal-500">Compressing photo…</p>}
          <p className="text-xs text-charcoal-500">
            Photos are resized to 800 px and saved on this device, so they show offline.
          </p>
        </div>

        <div className="grid content-start gap-3">
          {!full && (
            <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
              You can change the photo and description. Prices and other details need the manager PIN.
            </p>
          )}
          <Field label="Name">
            <input
              className={inputClass}
              value={name}
              maxLength={80}
              disabled={!full}
              onChange={(e) => setName(e.target.value)}
              data-testid="product-name"
            />
          </Field>
          <Field label="Description" hint="Shown to staff in POS. Keep it short.">
            <textarea
              className={`${inputClass} min-h-20 py-2`}
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="product-description"
            />
          </Field>
          {full && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Category">
                  <select className={inputClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                    {categories?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Sold by"
                  hint={product && product.stockQty !== 0 ? "Stock must be zero to change." : undefined}
                >
                  <select
                    className={inputClass}
                    value={saleUnit}
                    disabled={!!product && product.stockQty !== 0}
                    onChange={(e) => setSaleUnit(e.target.value as SaleUnit)}
                  >
                    <option value="kg">Kilogram (weighed)</option>
                    <option value="piece">Piece</option>
                  </select>
                </Field>
              </div>
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  placeholder="New category name"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  aria-label="New category name"
                />
                <Button
                  variant="secondary"
                  disabled={!newCategory.trim()}
                  onClick={async () => {
                    try {
                      const c = await addCategory(newCategory);
                      setCategoryId(c.id);
                      setNewCategory("");
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  Add
                </Button>
              </div>
              {product ? (
                <p className="text-sm text-charcoal-500">
                  Selling price {formatPeso(product.price)}
                  {unitLabel(product.saleUnit)}, cost {formatPeso(product.cost)}
                  {unitLabel(product.saleUnit)}. Change prices on the Products list.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={`Selling price (₱${unitLabel(saleUnit)})`}>
                    <NumberInput
                      className={inputClass}
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      data-testid="product-price"
                    />
                  </Field>
                  <Field label={`Cost (₱${unitLabel(saleUnit)})`} hint="Used for profit reports.">
                    <NumberInput
                      className={inputClass}
                      value={cost}
                      onChange={(e) => setCost(e.target.value)}
                      data-testid="product-cost"
                    />
                  </Field>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={`Low-stock warning at (${saleUnit === "kg" ? "kg" : "pcs"})`}>
                  <NumberInput className={inputClass} value={minStock} onChange={(e) => setMinStock(e.target.value)} />
                </Field>
                {!product ? (
                  <Field
                    label={`Opening stock (${saleUnit === "kg" ? "kg" : "pcs"})`}
                    hint="Recorded as a stock delivery."
                  >
                    <NumberInput
                      className={inputClass}
                      value={openingStock}
                      onChange={(e) => setOpeningStock(e.target.value)}
                    />
                  </Field>
                ) : (
                  <Field label="Current stock" hint="Change it with Adjust stock.">
                    <div className="flex min-h-11 items-center">
                      {formatQuantity(product.saleUnit, product.stockQty)}
                    </div>
                  </Field>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="SKU (optional)">
                  <input className={inputClass} value={sku} maxLength={40} onChange={(e) => setSku(e.target.value)} />
                </Field>
                <Field label="Barcode (optional)">
                  <input
                    className={inputClass}
                    value={barcode}
                    maxLength={40}
                    onChange={(e) => setBarcode(e.target.value)}
                  />
                </Field>
              </div>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5 accent-burgundy-700"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                <span className="font-semibold">Active (shown on the selling screen)</span>
                {!active && <Badge tone="warn">Hidden</Badge>}
              </label>
            </>
          )}
          <ErrorText>{error}</ErrorText>
        </div>
      </div>
    </Modal>
  );
}
