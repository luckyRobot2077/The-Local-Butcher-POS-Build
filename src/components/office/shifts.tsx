"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ErrorText } from "@/components/ui";
import { ShiftTimeline, differenceLabel } from "@/components/shift-timeline";
import { CloudRejection, type CloudApi } from "@/lib/cloud/api";
import { formatPeso } from "@/domain/money";
import { businessDate, formatManila } from "@/domain/time";
import {
  RANGE_PRESETS,
  officeShiftTimeline,
  presetRange,
  shiftsCsv,
  type OfficeShift,
  type RangePreset,
} from "@/domain/office";

/** Shifts from every device: when they opened and closed, the cash count, and each sale and drawer opening. */
export function ShiftsPage({ api, onCsv }: { api: CloudApi; onCsv: (name: string, csv: string) => void }) {
  const today = businessDate(new Date());
  const [preset, setPreset] = useState<RangePreset>("7d");
  const range = useMemo(
    () => (preset === "custom" ? { from: today, to: today } : presetRange(preset, today)),
    [preset, today],
  );
  const [shifts, setShifts] = useState<OfficeShift[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await api.rpc<{ shifts: OfficeShift[] }>("office_shifts", { p_from: range.from, p_to: range.to });
      setShifts(r.shifts);
    } catch (e) {
      setErr(
        e instanceof CloudRejection && /office_shifts|PGRST202|schema cache/i.test(e.message)
          ? "The cloud database needs migration 11 (20261029000011_shifts.sql) before shifts show here."
          : e instanceof CloudRejection
            ? e.message
            : "Could not reach the cloud. Check the internet connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [api, range]);

  useEffect(() => {
    // Fetches the shifts whenever the date range changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="grid gap-4" data-testid="office-shifts">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Date range">
        {RANGE_PRESETS.filter((p) => p.id !== "custom").map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={preset === p.id}
            onClick={() => setPreset(p.id)}
            className={`min-h-9 rounded-full px-3 text-sm font-semibold ${
              preset === p.id
                ? "bg-navy-800 text-cream-50"
                : "border border-cream-300 bg-white text-charcoal-700 hover:bg-cream-50"
            }`}
          >
            {p.label}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!shifts?.length}
            onClick={() => shifts && onCsv(`shifts_${range.from || "start"}_to_${range.to}.csv`, shiftsCsv(shifts))}
            data-testid="shifts-csv"
          >
            Download CSV
          </Button>
          <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>
      <ErrorText>{err}</ErrorText>
      <p className="text-sm text-charcoal-700">
        Shifts and their sales reach the Back Office after each device syncs. Open a shift to see every time stamp.
      </p>
      {shifts?.length === 0 && <p className="rounded-xl bg-white p-6 text-center text-charcoal-500">No shifts yet.</p>}
      <div className="grid gap-3">
        {shifts?.map((sh) => (
          <details key={sh.id} className="rounded-2xl border border-cream-300 bg-white p-4" data-testid="office-shift">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold">
                {formatManila(sh.opened_at)} · {sh.opened_by}
              </span>
              <span className="text-sm text-charcoal-500">
                {sh.device_label || sh.device_code} ·{" "}
                {sh.closed_at ? `closed ${formatManila(sh.closed_at)} by ${sh.closed_by}` : "open now"}
              </span>
              <span className="ml-auto text-sm tabular-nums">
                {sh.sale_count} sale{sh.sale_count === 1 ? "" : "s"} · cash {formatPeso(sh.cash_sales)} · GCash{" "}
                {formatPeso(sh.gcash_sales)}
              </span>
              {sh.closed_at && sh.counted_cash !== null && sh.expected_cash !== null && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    sh.counted_cash === sh.expected_cash
                      ? "bg-emerald-50 text-emerald-800"
                      : "bg-amber-50 text-amber-900"
                  }`}
                  data-testid="office-shift-difference"
                >
                  {differenceLabel(sh.counted_cash, sh.expected_cash)}
                </span>
              )}
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-[16rem_1fr]">
              <dl className="grid h-fit grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-cream-50 p-3 text-sm tabular-nums">
                <dt>Starting cash</dt>
                <dd className="text-right">{formatPeso(sh.opening_float)}</dd>
                <dt>Cash sales</dt>
                <dd className="text-right">{formatPeso(sh.cash_sales)}</dd>
                {sh.closed_at && (
                  <>
                    <dt>Expected</dt>
                    <dd className="text-right">{formatPeso(sh.expected_cash ?? 0)}</dd>
                    <dt className="font-semibold">Counted</dt>
                    <dd className="text-right font-semibold">{formatPeso(sh.counted_cash ?? 0)}</dd>
                  </>
                )}
                <dt>No-sale openings</dt>
                <dd className="text-right">{sh.events.length}</dd>
                {sh.note && <dd className="col-span-2 pt-1 text-charcoal-700">Note: {sh.note}</dd>}
              </dl>
              <ShiftTimeline entries={officeShiftTimeline(sh)} />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
