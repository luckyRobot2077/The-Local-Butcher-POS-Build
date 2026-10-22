import { getDb } from "./db";
import { setProductImage } from "./products";
import type { Product } from "./types";

/**
 * Starter pictures for common cuts: flat illustrations drawn for this app
 * (scripts/draw-product-art.py), in public/product-art. They stand in until
 * the shop takes real photos. Matched to products by words in the name;
 * the first rule that matches wins.
 */
const RULES: [RegExp, string][] = [
  [/salmon.*belly|belly.*salmon/i, "salmon-belly"],
  [/salmon/i, "salmon-steak"],
  [/whole chicken|chicken \(whole\)/i, "whole-chicken"],
  [/chicken|manok/i, "chicken-thigh"],
  [/bulalo|shank/i, "beef-shank"],
  [/beef|baka/i, "beef-cubes"],
  [/liempo|pork belly/i, "pork-belly"],
  [/chop|loin/i, "pork-chop"],
  [/kasim|shoulder/i, "pork-shoulder"],
  [/pigue|ham/i, "pork-ham"],
  [/ribs|tadyang/i, "pork-ribs"],
  [/giniling|ground/i, "ground-pork"],
  [/bones|sabaw|buto/i, "pork-bones"],
  [/pata|feet|hock/i, "pork-hock"],
  [/liver|atay/i, "pork-liver"],
  [/adobo|menudo|cubes|kaldereta/i, "pork-cubes"],
];

/** The starter picture for a product name, if one fits. */
export function productArtFor(name: string): string | undefined {
  const hit = RULES.find(([re]) => re.test(name));
  return hit ? `/product-art/${hit[1]}.jpg` : undefined;
}

/** Products with no photo that a starter picture fits. */
export function productsMissingArt(products: Product[]): Product[] {
  return products.filter((p) => !p.imageId && productArtFor(p.name));
}

/**
 * Gives each product without a photo its starter picture. Products that
 * already have a photo are never changed. Returns how many were added.
 */
export async function addStarterPictures(by: string, db = getDb()): Promise<number> {
  let added = 0;
  for (const p of productsMissingArt(await db.products.toArray())) {
    const res = await fetch(productArtFor(p.name)!);
    if (!res.ok) continue;
    const blob = await res.blob();
    await setProductImage(p.id, { blob, mime: "image/jpeg", width: 800, height: 600 }, by, db);
    added++;
  }
  return added;
}
