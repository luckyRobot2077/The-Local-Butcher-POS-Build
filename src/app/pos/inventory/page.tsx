import { Suspense } from "react";
import { InventoryScreen } from "@/components/pos/inventory/inventory-screen";

export const metadata = { title: "Inventory" };

export default function InventoryPage() {
  // The screen reads ?tab= from the URL, which is only known in the browser.
  return (
    <Suspense fallback={<p className="m-4 text-charcoal-500">Opening inventory…</p>}>
      <InventoryScreen />
    </Suspense>
  );
}
