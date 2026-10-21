"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { cloudConfigured, getSupabase, supabaseApi } from "@/lib/cloud/api";
import { getCloudIdentity, getSyncMeta } from "@/lib/cloud/identity";
import { addStaff, createStore, refreshAccount, signIn, signOut, type AccountState } from "@/lib/cloud/session";
import { keepLocalVersion, retryFailed, runSync, takeServerVersion } from "@/lib/cloud/sync";
import { getDb } from "@/lib/db/db";
import { formatManila } from "@/domain/time";
import { Badge, Button, ErrorText, Field, inputClass } from "@/components/ui";

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

const KIND_LABEL: Record<string, string> = {
  sale: "Sale",
  product: "Product",
  product_image: "Photo",
  inventory_movement: "Stock change",
};

export function CloudSection() {
  if (!cloudConfigured()) {
    return (
      <section id="sync" className="grid gap-2 rounded-2xl border border-cream-300 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-bold text-burgundy-800">Cloud account and sync</h2>
        <p className="text-sm text-charcoal-700">
          Cloud sync is not set up on this site yet. The owner must add the Supabase settings in Vercel and redeploy
          (see README, &quot;Connecting Supabase&quot;). Until then all sales stay on this device.
        </p>
      </section>
    );
  }
  return <CloudAccount />;
}

function CloudAccount() {
  const sb = getSupabase()!;
  const api = supabaseApi(sb);
  const identity = useLiveQuery(() => getCloudIdentity(), []);
  const [state, setState] = useState<AccountState | { kind: "loading" } | { kind: "offline" }>({ kind: "loading" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      setState(await refreshAccount(sb, api));
    } catch (e) {
      const cached = await getCloudIdentity();
      if (cached) setState({ kind: "ready", identity: cached });
      else setState({ kind: "offline" });
      setError(`Could not reach the cloud: ${message(e)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Initial account check; the result arrives asynchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="sync" className="grid gap-3 rounded-2xl border border-cream-300 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-bold text-burgundy-800">Cloud account and sync</h2>
      {state.kind === "loading" && <p className="text-sm text-charcoal-500">Checking account…</p>}
      {state.kind === "offline" && (
        <p className="text-sm text-charcoal-700">
          Offline. Sign-in needs the internet; selling works without it.{" "}
          <Button variant="secondary" size="sm" onClick={refresh}>
            Try again
          </Button>
        </p>
      )}
      {state.kind === "signed_out" && (
        <SignInForm
          busy={busy}
          onSubmit={(email, pw) =>
            run(async () => {
              await signIn(sb, email, pw);
              await refresh();
            })
          }
        />
      )}
      {state.kind === "needs_store" && (
        <CreateStoreForm
          busy={busy}
          onSubmit={(store, name) =>
            run(async () => {
              await createStore(api, store, name);
              await refresh();
            })
          }
          onSignOut={() =>
            run(async () => {
              await signOut(sb);
              await refresh();
            })
          }
        />
      )}
      {state.kind === "not_staff" && (
        <div className="grid gap-2 text-sm">
          <p>
            Signed in as <strong>{state.email}</strong>, but this account is not staff of the store yet. Ask the owner
            to add this email on their Device tab.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={refresh}>
              Check again
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                run(async () => {
                  await signOut(sb);
                  await refresh();
                })
              }
            >
              Sign out
            </Button>
          </div>
        </div>
      )}
      {state.kind === "ready" && identity && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-charcoal-500">Signed in</dt>
            <dd>
              {identity.displayName} · {identity.email} <Badge tone="info">{identity.role}</Badge>
            </dd>
            <dt className="text-charcoal-500">Store</dt>
            <dd>{identity.storeName}</dd>
            <dt className="text-charcoal-500">This device</dt>
            <dd>
              {identity.deviceRegistered ? (
                <Badge tone="ok">Registered</Badge>
              ) : (
                <Badge tone="warn">Not registered</Badge>
              )}
            </dd>
          </dl>
          <SyncPanel
            onSync={() =>
              run(async () => {
                await runSync(api);
              })
            }
            busy={busy}
          />
          {identity.role === "owner" && (
            <AddStaffForm busy={busy} onSubmit={(email, name, role) => run(() => addStaff(api, email, name, role))} />
          )}
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                run(async () => {
                  await signOut(sb);
                  await refresh();
                })
              }
            >
              Sign out of this device
            </Button>
          </div>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

function SignInForm({ busy, onSubmit }: { busy: boolean; onSubmit: (email: string, pw: string) => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(email, pw);
      }}
    >
      <p className="text-sm text-charcoal-700">Sign in with the staff account the owner created in Supabase.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email">
          <input
            className={inputClass}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </Field>
      </div>
      <Button type="submit" disabled={busy || !email || !pw}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

function CreateStoreForm({
  busy,
  onSubmit,
  onSignOut,
}: {
  busy: boolean;
  onSubmit: (store: string, name: string) => void;
  onSignOut: () => void;
}) {
  const [store, setStore] = useState("The Local Butcher");
  const [name, setName] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(store, name);
      }}
    >
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        The cloud database is empty. The first account to set up the store becomes the <strong>owner</strong>. Only do
        this with the owner&apos;s account.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Store name">
          <input className={inputClass} value={store} maxLength={60} onChange={(e) => setStore(e.target.value)} />
        </Field>
        <Field label="Your name">
          <input className={inputClass} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !store.trim() || !name.trim()}>
          Set up store as owner
        </Button>
        <Button variant="ghost" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </form>
  );
}

function AddStaffForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (email: string, name: string, role: "manager" | "cashier") => Promise<void> | void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"manager" | "cashier">("cashier");
  const [done, setDone] = useState<string>();
  return (
    <details className="rounded-lg bg-cream-100 p-3">
      <summary className="cursor-pointer font-semibold">Add staff</summary>
      <form
        className="mt-3 grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setDone(undefined);
          await onSubmit(email, name, role);
          setDone(`${name} can now sign in as ${role}.`);
        }}
      >
        <p className="text-sm text-charcoal-700">
          First create their login in Supabase (Authentication → Users → Add user), then add them here. Cashiers start
          with no product-editing rights.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Email">
            <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Name">
            <input className={inputClass} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Role">
            <select
              className={inputClass}
              value={role}
              onChange={(e) => setRole(e.target.value as "manager" | "cashier")}
            >
              <option value="cashier">Cashier</option>
              <option value="manager">Manager</option>
            </select>
          </Field>
        </div>
        {done && <p className="text-sm font-semibold text-emerald-800">{done}</p>}
        <Button type="submit" variant="secondary" disabled={busy || !email || !name}>
          Add staff member
        </Button>
      </form>
    </details>
  );
}

function SyncPanel({ onSync, busy }: { onSync: () => void; busy: boolean }) {
  const meta = useLiveQuery(() => getSyncMeta(), []);
  const outbox = useLiveQuery(async () => {
    const rows = await getDb().outbox.where("status").anyOf("pending", "failed").toArray();
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, []);
  const pending = outbox?.filter((r) => r.status === "pending") ?? [];
  const failed = outbox?.filter((r) => r.status === "failed") ?? [];
  const names = useLiveQuery(async () => {
    const ids = failed.map((f) => f.entityId);
    const m = new Map<string, string>();
    for (const p of await getDb().products.bulkGet(ids)) if (p) m.set(p.id, p.name);
    for (const s of await getDb().sales.bulkGet(ids)) if (s) m.set(s.id, `Receipt ${s.receiptNo}`);
    return m;
  }, [failed.map((f) => f.id).join()]);
  // Show one row per product conflict even if several edits are queued.
  const shownFailed = failed.filter(
    (f, i) => !f.conflict || failed.findIndex((g) => g.entityId === f.entityId && g.conflict) === i,
  );

  return (
    <div className="grid gap-2 rounded-lg bg-cream-100 p-3" data-testid="sync-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <div>
            Last synced: <strong>{meta?.lastSyncAt ? formatManila(meta.lastSyncAt) : "never"}</strong>
          </div>
          <div>
            Waiting to send: <strong>{pending.length}</strong> · Problems: <strong>{failed.length}</strong>
          </div>
          {meta?.lastError && <div className="text-amber-800">Last attempt: {meta.lastError}</div>}
          {meta?.feedError && <div className="text-amber-800">Inventory reports: {meta.feedError}</div>}
        </div>
        <Button onClick={onSync} disabled={busy} data-testid="sync-now">
          {busy ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      {shownFailed.length > 0 && (
        <ul className="grid gap-2">
          {shownFailed.map((f) => (
            <li key={f.id} className="rounded-lg border border-red-200 bg-white p-2 text-sm">
              <div className="font-semibold">
                {KIND_LABEL[f.kind] ?? f.kind}: {names?.get(f.entityId) ?? f.entityId.slice(0, 8)}
              </div>
              <div className="text-red-800">{f.lastError}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {f.conflict ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => keepLocalVersion(f.entityId)}>
                      Keep this device&apos;s version
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => takeServerVersion(f.entityId)}>
                      Use the cloud version
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => retryFailed(undefined, [f.id])}>
                    Retry
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
