"use client";

import { Keypad } from "@/components/keypad";
import type { QuickMode } from "@/domain/quick-entry";

const MODES: [QuickMode, string][] = [
  ["kg", "kg / pcs"],
  ["g", "grams"],
  ["peso", "₱ amount"],
];

/**
 * The numpad that stays on the sell screen (tablet and larger): type a
 * weight, piece count or peso amount, then tap a product to add it. On a
 * landscape tablet it is its own column; upright it sits under the sale.
 */
export function QuickEntry({
  column = false,
  text,
  mode,
  message,
  onText,
  onMode,
}: {
  column?: boolean;
  text: string;
  mode: QuickMode;
  message?: { tone: "info" | "error"; text: string };
  onText: (next: string) => void;
  onMode: (next: QuickMode) => void;
}) {
  const shown = text ? (mode === "peso" ? `₱${text}` : `${text} ${mode === "g" ? "g" : "kg / pcs"}`) : "";
  return (
    <div
      className={
        column
          ? "flex w-64 shrink-0 flex-col gap-2 border-l border-cream-300 bg-cream-100 p-2 xl:w-72"
          : "hidden gap-2 border-t border-cream-300 bg-cream-100 p-2 md:grid"
      }
      aria-label="Numpad"
      role="region"
      data-testid="quick-entry"
    >
      {column && <h2 className="px-1 pt-1 font-bold text-burgundy-800">Numpad</h2>}
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-cream-200 p-1" role="radiogroup" aria-label="Numpad mode">
        {MODES.map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => {
              onMode(m);
              onText("");
            }}
            className={`min-h-9 rounded-lg text-sm font-semibold ${mode === m ? "bg-white text-burgundy-800 shadow" : "text-charcoal-700"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="flex min-h-11 items-center justify-between rounded-xl border border-cream-300 bg-white px-3"
        aria-live="polite"
      >
        <span className="text-xs text-charcoal-500">{text ? "Now tap a product" : "Type, then tap a product"}</span>
        <span className="text-2xl font-bold text-charcoal-900" data-testid="quick-entry-value">
          {shown}
        </span>
      </div>
      <Keypad
        value={text}
        onChange={onText}
        decimal={mode !== "g"}
        maxLength={9}
        compact={!column}
        testId="quick-keypad"
      />
      {message && (
        <p
          className={`text-sm font-semibold ${message.tone === "error" ? "text-red-700" : "text-emerald-800"}`}
          data-testid="quick-entry-message"
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
