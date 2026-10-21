"use client";

import { useState } from "react";
import { DEFAULT_INVENTORY_RULES, type InventoryRules } from "@/domain/inventory";
import { saveSettings } from "@/lib/db/config";
import { Button, ErrorText, Field, inputClass } from "@/components/ui";
import { usePos } from "../pos-context";

const FIELDS: { key: keyof InventoryRules; label: string; hint: string }[] = [
  { key: "periodDays", label: "Main period (days)", hint: "How far back the reports look. The spec default is 30." },
  { key: "fastPct", label: "Fast-moving share (%)", hint: "Top share of similar products called fast." },
  { key: "slowPct", label: "Slow-moving share (%)", hint: "Bottom share of similar products called slow." },
  { key: "minHistoryDays", label: "History needed (days)", hint: "Days in stock before a product is ranked." },
  { key: "nonMovingDays", label: "No-sales alert (days)", hint: "Days in stock without a sale." },
  { key: "minGroupSize", label: "Smallest group to rank", hint: "Fewer similar products than this are not ranked." },
  { key: "trendPct", label: "Demand change alert (%)", hint: "Last 7 days vs the 4 weeks before." },
  { key: "stockoutDays", label: "Running-out alert (days)", hint: "Fast sellers with less stock than this." },
  { key: "excessCoverageDays", label: "Too-much-stock alert (days)", hint: "Slow sellers with more stock than this." },
  { key: "useByWarnDays", label: "Use-by warning (days)", hint: "Warn this many days before the use-by date." },
  { key: "leadTimeDays", label: "Supplier lead time (days)", hint: "Used for order estimates." },
  { key: "orderCoverDays", label: "Order covers (days)", hint: "Days of sales an order should cover." },
  { key: "safetyDays", label: "Safety stock (days)", hint: "Extra days of sales kept in reserve." },
];

export function RulesTab() {
  const { settings } = usePos();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, String(settings.inventoryRules[f.key])])),
  );
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(undefined);
    setSaved(false);
    const rules = Object.fromEntries(FIELDS.map((f) => [f.key, Number(values[f.key])])) as unknown as InventoryRules;
    try {
      await saveSettings({ ...settings, inventoryRules: rules });
      setSaved(true);
    } catch {
      setError("Check the numbers: each must be a whole number in a sensible range.");
    }
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-3 rounded-xl bg-white p-3 shadow-sm">
      <h2 className="text-lg font-bold text-burgundy-800">Inventory rules</h2>
      <p className="text-sm text-charcoal-700">
        These thresholds decide how products are classified and when alerts appear. They are saved on this device.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <input
              className={inputClass}
              inputMode="numeric"
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </Field>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      {saved && <p className="text-sm font-semibold text-emerald-800">Saved.</p>}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            setValues(Object.fromEntries(FIELDS.map((f) => [f.key, String(DEFAULT_INVENTORY_RULES[f.key])])))
          }
        >
          Reset to defaults
        </Button>
        <Button onClick={save}>Save rules</Button>
      </div>
    </div>
  );
}
