import { z } from "zod";
import { MAX_CENTAVOS } from "@/domain/money";
import { type DiscountProgram, ProgramError, validateProgram } from "@/domain/programs";
import { getDb } from "./db";
import { newId, nowIso } from "./ids";

export { ProgramError };

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const programInputSchema = z.object({
  name: z.string().trim().min(1, "Give the program a name").max(40),
  description: z.string().trim().max(200),
  input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("percent"), basisPoints: z.number().int().min(1).max(10_000) }),
    z.object({ kind: z.literal("fixed"), amount: z.number().int().min(1).max(MAX_CENTAVOS) }),
  ]),
  scope: z.enum(["order", "items"]),
  productIds: z.array(z.string()).max(500),
  categoryIds: z.array(z.string()).max(100),
  membersOnly: z.boolean(),
  minPurchase: z.number().int().min(0).max(MAX_CENTAVOS),
  startsOn: z.string().regex(isoDate).optional(),
  endsOn: z.string().regex(isoDate).optional(),
  active: z.boolean(),
});
export type ProgramInput = z.infer<typeof programInputSchema>;

export async function listPrograms(db = getDb()): Promise<DiscountProgram[]> {
  return (await db.programs.toArray()).sort(
    (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
  );
}

/** Creates or edits a program. Sales already made keep the discount they got. */
export async function saveProgram(
  input: ProgramInput,
  by: string,
  id?: string,
  db = getDb(),
): Promise<DiscountProgram> {
  const data = programInputSchema.parse(input);
  validateProgram(data);
  return db.transaction("rw", [db.programs, db.outbox, db.auditLog], async () => {
    const all = await db.programs.toArray();
    if (all.some((p) => p.id !== id && p.name.toLowerCase() === data.name.toLowerCase())) {
      throw new ProgramError("A program with that name already exists.");
    }
    const existing = id ? await db.programs.get(id) : undefined;
    if (id && !existing) throw new ProgramError("Program not found.");
    const at = nowIso();
    const program: DiscountProgram = {
      ...data,
      productIds: data.scope === "items" ? data.productIds : [],
      categoryIds: data.scope === "items" ? data.categoryIds : [],
      id: existing?.id ?? newId(),
      updatedAt: at,
      updatedBy: by,
    };
    await db.programs.put(program);
    await db.outbox.add({
      id: newId(),
      kind: "promotion",
      entityId: program.id,
      createdAt: at,
      status: "pending",
      attempts: 0,
    });
    await db.auditLog.add({
      id: newId(),
      action: existing ? "program.update" : "program.create",
      entity: "program",
      entityId: program.id,
      by,
      at,
      detail: { input: program.input, scope: program.scope, active: program.active },
    });
    return program;
  });
}
