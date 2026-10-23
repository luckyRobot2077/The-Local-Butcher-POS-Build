"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, ErrorText } from "@/components/ui";
import { CloudRejection, type CloudApi } from "@/lib/cloud/api";
import { formatManila } from "@/domain/time";
import { BACKUP_RUNS_URL, backupHealth, formatBytes, type BackupStatus } from "@/domain/backups";

export function useBackupStatus(api: CloudApi) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      setStatus(await api.rpc<BackupStatus>("office_backups", {}));
    } catch (e) {
      setErr(
        e instanceof CloudRejection && /office_backups|PGRST202|schema cache/i.test(e.message)
          ? "The cloud database needs migration 12 (20261030000012_backups_and_lockdown.sql) before backups show here."
          : e instanceof CloudRejection
            ? e.message
            : "Could not reach the cloud. Check the internet connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  return { status, err, loading, load };
}

/** A warning line for every Back Office page when the nightly backup is missing or late. */
export function BackupWarning({ status, onOpen }: { status: BackupStatus | null; onOpen: () => void }) {
  if (!status) return null;
  const health = backupHealth(status.lastOkAt);
  if (health === "ok") return null;
  return (
    <p
      className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
      data-testid="backup-warning"
    >
      {health === "never"
        ? "The nightly cloud backup is not set up yet."
        : `The last good cloud backup was ${formatManila(status.lastOkAt!)}. The nightly backup may be failing.`}
      <button type="button" className="font-semibold underline" onClick={onOpen}>
        Open Backups
      </button>
    </p>
  );
}

export function BackupsPage({ api }: { api: CloudApi }) {
  const { status, err, loading, load } = useBackupStatus(api);
  const health = status ? backupHealth(status.lastOkAt) : null;
  return (
    <div className="grid gap-4" data-testid="office-backups">
      <section className="grid gap-2 rounded-2xl border border-cream-300 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold text-charcoal-900">Nightly cloud backup</h2>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
        <ErrorText>{err}</ErrorText>
        {status && (
          <p
            data-testid="backup-health"
            data-health={health}
            className={`rounded-xl p-3 font-semibold ${
              health === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"
            }`}
          >
            {health === "never"
              ? "No backup has been made yet. Add the two GitHub secrets to switch it on (see below)."
              : `Last good backup: ${formatManila(status.lastOkAt!)}${health === "late" ? " (over a day and a half ago)" : ""}`}
          </p>
        )}
        <p className="text-sm text-charcoal-700">
          Every night at 12:30 AM the whole cloud database (products, prices, stock, sales, shifts, members, staff and
          settings) is copied into an encrypted 7-Zip file. Each file is kept for 90 days. Product photos are not in it;
          they stay in the cloud and in each device&apos;s own backup.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-charcoal-700">
          <li>
            <a href={BACKUP_RUNS_URL} target="_blank" rel="noreferrer" className="font-semibold underline">
              Open the backup runs on GitHub
            </a>{" "}
            (sign in as the shop&apos;s GitHub account) and pick the newest run with a green tick.
          </li>
          <li>Under Artifacts, download the file and copy it to the home hard drive. Once a week is enough.</li>
          <li>To check it, open it with 7-Zip on the computer and type the backup passphrase.</li>
        </ol>
      </section>
      {status && status.runs.length > 0 && (
        <section className="rounded-2xl border border-cream-300 bg-white p-4">
          <h3 className="mb-2 font-semibold">Recent runs</h3>
          <ul className="grid gap-1 text-sm" data-testid="backup-runs">
            {status.runs.map((r) => (
              <li key={r.finished_at + r.kind} className="flex flex-wrap gap-x-3 tabular-nums">
                <span className={r.ok ? "text-emerald-800" : "font-semibold text-burgundy-700"}>
                  {r.ok ? "OK" : "Failed"}
                </span>
                <span>{formatManila(r.finished_at)}</span>
                <span className="text-charcoal-500">{r.kind === "scheduled" ? "nightly" : "started by hand"}</span>
                <span className="text-charcoal-500">{formatBytes(r.bytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
