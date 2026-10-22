import { getDb, type PosDatabase } from "@/lib/db/db";
import { verifyPin } from "@/lib/pin";
import { matchTotp } from "./totp";

/**
 * Employees as this device knows them (downloaded from the cloud), so staff
 * can sign in at the counter with their badge and PIN while offline.
 */
export type StaffRole = "owner" | "manager" | "cashier";

export interface LocalEmployee {
  id: string;
  employeeNo: string;
  name: string;
  role: StaffRole;
  active: boolean;
  badgeHash: string;
  pin?: { salt: string; hash: string; iterations: number };
  /** Authenticator secret, for owners and managers who linked an app. */
  totpSecret?: string;
}

export interface SignedInEmployee {
  id: string;
  employeeNo: string;
  name: string;
  role: StaffRole;
}

const EMPLOYEES_KEY = "employees";
const TOTP_STEPS_KEY = "totpLastSteps";

/** Badge QR text starts with this so a member card is never taken for a badge. */
export const BADGE_PREFIX = "TLB-STAFF:";

export function newBadgeText(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return BADGE_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function looksLikeBadge(text: string): boolean {
  return text.trim().startsWith(BADGE_PREFIX);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getEmployees(db: PosDatabase = getDb()): Promise<LocalEmployee[]> {
  return ((await db.config.get(EMPLOYEES_KEY))?.value as LocalEmployee[] | undefined) ?? [];
}

export async function setEmployees(list: LocalEmployee[], db: PosDatabase = getDb()): Promise<void> {
  await db.config.put({ key: EMPLOYEES_KEY, value: list });
}

/** Badge sign-in is on once the shop has at least one active employee with a PIN. */
export function badgeSignInEnabled(list: LocalEmployee[]): boolean {
  return list.some((e) => e.active && e.pin);
}

/** Authenticator approval is on once an owner or manager has linked an app. */
export function approversWithCode(list: LocalEmployee[]): LocalEmployee[] {
  return list.filter((e) => e.active && e.totpSecret && (e.role === "owner" || e.role === "manager"));
}

export async function findByBadge(text: string, db: PosDatabase = getDb()): Promise<LocalEmployee | undefined> {
  const hash = await sha256Hex(text.trim());
  return (await getEmployees(db)).find((e) => e.active && e.badgeHash === hash);
}

export async function checkEmployeePin(e: LocalEmployee, pin: string): Promise<boolean> {
  return !!e.pin && verifyPin(pin, e.pin);
}

/**
 * Checks an authenticator code for an owner or manager on this device. A code
 * is accepted once per device (the step is remembered).
 */
export async function checkApproverCode(
  e: LocalEmployee,
  code: string,
  db: PosDatabase = getDb(),
  nowMs = Date.now(),
): Promise<boolean> {
  if (!e.totpSecret || (e.role !== "owner" && e.role !== "manager")) return false;
  const steps = ((await db.config.get(TOTP_STEPS_KEY))?.value as Record<string, number> | undefined) ?? {};
  const step = await matchTotp(e.totpSecret, code.trim(), steps[e.id] ?? 0, nowMs);
  if (step === null) return false;
  await db.config.put({ key: TOTP_STEPS_KEY, value: { ...steps, [e.id]: step } });
  return true;
}

export function toSignedIn(e: LocalEmployee): SignedInEmployee {
  return { id: e.id, employeeNo: e.employeeNo, name: e.name, role: e.role };
}

export const ROLE_LABEL: Record<StaffRole, string> = { owner: "Owner", manager: "Manager", cashier: "Cashier" };
