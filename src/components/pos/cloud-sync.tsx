"use client";

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { getSupabase, supabaseApi } from "@/lib/cloud/api";
import { getCloudIdentity } from "@/lib/cloud/identity";
import { refreshAccount } from "@/lib/cloud/session";
import { runSync } from "@/lib/cloud/sync";

const SYNC_INTERVAL_MS = 60_000;

const SyncContext = createContext<{ requestSync: () => void }>({ requestSync: () => {} });

export function useRequestSync() {
  return useContext(SyncContext).requestSync;
}

/**
 * Syncs while the app is open: on start, every minute, when the app comes
 * back to the foreground or the network returns, and right after a sale.
 * It never blocks selling; failures are recorded and shown on the Device tab.
 */
export function CloudSyncProvider({ ready, children }: { ready: boolean; children: ReactNode }) {
  const accountChecked = useRef(false);

  const requestSync = useCallback(() => {
    const sb = getSupabase();
    if (!sb || !navigator.onLine) return;
    void (async () => {
      try {
        const api = supabaseApi(sb);
        if (!accountChecked.current) {
          // Refresh role and permissions once per app start when online.
          const { data } = await sb.auth.getSession();
          if (data.session) {
            await refreshAccount(sb, api);
            accountChecked.current = true;
          }
        }
        if ((await getCloudIdentity())?.deviceRegistered) await runSync(api);
      } catch {
        /* recorded in sync metadata by runSync; retried on the next trigger */
      }
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    requestSync();
    const id = setInterval(requestSync, SYNC_INTERVAL_MS);
    const onVisible = () => document.visibilityState === "visible" && requestSync();
    window.addEventListener("online", requestSync);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", requestSync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, requestSync]);

  return <SyncContext.Provider value={{ requestSync }}>{children}</SyncContext.Provider>;
}
