"use client";

import { useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { parsePeso } from "@/domain/money";
import { formatQuantity, parsePieces, parseWeight } from "@/domain/quantity";
import { getDb } from "@/lib/db/db";
import { recordStockMovement } from "@/lib/db/products";
import type { MovementType, Product } from "@/lib/db/types";
import { Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import { NumberInput } from "@/components/keypad";

type ManualType = Exclude<MovementType, "sale" | "purchase">;

const TYPES: { value: ManualType; label: string; sign: 1 | -1 | 0 }[] = [
  { value: "delivery", label: "Delivery received (+)", sign: 1 },
  { value: "return", label: "Customer return to stock (+)", sign: 1 },
  { value: "spoilage", label: "Spoilage (−)", sign: -1 },
  { value: "damage", label: "Damaged (−)", sign: -1 },
  { value: "trim_loss", label: "Cutting / trimming loss (−)", sign: -1 },
  { value: "correction", label: "Count correction (+/−)", sign: 0 },
];

export function StockDialog({ product, by, onClose }: { product: Product; by: string; onClose: () => void }) {
  const [type, setType] = useState<ManualType>("delivery");
  const [batchId, setBatchId] = useState("");
  const batches = useLiveQuery(
    async () =>
      (await getDb().batches.where("productId").equals(product.id).toArray()).sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      ),
    [product.id],
  );
  const [direction, setDirection] = useState<1 | -1>(1);
  const [qtyText, setQtyText] = useState("");
  const [reason, setReason] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [useBy, setUseBy] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const meta = TYPES.find((t) => t.value === type)!;
  const sign = meta.sign === 0 ? direction : meta.sign;
  const qty = product.saleUnit === "kg" ? parseWeight(qtyText, "kg") : parsePieces(qtyText);

  async function save() {
    if (!qty) return setError("Enter a quantity.");
    const cost = unitCost.trim() ? parsePeso(unitCost) : undefined;
    if (cost === null) return setError("Enter a valid cost.");
    setBusy(true);
    try {
      await recordStockMovement(product.id, type, sign * qty, by, {
        reason,
        batchCode,
        useBy,
        unitCost: cost,
        batchId: meta.sign === -1 && batchId ? batchId : undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Adjust stock: ${product.name}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            Record
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <p className="text-sm text-charcoal-700">
          Current stock: <strong>{formatQuantity(product.saleUnit, product.stockQty)}</strong>. Every change is kept in
          the stock history.
        </p>
        <Field label="What happened">
          <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        {meta.sign === 0 && (
          <div className="grid grid-cols-2 gap-2">
            <Button variant={direction === 1 ? "primary" : "secondary"} onClick={() => setDirection(1)}>
              Add
            </Button>
            <Button variant={direction === -1 ? "primary" : "secondary"} onClick={() => setDirection(-1)}>
              Remove
            </Button>
          </div>
        )}
        <Field label={`Quantity (${product.saleUnit === "kg" ? "kg, e.g. 2.5" : "pieces"})`}>
          <NumberInput className={inputClass} value={qtyText} onChange={(e) => setQtyText(e.target.value)} autoFocus />
        </Field>
        {meta.sign === -1 && (batches?.length ?? 0) > 0 && (
          <Field label="From batch (optional)" hint="Helps track which delivery the loss came from.">
            <select className={inputClass} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">Not sure / mixed</option>
              {batches!.slice(0, 20).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batchCode || "No code"} · received {b.receivedAt.slice(0, 10)}
                  {b.useBy ? ` · use by ${b.useBy}` : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === "delivery" && (
          <>
            <p className="rounded-lg bg-cream-100 px-3 py-2 text-sm text-charcoal-700">
              For a supplier delivery with its cost, batch and use-by date, use{" "}
              <Link href="/pos/inventory?tab=receive" className="font-semibold text-burgundy-700 underline">
                Inventory → Receive
              </Link>{" "}
              instead.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Batch / lot code (optional)">
                <input
                  className={inputClass}
                  value={batchCode}
                  maxLength={40}
                  onChange={(e) => setBatchCode(e.target.value)}
                />
              </Field>
              <Field label="Use-by date (optional)">
                <input className={inputClass} type="date" value={useBy} onChange={(e) => setUseBy(e.target.value)} />
              </Field>
            </div>
            <Field
              label="Cost per unit for this delivery (optional)"
              hint="Leave blank to use the product's current cost."
            >
              <NumberInput className={inputClass} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
            </Field>
          </>
        )}
        <Field label={meta.sign === 0 ? "Reason (required)" : "Note (optional)"}>
          <input className={inputClass} value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
