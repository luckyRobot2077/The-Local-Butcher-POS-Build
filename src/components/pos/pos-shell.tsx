"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PosProvider, usePos } from "./pos-context";
import { SyncStatus } from "./status-bar";

const TABS = [
  { href: "/pos", label: "Sell" },
  { href: "/pos/products", label: "Products" },
  { href: "/pos/members", label: "Members" },
  { href: "/pos/inventory", label: "Inventory" },
  { href: "/pos/history", label: "History" },
  { href: "/pos/device", label: "Device" },
];

export function PosShell({ children }: { children: ReactNode }) {
  return (
    <PosProvider>
      <div className="flex h-dvh flex-col">
        <Header />
        <main className="flex min-h-0 flex-1 flex-col">
          <Gate>{children}</Gate>
        </main>
      </div>
    </PosProvider>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const { ready, dbError } = usePos();
  if (dbError) {
    return (
      <div className="m-4 rounded-xl bg-red-50 p-4 text-red-900" role="alert">
        <p className="font-bold">The local database could not be opened.</p>
        <p className="text-sm">{dbError}</p>
        <p className="mt-2 text-sm">
          Sales cannot be recorded until this is fixed. Private/incognito browsing or full storage are the usual causes.
        </p>
      </div>
    );
  }
  if (!ready) return <p className="m-4 text-charcoal-500">Opening local database…</p>;
  return <>{children}</>;
}

function Header() {
  const pathname = usePathname();
  const { settings, cashierName, changeCashier, managerUnlocked, lockManager } = usePos();
  return (
    <header className="border-b-4 border-burgundy-700 bg-navy-900 text-cream-50 shadow-md">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 pb-1">
        <Link href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- static logo, must work offline */}
          <img
            src="/brand/logo.jpg"
            alt=""
            width={36}
            height={40}
            className="h-10 w-9 rounded-md bg-white object-contain p-0.5"
          />
          <span className="font-bold leading-tight">{settings.storeName}</span>
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SyncStatus compact />
          {managerUnlocked && (
            <button
              type="button"
              onClick={lockManager}
              className="rounded-full bg-amber-300 px-2 py-1 text-xs font-bold text-charcoal-900"
              title="Manager mode is on. Tap to lock."
            >
              Manager · Lock
            </button>
          )}
          <button
            type="button"
            onClick={changeCashier}
            className="rounded-full bg-cream-50/15 px-3 py-1 text-xs font-semibold hover:bg-cream-50/25"
            data-testid="cashier-chip"
          >
            Cashier: {cashierName || "—"}
          </button>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2" aria-label="POS sections">
        {TABS.map((t) => {
          const active = t.href === "/pos" ? pathname === "/pos" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-t-lg px-4 py-2 text-sm font-semibold ${
                active ? "bg-burgundy-700 text-cream-50" : "text-cream-100 hover:bg-navy-700"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
