import { formatPeso } from "@/domain/money";
import { cashDifference, type TimelineEntry } from "@/domain/shift";
import { formatManilaTime } from "@/domain/time";

/** "Over by ₱5.00", "Short by ₱4.00" or "Exact". */
export function differenceLabel(counted: number, expected: number): string {
  const d = cashDifference(counted, expected);
  return d === 0 ? "Exact" : d > 0 ? `Over by ${formatPeso(d)}` : `Short by ${formatPeso(-d)}`;
}

function describe(e: TimelineEntry): { title: string; detail: string } {
  switch (e.type) {
    case "shift_open":
      return { title: "Shift started", detail: `${e.by} · starting cash ${formatPeso(e.amount)}` };
    case "sale_started":
      return { title: `Sale ${e.receiptNo} started`, detail: e.by };
    case "sale_paid":
      return {
        title: `Sale ${e.receiptNo} paid`,
        detail: `${e.by} · ${formatPeso(e.amount)} ${e.method === "cash" ? "cash" : "GCash"}`,
      };
    case "no_sale":
      return {
        title: "Drawer opened, no sale",
        detail: `${e.by} · ${e.reason}${e.approvedBy ? ` · approved by ${e.approvedBy}` : ""}`,
      };
    case "shift_close":
      return {
        title: "Shift closed",
        detail: `${e.by} · counted ${formatPeso(e.amount)}, expected ${formatPeso(e.expected)} · ${differenceLabel(e.amount, e.expected)}`,
      };
  }
}

/** Everything in a shift with its time, oldest first. */
export function ShiftTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="grid gap-0 border-l-2 border-cream-300 pl-3" data-testid="shift-timeline">
      {entries.map((e, i) => {
        const { title, detail } = describe(e);
        return (
          <li key={i} className="relative py-1.5" data-testid="timeline-entry" data-type={e.type}>
            <span
              className={`absolute top-3 -left-[1.1rem] size-2.5 rounded-full ${
                e.type === "no_sale" ? "bg-amber-500" : e.type.startsWith("shift") ? "bg-burgundy-700" : "bg-navy-800"
              }`}
            />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs text-charcoal-500">{formatManilaTime(e.at)}</span>
              <span className="font-semibold">{title}</span>
            </div>
            <div className="text-sm text-charcoal-700">{detail}</div>
          </li>
        );
      })}
    </ol>
  );
}
