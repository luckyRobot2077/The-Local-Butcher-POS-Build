"use client";

import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "success";

const variants: Record<Variant, string> = {
  primary: "bg-burgundy-700 text-cream-50 hover:bg-burgundy-800 disabled:bg-burgundy-200",
  secondary: "bg-white text-charcoal-900 border border-cream-300 hover:bg-cream-50 disabled:text-charcoal-500",
  danger: "bg-red-700 text-white hover:bg-red-800 disabled:bg-red-300",
  ghost: "bg-transparent text-charcoal-700 hover:bg-cream-200",
  success: "bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-300",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: "min-h-9 px-3 text-sm", md: "min-h-11 px-4", lg: "min-h-14 px-5 text-lg" };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-burgundy-600 disabled:cursor-not-allowed ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

/** Accessible modal built on <dialog>. Closes on Escape and backdrop tap. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto w-[calc(100%-1.5rem)] ${wide ? "max-w-2xl" : "max-w-md"} max-h-[92dvh] rounded-2xl bg-cream-50 p-0 text-charcoal-900 shadow-2xl backdrop:bg-charcoal-900/50`}
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-cream-200 px-4 py-3">
            <h2 id={titleId} className="text-lg font-bold text-burgundy-800">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-10 place-items-center rounded-full text-2xl leading-none text-charcoal-500 hover:bg-cream-200"
            >
              ×
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-4">{children}</div>
          {footer && <div className="border-t border-cream-200 px-4 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-semibold text-charcoal-700">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-charcoal-500">{hint}</span>}
      {error && <span className="text-xs font-semibold text-red-700">{error}</span>}
    </label>
  );
}

export const inputClass =
  "min-h-11 w-full rounded-lg border border-cream-300 bg-white px-3 text-base text-charcoal-900 placeholder:text-charcoal-500/60 focus:border-burgundy-600 focus:outline-none focus:ring-2 focus:ring-burgundy-200 disabled:bg-cream-100 disabled:text-charcoal-500";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn" | "danger" | "ok" | "info";
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-cream-200 text-charcoal-700",
    warn: "bg-amber-100 text-amber-900",
    danger: "bg-red-100 text-red-800",
    ok: "bg-emerald-100 text-emerald-800",
    info: "bg-sky-100 text-sky-900",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
      {children}
    </p>
  );
}
