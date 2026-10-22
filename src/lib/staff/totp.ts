/**
 * Time-based one-time codes (RFC 6238) as Google Authenticator makes them:
 * HMAC-SHA1, 30-second steps, 6 digits. The same maths runs in the database
 * (`totp_code`) for the Back Office, and here for approvals on the POS,
 * which must work offline.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("Not a base32 secret");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new 160-bit secret for an authenticator app. */
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export async function totpCode(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const msg = new Uint8Array(8);
  let s = step;
  for (let i = 7; i >= 0; i--) {
    msg[i] = s & 255;
    s = Math.floor(s / 256);
  }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[19] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * The step a code belongs to (allowing one step of clock drift either way),
 * or null. Steps at or before `lastStep` are refused so a code works once.
 */
export async function matchTotp(
  secret: string,
  code: string,
  lastStep = 0,
  nowMs = Date.now(),
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step > lastStep && (await totpCode(secret, step)) === code) return step;
  }
  return null;
}

/** The link an authenticator app reads from a QR code. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
