import { type Centavos } from "./money";
import { BUSINESS_TIMEZONE } from "./time";

/**
 * Store members (no tiers). A member is registered with name, age, gender
 * and an optional mobile number; the card carries a QR code that the POS
 * scans with the device camera to attach the member to a sale.
 */

export const GENDERS = [
  { id: "female", label: "Female" },
  { id: "male", label: "Male" },
  { id: "other", label: "Other" },
  { id: "undisclosed", label: "Prefer not to say" },
] as const;
export type Gender = (typeof GENDERS)[number]["id"];

export const MIN_MEMBER_AGE = 18;
export const MAX_MEMBER_AGE = 110;

export class MemberError extends Error {}

const yearFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE, year: "numeric" });

export function manilaYear(at: Date): number {
  return Number(yearFmt.format(at));
}

/**
 * Age is asked at the counter, but the birth year is what is stored, so
 * the member's age stays right in later years. It can be off by one
 * because the birthday itself is not asked.
 */
export function birthYearFromAge(age: number, now: Date): number {
  if (!Number.isInteger(age) || age < MIN_MEMBER_AGE || age > MAX_MEMBER_AGE) {
    throw new MemberError(`Age must be a whole number from ${MIN_MEMBER_AGE} to ${MAX_MEMBER_AGE}.`);
  }
  return manilaYear(now) - age;
}

export function ageFromBirthYear(birthYear: number, now: Date): number {
  return manilaYear(now) - birthYear;
}

/**
 * Normalises a Philippine mobile number to +639XXXXXXXXX, accepting the
 * usual ways it is written (0917 123 4567, 917-123-4567, +63 917 …).
 * Returns null when it is not a PH mobile number.
 */
export function normalizePhMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, "");
  const m = /^(?:\+?63|0)?(9\d{9})$/.exec(digits);
  return m ? `+63${m[1]}` : null;
}

/** +639171234567 → "0917 123 4567". */
export function formatPhMobile(e164: string): string {
  const m = /^\+63(9\d{2})(\d{3})(\d{4})$/.exec(e164);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** Member number: M-<device code>-<sequence>, e.g. "M-A1B2-0007". Unique per device, so per store. */
export function formatMemberNo(deviceCode: string, seq: number): string {
  return `M-${deviceCode}-${String(seq).padStart(4, "0")}`;
}

/** Content of the member card's QR code. Versioned so the format can change later. */
export const MEMBER_QR_PREFIX = "TLBM1:";

export function memberQrPayload(memberId: string): string {
  return MEMBER_QR_PREFIX + memberId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBER_NO = /^M-[A-Z0-9]{4}-\d{4,}$/;

export type MemberCode = { kind: "id"; id: string } | { kind: "memberNo"; memberNo: string };

/**
 * Reads what a scanner returned or what was typed: the card's QR content,
 * or the member number printed under it (a USB scanner types it too).
 */
export function parseMemberCode(text: string): MemberCode | null {
  const t = text.trim();
  if (t.toUpperCase().startsWith(MEMBER_QR_PREFIX)) {
    const id = t.slice(MEMBER_QR_PREFIX.length).toLowerCase();
    return UUID.test(id) ? { kind: "id", id } : null;
  }
  const no = t.toUpperCase().replace(/\s+/g, "");
  return MEMBER_NO.test(no) ? { kind: "memberNo", memberNo: no } : null;
}

/* ------------------------------------------------------------------ insights */

export const AGE_BANDS = ["18–24", "25–34", "35–44", "45–54", "55–64", "65+"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export function ageBand(age: number): AgeBand {
  if (age < 25) return "18–24";
  if (age < 35) return "25–34";
  if (age < 45) return "35–44";
  if (age < 55) return "45–54";
  if (age < 65) return "55–64";
  return "65+";
}

export interface MemberLike {
  id: string;
  name: string;
  memberNo: string;
  birthYear: number;
  gender: Gender;
  active: boolean;
  marketingConsent: boolean;
  contactNumber?: string;
}

/** One sale for reporting: total paid and the member, if any. */
export interface SaleFact {
  saleId: string;
  customerId?: string;
  total: Centavos;
  at: string;
}

export interface Bucket {
  label: string;
  members: number;
  sales: number;
  spent: Centavos;
}

export interface MemberInsights {
  members: number;
  reachable: number;
  sales: number;
  memberSales: number;
  revenue: Centavos;
  memberRevenue: Centavos;
  byGender: Bucket[];
  byAge: Bucket[];
  top: { member: MemberLike; sales: number; spent: Centavos; lastAt: string }[];
}

/** Demographics and spending of members over the given sales (usually one period). */
export function memberInsights(members: MemberLike[], sales: SaleFact[], now: Date, topN = 10): MemberInsights {
  const active = members.filter((m) => m.active);
  const byId = new Map(active.map((m) => [m.id, m]));
  const per = new Map<string, { sales: number; spent: Centavos; lastAt: string }>();
  let memberSales = 0;
  let memberRevenue = 0;
  let revenue = 0;
  for (const s of sales) {
    revenue += s.total;
    const m = s.customerId ? byId.get(s.customerId) : undefined;
    if (!m) continue;
    memberSales++;
    memberRevenue += s.total;
    const cur = per.get(m.id) ?? { sales: 0, spent: 0, lastAt: "" };
    per.set(m.id, { sales: cur.sales + 1, spent: cur.spent + s.total, lastAt: s.at > cur.lastAt ? s.at : cur.lastAt });
  }
  const bucket = (labels: readonly string[], keyOf: (m: MemberLike) => string): Bucket[] => {
    const map = new Map(labels.map((l) => [l, { label: l, members: 0, sales: 0, spent: 0 }]));
    for (const m of active) {
      const b = map.get(keyOf(m));
      if (!b) continue;
      const p = per.get(m.id);
      b.members++;
      b.sales += p?.sales ?? 0;
      b.spent += p?.spent ?? 0;
    }
    return [...map.values()];
  };
  return {
    members: active.length,
    reachable: active.filter((m) => m.marketingConsent && m.contactNumber).length,
    sales: sales.length,
    memberSales,
    revenue,
    memberRevenue,
    byGender: bucket(
      GENDERS.map((g) => g.label),
      (m) => GENDERS.find((g) => g.id === m.gender)?.label ?? "",
    ),
    byAge: bucket(AGE_BANDS, (m) => ageBand(ageFromBirthYear(m.birthYear, now))),
    top: [...per.entries()]
      .map(([id, p]) => ({ member: byId.get(id)!, ...p }))
      .sort((a, b) => b.spent - a.spent || b.sales - a.sales)
      .slice(0, topN),
  };
}

/** CSV of members who agreed to promo messages, for an SMS service. */
export function promoContactsCsv(members: MemberLike[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = members
    .filter((m) => m.active && m.marketingConsent && m.contactNumber)
    .sort((a, b) => a.name.localeCompare(b.name))
    // A name starting with = + - @ would run as a formula in a spreadsheet.
    .map((m) => [m.memberNo, m.name.replace(/^([=+\-@])/, "'$1"), m.contactNumber!].map(esc).join(","));
  return ["member_no,name,mobile", ...rows].join("\n") + "\n";
}
