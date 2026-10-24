"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ErrorText, Field, inputClass } from "@/components/ui";
import { CloudRejection, type CloudApi } from "@/lib/cloud/api";
import { formatPeso } from "@/domain/money";
import { businessDate, formatManila } from "@/domain/time";
import { taxPeriodsCsv } from "@/domain/office";
import {
  DEFAULT_TAX_SETTINGS,
  TAX_RANGE_PRESETS,
  TAX_CLASS_LABEL,
  TAX_MODE_LABEL,
  categoryClass,
  formatRateBp,
  normalizeTaxSettings,
  taxPeriods,
  taxRange,
  type TaxClass,
  type TaxMode,
  type TaxRangePreset,
  type TaxReport,
  type TaxSettings,
} from "@/domain/tax";

const NEEDS_MIGRATION = "The cloud database needs migration 13 (20261031000013_taxes.sql) before taxes work here.";

function message(e: unknown): string {
  if (e instanceof CloudRejection) {
    return /store_tax_settings|save_tax_settings|office_tax_report|PGRST202|schema cache|needs an update/i.test(
      e.message + (e.code ?? ""),
    )
      ? NEEDS_MIGRATION
      : e.message;
  }
  return "Could not reach the cloud. Check the internet connection and try again.";
}

interface CatRow {
  id: string;
  name: string;
  sort_order: number;
}
interface ProductRow {
  id: string;
  name: string;
  category_id: string;
  active: boolean;
}

/** Store tax setup (owner only) and the VAT / percentage tax report. */
export function TaxesPage({
  api,
  canEdit,
  onCsv,
}: {
  api: CloudApi;
  canEdit: boolean;
  onCsv: (name: string, csv: string) => void;
}) {
  const [saved, setSaved] = useState<TaxSettings | null>(null);
  const [cats, setCats] = useState<CatRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const [tax, c, p] = await Promise.all([
        api.rpc<unknown>("store_tax_settings", {}),
        api.select<CatRow>("categories", "id,name,sort_order"),
        api.select<ProductRow>("products", "id,name,category_id,active"),
      ]);
      setSaved(normalizeTaxSettings(tax));
      setCats(c.sort((a, b) => a.sort_order - b.sort_order));
      setProducts(p.filter((x) => x.active).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      setErr(message(e));
    }
  }, [api]);

  useEffect(() => {
    // Fetches the tax setup, categories and products once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="grid gap-4" data-testid="office-taxes">
      <TaxGuide />
      <ErrorText>{err}</ErrorText>
      {saved && (
        <TaxSetup api={api} saved={saved} cats={cats} products={products} canEdit={canEdit} onSaved={setSaved} />
      )}
      <TaxReportSection api={api} settings={saved ?? DEFAULT_TAX_SETTINGS} onCsv={onCsv} />
    </div>
  );
}

function TaxGuide() {
  return (
    <details className="rounded-2xl border border-cream-300 bg-white p-4 text-sm text-charcoal-700" open>
      <summary className="cursor-pointer font-semibold text-charcoal-900">How sales tax works for the shop</summary>
      <ul className="mt-2 grid list-disc gap-1 pl-5">
        <li>
          <strong>Fresh meat, poultry, fish and other fresh goods are VAT-exempt.</strong> They stay exempt when frozen,
          chilled, salted, dried, smoked or roasted for sale (Tax Code Sec. 109).
        </li>
        <li>
          <strong>Condiments, sauces, side dishes, cooked food, drinks and supplies are VATable at 12%.</strong>{" "}
          Processed meats with added ingredients (longganisa, tocino, hotdogs) are usually VATable too.
        </li>
        <li>
          <strong>Not VAT-registered</strong> (sales up to ₱3,000,000 a year): prices carry no VAT and the shop pays 3%
          percentage tax on its total sales each quarter (BIR Form 2551Q).
        </li>
        <li>
          <strong>VAT-registered:</strong> shelf prices include 12% VAT on VATable items, and receipts show VATable
          sales, VAT and VAT-exempt sales separately (BIR Form 2550Q).
        </li>
      </ul>
      <p className="mt-2 text-xs text-charcoal-500">
        This is a guide, not tax advice. Check the setup with your accountant, especially for processed or marinated
        items. Official BIR receipts from a POS also need the POS registered with the BIR first.
      </p>
    </details>
  );
}

function TaxSetup({
  api,
  saved,
  cats,
  products,
  canEdit,
  onSaved,
}: {
  api: CloudApi;
  saved: TaxSettings;
  cats: CatRow[];
  products: ProductRow[];
  canEdit: boolean;
  onSaved: (s: TaxSettings) => void;
}) {
  const [draft, setDraft] = useState<TaxSettings>(saved);
  const [vatRate, setVatRate] = useState(String(saved.vatRateBp / 100));
  const [ptRate, setPtRate] = useState(String(saved.percentageTaxBp / 100));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const catById = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);

  const set = (patch: Partial<TaxSettings>) => {
    setDone(false);
    setDraft((d) => ({ ...d, ...patch }));
  };

  async function save() {
    setErr("");
    const vatBp = Math.round(Number(vatRate) * 100);
    const ptBp = Math.round(Number(ptRate) * 100);
    if (!Number.isFinite(vatBp) || vatBp < 0 || vatBp > 5000 || !Number.isFinite(ptBp) || ptBp < 0 || ptBp > 5000) {
      return setErr("Tax rates must be between 0% and 50%.");
    }
    if (draft.mode === "vat" && draft.tin.replace(/\D/g, "").length < 9) {
      return setErr("A VAT-registered shop must enter its TIN (at least 9 digits).");
    }
    // Every category is saved with its class so a later change to the name guess never changes taxes.
    const categories = Object.fromEntries(cats.map((c) => [c.id, categoryClass(draft, c)]));
    setBusy(true);
    try {
      const r = await api.rpc<unknown>("save_tax_settings", {
        p: { ...draft, vatRateBp: vatBp, percentageTaxBp: ptBp, categories },
      });
      const next = normalizeTaxSettings(r);
      setDraft(next);
      onSaved(next);
      setDone(true);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-4 rounded-2xl border border-cream-300 bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-bold">Tax setup</h2>
        <span className="text-xs text-charcoal-500">
          {saved.updatedAt
            ? `Saved ${formatManila(saved.updatedAt)} by ${saved.updatedBy ?? "the owner"}. Devices pick it up on their next sync.`
            : "Not saved yet: every device treats the shop as not VAT-registered."}
        </span>
      </div>
      {!canEdit && <p className="text-sm text-charcoal-700">Only the owner can change the tax setup.</p>}
      <fieldset disabled={!canEdit || busy} className="grid gap-4">
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="VAT registration">
          {(["non_vat", "vat"] as TaxMode[]).map((m) => (
            <label
              key={m}
              className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm ${
                draft.mode === m ? "border-burgundy-700 bg-cream-50" : "border-cream-300"
              }`}
            >
              <input
                type="radio"
                name="tax-mode"
                checked={draft.mode === m}
                onChange={() => set({ mode: m })}
                data-testid={`tax-mode-${m}`}
                className="mt-1"
              />
              <span>
                <span className="font-semibold">{TAX_MODE_LABEL[m]}</span>
                <span className="block text-xs text-charcoal-500">
                  {m === "vat"
                    ? "Your BIR Form 2303 lists Value-Added Tax. Receipts split VATable sales, VAT and exempt sales."
                    : "Your BIR Form 2303 lists Percentage Tax. Receipts show no VAT; the report shows the 3% due."}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="TIN" hint="As printed on BIR Form 2303, e.g. 123-456-789-00000. Printed on receipts.">
            <input
              className={inputClass}
              value={draft.tin}
              maxLength={20}
              inputMode="numeric"
              onChange={(e) => set({ tin: e.target.value.replace(/[^0-9 -]/g, "") })}
              data-testid="tax-tin"
            />
          </Field>
          <Field label="Registered business name" hint="For invoices to businesses. Leave blank to use the store name.">
            <input
              className={inputClass}
              value={draft.registeredName}
              maxLength={80}
              onChange={(e) => set({ registeredName: e.target.value })}
            />
          </Field>
          <Field label="Registered address">
            <input
              className={inputClass}
              value={draft.registeredAddress}
              maxLength={160}
              onChange={(e) => set({ registeredAddress: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="VAT rate (%)" hint="12% by law">
              <input
                className={inputClass}
                value={vatRate}
                inputMode="decimal"
                onChange={(e) => (setDone(false), setVatRate(e.target.value))}
              />
            </Field>
            <Field label="Percentage tax (%)" hint="3% by law">
              <input
                className={inputClass}
                value={ptRate}
                inputMode="decimal"
                onChange={(e) => (setDone(false), setPtRate(e.target.value))}
              />
            </Field>
          </div>
        </div>

        <div className="grid gap-2">
          <h3 className="font-semibold">Categories</h3>
          <p className="text-xs text-charcoal-500">
            Only matters when the shop is VAT-registered. New categories start from a guess based on their name until
            you save.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {cats.map((c) => (
              <label
                key={c.id}
                className="flex items-center gap-2 rounded-xl border border-cream-300 px-3 py-2 text-sm"
                data-testid="tax-category"
              >
                <span className="flex-1 font-semibold">{c.name}</span>
                <select
                  className="rounded-lg border border-cream-300 bg-white px-2 py-1"
                  value={categoryClass(draft, c)}
                  onChange={(e) => set({ categories: { ...draft.categories, [c.id]: e.target.value as TaxClass } })}
                  aria-label={`${c.name} tax`}
                >
                  <option value="exempt">{TAX_CLASS_LABEL.exempt}</option>
                  <option value="vatable">{TAX_CLASS_LABEL.vatable}</option>
                </select>
                {!draft.categories[c.id] && (
                  <span className="text-[10px] uppercase text-charcoal-500" title="Guessed from the name">
                    guess
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>

        <details className="grid gap-2">
          <summary className="cursor-pointer font-semibold">
            Products taxed differently from their category ({Object.keys(draft.products).length})
          </summary>
          <p className="mt-1 text-xs text-charcoal-500">
            For example a marinated or processed item inside a fresh meat category.
          </p>
          <div className="mt-2 grid max-h-96 gap-1 overflow-y-auto">
            {products.map((p) => {
              const cat = catById.get(p.category_id);
              const own = draft.products[p.id];
              return (
                <label key={p.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-cream-50">
                  <span className="flex-1">
                    {p.name} <span className="text-xs text-charcoal-500">{cat?.name}</span>
                  </span>
                  <select
                    className="rounded-lg border border-cream-300 bg-white px-2 py-1"
                    value={own ?? ""}
                    aria-label={`${p.name} tax`}
                    onChange={(e) => {
                      const next = { ...draft.products };
                      if (e.target.value) next[p.id] = e.target.value as TaxClass;
                      else delete next[p.id];
                      set({ products: next });
                    }}
                  >
                    <option value="">Same as category ({TAX_CLASS_LABEL[categoryClass(draft, cat)]})</option>
                    <option value="exempt">{TAX_CLASS_LABEL.exempt}</option>
                    <option value="vatable">{TAX_CLASS_LABEL.vatable}</option>
                  </select>
                </label>
              );
            })}
          </div>
        </details>
      </fieldset>
      <ErrorText>{err}</ErrorText>
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={busy} data-testid="tax-save">
            {busy ? "Saving…" : "Save tax setup"}
          </Button>
          {done && (
            <span className="text-sm text-emerald-800" data-testid="tax-saved">
              Saved. Sync each device to use it.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function TaxReportSection({
  api,
  settings,
  onCsv,
}: {
  api: CloudApi;
  settings: TaxSettings;
  onCsv: (name: string, csv: string) => void;
}) {
  const today = businessDate(new Date());
  const [preset, setPreset] = useState<TaxRangePreset>("year");
  const [grain, setGrain] = useState<"quarters" | "months">("quarters");
  const range = useMemo(() => taxRange(preset, today), [preset, today]);
  const [report, setReport] = useState<TaxReport | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      setReport(await api.rpc<TaxReport>("office_tax_report", { p_from: range.from, p_to: range.to }));
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

  const periods = report ? taxPeriods(report, settings.percentageTaxBp)[grain] : [];
  const pt = formatRateBp(settings.percentageTaxBp);
  const anyVat = periods.some((p) => p.vatableSales + p.vatAmount + p.vatExemptSales > 0);

  return (
    <section className="grid gap-3 rounded-2xl border border-cream-300 bg-white p-4" data-testid="tax-report">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-lg font-bold">Tax report</h2>
        {TAX_RANGE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={preset === p.id}
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
          <select
            className="rounded-lg border border-cream-300 bg-white px-2 py-1 text-sm"
            value={grain}
            onChange={(e) => setGrain(e.target.value as "quarters" | "months")}
            aria-label="Group by"
          >
            <option value="quarters">By quarter</option>
            <option value="months">By month</option>
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!periods.length}
            onClick={() =>
              onCsv(
                `taxes_${grain}_${range.from || "start"}_to_${range.to}.csv`,
                taxPeriodsCsv(periods, settings.percentageTaxBp),
              )
            }
            data-testid="tax-csv"
          >
            Download CSV
          </Button>
          <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>
      <ErrorText>{err}</ErrorText>
      {report && periods.length === 0 && <p className="text-center text-charcoal-500">No sales in this range.</p>}
      {periods.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-xs uppercase text-charcoal-500">
              <tr>
                <th className="py-1 pr-3">{grain === "quarters" ? "Quarter" : "Month"}</th>
                <th className="py-1 pr-3 text-right">Gross sales</th>
                <th className="py-1 pr-3 text-right">Non-VAT sales</th>
                <th className="py-1 pr-3 text-right">Percentage tax ({pt})</th>
                {anyVat && (
                  <>
                    <th className="py-1 pr-3 text-right">VATable (excl. VAT)</th>
                    <th className="py-1 pr-3 text-right">VAT</th>
                    <th className="py-1 text-right">VAT-exempt</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.period} className="border-t border-cream-200" data-testid="tax-period">
                  <td className="py-1 pr-3 font-semibold">{p.period}</td>
                  <td className="py-1 pr-3 text-right">{formatPeso(p.gross)}</td>
                  <td className="py-1 pr-3 text-right">{formatPeso(p.nonVatSales)}</td>
                  <td className="py-1 pr-3 text-right font-semibold">{formatPeso(p.percentageTax)}</td>
                  {anyVat && (
                    <>
                      <td className="py-1 pr-3 text-right">{formatPeso(p.vatableSales)}</td>
                      <td className="py-1 pr-3 text-right font-semibold">{formatPeso(p.vatAmount)}</td>
                      <td className="py-1 text-right">{formatPeso(p.vatExemptSales)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report && report.categories.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">By category</summary>
          <table className="mt-2 w-full text-sm tabular-nums">
            <thead className="text-left text-xs uppercase text-charcoal-500">
              <tr>
                <th className="py-1 pr-3">Category</th>
                <th className="py-1 pr-3 text-right">Sales</th>
                <th className="py-1 pr-3 text-right">VATable sales</th>
                <th className="py-1 pr-3 text-right">VAT</th>
                <th className="py-1 text-right">VAT-exempt</th>
              </tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <tr key={c.category_id ?? c.name} className="border-t border-cream-200">
                  <td className="py-1 pr-3">{c.name}</td>
                  <td className="py-1 pr-3 text-right">{formatPeso(Number(c.gross))}</td>
                  <td className="py-1 pr-3 text-right">{formatPeso(Number(c.vatable_gross))}</td>
                  <td className="py-1 pr-3 text-right">{formatPeso(Number(c.vat))}</td>
                  <td className="py-1 text-right">{formatPeso(Number(c.exempt_gross))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <p className="text-xs text-charcoal-500">
        Sales reach this report after each device syncs. Sales made before the tax setup count as non-VAT. The
        percentage tax is {pt} of non-VAT sales; check the amounts with your accountant before filing.
      </p>
    </section>
  );
}
