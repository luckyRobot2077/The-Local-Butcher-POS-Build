"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { GENDERS, ageFromBirthYear, formatPhMobile } from "@/domain/members";
import { formatPeso } from "@/domain/money";
import { formatManila } from "@/domain/time";
import { getDb } from "@/lib/db/db";
import { memberHistory, searchMembers } from "@/lib/db/members";
import type { Member } from "@/lib/db/types";
import { Badge, Button, Modal, inputClass } from "@/components/ui";
import { MemberCard } from "./member-card";
import { MemberForm } from "./member-form";
import { MemberPicker } from "./member-picker";

type Dialog = { type: "register" } | { type: "edit"; member: Member } | { type: "view"; id: string } | { type: "scan" };

export function MembersTab() {
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const members = useLiveQuery(() => searchMembers(query, undefined, 200), [query]);
  const total = useLiveQuery(() => getDb().members.count(), []);

  return (
    <div className="mx-auto grid max-w-3xl gap-3">
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          className={`${inputClass} min-w-0 flex-1`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, member number or mobile"
          aria-label="Search members"
        />
        <Button variant="secondary" onClick={() => setDialog({ type: "scan" })}>
          Scan card
        </Button>
        <Button onClick={() => setDialog({ type: "register" })} data-testid="register-member">
          Register member
        </Button>
      </div>
      <p className="text-sm text-charcoal-500">
        {total ?? 0} member{total === 1 ? "" : "s"} on this device. Members registered on other devices appear after a
        sync.
      </p>
      <ul className="divide-y divide-cream-200 rounded-xl bg-white shadow-sm" data-testid="member-list">
        {members?.length === 0 && (
          <li className="p-6 text-center text-charcoal-500">
            {query ? "No members match." : "No members yet. Register the first one."}
          </li>
        )}
        {members?.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-cream-50"
              onClick={() => setDialog({ type: "view", id: m.id })}
            >
              <span>
                <span className="block font-semibold">{m.name}</span>
                <span className="font-mono text-xs text-charcoal-500">{m.memberNo}</span>
              </span>
              <span className="flex gap-1">
                {!m.active && <Badge tone="danger">Off</Badge>}
                {m.marketingConsent && <Badge tone="ok">Promos</Badge>}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {dialog?.type === "register" && (
        <MemberForm onClose={() => setDialog(null)} onSaved={(m) => setDialog({ type: "view", id: m.id })} />
      )}
      {dialog?.type === "edit" && (
        <MemberForm
          member={dialog.member}
          onClose={() => setDialog({ type: "view", id: dialog.member.id })}
          onSaved={(m) => setDialog({ type: "view", id: m.id })}
        />
      )}
      {dialog?.type === "scan" && (
        <MemberPicker onClose={() => setDialog(null)} onPick={(m) => setDialog({ type: "view", id: m.id })} />
      )}
      {dialog?.type === "view" && (
        <MemberDetail
          id={dialog.id}
          onClose={() => setDialog(null)}
          onEdit={(member) => setDialog({ type: "edit", member })}
        />
      )}
    </div>
  );
}

function MemberDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (m: Member) => void }) {
  const member = useLiveQuery(() => getDb().members.get(id), [id]);
  const history = useLiveQuery(() => memberHistory(id), [id]);
  if (!member) return null;
  const now = new Date();
  return (
    <Modal open onClose={onClose} title={member.name} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <MemberCard member={member} />
        <div className="grid content-start gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="member-info">
            <dt className="text-charcoal-500">Member no.</dt>
            <dd className="font-mono font-semibold">{member.memberNo}</dd>
            <dt className="text-charcoal-500">Age</dt>
            <dd>
              about {ageFromBirthYear(member.birthYear, now)} (born {member.birthYear})
            </dd>
            <dt className="text-charcoal-500">Gender</dt>
            <dd>{GENDERS.find((g) => g.id === member.gender)?.label}</dd>
            <dt className="text-charcoal-500">Mobile</dt>
            <dd>{member.contactNumber ? formatPhMobile(member.contactNumber) : "—"}</dd>
            <dt className="text-charcoal-500">Promo texts</dt>
            <dd>{member.marketingConsent ? "Yes" : "No"}</dd>
            <dt className="text-charcoal-500">Registered</dt>
            <dd>
              {formatManila(member.registeredAt)} by {member.registeredBy || "—"}
            </dd>
            {!member.active && (
              <>
                <dt className="text-charcoal-500">Status</dt>
                <dd className="font-semibold text-red-700">Switched off</dd>
              </>
            )}
          </dl>
          <Button variant="secondary" onClick={() => onEdit(member)} data-testid="member-edit">
            Edit details
          </Button>
          <div className="rounded-xl bg-white p-3">
            <h3 className="font-bold text-burgundy-800">Purchases</h3>
            {history && (
              <p className="text-sm text-charcoal-700" data-testid="member-summary">
                {history.visits.length} visit{history.visits.length === 1 ? "" : "s"} · {formatPeso(history.totalSpent)}
                {history.lastVisit ? ` · last ${formatManila(history.lastVisit)}` : ""}
              </p>
            )}
            <ul
              className="mt-2 max-h-56 divide-y divide-cream-200 overflow-y-auto text-sm"
              data-testid="member-history"
            >
              {history?.visits.length === 0 && <li className="py-2 text-charcoal-500">No purchases yet.</li>}
              {history?.visits.map((v) => (
                <li key={v.saleId} className="flex justify-between gap-2 py-1.5">
                  <span>
                    {formatManila(v.at)}
                    <span className="block text-xs text-charcoal-500">
                      {v.receiptNo ?? "Other device"} · {v.items} item{v.items === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="font-semibold">{formatPeso(v.total)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-charcoal-500">
              Sales from other devices show here on owner and manager devices after a sync.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
