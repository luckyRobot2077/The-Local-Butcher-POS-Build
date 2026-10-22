"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { memberInsights, promoContactsCsv, type Bucket } from "@/domain/members";
import { formatPeso } from "@/domain/money";
import { formatManila } from "@/domain/time";
import { getDb } from "@/lib/db/db";
import { newId, nowIso } from "@/lib/db/ids";
import { saleFacts } from "@/lib/db/members";
import { Button } from "@/components/ui";
import { usePos } from "../pos-context";

const PERIODS = [30, 90, 365] as const;

function pct(part: number, whole: number) {
  return whole ? `${Math.round((part * 100) / whole)}%` : "—";
}

/** Member demographics and spending. Behind the manager PIN (it shows sales totals). */
export function InsightsTab() {
  const { managerUnlocked, requestManager, cashierName } = usePos();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(30);
  const data = useLiveQuery(async () => {
    if (!managerUnlocked) return null;
    const now = new Date();
    const since = new Date(now.getTime() - period * 86_400_000).toISOString();
    const [members, sales] = await Promise.all([getDb().members.toArray(), saleFacts(since)]);
    return { members, insights: memberInsights(members, sales, now) };
  }, [managerUnlocked, period]);

  if (!managerUnlocked) {
    return (
      <div className="mx-auto grid max-w-md gap-3 rounded-xl bg-white p-4 shadow-sm">
        <p>Member insights show sales totals, so they need the manager PIN.</p>
        <Button onClick={() => requestManager("Member insights need manager approval.")}>
          Unlock with manager PIN
        </Button>
      </div>
    );
  }
  if (!data) return <p className="text-charcoal-500">Loading…</p>;
  const { insights: i, members } = data;

  async function exportContacts() {
    const csv = promoContactsCsv(members);
    await getDb().auditLog.add({
      id: newId(),
      action: "member.export_promo_contacts",
      entity: "member",
      by: cashierName || "manager",
      at: nowIso(),
      detail: { count: i.reachable },
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `promo-contacts-${nowIso().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-charcoal-700">Period</span>
        {PERIODS.map((p) => (
          <Button key={p} size="sm" variant={p === period ? "primary" : "secondary"} onClick={() => setPeriod(p)}>
            {p} days
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="insight-tiles">
        <Tile label="Active members" value={String(i.members)} />
        <Tile label="Member sales" value={`${i.memberSales} of ${i.sales}`} sub={pct(i.memberSales, i.sales)} />
        <Tile
          label="Member revenue"
          value={formatPeso(i.memberRevenue)}
          sub={`${pct(i.memberRevenue, i.revenue)} of ${formatPeso(i.revenue)}`}
        />
        <Tile label="Agreed to promo texts" value={String(i.reachable)} sub={pct(i.reachable, i.members)} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <BucketTable title="By gender" rows={i.byGender} />
        <BucketTable title="By age" rows={i.byAge} />
      </div>
      <div className="rounded-xl bg-white p-3 shadow-sm">
        <h3 className="font-bold text-burgundy-800">Top members</h3>
        <table className="mt-2 w-full text-sm" data-testid="top-members">
          <thead className="text-left text-xs text-charcoal-500">
            <tr>
              <th className="py-1">Member</th>
              <th className="py-1 text-right">Visits</th>
              <th className="py-1 text-right">Spent</th>
              <th className="py-1 text-right">Last visit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {i.top.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-center text-charcoal-500">
                  No member purchases in this period.
                </td>
              </tr>
            )}
            {i.top.map((t) => (
              <tr key={t.member.id}>
                <td className="py-1.5">
                  {t.member.name} <span className="font-mono text-xs text-charcoal-500">{t.member.memberNo}</span>
                </td>
                <td className="py-1.5 text-right">{t.sales}</td>
                <td className="py-1.5 text-right font-semibold">{formatPeso(t.spent)}</td>
                <td className="py-1.5 text-right text-xs">{formatManila(t.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-2 rounded-xl bg-white p-3 shadow-sm">
        <h3 className="font-bold text-burgundy-800">Member-only promo texts</h3>
        <p className="text-sm text-charcoal-700">
          The POS does not send text messages itself; that needs an account with an SMS provider (for example
          Semaphore). Export the members who agreed to promo texts and upload the list there. Members who said no, or
          who later stopped promos, are never in the file.
        </p>
        <Button variant="secondary" onClick={exportContacts} disabled={i.reachable === 0} data-testid="export-contacts">
          Export {i.reachable} promo contact{i.reachable === 1 ? "" : "s"} (CSV)
        </Button>
      </div>
      <p className="text-xs text-charcoal-500">
        Ages are from the birth year, so they can be off by one. Sales from other devices are included on owner and
        manager devices after a sync.
      </p>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-white p-3 shadow-sm">
      <div className="text-xs text-charcoal-500">{label}</div>
      <div className="text-xl font-bold text-burgundy-800">{value}</div>
      {sub && <div className="text-xs text-charcoal-700">{sub}</div>}
    </div>
  );
}

function BucketTable({ title, rows }: { title: string; rows: Bucket[] }) {
  const max = Math.max(1, ...rows.map((r) => r.members));
  return (
    <div className="rounded-xl bg-white p-3 shadow-sm">
      <h3 className="font-bold text-burgundy-800">{title}</h3>
      <table className="mt-2 w-full text-sm">
        <thead className="text-left text-xs text-charcoal-500">
          <tr>
            <th className="py-1">Group</th>
            <th className="py-1">Members</th>
            <th className="py-1 text-right">Spent</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="py-1 pr-2">{r.label}</td>
              <td className="w-1/2 py-1">
                <div className="flex items-center gap-2">
                  <div className="h-2 rounded bg-burgundy-600" style={{ width: `${(r.members / max) * 100}%` }} />
                  <span className="text-xs">{r.members}</span>
                </div>
              </td>
              <td className="py-1 text-right">{formatPeso(r.spent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
