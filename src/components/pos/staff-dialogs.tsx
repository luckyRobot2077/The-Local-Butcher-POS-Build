"use client";

import { useRef, useState, type FormEvent } from "react";
import { Keypad } from "@/components/keypad";
import { Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import {
  ROLE_LABEL,
  checkApproverCode,
  checkEmployeePin,
  findByBadge,
  looksLikeBadge,
  type LocalEmployee,
  type SignedInEmployee,
} from "@/lib/staff/employees";
import { QrScanner } from "./members/qr-scanner";

const MAX_PIN_TRIES = 5;
const PIN_LOCK_MS = 60_000;

/**
 * Reads an employee badge: a handheld scanner types into the field (no
 * on-screen keyboard pops up), or the camera reads the QR code.
 */
export function BadgeReader({
  onBadge,
  label = "Scan your badge",
}: {
  onBadge: (text: string) => void;
  label?: string;
}) {
  const [camera, setCamera] = useState(false);
  const [text, setText] = useState("");
  return (
    <div className="grid gap-2">
      {camera ? (
        <QrScanner onResult={(t) => onBadge(t)} />
      ) : (
        <Button variant="secondary" size="lg" onClick={() => setCamera(true)} data-testid="badge-camera">
          {label} with the camera
        </Button>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onBadge(text.trim());
          setText("");
        }}
      >
        <Field label="Or use a handheld scanner" hint="Point the scanner at the badge; it types the code here.">
          <input
            className={inputClass}
            inputMode="none"
            autoComplete="off"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="badge-input"
            aria-label="Badge code"
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </div>
  );
}

/** Opens the POS for an employee: badge, then their personal PIN. */
export function StaffSignInDialog({ onSignedIn }: { onSignedIn: (e: LocalEmployee) => void }) {
  const [employee, setEmployee] = useState<LocalEmployee>();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const tries = useRef(new Map<string, { count: number; until: number }>());

  async function onBadge(text: string) {
    setError(undefined);
    if (!looksLikeBadge(text)) return setError("That is not an employee badge.");
    const e = await findByBadge(text);
    if (!e) return setError("This badge is not recognised. If it is new, sync this device and try again.");
    if (!e.pin) return setError(`${e.name} has no PIN yet. The owner sets it in the Back Office.`);
    setEmployee(e);
    setPin("");
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!employee) return;
    const t = tries.current.get(employee.id) ?? { count: 0, until: 0 };
    if (t.until > Date.now()) return setError("Too many wrong PINs. Wait a minute and try again.");
    setBusy(true);
    try {
      if (await checkEmployeePin(employee, pin)) {
        tries.current.delete(employee.id);
        onSignedIn(employee);
      } else {
        t.count++;
        if (t.count >= MAX_PIN_TRIES) {
          t.count = 0;
          t.until = Date.now() + PIN_LOCK_MS;
        }
        tries.current.set(employee.id, t);
        setError("Wrong PIN.");
        setPin("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => {}} title="Sign in to the POS">
      {employee ? (
        <form onSubmit={submit} className="grid gap-3" data-testid="staff-pin-form">
          <p className="text-charcoal-700">
            <span className="font-semibold text-charcoal-900">{employee.name}</span> · {ROLE_LABEL[employee.role]} ·{" "}
            <span className="font-mono text-sm">{employee.employeeNo}</span>
          </p>
          <Field label="Your PIN">
            <input
              className={inputClass}
              type="password"
              inputMode="none"
              autoComplete="off"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
              aria-label="Your PIN"
              data-testid="staff-pin"
            />
          </Field>
          <Keypad value={pin} onChange={(v) => setPin(v.replace(/\D/g, "").slice(0, 8))} decimal={false} compact />
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-between gap-2">
            <Button variant="secondary" onClick={() => (setEmployee(undefined), setError(undefined))}>
              Different badge
            </Button>
            <Button type="submit" disabled={busy || pin.length < 4}>
              Start selling
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-3">
          <p className="text-charcoal-700">Scan your employee badge to start.</p>
          <BadgeReader onBadge={(t) => void onBadge(t)} />
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Modal>
  );
}

/**
 * Owner or manager approval with the authenticator app: the signed-in
 * owner/manager only types the code; anyone else first scans an owner or
 * manager badge.
 */
export function ApproveWithCodeDialog({
  reason,
  current,
  approvers,
  onDone,
}: {
  reason: string;
  current?: SignedInEmployee;
  approvers: LocalEmployee[];
  onDone: (approvedBy?: LocalEmployee) => void;
}) {
  const self = approvers.find((a) => a.id === current?.id);
  const [approver, setApprover] = useState<LocalEmployee | undefined>(self);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function onBadge(text: string) {
    setError(undefined);
    const e = looksLikeBadge(text) ? await findByBadge(text) : undefined;
    const a = e && approvers.find((x) => x.id === e.id);
    if (!e) return setError("This badge is not recognised.");
    if (!a)
      return setError(
        e.role === "cashier"
          ? "A cashier badge cannot approve this. Scan an owner or manager badge."
          : `${e.name} has no authenticator app linked yet.`,
      );
    setApprover(a);
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!approver) return;
    setBusy(true);
    try {
      if (await checkApproverCode(approver, code)) onDone(approver);
      else {
        setError("Wrong or already used code. Wait for the next code in the authenticator app.");
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => onDone()} title="Owner or manager approval">
      <div className="grid gap-3">
        <p className="text-sm text-charcoal-700">{reason}</p>
        {approver ? (
          <form onSubmit={submit} className="grid gap-3">
            <p className="text-charcoal-700">
              <span className="font-semibold text-charcoal-900">{approver.name}</span> · {ROLE_LABEL[approver.role]}
            </p>
            <Field label="6-digit code from the authenticator app">
              <input
                className={`${inputClass} font-mono tracking-[0.3em]`}
                inputMode="none"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                aria-label="Authenticator code"
                data-testid="approver-code"
              />
            </Field>
            <Keypad value={code} onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))} decimal={false} compact />
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-between gap-2">
              <Button variant="secondary" onClick={() => (setApprover(undefined), setError(undefined))}>
                Use another badge
              </Button>
              <Button type="submit" disabled={busy || code.length !== 6}>
                Approve
              </Button>
            </div>
          </form>
        ) : (
          <>
            <BadgeReader onBadge={(t) => void onBadge(t)} label="Scan an owner or manager badge" />
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => onDone()}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
