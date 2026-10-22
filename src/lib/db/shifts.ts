import { summariseShift, type DrawerEvent, type Shift, type ShiftSummary } from "@/domain/shift";
import type { SaleRecord } from "@/domain/checkout";
import { getDb } from "./db";
import { ensureDevice } from "./config";
import { newId, nowIso } from "./ids";

/** Config key holding the id of the shift open on this device. */
export const OPEN_SHIFT_KEY = "openShiftId";

export async function getOpenShift(db = getDb()): Promise<Shift | undefined> {
  const id = (await db.config.get(OPEN_SHIFT_KEY))?.value as string | undefined;
  return id ? db.shifts.get(id) : undefined;
}

export async function openShift(
  args: { openingFloat: number; by: string; employeeId?: string; now?: Date },
  db = getDb(),
): Promise<Shift> {
  if (!Number.isSafeInteger(args.openingFloat) || args.openingFloat < 0) throw new Error("Enter the starting cash.");
  if (!args.by.trim()) throw new Error("No cashier is signed in on this device.");
  const device = await ensureDevice(db);
  return db.transaction("rw", [db.shifts, db.config, db.outbox, db.auditLog], async () => {
    const current = await getOpenShift(db);
    if (current) return current;
    const shift: Shift = {
      id: newId(),
      deviceId: device.deviceId,
      openedAt: (args.now ?? new Date()).toISOString(),
      openedBy: args.by.trim(),
      ...(args.employeeId ? { openedByEmployeeId: args.employeeId } : {}),
      openingFloat: args.openingFloat,
    };
    await db.shifts.add(shift);
    await db.config.put({ key: OPEN_SHIFT_KEY, value: shift.id });
    await queue(db, "shift", shift.id);
    await db.auditLog.add({
      id: newId(),
      action: "shift.open",
      entity: "shift",
      entityId: shift.id,
      by: shift.openedBy,
      at: shift.openedAt,
      detail: { openingFloat: shift.openingFloat },
    });
    return shift;
  });
}

export async function shiftSales(shiftId: string, db = getDb()): Promise<SaleRecord[]> {
  return (await db.sales.where("shiftId").equals(shiftId).toArray()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export async function shiftEvents(shiftId: string, db = getDb()): Promise<DrawerEvent[]> {
  return (await db.drawerEvents.where("shiftId").equals(shiftId).toArray()).sort((a, b) => a.at.localeCompare(b.at));
}

export async function currentSummary(shift: Shift, db = getDb()): Promise<ShiftSummary> {
  return summariseShift(shift, await shiftSales(shift.id, db), await shiftEvents(shift.id, db));
}

/** Closes the open shift with the cash counted; the expected cash is worked out from its sales. */
export async function closeShift(
  args: { countedCash: number; by: string; note?: string; now?: Date },
  db = getDb(),
): Promise<Shift> {
  if (!Number.isSafeInteger(args.countedCash) || args.countedCash < 0) throw new Error("Enter the cash counted.");
  return db.transaction("rw", [db.shifts, db.sales, db.drawerEvents, db.config, db.outbox, db.auditLog], async () => {
    const shift = await getOpenShift(db);
    if (!shift) throw new Error("No shift is open on this device.");
    const sum = await currentSummary(shift, db);
    const closed: Shift = {
      ...shift,
      closedAt: (args.now ?? new Date()).toISOString(),
      closedBy: args.by.trim() || shift.openedBy,
      countedCash: args.countedCash,
      expectedCash: sum.expectedCash,
      cashSales: sum.cashSales,
      gcashSales: sum.gcashSales,
      saleCount: sum.saleCount,
      ...(args.note?.trim() ? { note: args.note.trim().slice(0, 200) } : {}),
    };
    await db.shifts.put(closed);
    await db.config.delete(OPEN_SHIFT_KEY);
    await queue(db, "shift", shift.id);
    await db.auditLog.add({
      id: newId(),
      action: "shift.close",
      entity: "shift",
      entityId: shift.id,
      by: closed.closedBy!,
      at: closed.closedAt!,
      detail: { countedCash: closed.countedCash, expectedCash: closed.expectedCash },
    });
    return closed;
  });
}

/** Logs the drawer being opened without a sale. */
export async function recordNoSale(
  args: { reason: string; by: string; approvedBy?: string; now?: Date },
  db = getDb(),
): Promise<DrawerEvent> {
  const reason = args.reason.trim().slice(0, 120);
  if (!reason) throw new Error("Choose why the drawer is being opened.");
  return db.transaction("rw", [db.shifts, db.drawerEvents, db.config, db.outbox, db.auditLog], async () => {
    const shift = await getOpenShift(db);
    if (!shift) throw new Error("Open a shift first.");
    const event: DrawerEvent = {
      id: newId(),
      shiftId: shift.id,
      deviceId: shift.deviceId,
      kind: "no_sale",
      at: (args.now ?? new Date()).toISOString(),
      by: args.by.trim(),
      ...(args.approvedBy ? { approvedBy: args.approvedBy } : {}),
      reason,
    };
    await db.drawerEvents.add(event);
    await queue(db, "drawer_event", event.id);
    await db.auditLog.add({
      id: newId(),
      action: "drawer.no_sale",
      entity: "shift",
      entityId: shift.id,
      by: event.by,
      at: event.at,
      detail: { reason, approvedBy: event.approvedBy },
    });
    return event;
  });
}

export async function listShifts(limit = 60, db = getDb()): Promise<Shift[]> {
  return db.shifts.orderBy("openedAt").reverse().limit(limit).toArray();
}

async function queue(db: ReturnType<typeof getDb>, kind: "shift" | "drawer_event", entityId: string) {
  await db.outbox.add({ id: newId(), kind, entityId, createdAt: nowIso(), status: "pending", attempts: 0 });
}
