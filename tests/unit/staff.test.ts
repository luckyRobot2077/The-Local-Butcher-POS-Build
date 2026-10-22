import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, matchTotp, newTotpSecret, otpauthUri, totpCode } from "@/lib/staff/totp";
import {
  BADGE_PREFIX,
  badgeSignInEnabled,
  approversWithCode,
  looksLikeBadge,
  newBadgeText,
  sha256Hex,
  type LocalEmployee,
} from "@/lib/staff/employees";

// RFC 6238 appendix B: secret "12345678901234567890", SHA-1. Authenticator apps show the last 6 digits.
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

describe("authenticator codes", () => {
  it("match the RFC 6238 test vectors", async () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(await totpCode(RFC_SECRET, 1)).toBe("287082"); // T = 59
    expect(await totpCode(RFC_SECRET, 37037036)).toBe("081804"); // T = 1111111109
    expect(await totpCode(RFC_SECRET, 37037037)).toBe("050471"); // T = 1111111111
    expect(await totpCode(RFC_SECRET, 41152263)).toBe("005924"); // T = 1234567890
    expect(await totpCode(RFC_SECRET, 66666666)).toBe("279037"); // T = 2000000000
  });

  it("accepts one step of clock drift and refuses a used step", async () => {
    const now = 1111111111 * 1000;
    expect(await matchTotp(RFC_SECRET, "050471", 0, now)).toBe(37037037);
    expect(await matchTotp(RFC_SECRET, "081804", 0, now)).toBe(37037036);
    expect(await matchTotp(RFC_SECRET, "050471", 37037037, now)).toBeNull();
    expect(await matchTotp(RFC_SECRET, "12345", 0, now)).toBeNull();
    expect(await matchTotp(RFC_SECRET, "287082", 0, now)).toBeNull();
  });

  it("makes 160-bit secrets and the link authenticator apps scan", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(otpauthUri("JBSWY3DPEHPK3PXP", "Josh (E-0001)", "The Local Butcher")).toBe(
      "otpauth://totp/The%20Local%20Butcher%3AJosh%20(E-0001)?secret=JBSWY3DPEHPK3PXP&issuer=The%20Local%20Butcher&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("employee badges", () => {
  it("are random, marked, and stored only as a hash", async () => {
    const a = newBadgeText();
    expect(a).toMatch(/^TLB-STAFF:[0-9a-f]{32}$/);
    expect(newBadgeText()).not.toBe(a);
    expect(looksLikeBadge(a)).toBe(true);
    expect(looksLikeBadge("TLB-M:1234")).toBe(false);
    expect(await sha256Hex(`${BADGE_PREFIX}x`)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("turn on badge sign-in and code approval only when set up", () => {
    const e = (over: Partial<LocalEmployee>): LocalEmployee => ({
      id: "1",
      employeeNo: "E-0001",
      name: "Josh",
      role: "owner",
      active: true,
      badgeHash: "0".repeat(64),
      ...over,
    });
    expect(badgeSignInEnabled([])).toBe(false);
    expect(badgeSignInEnabled([e({})])).toBe(false); // no PIN yet
    expect(badgeSignInEnabled([e({ pin: { salt: "a", hash: "b", iterations: 1 } })])).toBe(true);
    expect(
      approversWithCode([e({ totpSecret: "JBSWY3DPEHPK3PXP" }), e({ role: "cashier", totpSecret: "X" })]),
    ).toHaveLength(1);
    expect(approversWithCode([e({ totpSecret: "JBSWY3DPEHPK3PXP", active: false })])).toHaveLength(0);
  });
});
