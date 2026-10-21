import { getDb, LOCAL_SCHEMA_VERSION, type PosDatabase } from "./db/db";
import { ensureDevice } from "./db/config";
import { fromB64, toB64 } from "./pin";

/**
 * Encrypted offline-device backup (spec section 16, type B).
 *
 * File layout (JSON, versioned):
 *   { format: "tlb-device-backup", formatVersion: 1, createdAt, storeId, deviceId,
 *     kdf: { name: "PBKDF2-SHA256", iterations, salt }, cipher: { name: "AES-256-GCM", iv },
 *     ciphertext }
 * The plaintext is { manifest, tables } where the manifest lists record
 * counts per table and a SHA-256 of the serialized tables. AES-GCM
 * authenticates the ciphertext; the hash double-checks the content.
 *
 * Secrets are excluded: the manager PIN hash is never exported.
 */
export const BACKUP_FORMAT = "tlb-device-backup";
export const BACKUP_FORMAT_VERSION = 1;
const KDF_ITERATIONS = 310_000;
const EXCLUDED_CONFIG_KEYS = new Set(["managerPin"]);

export interface BackupManifest {
  createdAt: string;
  storeId: string;
  deviceId: string;
  localSchemaVersion: number;
  counts: Record<string, number>;
  unsyncedSales: number;
  sha256: string;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  storeId: string;
  deviceId: string;
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  cipher: { name: "AES-256-GCM"; iv: string };
  ciphertext: string;
}

type SerializedImage = {
  id: string;
  productId: string;
  mime: string;
  width: number;
  height: number;
  createdAt: string;
  uploadStatus: string;
  data: string;
};

async function blobToB64(blob: Blob): Promise<string> {
  return toB64(new Uint8Array(await blob.arrayBuffer()));
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function collectTables(db: PosDatabase): Promise<Record<string, unknown[]>> {
  const tables: Record<string, unknown[]> = {};
  for (const table of db.tables) {
    if (table.name === "productImages") {
      const imgs = await db.productImages.toArray();
      tables.productImages = await Promise.all(
        imgs.map(async ({ blob, ...rest }): Promise<SerializedImage> => ({ ...rest, data: await blobToB64(blob) })),
      );
    } else if (table.name === "config") {
      tables.config = (await db.config.toArray()).filter((kv) => !EXCLUDED_CONFIG_KEYS.has(kv.key));
    } else {
      tables[table.name] = await table.toArray();
    }
  }
  return tables;
}

export async function createBackup(
  passphrase: string,
  db = getDb(),
): Promise<{ file: BackupFile; manifest: BackupManifest }> {
  if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const device = await ensureDevice(db);
  const tables = await collectTables(db);
  const tablesJson = JSON.stringify(tables);
  const createdAt = new Date().toISOString();
  const manifest: BackupManifest = {
    createdAt,
    storeId: device.storeId,
    deviceId: device.deviceId,
    localSchemaVersion: LOCAL_SCHEMA_VERSION,
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    unsyncedSales: await db.sales.where("syncStatus").notEqual("synced").count(),
    sha256: await sha256Hex(tablesJson),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify({ manifest, tables: tablesJson }));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt,
    storeId: device.storeId,
    deviceId: device.deviceId,
    kdf: { name: "PBKDF2-SHA256", iterations: KDF_ITERATIONS, salt: toB64(salt) },
    cipher: { name: "AES-256-GCM", iv: toB64(iv) },
    ciphertext: toB64(ct),
  };
  return { file, manifest };
}

export class BackupVerifyError extends Error {}

/**
 * Decrypts and verifies a backup without touching the live database.
 * Returns the manifest and the tables for preview. Restoring is a later
 * phase and will go through a staging area first (docs/BACKUP_RECOVERY.md).
 */
export async function verifyBackup(raw: string, passphrase: string) {
  let file: BackupFile;
  try {
    file = JSON.parse(raw);
  } catch {
    throw new BackupVerifyError("This is not a backup file.");
  }
  if (file.format !== BACKUP_FORMAT) throw new BackupVerifyError("This is not a Local Butcher device backup.");
  if (file.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupVerifyError("This backup was made by a newer version of the app.");
  }
  const key = await deriveKey(passphrase, fromB64(file.kdf.salt), file.kdf.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(file.cipher.iv) },
      key,
      fromB64(file.ciphertext),
    );
  } catch {
    throw new BackupVerifyError("Wrong passphrase, or the file is damaged.");
  }
  const { manifest, tables: tablesJson } = JSON.parse(new TextDecoder().decode(plain)) as {
    manifest: BackupManifest;
    tables: string;
  };
  if ((await sha256Hex(tablesJson)) !== manifest.sha256) {
    throw new BackupVerifyError("Integrity check failed: the content does not match its checksum.");
  }
  const tables = JSON.parse(tablesJson) as Record<string, unknown[]>;
  for (const [name, count] of Object.entries(manifest.counts)) {
    if ((tables[name]?.length ?? -1) !== count) throw new BackupVerifyError(`Record count mismatch in ${name}.`);
  }
  return { manifest, tables };
}

export function backupFileName(createdAt: string): string {
  return `local-butcher-device-backup-${createdAt.replace(/[:.]/g, "-")}.tlbbackup.json`;
}
