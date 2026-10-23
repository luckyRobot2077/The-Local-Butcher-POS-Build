import { describe, expect, it } from "vitest";
import { backupHealth, formatBytes } from "@/domain/backups";

describe("backup health", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  it("is ok within a day and a half, late after, never without a backup", () => {
    expect(backupHealth(null, now)).toBe("never");
    expect(backupHealth("2026-10-23T00:30:00Z", now)).toBe("ok");
    expect(backupHealth("2026-10-22T00:00:01Z", now)).toBe("ok");
    expect(backupHealth("2026-10-21T23:59:00Z", now)).toBe("late");
  });
  it("formats sizes", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(24_000)).toBe("23 KB");
    expect(formatBytes(2_400_000)).toBe("2.3 MB");
  });
});
