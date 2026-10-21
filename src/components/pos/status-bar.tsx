"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { syncCounts } from "@/lib/db/sales";

export type Reachability = "checking" | "online" | "offline";

/**
 * Checks whether the server is actually reachable, not just whether the
 * device has a network interface (navigator.onLine can be true with no
 * internet). Re-checks every 30 s, on focus, and on online/offline events.
 */
export function useReachability(): Reachability {
  const [state, setState] = useState<Reachability>("checking");
  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (!navigator.onLine) return alive && setState("offline");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`/api/health?t=${Date.now()}`, { cache: "no-store", signal: ctrl.signal });
        if (alive) setState(res.ok ? "online" : "offline");
      } catch {
        if (alive) setState("offline");
      } finally {
        clearTimeout(t);
      }
    };
    check();
    const id = setInterval(check, 30_000);
    const onVis = () => document.visibilityState === "visible" && check();
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return state;
}

export function SyncStatus({ compact = false }: { compact?: boolean }) {
  const reach = useReachability();
  const counts = useLiveQuery(() => syncCounts(), []);
  const dot = reach === "online" ? "bg-emerald-400" : reach === "offline" ? "bg-amber-400" : "bg-cream-300";
  const label = reach === "online" ? "Online" : reach === "offline" ? "Offline" : "Checking";
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="sync-status">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-burgundy-900/40 px-2 py-1">
        <span className={`size-2 rounded-full ${dot}`} aria-hidden />
        <span data-testid="reachability">{label}</span>
      </span>
      {counts && (
        <span
          className="rounded-full bg-burgundy-900/40 px-2 py-1"
          title="Sales saved on this device and waiting for cloud sync (cloud sync arrives in Phase 2)"
          data-testid="pending-count"
        >
          {counts.pendingSales} {compact ? "unsynced" : `sale${counts.pendingSales === 1 ? "" : "s"} not yet synced`}
        </span>
      )}
    </div>
  );
}
