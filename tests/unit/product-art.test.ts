import { describe, expect, it } from "vitest";
import { productArtFor } from "@/lib/db/product-art";

describe("starter product pictures", () => {
  it("matches every sample product to its own picture", () => {
    const expected: Record<string, string> = {
      "Liempo (Pork Belly)": "pork-belly",
      "Pork Chop / Loin": "pork-chop",
      "Kasim (Shoulder)": "pork-shoulder",
      "Pigue (Ham)": "pork-ham",
      "Pork Ribs": "pork-ribs",
      "Adobo / Menudo Cut": "pork-cubes",
      "Giniling (Ground Pork)": "ground-pork",
      "Bones / Sabaw Pack": "pork-bones",
      "Pata (Pork Feet)": "pork-hock",
      "Pork Liver": "pork-liver",
      "Beef Cubes": "beef-cubes",
      "Beef Shank (Bulalo)": "beef-shank",
      "Whole Chicken": "whole-chicken",
      "Chicken Thigh": "chicken-thigh",
      "Salmon Cuts": "salmon-steak",
      "Salmon Belly": "salmon-belly",
    };
    for (const [name, art] of Object.entries(expected)) expect(productArtFor(name)).toBe(`/product-art/${art}.jpg`);
    expect(productArtFor("Soy sauce 1L")).toBeUndefined();
  });
});
