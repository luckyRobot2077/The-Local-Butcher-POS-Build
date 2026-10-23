import { getDb, type PosDatabase } from "./db/db";

/**
 * Wrong-guess limit for PINs and authenticator codes on this device. After
 * MAX_TRIES wrong tries in a row the check is refused for LOCK_MS. The count
 * is kept in the local database, so reloading the page does not reset it.
 */
export const MAX_TRIES = 5;
export const LOCK_MS = 5 * 60_000;
const KEY = "wrongTries";

type Tries = Record<string, { count: number; until: number }>;

async function load(db: PosDatabase): Promise<Tries> {
  return ((await db.config.get(KEY))?.value as Tries | undefined) ?? {};
}

/** Milliseconds left before this check may be tried again (0 when it is open). */
export async function lockedFor(scope: string, db: PosDatabase = getDb(), nowMs = Date.now()): Promise<number> {
  const t = (await load(db))[scope];
  return t && t.until > nowMs ? t.until - nowMs : 0;
}

/** Records the result of a check. A success clears the count; the fifth failure starts the lock. */
export async function recordTry(
  scope: string,
  ok: boolean,
  db: PosDatabase = getDb(),
  nowMs = Date.now(),
): Promise<void> {
  await db.transaction("rw", db.config, async () => {
    const all = await load(db);
    if (ok) delete all[scope];
    else {
      const prev = all[scope];
      // A lock that has run out starts a fresh count.
      const t = !prev || (prev.until && prev.until <= nowMs) ? { count: 0, until: 0 } : { ...prev };
      t.count++;
      if (t.count >= MAX_TRIES) t.until = nowMs + LOCK_MS;
      all[scope] = t;
    }
    await db.config.put({ key: KEY, value: all });
  });
}

export function lockMessage(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  return `Too many wrong tries. Try again in ${min} minute${min === 1 ? "" : "s"}.`;
}
