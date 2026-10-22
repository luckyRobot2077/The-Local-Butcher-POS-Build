"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  DEFAULT_SETTINGS,
  ensureDevice,
  getCashierName,
  getPinRecord,
  getSettings,
  setCashierName,
  setPinRecord,
  type DeviceIdentity,
  type Settings,
} from "@/lib/db/config";
import { ensureDefaultCategories } from "@/lib/db/seed";
import { hashPin, isValidPinFormat, verifyPin } from "@/lib/pin";
import { Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import { CloudSyncProvider } from "./cloud-sync";
import {
  approversWithCode,
  badgeSignInEnabled,
  getEmployees,
  toSignedIn,
  type SignedInEmployee,
} from "@/lib/staff/employees";
import { ApproveWithCodeDialog, StaffSignInDialog } from "./staff-dialogs";

const UNLOCK_MS = 5 * 60 * 1000;

interface PosContextValue {
  ready: boolean;
  dbError?: string;
  device?: DeviceIdentity;
  settings: Settings;
  cashierName: string;
  managerUnlocked: boolean;
  /** Ask for the manager PIN (or reuse a recent unlock). Resolves true when approved. */
  requestManager: (reason: string) => Promise<boolean>;
  lockManager: () => void;
  changeCashier: () => void;
  /** The employee signed in with their badge, once the shop uses employee IDs. */
  employee?: SignedInEmployee;
  badgeSignIn: boolean;
  storagePersisted?: boolean;
}

const PosContext = createContext<PosContextValue | null>(null);

export function usePos(): PosContextValue {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePos must be used inside PosProvider");
  return ctx;
}

export function PosProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState<string>();
  const [device, setDevice] = useState<DeviceIdentity>();
  const [storagePersisted, setStoragePersisted] = useState<boolean>();
  const settings = useLiveQuery(() => getSettings(), []) ?? DEFAULT_SETTINGS;
  const cashierName = useLiveQuery(() => getCashierName(), []);
  const [managerUnlocked, setManagerUnlocked] = useState(false);
  const unlockedUntil = useRef(0);
  const lockTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pinRequest, setPinRequest] = useState<{ reason: string; resolve: (ok: boolean) => void } | null>(null);
  const [askCashier, setAskCashier] = useState(false);
  const employees = useLiveQuery(() => getEmployees(), []);
  const [employee, setEmployee] = useState<SignedInEmployee>();
  const badgeSignIn = !!employees && badgeSignInEnabled(employees);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await ensureDevice();
        await ensureDefaultCategories();
        if (cancelled) return;
        setDevice(d);
        setReady(true);
        if (navigator.storage?.persist) {
          const already = await navigator.storage.persisted();
          setStoragePersisted(already || (await navigator.storage.persist()));
        }
      } catch (e) {
        setDbError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const lock = useCallback(() => {
    unlockedUntil.current = 0;
    clearTimeout(lockTimer.current);
    setManagerUnlocked(false);
  }, []);

  const unlock = useCallback(() => {
    unlockedUntil.current = Date.now() + UNLOCK_MS;
    clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(lock, UNLOCK_MS);
    setManagerUnlocked(true);
  }, [lock]);

  useEffect(() => () => clearTimeout(lockTimer.current), []);

  const requestManager = useCallback((reason: string) => {
    if (unlockedUntil.current > Date.now()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => setPinRequest({ reason, resolve }));
  }, []);

  const value: PosContextValue = {
    ready,
    dbError,
    device,
    settings,
    cashierName: cashierName ?? "",
    managerUnlocked,
    requestManager,
    lockManager: lock,
    changeCashier: () => {
      if (!badgeSignIn) return setAskCashier(true);
      lock();
      setEmployee(undefined);
    },
    employee,
    badgeSignIn,
    storagePersisted,
  };

  const needCashier = ready && cashierName !== undefined && !cashierName && !badgeSignIn;
  const needBadge = ready && badgeSignIn && !employee;
  const approvers = employees ? approversWithCode(employees) : [];

  return (
    <PosContext.Provider value={value}>
      <CloudSyncProvider ready={ready}>{children}</CloudSyncProvider>
      {needBadge && (
        <StaffSignInDialog
          onSignedIn={(e) => {
            setEmployee(toSignedIn(e));
            void setCashierName(e.name);
          }}
        />
      )}
      {pinRequest && approvers.length > 0 && (
        <ApproveWithCodeDialog
          reason={pinRequest.reason}
          current={employee}
          approvers={approvers}
          onDone={(by) => {
            if (by) unlock();
            pinRequest.resolve(!!by);
            setPinRequest(null);
          }}
        />
      )}
      {pinRequest && approvers.length === 0 && (
        <PinDialog
          reason={pinRequest.reason}
          onDone={(ok) => {
            if (ok) unlock();
            pinRequest.resolve(ok);
            setPinRequest(null);
          }}
        />
      )}
      {(needCashier || (askCashier && !badgeSignIn)) && (
        <CashierDialog current={cashierName ?? ""} canCancel={!needCashier} onClose={() => setAskCashier(false)} />
      )}
    </PosContext.Provider>
  );
}

function PinDialog({ reason, onDone }: { reason: string; onDone: (ok: boolean) => void }) {
  const hasPin = useLiveQuery(async () => !!(await getPinRecord()), []);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const settingUp = hasPin === false;

  async function submit() {
    setError(undefined);
    setBusy(true);
    try {
      if (settingUp) {
        if (!isValidPinFormat(pin)) return setError("PIN must be 4 to 8 digits.");
        if (pin !== confirm) return setError("The two PINs do not match.");
        await setPinRecord(await hashPin(pin));
        onDone(true);
      } else {
        const rec = await getPinRecord();
        if (rec && (await verifyPin(pin, rec))) onDone(true);
        else {
          setError("Wrong PIN.");
          setPin("");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => onDone(false)}
      title={settingUp ? "Set a manager PIN" : "Manager approval"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || hasPin === undefined}>
            {settingUp ? "Save PIN" : "Approve"}
          </Button>
        </div>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-sm text-charcoal-700">{reason}</p>
        {settingUp && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            No manager PIN exists on this device yet. Choose one now. Only the owner or manager should know it.
          </p>
        )}
        <Field label={settingUp ? "New PIN (4 to 8 digits)" : "Manager PIN"}>
          <input
            className={inputClass}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            aria-label={settingUp ? "New PIN" : "Manager PIN"}
          />
        </Field>
        {settingUp && (
          <Field label="Repeat PIN">
            <input
              className={inputClass}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, "").slice(0, 8))}
              aria-label="Repeat PIN"
            />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function CashierDialog({ current, canCancel, onClose }: { current: string; canCancel: boolean; onClose: () => void }) {
  const [name, setName] = useState(current);
  const save = async () => {
    if (!name.trim()) return;
    await setCashierName(name);
    onClose();
  };
  return (
    <Modal
      open
      onClose={canCancel ? onClose : () => {}}
      title="Who is at the counter?"
      footer={
        <div className="flex justify-end gap-2">
          {canCancel && (
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button onClick={save} disabled={!name.trim()}>
            Start selling
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="grid gap-3"
      >
        <Field
          label="Cashier name"
          hint="Printed on receipts and saved with each sale. Staff accounts with passwords arrive with cloud sign-in."
        >
          <input
            className={inputClass}
            autoFocus
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            aria-label="Cashier name"
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
