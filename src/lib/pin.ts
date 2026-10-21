import type { PinRecord } from "./db/config";

/**
 * Manager PIN for this device, stored as a salted PBKDF2-SHA256 hash.
 *
 * This is a local deterrent so cashiers do not wander into product editing
 * or large discounts by accident. It is NOT server-side authorization:
 * real role checks arrive with Supabase Auth in Phase 2.
 */
const ITERATIONS = 210_000;

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export function isValidPinFormat(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

export async function hashPin(pin: string): Promise<PinRecord> {
  if (!isValidPinFormat(pin)) throw new Error("PIN must be 4 to 8 digits.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  return { salt: toB64(salt), hash: toB64(hash), iterations: ITERATIONS };
}

export async function verifyPin(pin: string, rec: PinRecord): Promise<boolean> {
  if (!isValidPinFormat(pin)) return false;
  const hash = await derive(pin, fromB64(rec.salt), rec.iterations);
  const expected = fromB64(rec.hash);
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}
