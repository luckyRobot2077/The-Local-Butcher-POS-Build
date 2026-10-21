import { z } from "zod";
import { getDb, type PosDatabase } from "./db";
import { newId } from "./ids";

export const settingsSchema = z.object({
  storeName: z.string().trim().min(1).max(60),
  tagline: z.string().max(80),
  /** Registered business details printed on receipts, one per line. */
  businessLines: z.array(z.string().max(60)).max(6),
  receiptFooter: z.string().max(120),
  /** Highest manual discount a cashier may give without the manager PIN, in basis points. */
  cashierDiscountLimitBp: z.number().int().min(0).max(10_000),
  allowItemAndOrderStacking: z.boolean(),
  /** Lets cashiers change product photos and descriptions without the manager PIN. */
  cashierCanEditPhotos: z.boolean(),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  storeName: "The Local Butcher",
  tagline: "Where Quality Meets Affordability",
  businessLines: [],
  receiptFooter: "Salamat po! Please come again.",
  cashierDiscountLimitBp: 1000,
  allowItemAndOrderStacking: false,
  cashierCanEditPhotos: false,
};

export interface DeviceIdentity {
  storeId: string;
  deviceId: string;
  /** Short code printed in receipt numbers so two devices never collide. */
  deviceCode: string;
  registeredAt: string;
}

export interface PinRecord {
  salt: string; // base64
  hash: string; // base64
  iterations: number;
}

async function getValue<T>(db: PosDatabase, key: string): Promise<T | undefined> {
  return (await db.config.get(key))?.value as T | undefined;
}

export async function getSettings(db = getDb()): Promise<Settings> {
  const stored = await getValue<Partial<Settings>>(db, "settings");
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(s: Settings, db = getDb()): Promise<void> {
  await db.config.put({ key: "settings", value: settingsSchema.parse(s) });
}

function randomDeviceCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Returns this device's identity, creating it on first use. */
export async function ensureDevice(db = getDb()): Promise<DeviceIdentity> {
  return db.transaction("rw", db.config, async () => {
    const existing = await getValue<DeviceIdentity>(db, "device");
    if (existing) return existing;
    const device: DeviceIdentity = {
      storeId: newId(),
      deviceId: newId(),
      deviceCode: randomDeviceCode(),
      registeredAt: new Date().toISOString(),
    };
    await db.config.put({ key: "device", value: device });
    return device;
  });
}

export async function getCashierName(db = getDb()): Promise<string> {
  return (await getValue<string>(db, "cashierName")) ?? "";
}

export async function setCashierName(name: string, db = getDb()): Promise<void> {
  await db.config.put({ key: "cashierName", value: name.trim().slice(0, 40) });
}

export async function getPinRecord(db = getDb()): Promise<PinRecord | undefined> {
  return getValue<PinRecord>(db, "managerPin");
}

export async function setPinRecord(rec: PinRecord, db = getDb()): Promise<void> {
  await db.config.put({ key: "managerPin", value: rec });
}

export async function getLastExportAt(db = getDb()): Promise<string | undefined> {
  return getValue<string>(db, "lastExportAt");
}

export async function setLastExportAt(at: string, db = getDb()): Promise<void> {
  await db.config.put({ key: "lastExportAt", value: at });
}
