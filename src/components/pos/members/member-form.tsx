"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { z } from "zod";
import { GENDERS, ageFromBirthYear, formatPhMobile, normalizePhMobile } from "@/domain/members";
import { getDb } from "@/lib/db/db";
import { registerMember, updateMember } from "@/lib/db/members";
import type { Member } from "@/lib/db/types";
import { Button, ErrorText, Field, Modal, inputClass } from "@/components/ui";
import { NumberInput } from "@/components/keypad";
import { usePos } from "../pos-context";

type Errors = Partial<
  Record<"name" | "age" | "gender" | "contactNumber" | "privacyConsent" | "deliveryAddress", string>
>;

/** Register a new member, or edit one (member number and QR code never change). */
export function MemberForm({
  member,
  onSaved,
  onClose,
}: {
  member?: Member;
  onSaved: (m: Member) => void;
  onClose: () => void;
}) {
  const { settings, cashierName } = usePos();
  const startAge = member ? String(ageFromBirthYear(member.birthYear, new Date())) : "";
  const [name, setName] = useState(member?.name ?? "");
  const [age, setAge] = useState(startAge);
  const [gender, setGender] = useState<string>(member?.gender ?? "");
  const [contact, setContact] = useState(member?.contactNumber ? formatPhMobile(member.contactNumber) : "");
  const [privacy, setPrivacy] = useState(!!member);
  const [promo, setPromo] = useState(member?.marketingConsent ?? false);
  const [notes, setNotes] = useState(member?.notes ?? "");
  const [delivery, setDelivery] = useState(member?.wantsDelivery ?? false);
  const [address, setAddress] = useState(member?.deliveryAddress ?? "");
  const [landmark, setLandmark] = useState(member?.deliveryLandmark ?? "");
  const [active, setActive] = useState(member?.active ?? true);
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const normalized = normalizePhMobile(contact);
  const sharedWith = useLiveQuery(
    async () =>
      normalized
        ? (
            await getDb()
              .members.filter((m) => m.contactNumber === normalized && m.id !== member?.id)
              .toArray()
          ).map((m) => m.name)
        : [],
    [normalized, member?.id],
  );

  async function save() {
    setBusy(true);
    setError(undefined);
    setErrors({});
    const by = cashierName || "staff";
    const ageNum = age.trim() === "" ? NaN : Number(age);
    try {
      const saved = member
        ? await updateMember(
            member.id,
            {
              name,
              age: age === startAge ? undefined : ageNum,
              gender: gender as Member["gender"],
              contactNumber: contact,
              marketingConsent: promo,
              wantsDelivery: delivery,
              deliveryAddress: delivery ? address : "",
              deliveryLandmark: delivery ? landmark : "",
              notes,
              active,
            },
            by,
          )
        : await registerMember(
            {
              name,
              age: ageNum,
              gender: gender as Member["gender"],
              contactNumber: contact,
              privacyConsent: privacy as true,
              marketingConsent: promo,
              wantsDelivery: delivery,
              deliveryAddress: delivery ? address : "",
              deliveryLandmark: delivery ? landmark : "",
              notes,
            },
            by,
          );
      onSaved(saved);
    } catch (e) {
      if (e instanceof z.ZodError) {
        const out: Errors = {};
        for (const issue of e.issues) {
          const key = issue.path[0] as keyof Errors;
          if (key && !out[key]) out[key] = issue.message;
        }
        setErrors(out);
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={member ? `Edit ${member.memberNo}` : "Register a member"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} data-testid="member-save">
            {member ? "Save changes" : "Register and make card"}
          </Button>
        </div>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Full name" error={errors.name}>
          <input
            className={inputClass}
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            data-testid="member-name"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Age" hint="Saved as birth year" error={errors.age}>
            <NumberInput
              decimal={false}
              className={inputClass}
              value={age}
              onChange={(e) => setAge(e.target.value.replace(/\D/g, "").slice(0, 3))}
              data-testid="member-age"
            />
          </Field>
          <Field label="Gender" error={errors.gender}>
            <select
              className={inputClass}
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              data-testid="member-gender"
            >
              <option value="">Choose…</option>
              {GENDERS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          label="Mobile number (optional)"
          hint={
            sharedWith?.length
              ? `Also used by ${sharedWith.slice(0, 2).join(", ")}. That is fine for a shared family phone.`
              : "For member-only promo texts, if they agree below."
          }
          error={errors.contactNumber}
        >
          <input
            className={inputClass}
            inputMode="tel"
            value={contact}
            maxLength={20}
            onChange={(e) => setContact(e.target.value)}
            placeholder="0917 123 4567"
            data-testid="member-contact"
          />
        </Field>
        {!member && (
          <label className="flex items-start gap-3 rounded-xl bg-white p-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-5 shrink-0"
              checked={privacy}
              onChange={(e) => setPrivacy(e.target.checked)}
              data-testid="member-privacy"
            />
            <span>
              <span className="font-semibold">The customer agrees</span> that {settings.storeName} keeps their name,
              age, gender, mobile number and purchase history to run the membership. They can ask to see, correct or
              remove it at any time.
              {errors.privacyConsent && (
                <span className="block text-xs font-semibold text-red-700">{errors.privacyConsent}</span>
              )}
            </span>
          </label>
        )}
        <label className="flex items-start gap-3 rounded-xl bg-white p-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-5 shrink-0"
            checked={promo}
            onChange={(e) => setPromo(e.target.checked)}
            data-testid="member-promo"
          />
          <span>
            <span className="font-semibold">Optional:</span> the customer wants member-only promo messages by text. They
            can stop them any time.
          </span>
        </label>
        <div className="grid gap-3 rounded-xl bg-white p-3 text-sm">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 size-5 shrink-0"
              checked={delivery}
              onChange={(e) => setDelivery(e.target.checked)}
              data-testid="member-delivery"
            />
            <span>
              <span className="font-semibold">Optional:</span> the customer wants home deliveries and agrees that the
              store keeps their address for them. Unticking it later removes the address.
            </span>
          </label>
          {delivery && (
            <>
              <Field
                label="Delivery address"
                hint="House or unit, street, barangay, city"
                error={errors.deliveryAddress}
              >
                <textarea
                  className={`${inputClass} py-2`}
                  rows={2}
                  value={address}
                  maxLength={300}
                  onChange={(e) => setAddress(e.target.value)}
                  data-testid="member-address"
                />
              </Field>
              <Field label="Landmark or directions (optional)">
                <input
                  className={inputClass}
                  value={landmark}
                  maxLength={150}
                  onChange={(e) => setLandmark(e.target.value)}
                  placeholder="e.g. green gate beside the sari-sari store"
                  data-testid="member-landmark"
                />
              </Field>
              {!contact.trim() && (
                <p className="text-xs text-amber-800">Add a mobile number so the rider can call when they arrive.</p>
              )}
            </>
          )}
        </div>
        <Field label="Notes (optional)">
          <input className={inputClass} value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {member && (
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" className="size-5" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Membership active (switch off to stop the card working)
          </label>
        )}
        <ErrorText>{error}</ErrorText>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
