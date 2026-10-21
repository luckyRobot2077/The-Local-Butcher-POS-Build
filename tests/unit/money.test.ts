import { describe, expect, it } from "vitest";
import { divRoundHalfUp, formatPeso, parsePeso, centavosToInput } from "@/domain/money";
import { formatQuantity, parseWeight, parsePieces } from "@/domain/quantity";
import { lineGross } from "@/domain/pricing";

describe("money", () => {
  it("rounds half up", () => {
    expect(divRoundHalfUp(5, 10)).toBe(1); // 0.5 -> 1
    expect(divRoundHalfUp(4, 10)).toBe(0);
    expect(divRoundHalfUp(15, 10)).toBe(2);
    expect(divRoundHalfUp(14999, 10000)).toBe(1);
  });
  it("formats pesos without float error", () => {
    expect(formatPeso(36050)).toBe("₱360.50");
    expect(formatPeso(125075)).toBe("₱1,250.75");
    expect(formatPeso(5)).toBe("₱0.05");
    expect(formatPeso(-1000)).toBe("-₱10.00");
    expect(centavosToInput(125075)).toBe("1250.75");
  });
  it("parses peso input", () => {
    expect(parsePeso("360")).toBe(36000);
    expect(parsePeso("360.5")).toBe(36050);
    expect(parsePeso("₱1,250.75")).toBe(125075);
    expect(parsePeso("0.1")).toBe(10);
    expect(parsePeso("1.234")).toBeNull();
    expect(parsePeso("-5")).toBeNull();
    expect(parsePeso("abc")).toBeNull();
  });
});

describe("quantity", () => {
  it("parses weights in kg and g", () => {
    expect(parseWeight("1.25", "kg")).toBe(1250);
    expect(parseWeight("0.5", "kg")).toBe(500);
    expect(parseWeight("750", "g")).toBe(750);
    expect(parseWeight("1.2345", "kg")).toBeNull();
    expect(parseWeight("0", "kg")).toBeNull();
    expect(parseWeight("1.5", "g")).toBeNull();
  });
  it("parses pieces", () => {
    expect(parsePieces("3")).toBe(3);
    expect(parsePieces("0")).toBeNull();
    expect(parsePieces("1.5")).toBeNull();
  });
  it("formats quantities", () => {
    expect(formatQuantity("kg", 1250)).toBe("1.250 kg");
    expect(formatQuantity("kg", 75)).toBe("0.075 kg");
    expect(formatQuantity("piece", 1)).toBe("1 pc");
    expect(formatQuantity("piece", 2)).toBe("2 pcs");
  });
});

describe("line pricing", () => {
  it("prices weight-based items", () => {
    // ₱360/kg × 1.250 kg = ₱450.00
    expect(lineGross("kg", 36000, 1250)).toBe(45000);
    // ₱350/kg × 0.333 kg = ₱116.55
    expect(lineGross("kg", 35000, 333)).toBe(11655);
    // ₱310.75/kg × 0.457 kg = 142.01275 -> ₱142.01
    expect(lineGross("kg", 31075, 457)).toBe(14201);
    // ₱195.50/kg × 0.001 kg = 0.1955 -> ₱0.20 (19.55 centavos rounds up)
    expect(lineGross("kg", 19550, 1)).toBe(20);
    // exact half centavo rounds up: 50 centavos/kg × 0.001 kg... 0.05 -> 0; 500 × 1 g = 0.5 -> 1
    expect(lineGross("kg", 500, 1)).toBe(1);
  });
  it("prices piece-based items", () => {
    expect(lineGross("piece", 19500, 3)).toBe(58500);
  });
  it("rejects invalid quantities", () => {
    expect(() => lineGross("piece", 19500, 0)).toThrow();
    expect(() => lineGross("kg", 36000, 1.5)).toThrow();
    expect(() => lineGross("kg", 36000, -100)).toThrow();
  });
});
