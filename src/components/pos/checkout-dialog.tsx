"use client";

import { useState } from "react";
import { formatPeso, parsePeso } from "@/domain/money";
import type { CartTotals, AppliedDiscountInput } from "@/domain/cart";
import type { PaymentInput } from "@/domain/checkout";
import { completeSale } from "@/lib/db/sales";
import { Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";

function quickCash(total: number): number[] {
  const opts = new Set<number>([total]);
  for (const step of [10000, 50000, 100000]) opts.add(Math.ceil(total / step) * step);
  opts.add(Math.ceil(total / 100000) * 100000 + 100000);
  return [...opts]
    .filter((v) => v >= total)
    .sort((a, b) => a - b)
    .slice(0, 4);
}

export function CheckoutDialog({
  totals,
  cashierName,
  orderDiscountDetail,
  discountApprovedBy,
  onClose,
  onCompleted,
}: {
  totals: CartTotals;
  cashierName: string;
  orderDiscountDetail?: AppliedDiscountInput;
  discountApprovedBy?: string;
  onClose: () => void;
  onCompleted: (saleId: string) => void;
}) {
  const [method, setMethod] = useState<"cash" | "gcash">("cash");
  const [tenderedText, setTenderedText] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const tendered = parsePeso(tenderedText);
  const change = tendered !== null && tendered >= totals.total ? tendered - totals.total : null;
  const canConfirm = method === "gcash" ? true : change !== null;

  const confirm = async () => {
    if (!canConfirm || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const payment: PaymentInput =
        method === "cash"
          ? { method: "cash", tendered: tendered! }
          : { method: "gcash", reference: reference || undefined };
      const sale = await completeSale({ totals, payment, cashierName, orderDiscountDetail, discountApprovedBy });
      onCompleted(sale.id);
    } catch (e) {
      // Nothing was saved: the local write is a single transaction.
      setError(`Sale NOT saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title="Payment"
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Back
          </Button>
          <Button
            variant="success"
            size="lg"
            className="flex-1"
            onClick={confirm}
            disabled={!canConfirm || busy}
            data-testid="confirm-sale"
          >
            {busy ? "Saving…" : `Confirm ${formatPeso(totals.total)}`}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <div className="rounded-xl bg-burgundy-700 px-4 py-3 text-cream-50">
          <div className="text-sm opacity-80">Total payable</div>
          <div className="text-3xl font-bold" data-testid="checkout-total">
            {formatPeso(totals.total)}
          </div>
          {totals.discountTotal > 0 && (
            <div className="text-sm opacity-80">Includes {formatPeso(totals.discountTotal)} discount</div>
          )}
        </div>
        <div
          className="grid grid-cols-2 gap-1 rounded-xl bg-cream-200 p-1"
          role="radiogroup"
          aria-label="Payment method"
        >
          {(
            [
              ["cash", "Cash"],
              ["gcash", "GCash"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={`min-h-11 rounded-lg font-semibold ${method === m ? "bg-white text-burgundy-800 shadow" : "text-charcoal-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {method === "cash" ? (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              confirm();
            }}
          >
            <Field label="Cash received">
              <input
                className={`${inputClass} text-2xl font-bold`}
                inputMode="decimal"
                autoFocus
                value={tenderedText}
                onChange={(e) => setTenderedText(e.target.value)}
                placeholder="0.00"
                data-testid="tendered-input"
              />
            </Field>
            <div className="grid grid-cols-4 gap-2">
              {quickCash(totals.total).map((v) => (
                <Button key={v} variant="secondary" size="sm" onClick={() => setTenderedText((v / 100).toFixed(2))}>
                  {v === totals.total ? "Exact" : formatPeso(v).replace(".00", "")}
                </Button>
              ))}
            </div>
            <div className="flex items-baseline justify-between rounded-xl bg-white px-3 py-3">
              <span className="font-semibold text-charcoal-700">Change</span>
              <span className="text-3xl font-bold text-emerald-800" data-testid="change-amount">
                {change !== null ? formatPeso(change) : "—"}
              </span>
            </div>
            {tendered !== null && tendered < totals.total && (
              <p className="text-sm font-semibold text-red-700">Short by {formatPeso(totals.total - tendered)}</p>
            )}
            <button type="submit" hidden />
          </form>
        ) : (
          <div className="grid gap-3">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Check the customer&apos;s GCash confirmation before confirming. This app records the payment manually and
              does not verify it with GCash.
            </p>
            <Field label="GCash reference number (optional)">
              <input
                className={inputClass}
                inputMode="numeric"
                value={reference}
                maxLength={40}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
