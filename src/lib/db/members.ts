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
    /** Optional: the member wants home deliveries and agrees to the store keeping their address. */
    wantsDelivery: z.boolean().default(false),
    deliveryAddress: z.string().trim().max(300).default(""),
    deliveryLandmark: z.string().trim().max(150).default(""),
    notes: z.string().trim().max(200),
  })
  .superRefine((v, ctx) => {
    if (v.contactNumber && !normalizePhMobile(v.contactNumber)) {
      ctx.addIssue({ code: "custom", path: ["contactNumber"], message: "Enter a PH mobile number like 0917 123 4567" });
    }
    if (v.marketingConsent && !v.contactNumber) {
      ctx.addIssue({ code: "custom", path: ["contactNumber"], message: "Promo messages need a mobile number" });
    }
    if (v.wantsDelivery && !v.deliveryAddress) {
      ctx.addIssue({ code: "custom", path: ["deliveryAddress"], message: "Enter the delivery address" });
    }
  });
export type MemberInput = z.input<typeof memberInputSchema>;

/** The address is kept only while the member wants deliveries; turning it off removes it. */
function deliveryFields(
  d: { wantsDelivery: boolean; deliveryAddress: string; deliveryLandmark: string },
  consentAt: string,
): Pick<Member, "wantsDelivery" | "deliveryConsentAt" | "deliveryAddress" | "deliveryLandmark"> {
  if (!d.wantsDelivery) {
    return {
      wantsDelivery: false,
      deliveryConsentAt: undefined,
      deliveryAddress: undefined,
      deliveryLandmark: undefined,
    };
  }
  return {
    wantsDelivery: true,
    deliveryConsentAt: consentAt,
    deliveryAddress: d.deliveryAddress,
    deliveryLandmark: d.deliveryLandmark || undefined,
  };
}

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
      ...deliveryFields(data, at),
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
    /** Optional: the member wants home deliveries and agrees to the store keeping their address. */
    wantsDelivery: z.boolean().default(false),
    deliveryAddress: z.string().trim().max(300).default(""),
    deliveryLandmark: z.string().trim().max(150).default(""),
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
    if (v.wantsDelivery && !v.deliveryAddress) {
      ctx.addIssue({ code: "custom", path: ["deliveryAddress"], message: "Enter the delivery address" });
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
    const deliveryChanged = data.wantsDelivery !== !!cur.wantsDelivery;
    const next: Member = {
      ...cur,
      name: data.name,
      birthYear: data.age === undefined ? cur.birthYear : birthYearFromAge(data.age, now),
      gender: data.gender,
      contactNumber: data.contactNumber ? normalizePhMobile(data.contactNumber)! : undefined,
      marketingConsent: data.marketingConsent,
      marketingConsentAt: consentChanged ? at : cur.marketingConsentAt,
      ...deliveryFields(data, deliveryChanged ? at : (cur.deliveryConsentAt ?? at)),
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
      detail:
        consentChanged || deliveryChanged
          ? {
              ...(consentChanged ? { marketingConsent: data.marketingConsent } : {}),
              ...(deliveryChanged ? { wantsDelivery: data.wantsDelivery } : {}),
            }
          : undefined,
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

/** Config key for the per-member sale counts last downloaded from the cloud. */
export const MEMBER_VISITS_KEY = "memberVisits";
export interface ServerVisitCounts {
  at: string;
  counts: Record<string, { visits: number; lastAt: string }>;
}

/**
 * How many times the member has bought, across all devices: the cloud count
 * plus this device's sales not uploaded yet, or what this device has seen
 * itself if that is more (e.g. never synced).
 */
export async function memberVisitSummary(memberId: string, db = getDb()): Promise<{ visits: number; lastAt?: string }> {
  const [history, server, unsent] = await Promise.all([
    memberHistory(memberId, db),
    db.config.get(MEMBER_VISITS_KEY),
    db.outbox
      .where("kind")
      .equals("sale")
      .filter((e) => e.status !== "sent")
      .toArray(),
  ]);
  const row = (server?.value as ServerVisitCounts | undefined)?.counts[memberId];
  let fromServer = 0;
  let lastAt = row?.lastAt;
  if (row) {
    const unsentIds = new Set(unsent.map((e) => e.entityId));
    const pending = (await db.sales.where("customerId").equals(memberId).toArray()).filter((s) => unsentIds.has(s.id));
    fromServer = row.visits + pending.length;
    for (const p of pending) if (!lastAt || p.createdAt > lastAt) lastAt = p.createdAt;
  }
  if (history.visits.length >= fromServer) return { visits: history.visits.length, lastAt: history.lastVisit };
  return { visits: fromServer, lastAt };
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
