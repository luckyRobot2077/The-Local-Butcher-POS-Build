import { z } from "zod";
import { DEFAULT_INVENTORY_RULES } from "@/domain/inventory";
import { normalizeTaxSettings, type TaxSettings } from "@/domain/tax";
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
  /** Social accounts printed under the QR code on member cards. Empty ones are left off. */
  socials: z.object({
    facebook: z.string().trim().max(60),
    tiktok: z.string().trim().max(60),
    whatsapp: z.string().trim().max(30),
  }),
  /** Lets cashiers change product photos and descriptions without the manager PIN. */
  cashierCanEditPhotos: z.boolean(),
  /** Thresholds for movement classification, alerts and order estimates (spec 11). */
  inventoryRules: z.object({
    periodDays: z.number().int().min(7).max(90),
    fastPct: z.number().int().min(5).max(50),
    slowPct: z.number().int().min(5).max(50),
    minHistoryDays: z.number().int().min(1).max(90),
    nonMovingDays: z.number().int().min(1).max(60),
    minGroupSize: z.number().int().min(2).max(50),
    trendPct: z.number().int().min(5).max(200),
    stockoutDays: z.number().int().min(0).max(60),
    excessCoverageDays: z.number().int().min(1).max(365),
    useByWarnDays: z.number().int().min(0).max(30),
    leadTimeDays: z.number().int().min(0).max(30),
    orderCoverDays: z.number().int().min(1).max(60),
    safetyDays: z.number().int().min(0).max(30),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  storeName: "The Local Butcher",
  tagline: "Where Quality Meets Affordability",
  businessLines: [],
  receiptFooter: "Salamat po! Please come again.",
  cashierDiscountLimitBp: 1000,
  allowItemAndOrderStacking: false,
  socials: { facebook: "", tiktok: "", whatsapp: "" },
  cashierCanEditPhotos: false,
  inventoryRules: DEFAULT_INVENTORY_RULES,
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
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    socials: { ...DEFAULT_SETTINGS.socials, ...stored?.socials },
    inventoryRules: { ...DEFAULT_INVENTORY_RULES, ...stored?.inventoryRules },
  };
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

/** Store tax setup, set in the Back Office and downloaded on every sync. Non-VAT until then. */
export async function getTaxSettings(db = getDb()): Promise<TaxSettings> {
  return normalizeTaxSettings(await getValue<unknown>(db, "taxSettings"));
}

export async function setTaxSettings(s: TaxSettings, db = getDb()): Promise<void> {
  await db.config.put({ key: "taxSettings", value: normalizeTaxSettings(s) });
}
