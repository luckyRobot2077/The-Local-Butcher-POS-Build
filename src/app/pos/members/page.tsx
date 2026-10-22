import { Suspense } from "react";
import { MembersScreen } from "@/components/pos/members/members-screen";

export const metadata = { title: "Members" };

export default function MembersPage() {
  // The screen reads ?tab= from the URL, which is only known in the browser.
  return (
    <Suspense fallback={<p className="m-4 text-charcoal-500">Opening members…</p>}>
      <MembersScreen />
    </Suspense>
  );
}
