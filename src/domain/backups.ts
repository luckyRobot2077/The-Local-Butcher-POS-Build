/** One run of the nightly database backup, as office_backups returns it. */
export interface BackupRun {
  finished_at: string;
  kind: "scheduled" | "manual";
  ok: boolean;
  bytes: number | null;
  note: string | null;
}

export interface BackupStatus {
  lastOkAt: string | null;
  runs: BackupRun[];
}

/** Where the backups are kept and downloaded from. */
export const BACKUP_RUNS_URL =
  "https://github.com/luckyRobot2077/The-Local-Butcher-POS-Build/actions/workflows/db-backup.yml";

/** A nightly job may run late; past this the Back Office warns. */
export const BACKUP_LATE_HOURS = 36;

export type BackupHealth = "ok" | "late" | "never";

export function backupHealth(lastOkAt: string | null, nowMs = Date.now()): BackupHealth {
  if (!lastOkAt) return "never";
  return nowMs - Date.parse(lastOkAt) > BACKUP_LATE_HOURS * 3_600_000 ? "late" : "ok";
}

export function formatBytes(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
