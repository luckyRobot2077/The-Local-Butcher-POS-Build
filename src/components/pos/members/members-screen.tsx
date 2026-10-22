"use client";

import { useSearchParams } from "next/navigation";
import { InsightsTab } from "./insights-tab";
import { MembersTab } from "./members-tab";
import { ProgramsTab } from "./programs-tab";

const TABS = [
  { id: "members", label: "Members" },
  { id: "programs", label: "Discount programs" },
  { id: "insights", label: "Insights" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function MembersScreen() {
  // The tab lives in the URL (?tab=programs) so links can open a tab and a revisited page shows the right one.
  const wanted = useSearchParams().get("tab");
  const tab: TabId = TABS.find((t) => t.id === wanted)?.id ?? "members";
  const setTab = (id: TabId) => window.history.replaceState(null, "", `?tab=${id}`);

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
        {tab === "members" && <MembersTab />}
        {tab === "programs" && <ProgramsTab />}
        {tab === "insights" && <InsightsTab />}
      </div>
    </div>
  );
}
