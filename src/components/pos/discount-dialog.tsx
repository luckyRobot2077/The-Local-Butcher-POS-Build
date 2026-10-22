"use client";

import { useState } from "react";
import { formatPeso, parsePeso } from "@/domain/money";
import { discountAmount, DiscountError, parsePercent, type DiscountInput } from "@/domain/discount";
import { Keypad } from "@/components/keypad";
import { Button, Field, Modal, inputClass } from "@/components/ui";

export function DiscountDialog({
  title,
  eligibleAmount,
  initial,
  onApply,
  onRemove,
  onClose,
}: {
  title: string;
  eligibleAmount: number;
  initial?: { input: DiscountInput; reason?: string };
  onApply: (input: DiscountInput, reason: string) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<DiscountInput["kind"]>(initial?.input.kind ?? "percent");
  const [text, setText] = useState(() => {
    if (!initial) return "";
    return initial.input.kind === "percent"
      ? String(initial.input.basisPoints / 100)
      : String(initial.input.amount / 100);
  });
  const [reason, setReason] = useState(initial?.reason ?? "");

  let input: DiscountInput | null = null;
  let error: string | undefined;
  if (text.trim()) {
    if (kind === "percent") {
      const bp = parsePercent(text);
      if (bp === null) error = "Enter a percentage from 0 to 100.";
      else input = { kind, basisPoints: bp };
    } else {
      const amt = parsePeso(text);
      if (amt === null) error = "Enter a valid peso amount.";
      else input = { kind, amount: amt };
    }
  }
  let preview: number | null = null;
  if (input) {
    try {
      preview = discountAmount(input, eligibleAmount);
    } catch (e) {
      error = e instanceof DiscountError ? e.message : String(e);
      input = null;
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <div className="flex items-center gap-2">
          {onRemove && (
            <Button variant="ghost" className="text-red-700" onClick={onRemove}>
              Remove discount
            </Button>
          )}
          <Button variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => input && onApply(input, reason)}
            disabled={!input || !reason.trim()}
            data-testid="discount-apply"
          >
            Apply
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <p className="text-sm text-charcoal-500">Applies to {formatPeso(eligibleAmount)}</p>
        <div
          className="grid grid-cols-2 gap-1 rounded-xl bg-cream-200 p-1"
          role="radiogroup"
          aria-label="Discount type"
        >
          {(
            [
              ["percent", "Percent %"],
              ["fixed", "Fixed ₱"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => {
                setKind(k);
                setText("");
              }}
              className={`min-h-10 rounded-lg text-sm font-semibold ${kind === k ? "bg-white text-burgundy-800 shadow" : "text-charcoal-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <Field label={kind === "percent" ? "Percent off" : "Pesos off"} error={error}>
          <input
            className={`${inputClass} text-xl font-bold`}
            inputMode="none"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="discount-value"
          />
        </Field>
        <Keypad value={text} onChange={setText} compact maxLength={8} />
        <Field label="Reason" hint="Required. Saved with the sale for auditing.">
          <input
            className={inputClass}
            value={reason}
            maxLength={80}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Suki discount, bruised pack"
            data-testid="discount-reason"
          />
        </Field>
        <div className="flex justify-between rounded-xl bg-white px-3 py-2">
          <span className="text-sm text-charcoal-700">Discount</span>
          <span className="font-bold text-emerald-800">{preview !== null ? `-${formatPeso(preview)}` : "—"}</span>
        </div>
      </div>
    </Modal>
  );
}
