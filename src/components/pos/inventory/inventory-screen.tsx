"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";
import { usePos } from "../pos-context";
import { MovementTab } from "./movement-tab";
import { OverviewTab } from "./overview-tab";
import { PurchasesTab } from "./purchases-tab";
import { ReceiveTab } from "./receive-tab";
import { RulesTab } from "./rules-tab";

const TABS = [
  { id: "overview", label: "Alerts" },
  { id: "receive", label: "Receive" },
  { id: "purchases", label: "Purchases" },
  { id: "movement", label: "Movement" },
  { id: "rules", label: "Rules" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function InventoryScreen() {
  const { managerUnlocked, requestManager } = usePos();
  // The tab lives in the URL (?tab=receive) so links can open a tab and a revisited page shows the right one.
  const wanted = useSearchParams().get("tab");
  const tab: TabId = TABS.find((t) => t.id === wanted)?.id ?? "overview";
  const setTab = (id: TabId) => window.history.replaceState(null, "", `?tab=${id}`);
  const asked = useRef(false);

  useEffect(() => {
    if (!managerUnlocked && !asked.current) {
      asked.current = true;
      void requestManager("Inventory, costs and supplier records need manager approval.");
    }
  }, [managerUnlocked, requestManager]);

  if (!managerUnlocked) {
    return (
      <div className="m-4 grid max-w-md gap-3 rounded-xl bg-white p-4 shadow-sm">
        <p>Inventory shows costs, suppliers and profit, so it needs the manager PIN.</p>
        <Button onClick={() => requestManager("Inventory, costs and supplier records need manager approval.")}>
          Unlock with manager PIN
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 overflow-x-auto border-b border-cream-200 bg-cream-50 px-2 pt-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-t-lg px-4 py-2 text-sm font-semibold ${
              tab === t.id ? "bg-white text-burgundy-800 shadow-sm" : "text-charcoal-700 hover:bg-cream-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "overview" && <OverviewTab />}
        {tab === "receive" && <ReceiveTab onDone={() => setTab("purchases")} />}
        {tab === "purchases" && <PurchasesTab />}
        {tab === "movement" && <MovementTab />}
        {tab === "rules" && <RulesTab />}
      </div>
    </div>
  );
}
