"use client";

import { useEffect, useState } from "react";
import { renderMemberCard } from "@/lib/members/card";
import type { Member } from "@/lib/db/types";
import { Button, ErrorText } from "@/components/ui";
import { usePos } from "../pos-context";

/** Card preview with print and save buttons. */
export function MemberCard({ member }: { member: Member }) {
  const { settings } = usePos();
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    renderMemberCard({
      memberId: member.id,
      memberNo: member.memberNo,
      name: member.name,
      storeName: settings.storeName,
      tagline: settings.tagline,
    })
      .then((url) => !cancelled && setSrc(url))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [member.id, member.memberNo, member.name, settings.storeName, settings.tagline]);

  function print() {
    // Card-size page just for this print, then back to the 58 mm receipt layout.
    const style = document.createElement("style");
    style.textContent = "@page { size: 85.6mm 54mm; margin: 0; }";
    document.head.appendChild(style);
    document.documentElement.classList.add("printing-card");
    const cleanup = () => {
      style.remove();
      document.documentElement.classList.remove("printing-card");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    try {
      window.print();
    } catch {
      cleanup();
      setError("Printing failed. Save the card image and print it instead.");
    }
  }

  return (
    <div className="grid gap-2">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- generated data URL, must work offline
        <img
          src={src}
          alt={`Member card for ${member.name}, ${member.memberNo}`}
          className="print-card mx-auto w-full max-w-sm rounded-xl border border-cream-300 shadow"
          data-testid="member-card"
        />
      ) : (
        <div className="mx-auto aspect-[1012/638] w-full max-w-sm animate-pulse rounded-xl bg-cream-200" />
      )}
      <ErrorText>{error}</ErrorText>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" disabled={!src} onClick={print} data-testid="print-card">
          Print card
        </Button>
        <a
          href={src}
          download={`${member.memberNo}.png`}
          aria-disabled={!src}
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-cream-300 bg-white px-4 font-semibold text-charcoal-900 hover:bg-cream-50"
        >
          Save image
        </a>
      </div>
      <p className="text-center text-xs text-charcoal-500">
        ID-card size (85.6 × 54 mm). Print on card stock, or save the image for a PVC card printer or print shop.
      </p>
    </div>
  );
}
