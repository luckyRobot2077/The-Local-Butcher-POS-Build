import { afterEach, describe, expect, it } from "vitest";
import { PosDatabase } from "@/lib/db/db";
import { LOCK_MS, MAX_TRIES, lockMessage, lockedFor, recordTry } from "@/lib/attempts";

const dbs: PosDatabase[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});

async function fresh() {
  const db = new PosDatabase(`attempts-${Math.random()}`);
  dbs.push(db);
  await db.open();
  return db;
}

describe("wrong-try lock", () => {
  it("locks after five wrong tries and survives a new database handle", async () => {
    const db = await fresh();
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_TRIES - 1; i++) await recordTry("managerPin", false, db, t0 + i);
    expect(await lockedFor("managerPin", db, t0 + 10)).toBe(0);
    await recordTry("managerPin", false, db, t0 + 10);
    expect(await lockedFor("managerPin", db, t0 + 10)).toBe(LOCK_MS);

    // Reloading the page opens the same database again.
    const again = new PosDatabase(db.name);
    await again.open();
    expect(await lockedFor("managerPin", again, t0 + 70_000)).toBe(LOCK_MS - 69_990);
    again.close();

    // Other checks are not affected.
    expect(await lockedFor("pin:abc", db, t0 + 10)).toBe(0);
  });

  it("starts a fresh count once the lock runs out, and a success clears it", async () => {
    const db = await fresh();
    const t0 = 5_000_000;
    for (let i = 0; i < MAX_TRIES; i++) await recordTry("code:x", false, db, t0);
    const after = t0 + LOCK_MS + 1;
    expect(await lockedFor("code:x", db, after)).toBe(0);
    await recordTry("code:x", false, db, after);
    expect(await lockedFor("code:x", db, after)).toBe(0);
    for (let i = 0; i < MAX_TRIES - 2; i++) await recordTry("code:x", false, db, after);
    await recordTry("code:x", true, db, after);
    await recordTry("code:x", false, db, after);
    expect(await lockedFor("code:x", db, after)).toBe(0);
  });

  it("says how many minutes are left", () => {
    expect(lockMessage(LOCK_MS)).toBe("Too many wrong tries. Try again in 5 minutes.");
    expect(lockMessage(30_000)).toBe("Too many wrong tries. Try again in 1 minute.");
  });
});
