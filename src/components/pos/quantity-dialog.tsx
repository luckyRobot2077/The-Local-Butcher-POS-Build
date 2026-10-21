"use client";

import { useState } from "react";
import { formatPeso, parsePeso } from "@/domain/money";
import { formatQuantity, parsePieces, parseWeight, unitLabel, type SaleUnit } from "@/domain/quantity";
import { lineGross } from "@/domain/pricing";
import { Button, ErrorText, Modal, inputClass } from "@/components/ui";

type Mode = "kg" | "g" | "peso";

/**
 * Weight or piece entry. For per-kg items the cashier can type kilograms,
 * grams, or a peso amount ("₱100 worth"), which is converted to the most
 * grams that do not exceed the amount.
 */
export function QuantityDialog({
  title,
  saleUnit,
  unitPrice,
  initialQty,
  confirmLabel,
  onConfirm,
  onClose,
  onRemove,
}: {
  title: string;
  saleUnit: SaleUnit;
  unitPrice: number;
  initialQty?: number;
  confirmLabel: string;
  onConfirm: (qty: number) => void;
  onClose: () => void;
  onRemove?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("kg");
  const [text, setText] = useState(() => {
    if (!initialQty) return saleUnit === "piece" ? "1" : "";
    return saleUnit === "piece" ? String(initialQty) : (initialQty / 1000).toString();
  });

  let qty: number | null = null;
  if (saleUnit === "piece") qty = parsePieces(text);
  else if (mode === "peso") {
    const amount = parsePeso(text);
    if (amount && unitPrice > 0) {
      let g = Math.floor((amount * 1000) / unitPrice);
      while (g > 0 && lineGross("kg", unitPrice, g) > amount) g -= 1;
      qty = g > 0 ? g : null;
    }
  } else qty = parseWeight(text, mode);

  const amount = qty ? lineGross(saleUnit, unitPrice, qty) : null;
  const invalid = text.trim() !== "" && qty === null;

  const quick =
    saleUnit === "piece"
      ? ["1", "2", "3", "5"]
      : mode === "kg"
        ? ["0.25", "0.5", "1", "2"]
        : mode === "g"
          ? ["250", "500", "750", "1000"]
          : ["100", "200", "500", "1000"];

  const confirm = () => qty && onConfirm(qty);

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <div className="flex items-center gap-2">
          {onRemove && (
            <Button variant="ghost" className="text-red-700" onClick={onRemove}>
              Remove
            </Button>
          )}
          <Button variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!qty} data-testid="qty-confirm">
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <p className="text-sm text-charcoal-500">
          {formatPeso(unitPrice)}
          {unitLabel(saleUnit)}
        </p>
        {saleUnit === "kg" && (
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-cream-200 p-1" role="radiogroup" aria-label="Entry mode">
            {(
              [
                ["kg", "Kilograms"],
                ["g", "Grams"],
                ["peso", "Peso amount"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => {
                  setMode(m);
                  setText("");
                }}
                className={`min-h-10 rounded-lg text-sm font-semibold ${mode === m ? "bg-white text-burgundy-800 shadow" : "text-charcoal-700"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <label className="grid gap-1">
          <span className="text-sm font-semibold text-charcoal-700">
            {saleUnit === "piece"
              ? "Pieces"
              : mode === "kg"
                ? "Weight in kg (e.g. 1.25)"
                : mode === "g"
                  ? "Weight in grams"
                  : "Amount in pesos"}
          </span>
          <input
            className={`${inputClass} text-2xl font-bold`}
            inputMode="decimal"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="qty-input"
            aria-invalid={invalid}
          />
        </label>
        <div className="grid grid-cols-4 gap-2">
          {quick.map((q) => (
            <Button key={q} variant="secondary" size="sm" onClick={() => setText(q)}>
              {mode === "peso" ? `₱${q}` : q}
            </Button>
          ))}
        </div>
        {invalid && (
          <ErrorText>
            {saleUnit === "piece"
              ? "Enter a whole number of pieces."
              : "Enter a valid weight (up to 3 decimals in kg)."}
          </ErrorText>
        )}
        <div className="flex items-baseline justify-between rounded-xl bg-white px-3 py-2">
          <span className="text-sm text-charcoal-700">{qty ? formatQuantity(saleUnit, qty) : "—"}</span>
          <span className="text-2xl font-bold text-burgundy-800" data-testid="qty-amount">
            {amount !== null ? formatPeso(amount) : "₱0.00"}
          </span>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
