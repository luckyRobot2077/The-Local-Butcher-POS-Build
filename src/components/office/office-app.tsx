"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button, ErrorText, Field, inputClass } from "@/components/ui";
import { CloudRejection, getSupabase, supabaseApi, type CloudApi } from "@/lib/cloud/api";
import { signIn } from "@/lib/cloud/session";
import { formatPeso, parsePeso } from "@/domain/money";
import { businessDate, formatManila } from "@/domain/time";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_LABEL,
  LOSS_LABEL,
  RANGE_PRESETS,
  WEEKDAY_LABEL,
  bucketLabel,
  bucketTrend,
  dailyCsv,
  expensesCsv,
  formatDate,
  formatQty,
  grainFor,
  marginPct,
  presetRange,
  productsCsv,
  saleLinesCsv,
  summaryCsv,
  type ExpenseCategory,
  type OfficeReport,
  type RangePreset,
  type SaleLineRow,
} from "@/domain/office";
import { ColumnChart, Legend, RankedBars, SERIES, ShareBar, TrendChart } from "./charts";
import { SetupWizard, StaffPage, UnlockScreen, withSession, type OfficeSession } from "./staff";

const OTHER_PART = "#a7afb8";

type Gate =
  | { kind: "loading" }
  | { kind: "no_cloud" }
  | { kind: "signed_out" }
  | { kind: "needs_update" }
  | { kind: "setup_wait"; store: string }
  | { kind: "setup"; api: CloudApi; name: string; store: string }
  | { kind: "locked"; api: CloudApi; store: string }
  | { kind: "open"; api: CloudApi; base: CloudApi; store: string; session: OfficeSession };

const SESSION_KEY = "tlb-office-session";

function savedSession(): OfficeSession | undefined {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as OfficeSession | null;
    return s && Date.parse(s.expiresAt) > Date.now() ? s : undefined;
  } catch {
    return undefined;
  }
}

function saveSession(s: OfficeSession | undefined) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Private mode: the session lasts only while the page is open.
  }
}

function message(e: unknown): string {
  if (e instanceof CloudRejection) return e.message;
  return "Could not reach the cloud. Check the internet connection and try again.";
}

function download(name: string, csv: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function OfficeApp() {
  const [gate, setGate] = useState<Gate>({ kind: "loading" });
  const [tab, setTab] = useState<"reports" | "staff">("reports");

  const openWith = useCallback((base: CloudApi, store: string, session: OfficeSession) => {
    saveSession(session);
    const lockNow = () => {
      saveSession(undefined);
      setGate({ kind: "locked", api: base, store });
    };
    setGate({ kind: "open", api: withSession(base, session.token, lockNow), base, store, session });
  }, []);

  const check = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return setGate({ kind: "no_cloud" });
    const { data } = await sb.auth.getSession();
    if (!data.session) return setGate({ kind: "signed_out" });
    const api = supabaseApi(sb);
    try {
      const rows = await api.rpc<{ display_name: string | null; role: string | null; store_name: string | null }[]>(
        "whoami",
        {},
      );
      const me = rows[0];
      if (!me?.role) return setGate({ kind: "signed_out" });
      const store = me.store_name ?? "";
      let status: { setupOpen: boolean; accountRole: string };
      try {
        status = await api.rpc("office_status", {});
      } catch (e) {
        if (e instanceof CloudRejection && e.code === "PGRST202") return setGate({ kind: "needs_update" });
        throw e;
      }
      if (status.setupOpen) {
        return setGate(
          status.accountRole === "owner"
            ? { kind: "setup", api, name: me.display_name ?? "", store }
            : { kind: "setup_wait", store },
        );
      }
      const saved = savedSession();
      if (saved) openWith(api, store, saved);
      else setGate({ kind: "locked", api, store });
    } catch (e) {
      setGate({ kind: "signed_out" });
      console.warn(message(e));
    }
  }, [openWith]);

  useEffect(() => {
    // Reads the saved session from browser storage once on load.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
  }, [check]);

  async function lock() {
    if (gate.kind !== "open") return;
    try {
      await gate.base.rpc("office_lock", { p_token: gate.session.token });
    } catch {
      // The session expires on its own.
    }
    saveSession(undefined);
    setGate({ kind: "locked", api: gate.base, store: gate.store });
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b-4 border-burgundy-700 bg-navy-900 text-cream-50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo.jpg" alt="" className="size-10 rounded-full bg-cream-50 object-cover" />
          <div>
            <h1 className="text-lg font-bold leading-tight">Back Office</h1>
            {gate.kind === "open" && (
              <p className="text-xs text-cream-200" data-testid="office-who">
                {gate.store} · {gate.session.name} ({gate.session.role}, {gate.session.employeeNo})
              </p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/pos" className="rounded-lg px-3 py-2 text-sm font-semibold text-cream-50 hover:bg-navy-700">
              Open POS
            </Link>
            {gate.kind === "open" && (
              <Button
                size="sm"
                className="bg-amber-300 text-charcoal-900 hover:bg-amber-200"
                onClick={lock}
                data-testid="office-lock"
              >
                Lock
              </Button>
            )}
            {gate.kind !== "loading" && gate.kind !== "no_cloud" && gate.kind !== "signed_out" && (
              <Button
                size="sm"
                variant="ghost"
                className="text-cream-50 hover:bg-navy-700"
                onClick={async () => {
                  await lock();
                  await getSupabase()?.auth.signOut();
                  setGate({ kind: "signed_out" });
                }}
              >
                Sign out of the cloud
              </Button>
            )}
          </div>
        </div>
        {gate.kind === "open" && (
          <nav className="mx-auto flex max-w-6xl gap-1 px-2" aria-label="Back Office sections">
            {(
              [
                ["reports", "Reports"],
                ["staff", "Staff"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id ? "page" : undefined}
                data-testid={`office-tab-${id}`}
                className={`rounded-t-lg px-4 py-2 text-sm font-semibold ${
                  tab === id ? "bg-burgundy-700 text-cream-50" : "text-cream-100 hover:bg-navy-700"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto grid max-w-6xl gap-4 p-4">
        {gate.kind === "loading" && <p className="text-charcoal-500">Loading…</p>}
        {gate.kind === "no_cloud" && (
          <Notice>
            The Back Office reads the shop&apos;s data from the cloud, and this copy of the app has no cloud connection
            set up.
          </Notice>
        )}
        {gate.kind === "signed_out" && <SignIn onDone={check} />}
        {gate.kind === "needs_update" && (
          <Notice>
            The cloud database needs an update before the Back Office can open: run the newest file in
            supabase/migrations in the Supabase SQL Editor, then reload this page.
          </Notice>
        )}
        {gate.kind === "setup_wait" && (
          <Notice>
            The owner has not set up their owner ID yet. The owner signs in here once with their account to do it.
          </Notice>
        )}
        {gate.kind === "setup" && (
          <SetupWizard
            api={gate.api}
            ownerName={gate.name}
            storeName={gate.store}
            onUnlocked={(sess) => openWith(gate.api, gate.store, sess)}
          />
        )}
        {gate.kind === "locked" && (
          <UnlockScreen api={gate.api} onUnlocked={(sess) => openWith(gate.api, gate.store, sess)} />
        )}
        {gate.kind === "open" && tab === "reports" && <Dashboard key={gate.session.token} api={gate.api} />}
        {gate.kind === "open" && tab === "staff" && (
          <StaffPage api={gate.api} storeName={gate.store} session={gate.session} />
        )}
      </main>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-amber-50 p-4 text-amber-900">{children}</p>;
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const sb = getSupabase();
    if (!sb) return;
    setBusy(true);
    setErr("");
    try {
      await signIn(sb, email, pw);
      onDone();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mx-auto grid w-full max-w-sm gap-3 rounded-2xl bg-white p-5 shadow-sm">
      <h2 className="text-lg font-bold text-burgundy-800">Sign in</h2>
      <p className="text-sm text-charcoal-700">
        Sign this device in to the shop&apos;s cloud account once (the same one the POS uses). After that the Back
        Office opens with an owner or manager badge and a code from Google Authenticator.
      </p>
      <Field label="Email">
        <input
          className={inputClass}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </Field>
      <Field label="Password">
        <input
          className={inputClass}
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          required
        />
      </Field>
      <ErrorText>{err}</ErrorText>
      <Button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

function Card({
  title,
  children,
  action,
  className = "",
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`grid content-start gap-3 rounded-2xl border border-cream-300 bg-white p-4 ${className}`}>
      <div className="flex items-center gap-2">
        <h2 className="font-bold text-navy-900">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "bad";
  testId: string;
}) {
  return (
    <div className="rounded-2xl border border-cream-300 bg-white p-3" data-testid={testId}>
      <p className="text-xs font-semibold uppercase tracking-wide text-charcoal-500">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${tone === "bad" ? "text-burgundy-700" : "text-charcoal-900"}`}
      >
        {value}
      </p>
      {note && <p className="mt-0.5 text-xs text-charcoal-500">{note}</p>}
    </div>
  );
}

function Dashboard({ api }: { api: CloudApi }) {
  const today = businessDate(new Date());
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [custom, setCustom] = useState({ from: today.slice(0, 8) + "01", to: today });
  const [report, setReport] = useState<OfficeReport | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const range = useMemo(() => (preset === "custom" ? custom : presetRange(preset, today)), [preset, custom, today]);

  const load = useCallback(async () => {
    if (range.from && range.from > range.to) return setErr("The start date is after the end date.");
    setLoading(true);
    setErr("");
    try {
      setReport(await api.rpc<OfficeReport>("office_report", { p_from: range.from, p_to: range.to }));
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }, [api, range]);

  useEffect(() => {
    // Fetches the report whenever the date range changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Date range">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={preset === p.id}
            data-testid={`range-${p.id}`}
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
        <Button size="sm" variant="secondary" className="ml-auto" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>
      {preset === "custom" && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <input
              type="date"
              className={inputClass}
              value={custom.from}
              max={today}
              onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={inputClass}
              value={custom.to}
              max={today}
              onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
            />
          </Field>
        </div>
      )}
      <ErrorText>{err}</ErrorText>
      {report && <ReportView report={report} api={api} reload={load} />}
    </>
  );
}

function ReportView({ report: r, api, reload }: { report: OfficeReport; api: CloudApi; reload: () => void }) {
  const t = r.totals;
  const grain = grainFor(r.days);
  const trend = bucketTrend(r.daily, grain).map((b) => ({ ...b, label: bucketLabel(b.key, grain) }));
  const margin = marginPct(t.revenue, t.cogs);
  const period = r.from === r.to ? formatDate(r.from) : `${formatDate(r.from)} to ${formatDate(r.to)}`;
  const cash = r.byPayment.find((p) => p.method === "cash");
  const gcash = r.byPayment.find((p) => p.method === "gcash");
  const hours = r.byHour.filter((h) => h.transactions > 0).map((h) => h.hour);
  const firstHour = Math.min(6, ...hours);
  const lastHour = Math.max(20, ...hours);
  const walkInRevenue = t.revenue - r.members.memberRevenue;
  const lossTotal = r.inventory.losses.reduce((a, l) => a + l.value, 0);
  const fileTag = `${r.from}_to_${r.to}`;

  return (
    <div className="grid gap-4" data-testid="office-report">
      <p className="text-sm text-charcoal-700">
        Showing <strong>{period}</strong>
        {grain !== "day" && (
          <>
            {" "}
            · trend grouped by {grain} (the first and last {grain} may be partial)
          </>
        )}
        . Sales reach the Back Office after each device syncs.
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          testId="kpi-sales"
          label="Sales"
          value={formatPeso(t.revenue)}
          note={`${t.transactions.toLocaleString("en-PH")} transactions`}
        />
        <Tile
          testId="kpi-average"
          label="Average sale"
          value={formatPeso(t.average)}
          note={t.discounts > 0 ? `${formatPeso(t.discounts)} given in discounts` : "No discounts given"}
        />
        <Tile
          testId="kpi-gross"
          label="Gross profit"
          value={formatPeso(t.grossProfit)}
          note={`Cost of goods ${formatPeso(t.cogs)}${margin != null ? ` · ${margin}% margin` : ""}`}
          tone={t.grossProfit < 0 ? "bad" : undefined}
        />
        <Tile
          testId="kpi-net"
          label="Net operating profit"
          value={formatPeso(t.netProfit)}
          note={`After ${formatPeso(t.expenses)} expenses (estimate)`}
          tone={t.netProfit < 0 ? "bad" : undefined}
        />
      </div>

      <Card
        title="Sales and gross profit"
        action={
          <Legend
            items={[
              { label: "Sales", color: SERIES.sales },
              { label: "Gross profit", color: SERIES.profit },
            ]}
          />
        }
      >
        {t.transactions === 0 ? (
          <p className="text-sm text-charcoal-500">No synced sales in this period yet.</p>
        ) : (
          <TrendChart data={trend} />
        )}
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold text-charcoal-700">Show as a table</summary>
          <div className="mt-2 max-h-72 overflow-auto">
            <table className="w-full text-left tabular-nums">
              <thead className="sticky top-0 bg-white text-charcoal-500">
                <tr>
                  <th className="py-1">{grain === "day" ? "Date" : grain === "week" ? "Week of" : "Month"}</th>
                  <th>Sales</th>
                  <th>Gross profit</th>
                  <th>Transactions</th>
                  <th>Expenses</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((b) => (
                  <tr key={b.key} className="border-t border-cream-200">
                    <td className="py-1">{bucketLabel(b.key, grain)}</td>
                    <td>{formatPeso(b.revenue)}</td>
                    <td>{formatPeso(b.grossProfit)}</td>
                    <td>{b.transactions}</td>
                    <td>{formatPeso(b.expenses)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Sales by category">
          <RankedBars
            testId="by-category"
            rows={r.byCategory.map((c) => ({
              label: c.name,
              value: c.revenue,
              detail: margin == null ? undefined : `${marginPct(c.revenue, c.cost) ?? 0}% margin`,
            }))}
          />
        </Card>
        <Card title="Best sellers" action={<span className="text-xs text-charcoal-500">Top 10 by sales</span>}>
          <RankedBars
            testId="best-sellers"
            rows={r.products
              .slice(0, 10)
              .map((p) => ({ label: p.name, value: p.revenue, detail: formatQty(p.unit, p.qty) }))}
          />
        </Card>
      </div>

      <Card title="Product profit">
        {r.products.length === 0 ? (
          <p className="text-sm text-charcoal-500">Nothing sold in this period.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm tabular-nums" data-testid="product-profit">
              <thead className="sticky top-0 bg-white text-charcoal-500">
                <tr>
                  <th className="py-1">Product</th>
                  <th>Sold</th>
                  <th>Sales</th>
                  <th>Cost</th>
                  <th>Profit</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {[...r.products]
                  .sort((a, b) => b.revenue - b.cost - (a.revenue - a.cost))
                  .map((p) => {
                    const m = marginPct(p.revenue, p.cost);
                    return (
                      <tr key={p.id} className="border-t border-cream-200">
                        <td className="py-1.5 pr-2 font-medium text-charcoal-900">{p.name}</td>
                        <td>{formatQty(p.unit, p.qty)}</td>
                        <td>{formatPeso(p.revenue)}</td>
                        <td>{formatPeso(p.cost)}</td>
                        <td className={p.revenue - p.cost < 0 ? "font-semibold text-burgundy-700" : "font-semibold"}>
                          {formatPeso(p.revenue - p.cost)}
                        </td>
                        <td className={m != null && m < 10 ? "text-burgundy-700" : ""}>{m == null ? "—" : `${m}%`}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Busy hours">
          <ColumnChart
            testId="by-hour"
            data={r.byHour
              .filter((h) => h.hour >= firstHour && h.hour <= lastHour)
              .map((h) => ({ label: hourLabel(h.hour), value: h.revenue, detail: `${h.transactions} transactions` }))}
          />
        </Card>
        <Card title="Sales by day of the week">
          <ColumnChart
            testId="by-weekday"
            data={[1, 2, 3, 4, 5, 6, 0].map((w) => {
              const d = r.byWeekday.find((x) => x.weekday === w);
              return {
                label: WEEKDAY_LABEL[w],
                value: d?.revenue ?? 0,
                detail: `${d?.transactions ?? 0} transactions`,
              };
            })}
          />
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Payments">
          <ShareBar
            testId="by-payment"
            parts={[
              { label: "Cash", value: cash?.revenue ?? 0, color: SERIES.sales, detail: formatPeso(cash?.revenue ?? 0) },
              {
                label: "GCash",
                value: gcash?.revenue ?? 0,
                color: OTHER_PART,
                detail: formatPeso(gcash?.revenue ?? 0),
              },
            ]}
          />
        </Card>
        <Card title="Sales by cashier">
          <RankedBars
            testId="by-cashier"
            rows={r.byCashier.map((c) => ({ label: c.name, value: c.revenue, detail: `${c.transactions} sales` }))}
          />
        </Card>
        <Card title="Discounts given">
          <RankedBars
            testId="discounts"
            empty="No discounts in this period."
            rows={r.discounts.map((d) => ({
              label: d.name,
              value: d.amount,
              detail: `${d.uses} ${d.uses === 1 ? "sale" : "sales"}`,
            }))}
          />
        </Card>
      </div>

      <MembersSection r={r} walkInRevenue={walkInRevenue} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Inventory">
          <div className="grid grid-cols-3 gap-2 text-sm">
            <Mini label="Stock value (at cost)" value={formatPeso(r.inventory.stockValue)} testId="stock-value" />
            <Mini label="Bought from suppliers" value={formatPeso(r.inventory.purchases)} testId="purchases" />
            <Mini label="Lost to waste" value={formatPeso(lossTotal)} testId="losses" />
          </div>
          {r.inventory.losses.length > 0 && (
            <p className="text-xs text-charcoal-500">
              {r.inventory.losses.map((l) => `${LOSS_LABEL[l.type]} ${formatPeso(l.value)}`).join(" · ")}
            </p>
          )}
          <h3 className="text-sm font-semibold text-charcoal-700">Low stock now</h3>
          {r.inventory.lowStock.length === 0 ? (
            <p className="text-sm text-charcoal-500">Everything is above its minimum.</p>
          ) : (
            <ul className="grid gap-1 text-sm" data-testid="low-stock">
              {r.inventory.lowStock.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 border-t border-cream-200 pt-1">
                  <span>
                    {p.name} <span className="text-charcoal-500">· {p.category}</span>
                  </span>
                  <span className={`tabular-nums ${p.qty <= 0 ? "font-semibold text-burgundy-700" : ""}`}>
                    {formatQty(p.unit, Math.max(p.qty, 0))}{" "}
                    <span className="text-charcoal-500">(min {formatQty(p.unit, p.min)})</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Expenses r={r} api={api} reload={reload} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Recent sales">
          {r.recent.length === 0 ? (
            <p className="text-sm text-charcoal-500">No synced sales in this period.</p>
          ) : (
            <ul className="grid gap-1 text-sm" data-testid="recent-sales">
              {r.recent.map((s) => (
                <li key={s.id} className="flex justify-between gap-2 border-t border-cream-200 pt-1">
                  <span>
                    <span className="font-medium">{s.receiptNo}</span>{" "}
                    <span className="text-charcoal-500">
                      {formatManila(s.at)} · {s.cashier} · {s.method === "gcash" ? "GCash" : "Cash"}
                      {s.member ? " · member" : ""}
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">{formatPeso(s.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Download for Excel (CSV)">
          <p className="text-sm text-charcoal-700">Files cover {period}.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              data-testid="csv-summary"
              onClick={() => download(`summary_${fileTag}.csv`, summaryCsv(r))}
            >
              Summary
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="csv-daily"
              onClick={() => download(`daily-sales_${fileTag}.csv`, dailyCsv(r))}
            >
              Daily sales
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="csv-products"
              onClick={() => download(`product-sales_${fileTag}.csv`, productsCsv(r))}
            >
              Product sales
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="csv-expenses"
              onClick={() => download(`expenses_${fileTag}.csv`, expensesCsv(r))}
            >
              Expenses
            </Button>
            <SaleLinesButton api={api} from={r.from} to={r.to} fileTag={fileTag} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function hourLabel(h: number): string {
  return h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
}

function Mini({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-xl bg-cream-100 p-2" data-testid={testId}>
      <p className="text-xs text-charcoal-500">{label}</p>
      <p className="font-bold tabular-nums text-charcoal-900">{value}</p>
    </div>
  );
}

function MembersSection({ r, walkInRevenue }: { r: OfficeReport; walkInRevenue: number }) {
  const m = r.members;
  const genderLabel: Record<string, string> = {
    female: "Female",
    male: "Male",
    other: "Other",
    undisclosed: "Not said",
  };
  return (
    <Card title="Members">
      <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
        <Mini label="Members" value={String(m.total)} testId="members-total" />
        <Mini label="New in this period" value={String(m.newInRange)} testId="members-new" />
        <Mini label="Bought in this period" value={String(m.active)} testId="members-active" />
        <Mini label="Came back (2+ visits)" value={String(m.repeat)} testId="members-repeat" />
        <Mini label="Promo opt-ins" value={String(m.promoOptIns)} testId="members-optins" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="grid content-start gap-2">
          <h3 className="text-sm font-semibold text-charcoal-700">Members vs walk-ins (sales)</h3>
          <ShareBar
            testId="member-share"
            parts={[
              { label: "Members", value: m.memberRevenue, color: SERIES.sales, detail: formatPeso(m.memberRevenue) },
              { label: "Walk-ins", value: walkInRevenue, color: OTHER_PART, detail: formatPeso(walkInRevenue) },
            ]}
          />
        </div>
        <div className="grid content-start gap-2">
          <h3 className="text-sm font-semibold text-charcoal-700">Top members</h3>
          {m.top.length === 0 ? (
            <p className="text-sm text-charcoal-500">No member purchases in this period.</p>
          ) : (
            <ol className="grid gap-1 text-sm" data-testid="top-members">
              {m.top.map((x, i) => (
                <li key={`${x.memberNo}-${i}`} className="flex justify-between gap-2 border-t border-cream-200 pt-1">
                  <span className="truncate">
                    {x.name}{" "}
                    <span className="text-charcoal-500">
                      · {x.visits} {x.visits === 1 ? "visit" : "visits"}
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">{formatPeso(x.spent)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="grid content-start gap-2">
          <h3 className="text-sm font-semibold text-charcoal-700">Members by age</h3>
          <RankedBars
            testId="members-age"
            empty="No members yet."
            format={(n) => String(n)}
            rows={["Under 25", "25-34", "35-44", "45-54", "55+", "Unknown"]
              .map((band) => ({ label: band, value: m.byAge.find((a) => a.band === band)?.members ?? 0 }))
              .filter((a) => a.value > 0)}
          />
          {m.byGender.length > 0 && (
            <p className="text-xs text-charcoal-500">
              {m.byGender.map((g) => `${genderLabel[g.gender] ?? g.gender} ${g.members}`).join(" · ")}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function Expenses({ r, api, reload }: { r: OfficeReport; api: CloudApi; reload: () => void }) {
  const today = businessDate(new Date());
  const [form, setForm] = useState({
    id: crypto.randomUUID(),
    category: "wages" as ExpenseCategory,
    amount: "",
    spentOn: today,
    note: "",
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const amount = parsePeso(form.amount);
    if (!amount) return setErr("Enter the amount spent, for example 1500.");
    setBusy(true);
    setErr("");
    try {
      await api.rpc("record_expense", {
        p: { id: form.id, category: form.category, amount, spentOn: form.spentOn, note: form.note },
      });
      setForm({ ...form, id: crypto.randomUUID(), amount: "", note: "" });
      reload();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this expense?")) return;
    try {
      await api.rpc("delete_expense", { p_id: id });
      reload();
    } catch (x) {
      setErr(message(x));
    }
  }

  return (
    <Card title="Expenses">
      <form onSubmit={save} className="grid gap-2 sm:grid-cols-2" data-testid="expense-form">
        <Field label="What for">
          <select
            className={inputClass}
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as ExpenseCategory })}
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EXPENSE_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount (₱)">
          <input
            className={inputClass}
            inputMode="decimal"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="0.00"
          />
        </Field>
        <Field label="Date spent">
          <input
            type="date"
            className={inputClass}
            value={form.spentOn}
            max={today}
            onChange={(e) => setForm({ ...form, spentOn: e.target.value })}
          />
        </Field>
        <Field label="Note (optional)">
          <input
            className={inputClass}
            value={form.note}
            maxLength={200}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        <div className="sm:col-span-2">
          <ErrorText>{err}</ErrorText>
          <Button type="submit" disabled={busy} className="mt-1 w-full sm:w-auto">
            {busy ? "Saving…" : "Add expense"}
          </Button>
        </div>
      </form>
      <RankedBars
        testId="expenses-by-category"
        empty="No expenses recorded in this period."
        rows={r.expenses.byCategory.map((c) => ({ label: EXPENSE_LABEL[c.category], value: c.amount }))}
      />
      {r.expenses.list.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold text-charcoal-700">
            All {r.expenses.list.length} expenses in this period
          </summary>
          <ul className="mt-2 grid max-h-72 gap-1 overflow-auto" data-testid="expense-list">
            {r.expenses.list.map((x) => (
              <li key={x.id} className="flex items-center gap-2 border-t border-cream-200 pt-1">
                <span className="w-24 shrink-0 text-charcoal-500">{formatDate(x.spentOn)}</span>
                <span className="truncate">
                  {EXPENSE_LABEL[x.category]}
                  {x.note ? <span className="text-charcoal-500"> · {x.note}</span> : null}
                </span>
                <span className="ml-auto font-semibold tabular-nums">{formatPeso(x.amount)}</span>
                <button
                  type="button"
                  aria-label={`Delete expense ${x.note ?? EXPENSE_LABEL[x.category]}`}
                  onClick={() => remove(x.id)}
                  className="grid size-8 place-items-center rounded-full text-charcoal-500 hover:bg-cream-200"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function SaleLinesButton({ api, from, to, fileTag }: { api: CloudApi; from: string; to: string; fileTag: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        data-testid="csv-lines"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            const rows = await api.rpc<SaleLineRow[]>("office_sales_lines", { p_from: from, p_to: to });
            download(`sale-lines_${fileTag}.csv`, saleLinesCsv(rows));
          } catch (x) {
            setErr(message(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Preparing…" : "Every sale line"}
      </Button>
      {err && <ErrorText>{err}</ErrorText>}
    </>
  );
}
