"use client";

import { useRef, useState, type InputHTMLAttributes } from "react";
import { useMediaQuery } from "@/lib/use-media-query";

/**
 * Big on-screen number keys for tablets, so weights, amounts, cash, PINs
 * and codes are entered without the system keyboard covering the screen.
 * Inputs it drives use inputMode="none"; a physical keyboard still works.
 */
export function applyKey(value: string, key: string, opts: { decimal?: boolean; maxLength?: number } = {}): string {
  const max = opts.maxLength ?? 12;
  if (key === "C") return "";
  if (key === "⌫") return value.slice(0, -1);
  if (key === ".") {
    if (!opts.decimal || value.includes(".")) return value;
    return (value || "0") + ".";
  }
  if (!/^\d+$/.test(key)) return value;
  const next = value === "0" && key !== "00" ? key : value + key;
  if (next === "00" || next === "000") return "0";
  // At most three decimals (grams in kg; pesos are checked by their own parser).
  if (/\.\d{4,}$/.test(next)) return value;
  return next.slice(0, max);
}

export function Keypad({
  value,
  onChange,
  decimal = true,
  maxLength,
  onEnter,
  enterLabel = "OK",
  compact = false,
  testId = "keypad",
}: {
  value: string;
  onChange: (next: string) => void;
  decimal?: boolean;
  maxLength?: number;
  onEnter?: () => void;
  enterLabel?: string;
  compact?: boolean;
  testId?: string;
}) {
  const keys = ["7", "8", "9", "⌫", "4", "5", "6", "C", "1", "2", "3", "00", decimal ? "." : "", "0"];
  const press = (k: string) => onChange(applyKey(value, k, { decimal, maxLength }));
  const h = compact ? "min-h-11 text-lg" : "min-h-14 text-2xl";
  return (
    <div className="grid grid-cols-4 gap-1.5" data-testid={testId} role="group" aria-label="Number keys">
      {keys.map((k, i) =>
        k === "" ? (
          <span key={i} />
        ) : (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            aria-label={k === "⌫" ? "Delete" : k === "C" ? "Clear" : k}
            data-key={k}
            className={`${h} rounded-xl font-bold select-none active:scale-95 ${
              k === "⌫" || k === "C"
                ? "bg-cream-200 text-charcoal-700 hover:bg-cream-300"
                : "border border-cream-300 bg-white text-charcoal-900 hover:bg-cream-50"
            }`}
          >
            {k}
          </button>
        ),
      )}
      {onEnter ? (
        <button
          type="button"
          onClick={onEnter}
          className={`${h} col-span-2 rounded-xl bg-navy-800 font-bold text-cream-50 hover:bg-navy-900`}
          data-key="enter"
        >
          {enterLabel}
        </button>
      ) : (
        <span className="col-span-2" />
      )}
    </div>
  );
}

/** Sets an input's value the way typing does, so the field's own onChange runs. */
function typeInto(input: HTMLInputElement, next: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * A number field that opens the on-screen keys right under itself while it
 * has focus on a touch screen, instead of the tablet's own keyboard. Takes
 * the same props as <input>; the keys feed the field's onChange. The keys
 * push the content below down, so they never cover the next field;
 * `floating` lays them over the page instead (for fields inside a row).
 */
export function NumberInput({
  decimal = true,
  floating = false,
  wrapperClassName = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { decimal?: boolean; floating?: boolean; wrapperClassName?: string }) {
  const touch = useMediaQuery("(pointer: coarse)");
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const value = String(props.value ?? "");
  const maxLength = props.maxLength && props.maxLength > 0 ? props.maxLength : undefined;
  const editable = !props.readOnly && !props.disabled;
  return (
    <div className={`relative ${wrapperClassName}`}>
      <input
        {...props}
        ref={ref}
        inputMode={touch ? "none" : (props.inputMode ?? (decimal ? "decimal" : "numeric"))}
        onFocus={(e) => {
          props.onFocus?.(e);
          setOpen(true);
        }}
        onBlur={(e) => {
          props.onBlur?.(e);
          setOpen(false);
        }}
      />
      {touch && open && editable && (
        <div
          className={`rounded-xl border border-cream-300 bg-cream-50 p-2 ${
            floating ? "absolute top-full left-0 z-50 mt-1 w-64 shadow-xl" : "mt-2 max-w-xs"
          }`}
          // Keeps focus in the field while keys are pressed, and stops a
          // surrounding <label> from focusing the field again after "Done".
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.preventDefault()}
          data-testid="popup-keypad"
        >
          <Keypad
            value={value}
            onChange={(next) => ref.current && typeInto(ref.current, next)}
            decimal={decimal}
            maxLength={maxLength}
            compact
            enterLabel="Done"
            onEnter={() => ref.current?.blur()}
          />
        </div>
      )}
    </div>
  );
}
