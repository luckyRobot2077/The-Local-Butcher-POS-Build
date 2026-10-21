import Link from "next/link";

export const metadata = { title: "Back Office" };

const PLANNED = [
  ["Phase 2", "Cloud sync to Supabase, staff sign-in and server-side permissions"],
  ["Phase 3", "Supplier purchases, batches, wastage, fast/slow-moving analysis"],
  ["Phase 4", "Member registration, purchase history, promotions (no tiers)"],
  ["Phase 5", "Sales and profit dashboards, expenses, shifts, audit history, CSV exports"],
  ["Phase 6", "PT-210 printer integration after testing on the real printer"],
  ["Phase 7", "Cloud backups, scheduled off-site backups, restore wizard"],
];

export default function OfficePage() {
  return (
    <main className="mx-auto grid w-full max-w-2xl gap-4 p-4">
      <h1 className="text-2xl font-bold text-burgundy-800">Back Office</h1>
      <p className="rounded-xl bg-amber-50 p-3 text-amber-900">
        The Back Office is not built yet. It needs cloud data (Phase 2) to show reports across devices. Today&apos;s
        totals for this device are on the POS History tab, and backups are on the POS Device tab.
      </p>
      <ol className="grid gap-2">
        {PLANNED.map(([phase, text]) => (
          <li key={phase} className="rounded-xl border border-cream-300 bg-white p-3">
            <span className="font-bold text-burgundy-700">{phase}:</span> {text}
          </li>
        ))}
      </ol>
      <Link href="/pos" className="font-semibold text-burgundy-700 underline">
        Back to POS
      </Link>
    </main>
  );
}
