"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { formatPeso } from "@/domain/money";
import { formatQuantity } from "@/domain/quantity";
import { formatManila } from "@/domain/time";
import { getDb } from "@/lib/db/db";
import { listSuppliers, saveSupplier, setPaymentStatus } from "@/lib/db/inventory";
import type { PaymentStatus, Purchase, Supplier } from "@/lib/db/types";
import { Badge, Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import { usePos } from "../pos-context";

const PAYMENT_LABEL: Record<PaymentStatus, string> = { unpaid: "Not paid", partial: "Partly paid", paid: "Paid" };

export function PurchasesTab() {
  const { cashierName } = usePos();
  const suppliers = useLiveQuery(() => listSuppliers(), []);
  const purchases = useLiveQuery(
    async () => (await getDb().purchases.orderBy("receivedAt").reverse().limit(100).toArray()) as Purchase[],
    [],
  );
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const name = new Map((suppliers ?? []).map((s) => [s.id, s.name]));
  const unpaid = (purchases ?? []).filter((p) => p.paymentStatus !== "paid").reduce((a, p) => a + p.totalCost, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <section className="rounded-xl bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold text-burgundy-800">Purchases</h2>
          <span className="text-sm">
            Not fully paid: <strong>{formatPeso(unpaid)}</strong>
          </span>
        </div>
        {purchases?.length === 0 && <p className="mt-2 text-sm text-charcoal-500">No deliveries received yet.</p>}
        <ul className="mt-2 divide-y divide-cream-200 text-sm" data-testid="purchase-list">
          {purchases?.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setOpen(p.id)}
                className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left hover:bg-cream-50"
              >
                <span>
                  <span className="font-semibold">{name.get(p.supplierId) ?? "Unknown supplier"}</span>
                  <span className="text-charcoal-500">
                    {" "}
                    · {formatManila(p.receivedAt)}
                    {p.reference ? ` · ${p.reference}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={p.paymentStatus === "paid" ? "ok" : "warn"}>{PAYMENT_LABEL[p.paymentStatus]}</Badge>
                  <strong>{formatPeso(p.totalCost)}</strong>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-xl bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-burgundy-800">Suppliers</h2>
          <Button size="sm" onClick={() => setEditing("new")}>
            + Add
          </Button>
        </div>
        <ul className="mt-2 divide-y divide-cream-200 text-sm">
          {suppliers?.map((s) => (
            <li key={s.id}>
              <button type="button" className="w-full py-2 text-left hover:bg-cream-50" onClick={() => setEditing(s)}>
                <span className="font-semibold">{s.name}</span>
                {!s.active && <Badge tone="neutral">Inactive</Badge>}
                {s.contact && <span className="block text-charcoal-500">{s.contact}</span>}
              </button>
            </li>
          ))}
          {suppliers?.length === 0 && <li className="py-2 text-charcoal-500">No suppliers yet.</li>}
        </ul>
      </section>
      {editing && (
        <SupplierDialog supplier={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />
      )}
      {open && (
        <PurchaseDialog
          id={open}
          supplierName={name.get(purchases?.find((p) => p.id === open)?.supplierId ?? "") ?? ""}
          by={`${cashierName || "unknown"} (manager PIN)`}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function PurchaseDialog({
  id,
  supplierName,
  by,
  onClose,
}: {
  id: string;
  supplierName: string;
  by: string;
  onClose: () => void;
}) {
  const data = useLiveQuery(async () => {
    const db = getDb();
    const purchase = await db.purchases.get(id);
    const items = await db.purchaseItems.where("purchaseId").equals(id).toArray();
    const products = new Map(
      (await db.products.bulkGet(items.map((i) => i.productId))).map((p, n) => [items[n].productId, p]),
    );
    const batches = new Map((await db.batches.where("purchaseId").equals(id).toArray()).map((b) => [b.id, b]));
    return { purchase, items, products, batches };
  }, [id]);
  const p = data?.purchase;
  return (
    <Modal open wide onClose={onClose} title={`Delivery from ${supplierName}`}>
      {p && (
        <div className="grid gap-3 text-sm">
          <p>
            Received {formatManila(p.receivedAt)} by {p.by}
            {p.reference ? ` · ref ${p.reference}` : ""}
            {p.remote ? " · recorded on another device" : ""}
          </p>
          {p.notes && <p className="text-charcoal-700">{p.notes}</p>}
          <table className="w-full">
            <thead className="text-left text-charcoal-500">
              <tr>
                <th>Product</th>
                <th>Qty</th>
                <th>Batch</th>
                <th>Use by</th>
                <th className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.items.map((i) => {
                const prod = data.products.get(i.productId);
                const b = data.batches.get(i.batchId);
                return (
                  <tr key={i.id}>
                    <td className="py-1">{prod?.name ?? "?"}</td>
                    <td>{prod ? formatQuantity(prod.saleUnit, i.qty) : i.qty}</td>
                    <td>{b?.batchCode ?? "—"}</td>
                    <td>{b?.useBy ?? "—"}</td>
                    <td className="text-right">{formatPeso(i.lineCost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-right text-base">
            Total <strong>{formatPeso(p.totalCost)}</strong>
          </p>
          <Field label="Payment status">
            <select
              className={inputClass}
              value={p.paymentStatus}
              onChange={(e) => setPaymentStatus(p.id, e.target.value as PaymentStatus, by)}
              data-testid="purchase-payment"
            >
              <option value="unpaid">Not paid yet</option>
              <option value="partial">Partly paid</option>
              <option value="paid">Paid</option>
            </select>
          </Field>
          <p className="text-xs text-charcoal-500">
            Deliveries cannot be edited or deleted. If something was entered wrong, record a stock correction with a
            reason.
          </p>
        </div>
      )}
    </Modal>
  );
}

export function SupplierDialog({ supplier, onClose }: { supplier?: Supplier; onClose: (id?: string) => void }) {
  const { cashierName } = usePos();
  const [name, setName] = useState(supplier?.name ?? "");
  const [contact, setContact] = useState(supplier?.contact ?? "");
  const [notes, setNotes] = useState(supplier?.notes ?? "");
  const [active, setActive] = useState(supplier?.active ?? true);
  const [error, setError] = useState<string>();

  async function save() {
    try {
      const s = await saveSupplier({ name, contact, notes, active }, cashierName || "unknown", supplier?.id);
      onClose(s.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open
      onClose={() => onClose()}
      title={supplier ? "Edit supplier" : "New supplier"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button onClick={save} data-testid="supplier-save">
            Save
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            data-testid="supplier-name"
          />
        </Field>
        <Field label="Contact (optional)">
          <input className={inputClass} value={contact} maxLength={80} onChange={(e) => setContact(e.target.value)} />
        </Field>
        <Field label="Notes (optional)">
          <input className={inputClass} value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {supplier && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
