"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import QRCode from "qrcode";
import { Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import { CloudRejection, type CloudApi } from "@/lib/cloud/api";
import { hashPin, isValidPinFormat } from "@/lib/pin";
import { renderMemberCard } from "@/lib/members/card";
import { printMemberCard } from "@/lib/members/card-print";
import { ROLE_LABEL, newBadgeText, sha256Hex, type StaffRole } from "@/lib/staff/employees";
import { newTotpSecret, otpauthUri } from "@/lib/staff/totp";
import { BadgeReader } from "@/components/pos/staff-dialogs";

export interface OfficeSession {
  token: string;
  employeeId: string;
  employeeNo: string;
  name: string;
  role: "owner" | "manager";
  expiresAt: string;
}

const ISSUER = "The Local Butcher";

function errorText(e: unknown): string {
  if (e instanceof CloudRejection) return e.message;
  return e instanceof Error ? e.message : "Could not reach the cloud. Check the internet connection.";
}

/** A Back Office API that sends the session token with every call. */
export function withSession(api: CloudApi, token: string, onLocked: () => void): CloudApi {
  return {
    ...api,
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      try {
        return await api.rpc<T>(fn, { ...args, p_token: token });
      } catch (e) {
        if (e instanceof CloudRejection && e.code === "42501" && /locked/i.test(e.message)) onLocked();
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------- unlock

export function UnlockScreen({ api, onUnlocked }: { api: CloudApi; onUnlocked: (s: OfficeSession) => void }) {
  const [badge, setBadge] = useState<string>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!badge) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.rpc<OfficeSession & { error?: string }>("office_unlock", { p_badge: badge, p_code: code });
      if (r.error) {
        setError(r.error);
        setCode("");
        if (/badge/i.test(r.error)) setBadge(undefined);
      } else onUnlocked(r);
    } catch (x) {
      setError(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mx-auto grid w-full max-w-sm gap-3 rounded-2xl bg-white p-5 shadow-sm"
      data-testid="office-unlock"
    >
      <h2 className="text-lg font-bold text-burgundy-800">Open the Back Office</h2>
      {badge ? (
        <form onSubmit={submit} className="grid gap-3">
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">Badge read.</p>
          <Field label="6-digit code from Google Authenticator">
            <input
              className={`${inputClass} font-mono tracking-[0.3em]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-label="Authenticator code"
              data-testid="office-code"
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-between gap-2">
            <Button variant="secondary" onClick={() => (setBadge(undefined), setError(undefined))}>
              Different badge
            </Button>
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Open"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-sm text-charcoal-700">Scan an owner or manager badge, then enter the code from the app.</p>
          <BadgeReader onBadge={(t) => (setBadge(t), setError(undefined))} />
          <ErrorText>{error}</ErrorText>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- shared pieces

function PinFields({ onChange }: { onChange: (pin: string | null) => void }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  useEffect(() => onChange(isValidPinFormat(pin) && pin === again ? pin : null), [pin, again, onChange]);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="PIN (4 to 8 digits)" hint="The employee types this themselves.">
        <input
          className={inputClass}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          aria-label="New PIN"
        />
      </Field>
      <Field label="Repeat PIN" error={again && again !== pin ? "The PINs do not match." : undefined}>
        <input
          className={inputClass}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value.replace(/\D/g, "").slice(0, 8))}
          aria-label="Repeat PIN"
        />
      </Field>
    </div>
  );
}

/** Shows the new badge (its QR text exists only now) and prints it. */
function BadgePanel({
  badge,
  name,
  employeeNo,
  role,
  storeName,
}: {
  badge: string;
  name: string;
  employeeNo: string;
  role: StaffRole;
  storeName: string;
}) {
  const [img, setImg] = useState<string>();
  useEffect(() => {
    let live = true;
    void renderMemberCard({
      memberId: "",
      memberNo: employeeNo,
      name,
      storeName,
      qrText: badge,
      heading: `STAFF · ${ROLE_LABEL[role].toUpperCase()}`,
      footer: "Employee ID · do not share",
    }).then((d) => live && setImg(d));
    return () => {
      live = false;
    };
  }, [badge, name, employeeNo, role, storeName]);
  return (
    <div className="grid gap-2" data-testid="badge-panel">
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element -- generated data URL
        <img src={img} alt={`Badge for ${name}`} className="w-full rounded-xl border border-cream-300" />
      ) : (
        <p>Drawing the badge…</p>
      )}
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Print or save this badge now. For safety the app does not keep a copy; if it is lost, issue a new one and the
        old badge stops working.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => img && void printMemberCard(img)} disabled={!img} data-testid="print-badge">
          Print badge
        </Button>
        {img && (
          <a
            href={img}
            download={`badge-${employeeNo}.png`}
            className="inline-flex min-h-11 items-center rounded-xl border border-cream-300 bg-white px-4 font-semibold"
          >
            Save as image
          </a>
        )}
      </div>
    </div>
  );
}

/** QR for Google Authenticator, then a code to prove it works. */
function AuthenticatorLink({
  secret,
  account,
  onConfirm,
}: {
  secret: string;
  account: string;
  onConfirm: (code: string) => Promise<boolean>;
}) {
  const [qr, setQr] = useState<string>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void QRCode.toDataURL(otpauthUri(secret, account, ISSUER), { margin: 2, width: 240 }).then(setQr);
  }, [secret, account]);
  return (
    <form
      className="grid gap-3"
      data-testid="authenticator-link"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
          if (!(await onConfirm(code))) {
            setError("That code did not match. Check the phone's time is automatic and use the newest code.");
            setCode("");
          }
        } catch (x) {
          setError(errorText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <ol className="grid list-decimal gap-1 pl-5 text-sm text-charcoal-700">
        <li>Open Google Authenticator on the phone and tap +, then “Scan a QR code”.</li>
        <li>Scan this code. “{ISSUER}” appears in the app.</li>
        <li>Type the 6-digit code it shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
      {qr && <img src={qr} alt="Authenticator QR code" className="mx-auto size-60" />}
      <p className="text-center text-xs text-charcoal-500">
        Cannot scan? Enter this key instead:{" "}
        <span className="font-mono font-semibold text-charcoal-900" data-testid="totp-secret">
          {secret.match(/.{1,4}/g)?.join(" ")}
        </span>
      </p>
      <Field label="Code from the app">
        <input
          className={`${inputClass} font-mono tracking-[0.3em]`}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          aria-label="Code from the app"
          data-testid="totp-confirm-code"
        />
      </Field>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" disabled={busy || code.length !== 6}>
        {busy ? "Checking…" : "Link the app"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- first-time setup

export function SetupWizard({
  api,
  ownerName,
  storeName,
  onUnlocked,
}: {
  api: CloudApi;
  ownerName: string;
  storeName: string;
  onUnlocked: (s: OfficeSession) => void;
}) {
  const [step, setStep] = useState<"details" | "badge" | "app" | "open">("details");
  const [name, setName] = useState(ownerName);
  const [pin, setPin] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; employeeNo: string; badge: string; secret: string }>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const onPin = useCallback((p: string | null) => setPin(p), []);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!pin || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const id = crypto.randomUUID();
      const badge = newBadgeText();
      const secret = newTotpSecret();
      const r = await api.rpc<{ employeeNo: string }>("save_employee", {
        p: {
          id,
          name: name.trim(),
          role: "owner",
          badgeHash: await sha256Hex(badge),
          pin: await hashPin(pin),
          totpSecret: secret,
        },
        p_token: null,
      });
      setMade({ id, employeeNo: r.employeeNo, badge, secret });
      setStep("badge");
    } catch (x) {
      setError(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  async function open(e: FormEvent) {
    e.preventDefault();
    if (!made) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.rpc<OfficeSession & { error?: string }>("office_unlock", {
        p_badge: made.badge,
        p_code: code,
      });
      if (r.error) {
        setError(r.error);
        setCode("");
      } else onUnlocked(r);
    } catch (x) {
      setError(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mx-auto grid w-full max-w-lg gap-4 rounded-2xl bg-white p-5 shadow-sm"
      data-testid="office-setup"
    >
      <div>
        <h2 className="text-lg font-bold text-burgundy-800">Set up your owner ID</h2>
        <p className="text-sm text-charcoal-700">
          From now on the Back Office opens with your badge and a code from Google Authenticator. This takes about two
          minutes. Have your phone ready.
        </p>
      </div>
      <ol className="flex gap-2 text-xs font-semibold" aria-label="Steps">
        {(["details", "badge", "app", "open"] as const).map((s, i) => (
          <li
            key={s}
            className={`rounded-full px-2 py-1 ${step === s ? "bg-navy-800 text-cream-50" : "bg-cream-200 text-charcoal-700"}`}
          >
            {i + 1}. {{ details: "Name and PIN", badge: "Badge", app: "Authenticator", open: "Open" }[s]}
          </li>
        ))}
      </ol>
      {step === "details" && (
        <form onSubmit={create} className="grid gap-3">
          <Field label="Your name (printed on the badge)">
            <input className={inputClass} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </Field>
          <PinFields onChange={onPin} />
          <p className="text-xs text-charcoal-500">
            Your PIN opens the POS with your badge. The Back Office uses the app code instead.
          </p>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy || !pin || !name.trim()}>
            {busy ? "Saving…" : "Create my owner ID"}
          </Button>
        </form>
      )}
      {step === "badge" && made && (
        <>
          <BadgePanel
            badge={made.badge}
            name={name.trim()}
            employeeNo={made.employeeNo}
            role="owner"
            storeName={storeName}
          />
          <Button onClick={() => setStep("app")} data-testid="setup-next">
            I printed or saved it · Next
          </Button>
        </>
      )}
      {step === "app" && made && (
        <AuthenticatorLink
          secret={made.secret}
          account={`${name.trim()} (${made.employeeNo})`}
          onConfirm={async (c) => {
            const ok = await api.rpc<boolean>("confirm_totp", { p_employee: made.id, p_code: c, p_token: null });
            if (ok) setStep("open");
            return ok;
          }}
        />
      )}
      {step === "open" && (
        <form onSubmit={open} className="grid gap-3">
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            Linked. Wait for the next code in the app (each code works once), then open the Back Office.
          </p>
          <Field label="Next code from the app">
            <input
              className={`${inputClass} font-mono tracking-[0.3em]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-label="Next code"
              data-testid="setup-open-code"
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy || code.length !== 6}>
            Open the Back Office
          </Button>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- staff page (owner)

interface EmployeeRow {
  id: string;
  employeeNo: string;
  name: string;
  role: StaffRole;
  active: boolean;
  hasPin: boolean;
  authenticator: boolean;
}

type Editing =
  | { kind: "new" }
  | { kind: "edit"; row: EmployeeRow }
  | { kind: "badge"; row: EmployeeRow; badge: string }
  | { kind: "app"; row: EmployeeRow; secret: string };

export function StaffPage({ api, storeName, session }: { api: CloudApi; storeName: string; session: OfficeSession }) {
  const [rows, setRows] = useState<EmployeeRow[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Editing>();

  const load = useCallback(async () => {
    try {
      setRows(await api.rpc<EmployeeRow[]>("office_employees", {}));
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => {
    // Loads the list once the page opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const owner = session.role === "owner";

  async function save(
    row: Pick<EmployeeRow, "id" | "name" | "role"> & { active?: boolean },
    extra: Record<string, unknown> = {},
  ) {
    return api.rpc<{ employeeNo: string }>("save_employee", { p: { ...row, ...extra } });
  }

  async function newBadge(row: EmployeeRow) {
    if (!window.confirm(`Issue a new badge for ${row.name}? The old badge stops working once devices sync.`)) return;
    const badge = newBadgeText();
    try {
      await save(row, { badgeHash: await sha256Hex(badge) });
      setEditing({ kind: "badge", row, badge });
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function newApp(row: EmployeeRow) {
    const secret = newTotpSecret();
    try {
      await save(row, { totpSecret: secret });
      setEditing({ kind: "app", row, secret });
      void load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="grid gap-4" data-testid="staff-page">
      <section className="grid gap-3 rounded-2xl border border-cream-300 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold text-navy-900">Employees</h2>
          {owner && (
            <Button
              size="sm"
              className="ml-auto"
              onClick={() => setEditing({ kind: "new" })}
              data-testid="add-employee"
            >
              Add employee
            </Button>
          )}
        </div>
        <p className="text-sm text-charcoal-700">
          Everyone signs in to the POS with their badge and PIN. Owners and managers also link Google Authenticator to
          open the Back Office and approve price changes and big discounts. Devices pick up changes when they sync.
        </p>
        {!owner && <p className="text-sm text-amber-900">Only the owner can add or change employees.</p>}
        <ErrorText>{error}</ErrorText>
        {!rows ? (
          <p className="text-charcoal-500">Loading…</p>
        ) : (
          <ul className="grid gap-2" data-testid="employee-list">
            {rows.map((r) => (
              <li
                key={r.id}
                className={`flex flex-wrap items-center gap-2 rounded-xl border border-cream-200 p-3 ${r.active ? "" : "opacity-60"}`}
              >
                <span className="font-mono text-sm text-charcoal-500">{r.employeeNo}</span>
                <span className="font-semibold text-charcoal-900">{r.name}</span>
                <span className="rounded-full bg-cream-200 px-2 py-0.5 text-xs font-semibold">
                  {ROLE_LABEL[r.role]}
                </span>
                {!r.active && <span className="text-xs font-semibold text-burgundy-700">Inactive</span>}
                {!r.hasPin && <span className="text-xs font-semibold text-amber-800">No PIN</span>}
                {r.role !== "cashier" && (
                  <span className={`text-xs font-semibold ${r.authenticator ? "text-emerald-800" : "text-amber-800"}`}>
                    {r.authenticator ? "Authenticator linked" : "No authenticator"}
                  </span>
                )}
                {owner && (
                  <span className="ml-auto flex flex-wrap gap-1">
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ kind: "edit", row: r })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void newBadge(r)}>
                      New badge
                    </Button>
                    {r.role !== "cashier" && (
                      <Button size="sm" variant="secondary" onClick={() => void newApp(r)}>
                        {r.authenticator ? "Relink app" : "Link app"}
                      </Button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing?.kind === "new" && (
        <EmployeeForm
          title="Add employee"
          onClose={() => setEditing(undefined)}
          onSave={async (v) => {
            const id = crypto.randomUUID();
            const badge = newBadgeText();
            const r = await save(
              { id, name: v.name, role: v.role },
              { badgeHash: await sha256Hex(badge), ...(v.pin ? { pin: await hashPin(v.pin) } : {}) },
            );
            const row: EmployeeRow = {
              id,
              employeeNo: r.employeeNo,
              name: v.name,
              role: v.role,
              active: true,
              hasPin: !!v.pin,
              authenticator: false,
            };
            setEditing({ kind: "badge", row, badge });
            void load();
          }}
        />
      )}
      {editing?.kind === "edit" && (
        <EmployeeForm
          title={`Edit ${editing.row.employeeNo}`}
          row={editing.row}
          onClose={() => setEditing(undefined)}
          onSave={async (v) => {
            await save(
              { id: editing.row.id, name: v.name, role: v.role, active: v.active },
              v.pin ? { pin: await hashPin(v.pin) } : {},
            );
            setEditing(undefined);
            void load();
          }}
        />
      )}
      {editing?.kind === "badge" && (
        <Modal open wide title={`Badge for ${editing.row.name}`} onClose={() => setEditing(undefined)}>
          <div className="grid gap-3">
            <BadgePanel
              badge={editing.badge}
              name={editing.row.name}
              employeeNo={editing.row.employeeNo}
              role={editing.row.role}
              storeName={storeName}
            />
            {editing.row.role !== "cashier" && !editing.row.authenticator && (
              <Button variant="success" onClick={() => void newApp(editing.row)}>
                Next: link Google Authenticator
              </Button>
            )}
          </div>
        </Modal>
      )}
      {editing?.kind === "app" && (
        <Modal open title={`Authenticator for ${editing.row.name}`} onClose={() => setEditing(undefined)}>
          <AuthenticatorLink
            secret={editing.secret}
            account={`${editing.row.name} (${editing.row.employeeNo})`}
            onConfirm={async (c) => {
              const ok = await api.rpc<boolean>("confirm_totp", { p_employee: editing.row.id, p_code: c });
              if (ok) {
                setEditing(undefined);
                void load();
              }
              return ok;
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function EmployeeForm({
  title,
  row,
  onClose,
  onSave,
}: {
  title: string;
  row?: EmployeeRow;
  onClose: () => void;
  onSave: (v: { name: string; role: StaffRole; active: boolean; pin: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [role, setRole] = useState<StaffRole>(row?.role ?? "cashier");
  const [active, setActive] = useState(row?.active ?? true);
  const [pin, setPin] = useState<string | null>(null);
  const [changePin, setChangePin] = useState(!row);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const onPin = useCallback((p: string | null) => setPin(p), []);
  const pinOk = !changePin || !!pin;

  return (
    <Modal open title={title} onClose={onClose}>
      <form
        className="grid gap-3"
        data-testid="employee-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || !pinOk) return;
          setBusy(true);
          setError(undefined);
          try {
            await onSave({ name: name.trim(), role, active, pin: changePin ? pin : null });
          } catch (x) {
            setError(errorText(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name (printed on the badge)">
          <input
            className={inputClass}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            aria-label="Employee name"
          />
        </Field>
        <Field
          label="Role"
          hint="Managers and owners approve price changes and big discounts, and open the Back Office."
        >
          <select
            className={inputClass}
            value={role}
            onChange={(e) => setRole(e.target.value as StaffRole)}
            aria-label="Role"
          >
            <option value="cashier">Cashier</option>
            <option value="manager">Manager</option>
            <option value="owner">Owner</option>
          </select>
        </Field>
        {row && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5" />
            Active (can sign in)
          </label>
        )}
        {row && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={changePin}
              onChange={(e) => setChangePin(e.target.checked)}
              className="size-5"
            />
            Set a new PIN
          </label>
        )}
        {changePin && <PinFields onChange={onPin} />}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || !pinOk}>
            {row ? "Save" : "Create and make badge"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function OwnerOnlyNotice({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-amber-50 p-4 text-amber-900">{children}</p>;
}
