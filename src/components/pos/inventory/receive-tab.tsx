"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { lineCost } from "@/domain/checkout";
import { centavosToInput, formatPeso, parsePeso } from "@/domain/money";
import { parsePieces, parseWeight, unitLabel } from "@/domain/quantity";
import { getDb } from "@/lib/db/db";
import { listSuppliers, receivePurchase } from "@/lib/db/inventory";
import type { PaymentStatus, Product } from "@/lib/db/types";
import { Button, ErrorText, Field, inputClass } from "@/components/ui";
import { usePos } from "../pos-context";
import { SupplierDialog } from "./purchases-tab";

interface Line {
  key: string;
  productId: string;
  qtyText: string;
  costText: string;
  batchCode: string;
  useBy: string;
}

const blankLine = (): Line => ({
  key: crypto.randomUUID(),
  productId: "",
  qtyText: "",
  costText: "",
  batchCode: "",
  useBy: "",
});

/** Local date-time string for <input type="datetime-local">. */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function ReceiveTab({ onDone }: { onDone: () => void }) {
  const { cashierName } = usePos();
  const suppliers = useLiveQuery(() => listSuppliers(), []);
  const products = useLiveQuery(
    async () => (await getDb().products.toArray()).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );
  const productById = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const [supplierId, setSupplierId] = useState("");
  const [receivedAt, setReceivedAt] = useState(localNow);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [payment, setPayment] = useState<PaymentStatus>("unpaid");
  const [updateCosts, setUpdateCosts] = useState(true);
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [addSupplier, setAddSupplier] = useState(false);

  const parsed = lines.map((l) => {
    const p = productById.get(l.productId);
    if (!p) return null;
    const qty = p.saleUnit === "kg" ? parseWeight(l.qtyText, "kg") : parsePieces(l.qtyText);
    const unitCost = parsePeso(l.costText);
    return {
      line: l,
      product: p,
      qty,
      unitCost,
      cost: qty && unitCost !== null ? lineCost(p.saleUnit, unitCost, qty) : null,
    };
  });
  const total = parsed.reduce((a, x) => a + (x?.cost ?? 0), 0);

  function patch(key: string, change: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)));
  }

  function chooseProduct(key: string, p: Product | undefined) {
    patch(key, { productId: p?.id ?? "", costText: p ? centavosToInput(p.cost) : "" });
  }

  async function save() {
    setError(undefined);
    if (!supplierId) return setError("Choose a supplier.");
    const filled = parsed.filter((x) => x !== null);
    if (filled.length === 0) return setError("Add at least one product.");
    for (const x of filled) {
      if (!x.qty) return setError(`Enter the quantity for ${x.product.name}.`);
      if (x.unitCost === null) return setError(`Enter the cost for ${x.product.name}.`);
    }
    setBusy(true);
    try {
      await receivePurchase(
        {
          supplierId,
          receivedAt: new Date(receivedAt).toISOString(),
          reference,
          notes,
          paymentStatus: payment,
          updateCosts,
          lines: filled.map((x) => ({
            productId: x.product.id,
            qty: x.qty!,
            unitCost: x.unitCost!,
            batchCode: x.line.batchCode,
            useBy: x.line.useBy,
          })),
        },
        `${cashierName || "unknown"} (manager PIN)`,
      );
      setLines([blankLine()]);
      setReference("");
      setNotes("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <section className="grid gap-3 rounded-xl bg-white p-3 shadow-sm">
        <h2 className="text-lg font-bold text-burgundy-800">Receive a supplier delivery</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier">
            <div className="flex gap-2">
              <select
                className={inputClass}
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                data-testid="receive-supplier"
              >
                <option value="">Choose…</option>
                {suppliers
                  ?.filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <Button variant="secondary" onClick={() => setAddSupplier(true)}>
                New
              </Button>
            </div>
          </Field>
          <Field label="Received">
            <input
              className={inputClass}
              type="datetime-local"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
            />
          </Field>
          <Field label="Delivery receipt / reference (optional)">
            <input
              className={inputClass}
              value={reference}
              maxLength={60}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          <Field label="Payment">
            <select
              className={inputClass}
              value={payment}
              onChange={(e) => setPayment(e.target.value as PaymentStatus)}
            >
              <option value="unpaid">Not paid yet</option>
              <option value="partial">Partly paid</option>
              <option value="paid">Paid</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="grid gap-3 rounded-xl bg-white p-3 shadow-sm">
        <h3 className="font-bold text-burgundy-800">Products received</h3>
        {lines.map((l, i) => {
          const x = parsed[i];
          const p = x?.product;
          return (
            <div key={l.key} className="grid gap-2 rounded-lg border border-cream-200 p-2" data-testid="receive-line">
              <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
                <Field label="Product">
                  <select
                    className={inputClass}
                    value={l.productId}
                    onChange={(e) => chooseProduct(l.key, productById.get(e.target.value))}
                  >
                    <option value="">Choose…</option>
                    {products?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Quantity (${p?.saleUnit === "piece" ? "pieces" : "kg"})`}>
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    value={l.qtyText}
                    onChange={(e) => patch(l.key, { qtyText: e.target.value })}
                  />
                </Field>
                <Field label={`Cost ${p ? unitLabel(p.saleUnit) : ""}`}>
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    value={l.costText}
                    onChange={(e) => patch(l.key, { costText: e.target.value })}
                  />
                </Field>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Field label="Batch / lot code (optional)">
                  <input
                    className={inputClass}
                    value={l.batchCode}
                    maxLength={40}
                    onChange={(e) => patch(l.key, { batchCode: e.target.value })}
                  />
                </Field>
                <Field label="Use-by date (optional)">
                  <input
                    className={inputClass}
                    type="date"
                    value={l.useBy}
                    onChange={(e) => patch(l.key, { useBy: e.target.value })}
                  />
                </Field>
                <div className="flex items-end justify-between gap-2 sm:flex-col sm:items-end">
                  <span className="text-sm font-semibold">{x?.cost != null ? formatPeso(x.cost) : "—"}</span>
                  {lines.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setLines((ls) => ls.filter((y) => y.key !== l.key))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, blankLine()])}>
          + Add another product
        </Button>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={updateCosts}
            onChange={(e) => setUpdateCosts(e.target.checked)}
          />
          <span>
            Update each product&apos;s cost to the average of the stock on hand and this delivery. Selling prices do not
            change.
          </span>
        </label>
        <Field label="Notes (optional)">
          <input className={inputClass} value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-between gap-2">
          <span className="text-lg">
            Total: <strong data-testid="receive-total">{formatPeso(total)}</strong>
          </span>
          <Button onClick={save} disabled={busy} data-testid="receive-save">
            {busy ? "Saving…" : "Receive into stock"}
          </Button>
        </div>
      </section>
      {addSupplier && (
        <SupplierDialog
          onClose={(id) => {
            setAddSupplier(false);
            if (id) setSupplierId(id);
          }}
        />
      )}
    </div>
  );
}
