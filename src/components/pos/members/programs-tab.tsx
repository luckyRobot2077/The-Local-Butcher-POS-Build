"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { z } from "zod";
import { centavosToInput, parsePeso } from "@/domain/money";
import { parsePercent } from "@/domain/discount";
import { type DiscountProgram, describeProgram, isProgramCurrent } from "@/domain/programs";
import { businessDate } from "@/domain/time";
import { getDb } from "@/lib/db/db";
import { listCategories } from "@/lib/db/products";
import { listPrograms, saveProgram, type ProgramInput } from "@/lib/db/programs";
import { Badge, Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import { usePos } from "../pos-context";

/** Discount programs the cashier picks from at checkout. Setting them up needs the manager PIN. */
export function ProgramsTab() {
  const { requestManager } = usePos();
  const programs = useLiveQuery(() => listPrograms(), []);
  const [editing, setEditing] = useState<DiscountProgram | "new" | null>(null);
  const today = businessDate(new Date());

  async function open(p: DiscountProgram | "new") {
    if (await requestManager("Setting up discount programs needs manager approval.")) setEditing(p);
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-charcoal-700">
          Programs appear in the <span className="font-semibold">Discount program</span> list at checkout. The cashier
          only picks one; the rules here decide what it applies to, so no PIN is needed at the counter.
        </p>
        <Button onClick={() => open("new")} data-testid="new-program">
          New program
        </Button>
      </div>
      <ul className="divide-y divide-cream-200 rounded-xl bg-white shadow-sm" data-testid="program-list">
        {programs?.length === 0 && (
          <li className="p-6 text-center text-charcoal-500">
            No programs yet. Examples: “Member 5% off”, “Pork week 10% on pork”, “₱50 off ₱1,000+”.
          </li>
        )}
        {programs?.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-cream-50"
              onClick={() => open(p)}
            >
              <span>
                <span className="block font-semibold">{p.name}</span>
                <span className="text-xs text-charcoal-500">{describeProgram(p)}</span>
              </span>
              {isProgramCurrent(p, today) ? (
                <Badge tone="ok">Running</Badge>
              ) : (
                <Badge tone="neutral">{p.active ? "Not today" : "Off"}</Badge>
              )}
            </button>
          </li>
        ))}
      </ul>
      {editing && <ProgramEditor program={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProgramEditor({ program, onClose }: { program?: DiscountProgram; onClose: () => void }) {
  const { cashierName } = usePos();
  const categories = useLiveQuery(() => listCategories(), []);
  const products = useLiveQuery(
    async () => (await getDb().products.toArray()).filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );
  const [name, setName] = useState(program?.name ?? "");
  const [description, setDescription] = useState(program?.description ?? "");
  const [kind, setKind] = useState<"percent" | "fixed">(program?.input.kind ?? "percent");
  const [value, setValue] = useState(
    program
      ? program.input.kind === "percent"
        ? String(program.input.basisPoints / 100)
        : centavosToInput(program.input.amount)
      : "",
  );
  const [scope, setScope] = useState<"order" | "items">(program?.scope ?? "order");
  const [categoryIds, setCategoryIds] = useState<string[]>(program?.categoryIds ?? []);
  const [productIds, setProductIds] = useState<string[]>(program?.productIds ?? []);
  const [membersOnly, setMembersOnly] = useState(program?.membersOnly ?? false);
  const [minPurchase, setMinPurchase] = useState(program?.minPurchase ? centavosToInput(program.minPurchase) : "");
  const [startsOn, setStartsOn] = useState(program?.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(program?.endsOn ?? "");
  const [active, setActive] = useState(program?.active ?? true);
  const [error, setError] = useState<string>();

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function save() {
    setError(undefined);
    const bp = kind === "percent" ? parsePercent(value) : null;
    const amount = kind === "fixed" ? parsePeso(value) : null;
    if (kind === "percent" && !bp) return setError("Enter a percentage above 0, up to 100.");
    if (kind === "fixed" && !amount) return setError("Enter the peso amount off.");
    const min = minPurchase.trim() ? parsePeso(minPurchase) : 0;
    if (min === null) return setError("Enter the minimum purchase in pesos, or leave it empty.");
    const input: ProgramInput = {
      name,
      description,
      input: kind === "percent" ? { kind, basisPoints: bp! } : { kind, amount: amount! },
      scope,
      productIds,
      categoryIds,
      membersOnly,
      minPurchase: min,
      startsOn: startsOn || undefined,
      endsOn: endsOn || undefined,
      active,
    };
    try {
      await saveProgram(input, cashierName || "manager", program?.id);
      onClose();
    } catch (e) {
      setError(e instanceof z.ZodError ? e.issues[0]?.message : e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={program ? `Edit ${program.name}` : "New discount program"}
      wide
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} data-testid="program-save">
            Save program
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label="Name" hint="Shown in the checkout list and printed on the receipt.">
          <input
            className={inputClass}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            data-testid="program-name"
          />
        </Field>
        <Field label="Description (optional)">
          <input
            className={inputClass}
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Applies to">
            <select
              className={inputClass}
              value={scope}
              onChange={(e) => {
                const s = e.target.value as "order" | "items";
                setScope(s);
                if (s === "items") setKind("percent");
              }}
              data-testid="program-scope"
            >
              <option value="order">The whole sale</option>
              <option value="items">Selected items (percentage)</option>
            </select>
          </Field>
          <Field label={kind === "percent" ? "Percent off" : "Pesos off"}>
            <div className="flex gap-2">
              <select
                className={`${inputClass} w-24`}
                value={kind}
                disabled={scope === "items"}
                onChange={(e) => setKind(e.target.value as "percent" | "fixed")}
                aria-label="Discount type"
              >
                <option value="percent">%</option>
                <option value="fixed">₱</option>
              </select>
              <input
                className={inputClass}
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                data-testid="program-value"
              />
            </div>
          </Field>
        </div>
        {scope === "items" && (
          <div className="grid gap-2 rounded-xl bg-white p-3">
            <p className="text-sm text-charcoal-700">
              Pick categories and/or products. Leave both empty for every product. Items that already have a typed
              discount are skipped.
            </p>
            <div className="flex flex-wrap gap-2">
              {categories?.map((c) => (
                <label key={c.id} className="flex items-center gap-2 rounded-full bg-cream-100 px-3 py-1 text-sm">
                  <input
                    type="checkbox"
                    checked={categoryIds.includes(c.id)}
                    onChange={() => setCategoryIds((l) => toggle(l, c.id))}
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-burgundy-700">
                Products ({productIds.length} chosen)
              </summary>
              <div className="mt-2 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
                {products?.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={productIds.includes(p.id)}
                      onChange={() => setProductIds((l) => toggle(l, p.id))}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </details>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Minimum purchase (₱)" hint="Before discounts. Empty = none.">
            <input
              className={inputClass}
              inputMode="decimal"
              value={minPurchase}
              onChange={(e) => setMinPurchase(e.target.value)}
            />
          </Field>
          <Field label="Starts on (optional)">
            <input className={inputClass} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Ends on (optional)">
            <input className={inputClass} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={membersOnly}
            onChange={(e) => setMembersOnly(e.target.checked)}
            data-testid="program-members-only"
          />
          Members only (a member card must be scanned)
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-5" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Switched on
        </label>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
