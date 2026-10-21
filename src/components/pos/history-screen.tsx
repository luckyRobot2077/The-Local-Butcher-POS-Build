"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { findSales } from "@/lib/db/sales";
import { getDb } from "@/lib/db/db";
import { formatPeso } from "@/domain/money";
import { businessDate, formatManila } from "@/domain/time";
import { Badge, Modal } from "@/components/ui";
import { ReceiptView } from "./receipt-view";

export function HistoryScreen() {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string>();
  const sales = useLiveQuery(() => findSales(query), [query]);
  const today = useLiveQuery(async () => {
    const list = await getDb().sales.where("businessDate").equals(businessDate(new Date())).toArray();
    return {
      count: list.length,
      total: list.reduce((a, s) => a + s.total, 0),
      cash: list.filter((s) => s.paymentMethod === "cash").reduce((a, s) => a + s.total, 0),
      gcash: list.filter((s) => s.paymentMethod === "gcash").reduce((a, s) => a + s.total, 0),
      discounts: list.reduce((a, s) => a + s.discountTotal, 0),
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {today && (
        <div
          className="grid grid-cols-2 gap-2 border-b border-cream-200 bg-cream-50 p-2 sm:grid-cols-4"
          aria-label="Today on this device"
        >
          <Stat label="Sales today" value={String(today.count)} />
          <Stat label="Total today" value={formatPeso(today.total)} />
          <Stat label="Cash / GCash" value={`${formatPeso(today.cash)} / ${formatPeso(today.gcash)}`} />
          <Stat label="Discounts" value={formatPeso(today.discounts)} />
        </div>
      )}
      <div className="border-b border-cream-200 bg-cream-50 p-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search receipt number or transaction ID"
          aria-label="Search transactions"
          className="min-h-11 w-full rounded-xl border border-cream-300 bg-white px-3"
        />
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-cream-200 overflow-y-auto bg-white" data-testid="history-list">
        {sales?.length === 0 && <li className="p-6 text-center text-charcoal-500">No sales found on this device.</li>}
        {sales?.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-cream-50"
              onClick={() => setOpenId(s.id)}
              data-testid="history-row"
            >
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{s.receiptNo}</div>
                <div className="text-sm text-charcoal-500">
                  {formatManila(s.createdAt)} · {s.cashierName} · {s.itemCount} item{s.itemCount === 1 ? "" : "s"}
                </div>
              </div>
              <div className="grid justify-items-end gap-1">
                <span className="font-bold">{formatPeso(s.total)}</span>
                <span className="flex gap-1">
                  <Badge tone="neutral">{s.paymentMethod === "cash" ? "Cash" : "GCash"}</Badge>
                  <Badge tone={s.syncStatus === "synced" ? "ok" : s.syncStatus === "failed" ? "danger" : "warn"}>
                    {s.syncStatus === "synced" ? "Synced" : s.syncStatus === "failed" ? "Sync failed" : "Not synced"}
                  </Badge>
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {openId && (
        <Modal open onClose={() => setOpenId(undefined)} title="Receipt">
          <ReceiptView saleId={openId} />
          <p className="mt-3 text-xs text-charcoal-500">
            Refunds and voids of completed sales need manager approval and arrive with the Back Office (they will be
            recorded as reversing entries, never by deleting the sale).
          </p>
        </Modal>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
      <div className="text-xs text-charcoal-500">{label}</div>
      <div className="font-bold text-burgundy-800">{value}</div>
    </div>
  );
}
