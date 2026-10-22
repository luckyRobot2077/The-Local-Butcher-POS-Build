import { describe, expect, it } from "vitest";
import { applyKey } from "@/components/keypad";
import { quickEntryQty } from "@/domain/quick-entry";

describe("on-screen keys", () => {
  it("type numbers, one decimal point, delete and clear", () => {
    const type = (keys: string[], opts = { decimal: true }) => keys.reduce((v, k) => applyKey(v, k, opts), "");
    expect(type(["1", ".", "2", "5"])).toBe("1.25");
    expect(type([".", "5"])).toBe("0.5");
    expect(type(["1", ".", ".", "5"])).toBe("1.5");
    expect(type(["1", ".", "5"], { decimal: false })).toBe("15");
    expect(type(["0", "0", "7"])).toBe("7");
    expect(type(["00"])).toBe("0");
    expect(type(["5", "00"])).toBe("500");
    expect(type(["1", ".", "2", "5", "0", "1"])).toBe("1.250");
    expect(type(["1", "2", "⌫"])).toBe("1");
    expect(type(["1", "2", "C"])).toBe("");
    expect(applyKey("1234", "5", { maxLength: 4 })).toBe("1234");
  });
});

describe("sell-screen numpad", () => {
  const liempo = { name: "Liempo", saleUnit: "kg" as const, price: 35000 };
  const chicken = { name: "Whole Chicken", saleUnit: "piece" as const, price: 19500 };

  it("reads kilograms, grams and peso amounts for per-kg products", () => {
    expect(quickEntryQty(liempo, "kg", "0.5")).toEqual({ ok: true, qty: 500 });
    expect(quickEntryQty(liempo, "g", "750")).toEqual({ ok: true, qty: 750 });
    expect(quickEntryQty(liempo, "peso", "100")).toEqual({ ok: true, qty: 286, fixedAmount: 10000 });
    expect(quickEntryQty(liempo, "kg", "0")).toMatchObject({ ok: false });
    expect(quickEntryQty(liempo, "g", "1.5")).toMatchObject({ ok: false });
  });

  it("reads whole pieces only in the kg / pcs mode", () => {
    expect(quickEntryQty(chicken, "kg", "2")).toEqual({ ok: true, qty: 2 });
    expect(quickEntryQty(chicken, "kg", "1.5")).toMatchObject({ ok: false, reason: "Enter a whole number of pieces." });
    expect(quickEntryQty(chicken, "peso", "200")).toMatchObject({ ok: false });
    expect(quickEntryQty(chicken, "g", "2")).toMatchObject({ ok: false });
  });
});
