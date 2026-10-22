import { z } from "zod";
import {
  GENDERS,
  MAX_MEMBER_AGE,
  MIN_MEMBER_AGE,
  MemberError,
  birthYearFromAge,
  formatMemberNo,
  normalizePhMobile,
  parseMemberCode,
  type SaleFact,
} from "@/domain/members";
import type { Centavos } from "@/domain/money";
import { getDb, type PosDatabase } from "./db";
import { ensureDevice } from "./config";
import { newId, nowIso } from "./ids";
import type { Member } from "./types";

export { MemberError };

const genderIds = GENDERS.map((g) => g.id) as [Member["gender"], ...Member["gender"][]];

export const memberInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(80),
    age: z
      .number({ message: "Age is required" })
      .int("Age must be a whole number")
      .min(MIN_MEMBER_AGE, `Members must be at least ${MIN_MEMBER_AGE}`)
      .max(MAX_MEMBER_AGE, "Check the age"),
    gender: z.enum(genderIds, { message: "Choose a gender option" }),
    contactNumber: z.string().trim().max(20),
    /** The member agreed to the store keeping their details. Required to register. */
    privacyConsent: z.literal(true, { message: "The customer must agree before they can be registered" }),
    marketingConsent: z.boolean(),
    notes: z.string().trim().max(200),
  })
  .superRefine((v, ctx) => {
    if (v.contactNumber && !normalizePhMobile(v.contactNumber)) {
      ctx.addIssue({ code: "custom", path: ["contactNumber"], message: "Enter a PH mobile number like 0917 123 4567" });
    }
    if (v.marketingConsent && !v.contactNumber) {
      ctx.addIssue({ code: "custom", path: ["contactNumber"], message: "Promo messages need a mobile number" });
    }
  });
export type MemberInput = z.input<typeof memberInputSchema>;

function enqueue(db: PosDatabase, entityId: string) {
  return db.outbox.add({
    id: newId(),
    kind: "customer",
    entityId,
    createdAt: nowIso(),
    status: "pending",
    attempts: 0,
  });
}

/**
 * Registers a member and gives them the next member number for this
 * device. The QR code on the card holds the member's id (see
 * memberQrPayload), so it is unique as soon as the record is saved.
 */
export async function registerMember(input: MemberInput, by: string, db = getDb(), now = new Date()): Promise<Member> {
  const data = memberInputSchema.parse(input);
  const device = await ensureDevice(db);
  return db.transaction("rw", [db.members, db.config, db.outbox, db.auditLog], async () => {
    // Households often share one phone, so a repeated number is allowed (the form warns).
    const contact = data.contactNumber ? normalizePhMobile(data.contactNumber)! : undefined;
    const seq = (((await db.config.get("memberSeq"))?.value as number | undefined) ?? 0) + 1;
    await db.config.put({ key: "memberSeq", value: seq });
    const at = now.toISOString();
    const member: Member = {
      id: newId(),
      memberNo: formatMemberNo(device.deviceCode, seq),
      name: data.name,
      birthYear: birthYearFromAge(data.age, now),
      gender: data.gender,
      contactNumber: contact,
      privacyConsentAt: at,
      marketingConsent: data.marketingConsent,
      marketingConsentAt: data.marketingConsent ? at : undefined,
      active: true,
      notes: data.notes || undefined,
      registeredAt: at,
      registeredBy: by,
      deviceId: device.deviceId,
      updatedAt: at,
    };
    await db.members.add(member);
    await enqueue(db, member.id);
    await db.auditLog.add({ id: newId(), action: "member.register", entity: "member", entityId: member.id, by, at });
    return member;
  });
}

export const memberEditSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(80),
    /** Changes the stored birth year; leave unset to keep it. */
    age: z.number().int().min(MIN_MEMBER_AGE).max(MAX_MEMBER_AGE).optional(),
    gender: z.enum(genderIds),
    contactNumber: z.string().trim().max(20),
    marketingConsent: z.boolean(),
    notes: z.string().trim().max(200),
    active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.contactNumber && !normalizePhMobile(v.contactNumber)) {
      ctx.addIssue({ code: "custom", path: ["contactNumber"], message: "Enter a PH mobile number like 0917 123 4567" });
    }
    if (v.marketingConsent && !v.contactNumber) {
      ctx.addIssue({ code: "custom", path: ["contactNumber"], message: "Promo messages need a mobile number" });
    }
  });
export type MemberEdit = z.input<typeof memberEditSchema>;

/** Edits a member. The member number and QR code never change. */
export async function updateMember(id: string, edit: MemberEdit, by: string, db = getDb(), now = new Date()) {
  const data = memberEditSchema.parse(edit);
  return db.transaction("rw", [db.members, db.outbox, db.auditLog], async () => {
    const cur = await db.members.get(id);
    if (!cur) throw new MemberError("Member not found on this device.");
    const at = now.toISOString();
    const consentChanged = data.marketingConsent !== cur.marketingConsent;
    const next: Member = {
      ...cur,
      name: data.name,
      birthYear: data.age === undefined ? cur.birthYear : birthYearFromAge(data.age, now),
      gender: data.gender,
      contactNumber: data.contactNumber ? normalizePhMobile(data.contactNumber)! : undefined,
      marketingConsent: data.marketingConsent,
      marketingConsentAt: consentChanged ? at : cur.marketingConsentAt,
      notes: data.notes || undefined,
      active: data.active,
      updatedAt: at,
    };
    await db.members.put(next);
    await enqueue(db, id);
    await db.auditLog.add({
      id: newId(),
      action: "member.update",
      entity: "member",
      entityId: id,
      by,
      at,
      detail: consentChanged ? { marketingConsent: data.marketingConsent } : undefined,
    });
    return next;
  });
}

/** Finds a member from a scanned QR code or a typed member number. */
export async function findMemberByCode(text: string, db = getDb()): Promise<Member | undefined> {
  const code = parseMemberCode(text);
  if (!code) return undefined;
  return code.kind === "id" ? db.members.get(code.id) : db.members.where("memberNo").equals(code.memberNo).first();
}

/** Search by name, member number or mobile number. */
export async function searchMembers(query: string, db = getDb(), limit = 50): Promise<Member[]> {
  const q = query.trim().toLowerCase();
  const all = await db.members.toArray();
  const phone = normalizePhMobile(query);
  const hits = q
    ? all.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.memberNo.toLowerCase().includes(q) ||
          (!!phone && m.contactNumber === phone),
      )
    : all;
  return hits.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)).slice(0, limit);
}

export interface MemberVisit {
  saleId: string;
  receiptNo?: string;
  at: string;
  total: Centavos;
  items: number;
  /** Recorded on another device (downloaded for owner and manager devices). */
  remote: boolean;
}

/** Every sale this device knows for the member, newest first. */
export async function memberHistory(memberId: string, db = getDb()) {
  const [local, remote] = await Promise.all([
    db.sales.where("customerId").equals(memberId).toArray(),
    db.remoteSaleLines.where("customerId").equals(memberId).toArray(),
  ]);
  const visits: MemberVisit[] = local.map((s) => ({
    saleId: s.id,
    receiptNo: s.receiptNo,
    at: s.createdAt,
    total: s.total,
    items: s.itemCount,
    remote: false,
  }));
  const localIds = new Set(local.map((s) => s.id));
  const bySale = new Map<string, MemberVisit>();
  for (const l of remote) {
    if (localIds.has(l.saleId)) continue;
    const v = bySale.get(l.saleId) ?? { saleId: l.saleId, at: l.at, total: 0, items: 0, remote: true };
    v.total += l.net;
    v.items++;
    bySale.set(l.saleId, v);
  }
  visits.push(...bySale.values());
  visits.sort((a, b) => b.at.localeCompare(a.at));
  return {
    visits,
    totalSpent: visits.reduce((s, v) => s + v.total, 0),
    lastVisit: visits[0]?.at,
  };
}

/** Sales since `sinceIso` from this device and others, for member insights. */
export async function saleFacts(sinceIso: string, db = getDb()): Promise<SaleFact[]> {
  const [local, remote] = await Promise.all([
    db.sales.where("createdAt").aboveOrEqual(sinceIso).toArray(),
    db.remoteSaleLines.where("at").aboveOrEqual(sinceIso).toArray(),
  ]);
  const facts: SaleFact[] = local.map((s) => ({
    saleId: s.id,
    customerId: s.customerId,
    total: s.total,
    at: s.createdAt,
  }));
  const localIds = new Set(local.map((s) => s.id));
  const bySale = new Map<string, SaleFact>();
  for (const l of remote) {
    if (localIds.has(l.saleId)) continue;
    const f = bySale.get(l.saleId) ?? { saleId: l.saleId, customerId: l.customerId, total: 0, at: l.at };
    f.total += l.net;
    bySale.set(l.saleId, f);
  }
  return [...facts, ...bySale.values()];
}
