"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { findMemberByCode, searchMembers } from "@/lib/db/members";
import type { Member } from "@/lib/db/types";
import { Button, Modal, inputClass } from "@/components/ui";
import { QrScanner } from "./qr-scanner";

/**
 * Finds a member for the current sale: scan the card with the camera,
 * scan it with a USB/Bluetooth scanner (it types the code), or search by
 * name, member number or mobile number.
 */
export function MemberPicker({ onPick, onClose }: { onPick: (m: Member) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [camera, setCamera] = useState(false);
  const [notFound, setNotFound] = useState<string>();
  const results = useLiveQuery(() => (query.trim() ? searchMembers(query, undefined, 8) : []), [query]);

  async function lookUp(text: string) {
    setNotFound(undefined);
    const m = await findMemberByCode(text);
    if (m && m.active) return onPick(m);
    if (m) return setNotFound(`${m.name}'s membership is switched off. Turn it back on in Members first.`);
    setNotFound(
      `No member on this device for “${text.trim().slice(0, 60)}”. If they registered on another device, sync first.`,
    );
  }

  return (
    <Modal open onClose={onClose} title="Add member to sale">
      <div className="grid gap-3">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const hit = await findMemberByCode(query);
            if (hit || !results?.length) return lookUp(query);
            if (results.length === 1) onPick(results[0]);
          }}
        >
          <input
            className={inputClass}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setNotFound(undefined);
            }}
            placeholder="Member number, name or mobile"
            aria-label="Find member"
            data-testid="member-search"
          />
        </form>
        {notFound && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="member-not-found">
            {notFound}
          </p>
        )}
        {!!results?.length && (
          <ul className="divide-y divide-cream-200 rounded-xl bg-white" data-testid="member-results">
            {results.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  disabled={!m.active}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left disabled:opacity-50"
                  onClick={() => onPick(m)}
                >
                  <span className="font-semibold">{m.name}</span>
                  <span className="font-mono text-xs text-charcoal-500">{m.memberNo}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {camera ? (
          <QrScanner onResult={(text) => void lookUp(text).then(() => setCamera(false))} />
        ) : (
          <Button variant="secondary" onClick={() => setCamera(true)} data-testid="scan-camera">
            Scan card with camera
          </Button>
        )}
      </div>
    </Modal>
  );
}
