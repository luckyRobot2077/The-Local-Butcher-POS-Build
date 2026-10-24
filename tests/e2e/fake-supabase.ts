import { createHmac, pbkdf2Sync, createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";

/**
 * A fake Supabase for end-to-end tests: sign-in always works, and each RPC
 * is answered by `rpc[fn]` (missing ones answer "function not found", like
 * a database that is behind the app). Return `{ status, body }` for errors.
 */
export type RpcHandler = (body: Record<string, unknown>) => unknown;

export const FAKE_USER_ID = "00000000-0000-0000-0000-0000000000a1";

export async function fakeSupabase(
  page: Page,
  rpc: Record<string, RpcHandler>,
  calls: { fn: string; body: Record<string, unknown> }[] = [],
  tables: Record<string, unknown[]> = {},
) {
  await page.route("http://supabase.fake.test/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });
    if (req.method() === "OPTIONS") {
      return route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        },
      });
    }
    if (url.pathname === "/auth/v1/token") {
      const { email } = req.postDataJSON();
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: "fake-access-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: "fake-refresh",
        user: {
          id: FAKE_USER_ID,
          aud: "authenticated",
          role: "authenticated",
          email,
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      });
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/").pop()!;
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      calls.push({ fn, body });
      const h = rpc[fn];
      if (!h) return json(404, { code: "PGRST202", message: `no function ${fn}` });
      const out = await h(body);
      if (out && typeof out === "object" && "status" in out && "body" in out) {
        const o = out as { status: number; body: unknown };
        return json(o.status, o.body);
      }
      return json(200, out ?? null);
    }
    if (url.pathname.startsWith("/rest/v1/")) return json(200, tables[url.pathname.split("/").pop()!] ?? []);
    return json(404, { message: "not faked" });
  });
}

export function whoami(role: "owner" | "manager" | "cashier", name = role === "cashier" ? "Ana" : "Josh") {
  return () => [
    {
      user_id: FAKE_USER_ID,
      store_id: "10000000-0000-0000-0000-000000000001",
      store_name: "The Local Butcher",
      display_name: name,
      role,
      can_edit_photos: role !== "cashier",
      can_edit_descriptions: role !== "cashier",
      can_edit_names: role !== "cashier",
      can_edit_prices: role !== "cashier",
      can_edit_categories: role !== "cashier",
      discount_limit_bp: role === "cashier" ? 1000 : 10000,
      has_store: true,
    },
  ];
}

/** Google Authenticator's code for a base32 secret (RFC 6238). */
export function totpNow(secret: string, offsetSteps = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const step = Math.floor(Date.now() / 30000) + offsetSteps;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[19] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/** The PIN record the app stores (PBKDF2-SHA256), made the same way the Back Office makes it. */
export function pinRecord(pin: string) {
  const salt = Buffer.from("test-salt-123456");
  const iterations = 210_000;
  const hash = pbkdf2Sync(pin, salt, iterations, 32, "sha256");
  return { pin_salt: salt.toString("base64"), pin_hash: hash.toString("base64"), pin_iterations: iterations };
}

export function sha256Hex(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
