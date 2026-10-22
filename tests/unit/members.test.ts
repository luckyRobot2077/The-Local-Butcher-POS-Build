import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { emptyCart, priceCart, setOrderDiscount, type CartLine } from "@/domain/cart";
import {
  applyProgram,
  validateProgram,
  ProgramError,
  type DiscountProgram,
  type ProgramContext,
} from "@/domain/programs";
import {
  ageFromBirthYear,
  birthYearFromAge,
  formatMemberNo,
  formatPhMobile,
  memberInsights,
  memberQrPayload,
  normalizePhMobile,
  parseMemberCode,
  promoContactsCsv,
  type MemberLike,
} from "@/domain/members";
import { renderReceipt } from "@/domain/receipt";
import { buildSale } from "@/domain/checkout";

const belly = (qty: number, id = "l1"): CartLine => ({
  lineId: id,
  productId: "p-belly",
  productName: "Liempo",
  saleUnit: "kg",
  unitPrice: 36000,
  unitCost: 29500,
  qty,
});
const chicken = (qty: number, id = "l2"): CartLine => ({
  lineId: id,
  productId: "p-chicken",
  productName: "Whole Chicken",
  saleUnit: "piece",
  unitPrice: 19500,
  unitCost: 16000,
  qty,
});

const program = (over: Partial<DiscountProgram> = {}): DiscountProgram => ({
  id: "prog-1",
  name: "Member 10%",
  description: "",
  input: { kind: "percent", basisPoints: 1000 },
  scope: "order",
  productIds: [],
  categoryIds: [],
  membersOnly: false,
  minPurchase: 0,
  active: true,
  updatedAt: "",
  updatedBy: "Josh",
  ...over,
});

const ctx = (over: Partial<ProgramContext> = {}): ProgramContext => ({
  today: "2026-10-22",
  hasMember: true,
  categoryOf: (id) => (id === "p-belly" ? "cat-pork" : "cat-chicken"),
  ...over,
});

const cart = { ...emptyCart(), lines: [belly(1000), chicken(2)] }; // ₱360 + ₱390 = ₱750

describe("discount programs", () => {
  it("applies an order program without needing manager approval", () => {
    const r = applyProgram(cart, program(), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = priceCart(r.cart);
    expect(t.orderDiscount).toBe(7500);
    expect(t.total).toBe(67500);
    expect(t.maxDiscountBasisPoints).toBe(0); // program discounts are pre-approved
    expect(r.cart.orderDiscount).toMatchObject({ source: "promotion", promotionId: "prog-1", reason: "Member 10%" });
  });

  it("replaces a typed order discount, and still counts typed item discounts for approval", () => {
    const typed = setOrderDiscount(cart, { input: { kind: "percent", basisPoints: 5000 }, source: "manual" });
    const r = applyProgram(typed, program(), ctx());
    expect(r.ok && priceCart(r.cart).orderDiscount).toBe(7500);
    const withItem = {
      ...cart,
      lines: [
        {
          ...belly(1000),
          discount: { input: { kind: "percent" as const, basisPoints: 2000 }, source: "manual" as const },
        },
        chicken(2),
      ],
    };
    const r2 = applyProgram(withItem, program(), ctx());
    expect(r2.ok && priceCart(r2.cart).maxDiscountBasisPoints).toBe(2000);
  });

  it("applies item programs only to matching categories or products, skipping typed discounts", () => {
    const pork = program({ scope: "items", categoryIds: ["cat-pork"], name: "Pork week" });
    const r = applyProgram(cart, pork, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = priceCart(r.cart);
    expect(t.lines[0].itemDiscount).toBe(3600);
    expect(t.lines[1].itemDiscount).toBe(0);

    const byProduct = applyProgram(cart, program({ scope: "items", productIds: ["p-chicken"] }), ctx());
    expect(byProduct.ok && priceCart(byProduct.cart).lines[1].itemDiscount).toBe(3900);

    const typedLine = {
      ...cart,
      lines: [
        { ...belly(1000), discount: { input: { kind: "fixed" as const, amount: 100 }, source: "manual" as const } },
      ],
    };
    expect(applyProgram(typedLine, pork, ctx())).toEqual({
      ok: false,
      reason: "No items in this sale qualify for Pork week.",
    });
  });

  it("checks members-only, minimum purchase, dates and switched-off programs", () => {
    expect(applyProgram(cart, program({ membersOnly: true }), ctx({ hasMember: false })).ok).toBe(false);
    expect(applyProgram(cart, program({ membersOnly: true }), ctx()).ok).toBe(true);
    expect(applyProgram(cart, program({ minPurchase: 75001 }), ctx()).ok).toBe(false);
    expect(applyProgram(cart, program({ minPurchase: 75000 }), ctx()).ok).toBe(true);
    expect(applyProgram(cart, program({ startsOn: "2026-10-23" }), ctx()).ok).toBe(false);
    expect(applyProgram(cart, program({ endsOn: "2026-10-21" }), ctx()).ok).toBe(false);
    expect(applyProgram(cart, program({ startsOn: "2026-10-22", endsOn: "2026-10-22" }), ctx()).ok).toBe(true);
    expect(applyProgram(cart, program({ active: false }), ctx()).ok).toBe(false);
  });

  it("refuses a fixed program larger than the sale", () => {
    const r = applyProgram(cart, program({ input: { kind: "fixed", amount: 80000 } }), ctx());
    expect(r.ok).toBe(false);
    const ok = applyProgram(cart, program({ input: { kind: "fixed", amount: 5000 } }), ctx());
    expect(ok.ok && priceCart(ok.cart).total).toBe(70000);
  });

  it("validates program setup", () => {
    expect(() => validateProgram({ ...program(), scope: "items", input: { kind: "fixed", amount: 100 } })).toThrow(
      ProgramError,
    );
    expect(() => validateProgram({ ...program(), name: " " })).toThrow(ProgramError);
    expect(() => validateProgram({ ...program(), startsOn: "2026-10-22", endsOn: "2026-10-01" })).toThrow(ProgramError);
  });

  it("prints the program name and member number on the receipt", () => {
    const r = applyProgram(cart, program(), ctx());
    if (!r.ok) throw new Error("program not applied");
    const totals = priceCart(r.cart);
    let n = 0;
    const { sale, items, payment } = buildSale({
      totals,
      payment: { method: "cash", tendered: 70000 },
      orderDiscountDetail: r.cart.orderDiscount,
      member: { id: "m-1", memberNo: "M-AB12-0001" },
      saleId: "s-1",
      receiptNo: "AB12-000001",
      storeId: "st",
      deviceId: "d",
      cashierName: "Ana",
      now: new Date("2026-10-22T02:00:00Z"),
      newId: () => `id-${n++}`,
    });
    expect(sale.customerId).toBe("m-1");
    const text = renderReceipt({
      header: { storeName: "The Local Butcher", businessLines: [], footer: "" },
      sale,
      items,
      payment,
    }).join("\n");
    expect(text).toMatch(/Member\s+M-AB12-0001/);
    expect(text).toMatch(/Member 10% 10% off\s+-₱75\.00/);
  });
});

describe("members", () => {
  const now = new Date("2026-10-22T02:00:00Z");

  it("stores birth year from age", () => {
    expect(birthYearFromAge(38, now)).toBe(1988);
    expect(ageFromBirthYear(1988, now)).toBe(38);
    // Manila is already in the new year at 17:00 UTC on Dec 31.
    expect(birthYearFromAge(30, new Date("2026-12-31T17:00:00Z"))).toBe(1997);
    expect(() => birthYearFromAge(17, now)).toThrow();
    expect(() => birthYearFromAge(30.5, now)).toThrow();
  });

  it("normalises Philippine mobile numbers", () => {
    for (const v of ["09171234567", "0917 123 4567", "917-123-4567", "+63 917 123 4567", "639171234567"]) {
      expect(normalizePhMobile(v)).toBe("+639171234567");
    }
    expect(normalizePhMobile("028123456")).toBeNull();
    expect(normalizePhMobile("0917123456")).toBeNull();
    expect(formatPhMobile("+639171234567")).toBe("0917 123 4567");
  });

  it("makes member numbers and reads scanned or typed codes", () => {
    expect(formatMemberNo("AB12", 7)).toBe("M-AB12-0007");
    const id = "8f14e45f-ceea-4e7a-9f6b-1c2d3e4f5a6b";
    expect(parseMemberCode(memberQrPayload(id))).toEqual({ kind: "id", id });
    expect(parseMemberCode(" m-ab12-0007 ")).toEqual({ kind: "memberNo", memberNo: "M-AB12-0007" });
    expect(parseMemberCode("TLBM1:not-a-uuid")).toBeNull();
    expect(parseMemberCode("hello")).toBeNull();
  });

  it("QR code on the card decodes back to the member", () => {
    const id = "8f14e45f-ceea-4e7a-9f6b-1c2d3e4f5a6b";
    const qr = QRCode.create(memberQrPayload(id), { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const scale = 6;
    const quiet = 4;
    const px = (size + quiet * 2) * scale;
    const data = new Uint8ClampedArray(px * px * 4).fill(255);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (!qr.modules.get(x, y)) continue;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const o = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
            data[o] = data[o + 1] = data[o + 2] = 0;
          }
      }
    const decoded = jsQR(data, px, px);
    expect(decoded?.data).toBe(`TLBM1:${id}`);
    expect(parseMemberCode(decoded!.data)).toEqual({ kind: "id", id });
  });

  const members: MemberLike[] = [
    {
      id: "a",
      name: "Maria",
      memberNo: "M-AB12-0001",
      birthYear: 1988,
      gender: "female",
      active: true,
      marketingConsent: true,
      contactNumber: "+639171234567",
    },
    {
      id: "b",
      name: "=cmd()",
      memberNo: "M-AB12-0002",
      birthYear: 2000,
      gender: "male",
      active: true,
      marketingConsent: true,
      contactNumber: "+639181234567",
    },
    {
      id: "c",
      name: "Lito",
      memberNo: "M-AB12-0003",
      birthYear: 1950,
      gender: "male",
      active: true,
      marketingConsent: false,
      contactNumber: "+639191234567",
    },
    {
      id: "d",
      name: "Old",
      memberNo: "M-AB12-0004",
      birthYear: 1970,
      gender: "other",
      active: false,
      marketingConsent: true,
      contactNumber: "+639201234567",
    },
  ];

  it("summarises demographics and member spending", () => {
    const i = memberInsights(
      members,
      [
        { saleId: "1", customerId: "a", total: 50000, at: "2026-10-20T01:00:00Z" },
        { saleId: "2", customerId: "a", total: 20000, at: "2026-10-21T01:00:00Z" },
        { saleId: "3", customerId: "c", total: 10000, at: "2026-10-21T02:00:00Z" },
        { saleId: "4", total: 20000, at: "2026-10-21T03:00:00Z" },
        { saleId: "5", customerId: "d", total: 999, at: "2026-10-21T03:00:00Z" }, // switched-off member
      ],
      now,
    );
    expect(i.members).toBe(3);
    expect(i.reachable).toBe(2);
    expect([i.sales, i.memberSales, i.memberRevenue, i.revenue]).toEqual([5, 3, 80000, 100999]);
    expect(i.byGender.find((b) => b.label === "Female")).toMatchObject({ members: 1, sales: 2, spent: 70000 });
    expect(i.byGender.find((b) => b.label === "Male")).toMatchObject({ members: 2, sales: 1, spent: 10000 });
    expect(i.byAge.find((b) => b.label === "35–44")?.members).toBe(1);
    expect(i.byAge.find((b) => b.label === "65+")?.members).toBe(1);
    expect(i.top[0]).toMatchObject({ sales: 2, spent: 70000, lastAt: "2026-10-21T01:00:00Z" });
    expect(i.top[0].member.id).toBe("a");
  });

  it("exports only opted-in, active members, safe for spreadsheets", () => {
    const csv = promoContactsCsv(members);
    expect(csv).toBe("member_no,name,mobile\nM-AB12-0002,'=cmd(),+639181234567\nM-AB12-0001,Maria,+639171234567\n");
  });
});
