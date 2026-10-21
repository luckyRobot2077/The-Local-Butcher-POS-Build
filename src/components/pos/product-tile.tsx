"use client";

import { formatPeso } from "@/domain/money";
import { formatQuantity, unitLabel } from "@/domain/quantity";
import { isLowStock } from "@/lib/db/products";
import type { Product } from "@/lib/db/types";
import { useImageBlob } from "@/lib/hooks/use-image-url";
import { BlobImage } from "@/components/blob-image";
import { Badge } from "@/components/ui";

export function ProductImage({
  imageId,
  name,
  className = "",
}: {
  imageId?: string;
  name: string;
  className?: string;
}) {
  const blob = useImageBlob(imageId);
  if (blob) return <BlobImage blob={blob} alt={name} className={`object-cover ${className}`} />;
  return (
    <div
      aria-hidden
      className={`grid place-items-center bg-gradient-to-br from-burgundy-100 to-cream-200 text-3xl font-bold text-burgundy-700/60 ${className}`}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function StockBadge({ product }: { product: Product }) {
  if (product.stockQty <= 0) return <Badge tone="danger">Out of stock</Badge>;
  if (isLowStock(product)) return <Badge tone="warn">Low: {formatQuantity(product.saleUnit, product.stockQty)}</Badge>;
  return null;
}

export function ProductTile({ product, onSelect }: { product: Product; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex flex-col overflow-hidden rounded-xl border border-cream-300 bg-white text-left shadow-sm transition hover:border-burgundy-200 hover:shadow-md focus-visible:outline-2 focus-visible:outline-burgundy-600 active:scale-[0.98]"
      data-testid="product-tile"
    >
      <ProductImage imageId={product.imageId} name={product.name} className="aspect-[4/3] w-full" />
      <div className="flex flex-1 flex-col gap-1 p-2">
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-charcoal-900">{product.name}</span>
        <span className="mt-auto text-base font-bold text-burgundy-700">
          {formatPeso(product.price)}
          <span className="text-xs font-semibold text-charcoal-500">{unitLabel(product.saleUnit)}</span>
        </span>
        <StockBadge product={product} />
      </div>
    </button>
  );
}
