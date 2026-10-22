import { getDb } from "./db";
import { newId } from "./ids";
import { createProduct } from "./products";
import type { SaleUnit } from "@/domain/quantity";

/**
 * Sample catalog so a new device can be tried out immediately. Pork prices
 * come from the "Cut Pricing" sheet of the owner's break-even workbook
 * (Active Retail Price/kg, with the rounded break-even price as a sample
 * cost). Other prices are the examples from the specification. Every
 * sample product is flagged and says so in its description; the owner
 * must set real prices before selling.
 */
interface SampleProduct {
  name: string;
  category: string;
  unit: SaleUnit;
  price: number; // pesos
  cost: number; // pesos
  description: string;
  stock: number; // kg or pieces
  min: number; // kg or pieces
}

const SAMPLES: SampleProduct[] = [
  {
    name: "Liempo (Pork Belly)",
    category: "Pork",
    unit: "kg",
    price: 350,
    cost: 295,
    description: "Premium cut for inihaw and lechon kawali.",
    stock: 9,
    min: 2,
  },
  {
    name: "Pork Chop / Loin",
    category: "Pork",
    unit: "kg",
    price: 350,
    cost: 285,
    description: "Premium lean cut.",
    stock: 6.5,
    min: 2,
  },
  {
    name: "Kasim (Shoulder)",
    category: "Pork",
    unit: "kg",
    price: 340,
    cost: 265,
    description: "Everyday ulam cut.",
    stock: 12,
    min: 3,
  },
  {
    name: "Pigue (Ham)",
    category: "Pork",
    unit: "kg",
    price: 340,
    cost: 265,
    description: "Everyday lean cut.",
    stock: 11,
    min: 3,
  },
  {
    name: "Pork Ribs",
    category: "Pork",
    unit: "kg",
    price: 270,
    cost: 255,
    description: "Good for sinigang and grilling.",
    stock: 5,
    min: 1.5,
  },
  {
    name: "Adobo / Menudo Cut",
    category: "Pork",
    unit: "kg",
    price: 310,
    cost: 245,
    description: "Ready-cut cubes.",
    stock: 7,
    min: 2,
  },
  {
    name: "Giniling (Ground Pork)",
    category: "Pork",
    unit: "kg",
    price: 300,
    cost: 240,
    description: "Ground fresh daily.",
    stock: 5,
    min: 1.5,
  },
  {
    name: "Bones / Sabaw Pack",
    category: "Pork",
    unit: "kg",
    price: 270,
    cost: 145,
    description: "For soups and broth.",
    stock: 6,
    min: 1,
  },
  {
    name: "Pata (Pork Feet)",
    category: "Pork",
    unit: "kg",
    price: 260,
    cost: 175,
    description: "For crispy pata and paksiw.",
    stock: 2.5,
    min: 1,
  },
  {
    name: "Pork Liver",
    category: "Pork",
    unit: "kg",
    price: 190,
    cost: 175,
    description: "Sell same day.",
    stock: 1.3,
    min: 0.5,
  },
  {
    name: "Beef Cubes",
    category: "Beef",
    unit: "kg",
    price: 480,
    cost: 400,
    description: "For kaldereta and nilaga.",
    stock: 5,
    min: 1.5,
  },
  {
    name: "Beef Shank (Bulalo)",
    category: "Beef",
    unit: "kg",
    price: 420,
    cost: 350,
    description: "Bone-in shank for bulalo.",
    stock: 4,
    min: 1,
  },
  {
    name: "Whole Chicken",
    category: "Chicken",
    unit: "piece",
    price: 195,
    cost: 165,
    description: "Dressed whole chicken, about 1 kg.",
    stock: 15,
    min: 4,
  },
  {
    name: "Chicken Thigh",
    category: "Chicken",
    unit: "kg",
    price: 230,
    cost: 190,
    description: "Bone-in thigh quarters.",
    stock: 6,
    min: 2,
  },
  {
    name: "Salmon Cuts",
    category: "Salmon",
    unit: "kg",
    price: 650,
    cost: 540,
    description: "Steak cuts.",
    stock: 3,
    min: 1,
  },
  {
    name: "Salmon Belly",
    category: "Salmon",
    unit: "kg",
    price: 380,
    cost: 300,
    description: "Belly strips for grilling.",
    stock: 3,
    min: 1,
  },
];

export const DEFAULT_CATEGORIES = ["Pork", "Beef", "Chicken", "Salmon", "Fresh Goods", "Condiments", "Side Dishes"];

/**
 * Adds any default category this device does not have yet (matched by name,
 * ignoring case), after the existing ones. Devices that add the same name
 * end up with one category in the cloud: sync matches categories by name.
 */
export async function ensureDefaultCategories(db = getDb()): Promise<void> {
  await db.transaction("rw", db.categories, async () => {
    const existing = await db.categories.toArray();
    const have = new Set(existing.map((c) => c.name.toLowerCase()));
    let sortOrder = existing.reduce((m, c) => Math.max(m, c.sortOrder + 1), 0);
    const missing = DEFAULT_CATEGORIES.filter((name) => !have.has(name.toLowerCase()));
    if (missing.length)
      await db.categories.bulkAdd(missing.map((name) => ({ id: newId(), name, sortOrder: sortOrder++ })));
  });
}

export async function loadSampleCatalog(by: string, db = getDb()): Promise<number> {
  await ensureDefaultCategories(db);
  // One transaction: either the whole sample catalog is added or none of it.
  const tables = [db.categories, db.products, db.productRevisions, db.inventoryMovements, db.outbox, db.auditLog];
  await db.transaction("rw", tables, async () => {
    if ((await db.products.count()) > 0) throw new Error("Sample products can only be loaded into an empty catalog.");
    const cats = await db.categories.toArray();
    const catId = (name: string) => cats.find((c) => c.name === name)!.id;
    for (const s of SAMPLES) {
      const toBase = (n: number) => (s.unit === "kg" ? Math.round(n * 1000) : Math.round(n));
      await createProduct(
        {
          name: s.name,
          description: `${s.description} (Sample price: set your real price.)`,
          categoryId: catId(s.category),
          saleUnit: s.unit,
          price: s.price * 100,
          cost: s.cost * 100,
          minStockQty: toBase(s.min),
          active: true,
        },
        by,
        db,
        { initialStockQty: toBase(s.stock), isSample: true },
      );
    }
  });
  return SAMPLES.length;
}
