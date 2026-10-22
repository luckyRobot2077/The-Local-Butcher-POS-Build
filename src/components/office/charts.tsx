"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { formatPeso } from "@/domain/money";

/**
 * Chart colours, checked for colour-blind separation and contrast on white:
 * a brand-leaning blue for sales and a lighter brand red for profit.
 */
export const SERIES = { sales: "#2f6aa0", profit: "#d0453a" } as const;
const GRID = "#ebe4d6";
const AXIS_TEXT = "#56606b";

/** Compact peso for axis ticks: ₱950, ₱12.5k, ₱1.2M. */
export function shortPeso(centavos: number): string {
  const p = centavos / 100;
  const abs = Math.abs(p);
  if (abs >= 1_000_000) return `₱${(p / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1000) return `₱${(p / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `₱${Math.round(p)}`;
}

function TipBox({ title, rows }: { title: string; rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-lg border border-cream-300 bg-white px-3 py-2 text-sm shadow-md">
      <p className="font-semibold text-charcoal-900">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center gap-2 text-charcoal-700">
          {r.color && <span className="inline-block size-2.5 rounded-full" style={{ background: r.color }} />}
          <span>{r.label}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums text-charcoal-900">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

const axisProps = {
  tick: { fill: AXIS_TEXT, fontSize: 12 },
  tickLine: false,
  axisLine: { stroke: GRID },
} as const;

export interface TrendRow {
  label: string;
  revenue: number;
  grossProfit: number;
  transactions: number;
}

/** Sales and gross profit over time: two lines sharing one peso axis. */
export function TrendChart({ data }: { data: TrendRow[] }) {
  return (
    <div className="h-64 w-full" data-testid="chart-trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} axisLine={false} tickFormatter={shortPeso} width={56} />
          <Tooltip
            cursor={{ stroke: AXIS_TEXT, strokeWidth: 1 }}
            content={(p: TooltipContentProps<ValueType, NameType>) =>
              p.active && p.payload?.length ? (
                <TipBox
                  title={String(p.label)}
                  rows={[
                    { label: "Sales", value: formatPeso(p.payload[0].payload.revenue), color: SERIES.sales },
                    {
                      label: "Gross profit",
                      value: formatPeso(p.payload[0].payload.grossProfit),
                      color: SERIES.profit,
                    },
                    { label: "Transactions", value: String(p.payload[0].payload.transactions) },
                  ]}
                />
              ) : null
            }
          />
          <Line
            type="linear"
            dataKey="revenue"
            name="Sales"
            stroke={SERIES.sales}
            strokeWidth={2}
            dot={data.length <= 31 ? { r: 3, strokeWidth: 0, fill: SERIES.sales } : false}
            activeDot={{ r: 5, stroke: "#fff", strokeWidth: 2 }}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="grossProfit"
            name="Gross profit"
            stroke={SERIES.profit}
            strokeWidth={2}
            dot={data.length <= 31 ? { r: 3, strokeWidth: 0, fill: SERIES.profit } : false}
            activeDot={{ r: 5, stroke: "#fff", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-4 text-sm text-charcoal-700">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export interface ColumnRow {
  label: string;
  value: number;
  detail?: string;
}

/** One series of vertical columns (sales by hour, by weekday). */
export function ColumnChart({
  data,
  testId,
  valueLabel = "Sales",
}: {
  data: ColumnRow[];
  testId: string;
  valueLabel?: string;
}) {
  return (
    <div className="h-52 w-full" data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={8} />
          <YAxis {...axisProps} axisLine={false} tickFormatter={shortPeso} width={56} />
          <Tooltip
            cursor={{ fill: "#f3eee4" }}
            content={(p: TooltipContentProps<ValueType, NameType>) =>
              p.active && p.payload?.length ? (
                <TipBox
                  title={String(p.label)}
                  rows={[
                    { label: valueLabel, value: formatPeso(p.payload[0].payload.value), color: SERIES.sales },
                    ...(p.payload[0].payload.detail ? [{ label: "", value: p.payload[0].payload.detail }] : []),
                  ]}
                />
              ) : null
            }
          />
          <Bar dataKey="value" fill={SERIES.sales} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface BarRow {
  label: string;
  value: number;
  detail?: string;
}

/**
 * Ranked horizontal bars with the name and value written beside each bar,
 * so the numbers are readable without hovering.
 */
export function RankedBars({
  rows,
  testId,
  format = formatPeso,
  empty = "Nothing in this period.",
}: {
  rows: BarRow[];
  testId: string;
  format?: (n: number) => string;
  empty?: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-charcoal-500">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="grid gap-2" data-testid={testId}>
      {rows.map((r) => (
        <li key={r.label} title={r.detail ? `${r.label}: ${format(r.value)} · ${r.detail}` : undefined}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate text-charcoal-900">{r.label}</span>
            <span className="shrink-0 font-semibold tabular-nums text-charcoal-900">{format(r.value)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-cream-200">
              <div
                className="h-2 rounded-full"
                style={{
                  width: `${Math.max((r.value / max) * 100, r.value > 0 ? 1.5 : 0)}%`,
                  background: SERIES.sales,
                }}
              />
            </div>
            {r.detail && <span className="w-24 shrink-0 text-right text-xs text-charcoal-500">{r.detail}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A two-part share bar (cash vs GCash, members vs walk-ins) with labels. */
export function ShareBar({
  parts,
  testId,
}: {
  parts: { label: string; value: number; color: string; detail: string }[];
  testId: string;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="grid gap-2" data-testid={testId}>
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-cream-200">
        {total > 0 &&
          parts.map((p) =>
            p.value > 0 ? (
              <div
                key={p.label}
                style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
                title={p.label}
              />
            ) : null,
          )}
      </div>
      <ul className="grid gap-1 text-sm">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-2">
            <span className="inline-block size-2.5 rounded-full" style={{ background: p.color }} />
            <span className="text-charcoal-700">{p.label}</span>
            <span className="ml-auto font-semibold tabular-nums text-charcoal-900">
              {total > 0 ? `${Math.round((p.value / total) * 100)}%` : "0%"}
            </span>
            <span className="w-32 text-right text-charcoal-500 tabular-nums">{p.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
