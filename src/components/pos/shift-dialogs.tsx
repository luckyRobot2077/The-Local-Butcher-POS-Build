"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { formatPeso, parsePeso } from "@/domain/money";
import { cashDifference, NO_SALE_REASONS, type Shift } from "@/domain/shift";
import { formatManila } from "@/domain/time";
import { closeShift, currentSummary, openShift, recordNoSale } from "@/lib/db/shifts";
import { Keypad } from "@/components/keypad";
import { Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import { usePos } from "./pos-context";

/** Peso amount typed on the keypad, e.g. "1000" or "1,250.50". */
function AmountEntry({
  label,
  text,
  onText,
  quick,
  testId,
}: {
  label: string;
  text: string;
  onText: (t: string) => void;
  quick: number[];
  testId: string;
}) {
  return (
    <div className="grid gap-2">
      <Field label={label}>
        <input
          className={`${inputClass} text-2xl font-bold`}
          inputMode="none"
          value={text}
          onChange={(e) => onText(e.target.value)}
          data-testid={testId}
        />
      </Field>
      <div className="grid grid-cols-4 gap-2">
        {quick.map((q) => (
          <Button key={q} variant="secondary" size="sm" onClick={() => onText(String(q / 100))}>
            {formatPeso(q).replace(".00", "")}
          </Button>
        ))}
      </div>
      <Keypad value={text} onChange={onText} compact testId={`${testId}-keys`} />
    </div>
  );
}

/** Starting a shift: who, and how much cash is in the drawer. Selling waits for it. */
export function OpenShiftDialog() {
  const { cashierName, employee } = usePos();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const amount = text.trim() === "" ? null : parsePeso(text);

  async function start() {
    if (amount === null) return setError("Enter the starting cash (0 if the drawer is empty).");
    setBusy(true);
    try {
      await openShift({ openingFloat: amount, by: cashierName, employeeId: employee?.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => {}}
      title="Start a shift"
      footer={
        <div className="flex justify-end">
          <Button size="lg" onClick={start} disabled={busy || amount === null} data-testid="open-shift">
            Start shift
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <p className="text-charcoal-700">
          <span className="font-semibold text-charcoal-900">{cashierName}</span>, count the cash in the drawer before
          the first sale. The time is saved with your name.
        </p>
        <AmountEntry
          label="Starting cash in the drawer (₱)"
          text={text}
          onText={(t) => (setText(t), setError(undefined))}
          quick={[0, 50000, 100000, 200000]}
          testId="opening-float"
        />
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

/** The open shift: its totals so far, opening the drawer without a sale, and closing. */
export function ShiftDialog({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const [step, setStep] = useState<"menu" | "noSale" | "close">("menu");
  const summary = useLiveQuery(() => currentSummary(shift), [shift.id]);
  if (step === "noSale") return <NoSaleDialog onClose={onClose} />;
  if (step === "close") return <CloseShiftDialog shift={shift} onClose={onClose} />;
  return (
    <Modal open onClose={onClose} title="Shift">
      <div className="grid gap-3" data-testid="shift-panel">
        <p className="text-charcoal-700">
          Started {formatManila(shift.openedAt)} by <span className="font-semibold">{shift.openedBy}</span> with{" "}
          {formatPeso(shift.openingFloat)} in the drawer.
        </p>
        {summary && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-white p-3 text-sm">
            <dt>Sales</dt>
            <dd className="text-right font-semibold">{summary.saleCount}</dd>
            <dt>Cash sales</dt>
            <dd className="text-right font-semibold">{formatPeso(summary.cashSales)}</dd>
            <dt>GCash sales</dt>
            <dd className="text-right font-semibold">{formatPeso(summary.gcashSales)}</dd>
            <dt>Drawer opened without a sale</dt>
            <dd className="text-right font-semibold">{summary.noSaleCount}</dd>
          </dl>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="secondary" size="lg" onClick={() => setStep("noSale")} data-testid="no-sale">
            Open drawer (no sale)
          </Button>
          <Button size="lg" onClick={() => setStep("close")} data-testid="close-shift">
            Close shift
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Logs the drawer opened without a sale, with a reason and an owner or manager approval. */
function NoSaleDialog({ onClose }: { onClose: () => void }) {
  const { cashierName, requestApproval } = usePos();
  const [reason, setReason] = useState<string>(NO_SALE_REASONS[0]);
  const [other, setOther] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const why = reason === "Other" ? other.trim() : reason;

  async function submit() {
    setError(undefined);
    if (!why) return setError("Write why the drawer is being opened.");
    const by = await requestApproval(`Opening the drawer without a sale: ${why}.`);
    if (!by) return;
    try {
      await recordNoSale({ reason: why, by: cashierName, approvedBy: by });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal open onClose={onClose} title="Open drawer (no sale)">
      {done ? (
        <div className="grid gap-3" data-testid="no-sale-done">
          <p className="font-semibold text-emerald-800">Logged with the time, your name and who approved it.</p>
          <p className="text-sm text-charcoal-700">
            Open the drawer with its key for now. Once a receipt printer with a drawer port is connected, the app will
            open it.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold text-charcoal-700">Why?</legend>
            {[...NO_SALE_REASONS, "Other"].map((r) => (
              <label
                key={r}
                className="flex min-h-11 items-center gap-3 rounded-xl border border-cream-300 bg-white px-3"
              >
                <input
                  type="radio"
                  name="no-sale-reason"
                  className="size-5 accent-burgundy-700"
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                {r}
              </label>
            ))}
          </fieldset>
          {reason === "Other" && (
            <Field label="Reason">
              <input
                className={inputClass}
                value={other}
                maxLength={120}
                onChange={(e) => setOther(e.target.value)}
                data-testid="no-sale-other"
              />
            </Field>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} data-testid="no-sale-confirm">
              Log and open
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Counting the drawer at the end of the shift; the expected cash is shown after the count. */
function CloseShiftDialog({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const { cashierName } = usePos();
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<Shift>();
  const counted = text.trim() === "" ? null : parsePeso(text);

  async function submit() {
    if (counted === null) return setError("Enter the cash counted.");
    setBusy(true);
    try {
      setClosed(await closeShift({ countedCash: counted, by: cashierName, note }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    const diff = cashDifference(closed.countedCash!, closed.expectedCash!);
    return (
      <Modal open onClose={onClose} title="Shift closed">
        <div className="grid gap-3" data-testid="shift-closed">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-white p-3">
            <dt>Started</dt>
            <dd className="text-right">{formatManila(closed.openedAt)}</dd>
            <dt>Closed</dt>
            <dd className="text-right">{formatManila(closed.closedAt!)}</dd>
            <dt>Sales</dt>
            <dd className="text-right">{closed.saleCount}</dd>
            <dt>Starting cash</dt>
            <dd className="text-right">{formatPeso(closed.openingFloat)}</dd>
            <dt>Cash sales</dt>
            <dd className="text-right">{formatPeso(closed.cashSales!)}</dd>
            <dt>GCash sales</dt>
            <dd className="text-right">{formatPeso(closed.gcashSales!)}</dd>
            <dt className="font-semibold">Expected in drawer</dt>
            <dd className="text-right font-semibold" data-testid="expected-cash">
              {formatPeso(closed.expectedCash!)}
            </dd>
            <dt className="font-semibold">Counted</dt>
            <dd className="text-right font-semibold">{formatPeso(closed.countedCash!)}</dd>
          </dl>
          <p
            className={`rounded-xl px-3 py-2 text-lg font-bold ${
              diff === 0 ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"
            }`}
            data-testid="cash-difference"
          >
            {diff === 0 ? "Exact" : diff > 0 ? `Over by ${formatPeso(diff)}` : `Short by ${formatPeso(-diff)}`}
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose} data-testid="shift-closed-done">
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Close shift"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || counted === null} data-testid="confirm-close-shift">
            Close shift
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <p className="text-sm text-charcoal-700">
          Count all the cash in the drawer, including the {formatPeso(shift.openingFloat)} starting cash.
        </p>
        <AmountEntry
          label="Cash counted (₱)"
          text={text}
          onText={(t) => (setText(t), setError(undefined))}
          quick={[]}
          testId="counted-cash"
        />
        <Field label="Note (optional)">
          <input className={inputClass} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
