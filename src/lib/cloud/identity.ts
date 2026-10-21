import { getDb } from "@/lib/db/db";

/** Who is signed in on this device, as last confirmed by the server. */
export interface CloudIdentity {
  userId: string;
  email: string;
  storeId: string;
  storeName: string;
  displayName: string;
  role: "owner" | "manager" | "cashier";
  canEditPhotos: boolean;
  canEditDescriptions: boolean;
  canEditNames: boolean;
  canEditPrices: boolean;
  canEditCategories: boolean;
  discountLimitBp: number;
  deviceRegistered: boolean;
  confirmedAt: string;
}

export interface SyncMeta {
  lastSyncAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  running?: boolean;
}

export async function getCloudIdentity(db = getDb()): Promise<CloudIdentity | undefined> {
  return (await db.config.get("cloud"))?.value as CloudIdentity | undefined;
}

export async function setCloudIdentity(id: CloudIdentity | undefined, db = getDb()): Promise<void> {
  if (id) await db.config.put({ key: "cloud", value: id });
  else await db.config.delete("cloud");
}

export async function getSyncMeta(db = getDb()): Promise<SyncMeta> {
  return ((await db.config.get("syncMeta"))?.value as SyncMeta | undefined) ?? {};
}

export async function patchSyncMeta(patch: Partial<SyncMeta>, db = getDb()): Promise<void> {
  await db.transaction("rw", db.config, async () => {
    const cur = ((await db.config.get("syncMeta"))?.value as SyncMeta | undefined) ?? {};
    await db.config.put({ key: "syncMeta", value: { ...cur, ...patch } });
  });
}
