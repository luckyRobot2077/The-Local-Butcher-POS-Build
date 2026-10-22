"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  getLastExportAt,
  saveSettings,
  setLastExportAt,
  setPinRecord,
  settingsSchema,
  type Settings,
} from "@/lib/db/config";
import { backupFileName, createBackup, verifyBackup, type BackupManifest } from "@/lib/backup";
import { hashPin, isValidPinFormat } from "@/lib/pin";
import { formatManila } from "@/domain/time";
import { Badge, Button, ErrorText, Field, inputClass } from "@/components/ui";
import { usePos } from "./pos-context";
import { getDb } from "@/lib/db/db";
import { CloudSection } from "./cloud-section";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-2xl border border-cream-300 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-bold text-burgundy-800">{title}</h2>
      {children}
    </section>
  );
}

export function DeviceScreen() {
  const { device, storagePersisted, cashierName, changeCashier } = usePos();
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number }>();
  useEffect(() => {
    navigator.storage
      ?.estimate?.()
      .then(setEstimate)
      .catch(() => undefined);
  }, []);
  const mb = (n?: number) => (n === undefined ? "?" : `${(n / 1024 / 1024).toFixed(1)} MB`);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-3xl gap-4 p-3">
        <Section title="This device">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-charcoal-500">Cashier</dt>
            <dd>
              {cashierName}{" "}
              <button type="button" className="font-semibold text-burgundy-700 underline" onClick={changeCashier}>
                Change
              </button>
            </dd>
            <dt className="text-charcoal-500">Device code</dt>
            <dd className="font-mono">{device?.deviceCode}</dd>
            <dt className="text-charcoal-500">Registered</dt>
            <dd>{device && formatManila(device.registeredAt)}</dd>
            <dt className="text-charcoal-500">Storage</dt>
            <dd>
              {storagePersisted ? (
                <Badge tone="ok">Persistent</Badge>
              ) : (
                <Badge tone="warn">Not persistent: the browser may clear data if space runs low</Badge>
              )}{" "}
              {mb(estimate?.usage)} used of {mb(estimate?.quota)}
            </dd>
          </dl>
          <p className="text-sm text-charcoal-700">
            Sales are saved on this device first and sent to the cloud when there is internet. Install the app to the
            home screen, and export a backup regularly while any sales are not yet synced.
          </p>
        </Section>
        <CloudSection />
        <BackupSection />
        <SettingsSectionKeyed />
        <PinSection />
      </div>
    </div>
  );
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function BackupSection() {
  const { requestManager } = usePos();
  const lastExport = useLiveQuery(() => getLastExportAt(), []);
  const unsynced = useLiveQuery(() => getDb().sales.where("syncStatus").notEqual("synced").count(), []);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<BackupManifest>();
  const [verifyFile, setVerifyFile] = useState<File>();
  const [verifyPass, setVerifyPass] = useState("");
  const [verified, setVerified] = useState<BackupManifest>();
  const [verifyError, setVerifyError] = useState<string>();

  async function exportBackup() {
    setError(undefined);
    if (pass.length < 8) return setError("Use a passphrase of at least 8 characters.");
    if (pass !== pass2) return setError("The passphrases do not match.");
    if (!(await requestManager("Exporting business data needs manager approval."))) return;
    setBusy(true);
    try {
      const { file, manifest } = await createBackup(pass);
      // Verify the package before handing it over.
      await verifyBackup(JSON.stringify(file), pass);
      downloadText(backupFileName(file.createdAt), JSON.stringify(file));
      await setLastExportAt(file.createdAt);
      setMade(manifest);
      setPass("");
      setPass2("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setVerifyError(undefined);
    setVerified(undefined);
    if (!verifyFile) return;
    try {
      const { manifest } = await verifyBackup(await verifyFile.text(), verifyPass);
      setVerified(manifest);
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Section title="Backup to phone, USB or external drive">
      <p className="text-sm text-charcoal-700">
        Creates an encrypted file with all data on this device, including {unsynced ?? "…"} sale
        {unsynced === 1 ? "" : "s"} not yet in the cloud. Copy the file to a USB stick or external hard drive. Keep the
        passphrase somewhere safe: without it the file cannot be opened.
      </p>
      <p className="text-sm">
        Last export: <strong>{lastExport ? formatManila(lastExport) : "never"}</strong>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Passphrase (8+ characters)">
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </Field>
        <Field label="Repeat passphrase">
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
          />
        </Field>
      </div>
      <ErrorText>{error}</ErrorText>
      {made && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Backup created and verified: {made.counts.sales} sales, {made.counts.products} products,{" "}
          {made.counts.productImages} photos.
        </p>
      )}
      <Button onClick={exportBackup} disabled={busy}>
        {busy ? "Encrypting…" : "Export encrypted backup"}
      </Button>
      <details className="rounded-lg bg-cream-100 p-3">
        <summary className="cursor-pointer font-semibold">Check a backup file</summary>
        <div className="mt-3 grid gap-3">
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => setVerifyFile(e.target.files?.[0])}
            aria-label="Backup file"
          />
          <Field label="Passphrase">
            <input
              className={inputClass}
              type="password"
              value={verifyPass}
              onChange={(e) => setVerifyPass(e.target.value)}
            />
          </Field>
          <Button variant="secondary" onClick={verify} disabled={!verifyFile || !verifyPass}>
            Verify file
          </Button>
          <ErrorText>{verifyError}</ErrorText>
          {verified && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <p className="font-semibold">File is intact and decrypts correctly.</p>
              <p>Created {formatManila(verified.createdAt)}.</p>
              <p>
                {Object.entries(verified.counts)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
              </p>
              <p className="mt-1 text-xs">
                Restoring from a backup is planned for a later phase and will use a safe staging step.
              </p>
            </div>
          )}
        </div>
      </details>
    </Section>
  );
}

function SettingsSectionKeyed() {
  const { settings } = usePos();
  // Kept here so "Saved." survives the remount after saving.
  const [msg, setMsg] = useState<string>();
  // Remount the form when saved settings change so it shows the stored values.
  return <SettingsSection key={JSON.stringify(settings)} msg={msg} setMsg={setMsg} />;
}

function SettingsSection({ msg, setMsg }: { msg?: string; setMsg: (m: string | undefined) => void }) {
  const { settings, requestManager } = usePos();
  const [draft, setDraft] = useState<Settings>(settings);
  const [linesText, setLinesText] = useState(settings.businessLines.join("\n"));
  const [limitText, setLimitText] = useState(String(settings.cashierDiscountLimitBp / 100));
  const [error, setError] = useState<string>();

  async function save() {
    setMsg(undefined);
    setError(undefined);
    const limit = Number(limitText);
    const next = {
      ...draft,
      businessLines: linesText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      cashierDiscountLimitBp: Number.isFinite(limit) ? Math.round(limit * 100) : -1,
    };
    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the settings.");
    if (!(await requestManager("Changing store settings needs manager approval."))) return;
    await saveSettings(parsed.data);
    setMsg("Saved.");
  }

  return (
    <Section title="Store and receipt settings">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Store name">
          <input
            className={inputClass}
            value={draft.storeName}
            maxLength={60}
            onChange={(e) => setDraft({ ...draft, storeName: e.target.value })}
          />
        </Field>
        <Field label="Tagline">
          <input
            className={inputClass}
            value={draft.tagline}
            maxLength={80}
            onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
          />
        </Field>
      </div>
      <Field
        label="Business details on receipt (one per line)"
        hint="e.g. address, contact number. Not an official invoice until BIR requirements are met."
      >
        <textarea
          className={`${inputClass} min-h-20 py-2`}
          value={linesText}
          onChange={(e) => setLinesText(e.target.value)}
        />
      </Field>
      <Field label="Receipt footer">
        <input
          className={inputClass}
          value={draft.receiptFooter}
          maxLength={120}
          onChange={(e) => setDraft({ ...draft, receiptFooter: e.target.value })}
        />
      </Field>
      <fieldset className="grid gap-3 rounded-xl border border-cream-300 p-3">
        <legend className="px-1 text-sm font-semibold text-charcoal-700">Social media on member cards</legend>
        <p className="text-xs text-charcoal-500">
          Printed under the QR code with a small icon. Leave a box empty to leave it off the card.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ["facebook", "Facebook page", "e.g. fb.com/thelocalbutcherargao", 60],
              ["tiktok", "TikTok account", "e.g. @thelocalbutcher", 60],
              ["whatsapp", "WhatsApp number", "e.g. 0917 123 4567", 30],
            ] as const
          ).map(([key, label, placeholder, max]) => (
            <Field key={key} label={label}>
              <input
                className={inputClass}
                value={draft.socials[key]}
                maxLength={max}
                placeholder={placeholder}
                onChange={(e) => setDraft({ ...draft, socials: { ...draft.socials, [key]: e.target.value } })}
                data-testid={`social-${key}`}
              />
            </Field>
          ))}
        </div>
      </fieldset>
      <Field label="Cashier discount limit (%)" hint="Discounts above this need the manager PIN.">
        <input
          className={inputClass}
          inputMode="decimal"
          value={limitText}
          onChange={(e) => setLimitText(e.target.value)}
        />
      </Field>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-5 accent-burgundy-700"
          checked={draft.allowItemAndOrderStacking}
          onChange={(e) => setDraft({ ...draft, allowItemAndOrderStacking: e.target.checked })}
        />
        <span>
          <span className="font-semibold">Allow order discount on items that already have a discount</span>
          <span className="block text-sm text-charcoal-500">
            Off by default to prevent accidental double discounts.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-5 accent-burgundy-700"
          checked={draft.cashierCanEditPhotos}
          onChange={(e) => setDraft({ ...draft, cashierCanEditPhotos: e.target.checked })}
        />
        <span>
          <span className="font-semibold">Cashiers may change product photos and descriptions</span>
          <span className="block text-sm text-charcoal-500">
            Names, prices, categories and stock always need the manager PIN.
          </span>
        </span>
      </label>
      <ErrorText>{error}</ErrorText>
      {msg && <p className="text-sm font-semibold text-emerald-800">{msg}</p>}
      <Button onClick={save}>Save settings</Button>
    </Section>
  );
}

function PinSection() {
  const { requestManager } = usePos();
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  async function change() {
    setMsg(undefined);
    setError(undefined);
    if (!isValidPinFormat(pin)) return setError("PIN must be 4 to 8 digits.");
    if (pin !== pin2) return setError("The two PINs do not match.");
    if (!(await requestManager("Enter the current manager PIN to change it."))) return;
    await setPinRecord(await hashPin(pin));
    setPin("");
    setPin2("");
    setMsg("Manager PIN changed.");
  }
  return (
    <Section title="Manager PIN">
      <p className="text-sm text-charcoal-700">
        The PIN protects product editing, prices, stock changes, large discounts and backups on this device. It is a
        local safeguard; staff sign-in with server-side permissions comes with cloud sync.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New PIN">
          <input
            className={inputClass}
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          />
        </Field>
        <Field label="Repeat new PIN">
          <input
            className={inputClass}
            type="password"
            inputMode="numeric"
            value={pin2}
            onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 8))}
          />
        </Field>
      </div>
      <ErrorText>{error}</ErrorText>
      {msg && <p className="text-sm font-semibold text-emerald-800">{msg}</p>}
      <Button variant="secondary" onClick={change}>
        Change PIN
      </Button>
    </Section>
  );
}
