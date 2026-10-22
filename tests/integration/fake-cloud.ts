import { CloudRejection, CloudUnavailable, type CloudApi } from "@/lib/cloud/api";

type Row = Record<string, unknown>;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Row)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * In-memory stand-in for the Supabase functions in supabase/migrations,
 * reproducing the behaviour the sync engine relies on (idempotency,
 * version conflicts, category merging). The real SQL is tested separately
 * on PostgreSQL by scripts/test-migrations.sh.
 */
export class FakeCloud {
  offline = false;
  /** Function names to reject as if the user lacked permission. */
  deny = new Set<string>();
  /** Throw a network error after the next call to this function succeeds (lost reply). */
  loseReplyOnce = new Set<string>();
  calls: string[] = [];
  categories = new Map<string, { id: string; name: string; sort_order: number }>();
  products = new Map<string, Row & { id: string; version: number }>();
  images = new Map<string, Row>();
  files = new Map<string, Blob>();
  movements = new Map<string, Row>();
  sales = new Map<string, string>(); // id -> canonical payload
  employees: Record<string, unknown>[] = [];
  shifts = new Map<string, Row>();
  drawerEvents = new Map<string, Row>();
  saleRows: (Row & { receivedAt: string })[] = [];
  suppliers = new Map<string, Row & { id: string; name: string; updated_at: string }>();
  customers = new Map<string, Row & { id: string; updated_at: string }>();
  promotions = new Map<string, Row & { id: string; updated_at: string }>();
  purchases = new Map<
    string,
    { canonical: string; payload: Row; paymentStatus: string; at: string; updatedAt: string }
  >();

  api(): CloudApi {
    const guard = (name: string) => {
      this.calls.push(name);
      if (this.offline) throw new CloudUnavailable("Failed to fetch");
      if (this.deny.has(name)) throw new CloudRejection(`not allowed (${name})`, "42501");
    };
    const after = <T>(name: string, v: T): T => {
      if (this.loseReplyOnce.delete(name)) throw new CloudUnavailable("connection reset");
      return v;
    };
    return {
      rpc: async <T>(fn: string, a: Record<string, unknown>): Promise<T> => {
        guard(fn);
        return after(fn, this.handle(fn, a) as T);
      },
      select: async <T>(table: string): Promise<T[]> => {
        guard(`select:${table}`);
        const src = { categories: this.categories, products: this.products, product_images: this.images }[table];
        if (!src) throw new Error(`unknown table ${table}`);
        return structuredClone([...src.values()]) as T[];
      },
      upload: async (path, blob) => {
        guard("upload");
        this.files.set(path, blob);
      },
      download: async (path) => {
        guard("download");
        const b = this.files.get(path);
        if (!b) throw new CloudUnavailable("not found");
        return b;
      },
    };
  }

  stockOf(productId: string): number {
    let n = 0;
    for (const m of this.movements.values()) if (m.productId === productId) n += Number(m.qtyDelta);
    for (const s of this.saleRows)
      for (const it of s.items as Row[]) if (it.productId === productId) n -= Number(it.qty);
    for (const p of this.purchases.values())
      for (const l of p.payload.lines as Row[]) if (l.productId === productId) n += Number(l.qty);
    return n;
  }

  private supplierRow(p: Row) {
    return {
      id: String(p.id),
      name: String(p.name).trim(),
      contact: (p.contact as string) || null,
      notes: (p.notes as string) || null,
      active: p.active !== false,
      updated_at: "",
    };
  }

  private batchIds(): Set<string> {
    const ids = new Set<string>();
    for (const p of this.purchases.values()) for (const l of p.payload.lines as Row[]) ids.add(String(l.batchId));
    return ids;
  }

  /** Mirrors inventory_feed(): other devices' records changed after `since`. */
  private feed(since: string | null, device: string) {
    const after = (t: string) => !since || t > since;
    const purchases = [...this.purchases.values()];
    const own = (p: (typeof purchases)[number]) => (p.payload.purchase as Row).deviceId === device;
    const lines = purchases
      .filter((p) => after(p.at) && !own(p))
      .flatMap((p) => (p.payload.lines as Row[]).map((l) => ({ p, l })));
    return {
      now: new Date().toISOString(),
      suppliers: [...this.suppliers.values()].filter((s) => after(s.updated_at)),
      purchases: purchases
        .filter((p) => after(p.updatedAt))
        .map((p) => {
          const pur = p.payload.purchase as Row;
          return {
            id: pur.id,
            supplier_id: pur.supplierId,
            received_at: pur.receivedAt,
            reference: pur.reference || null,
            notes: pur.notes || null,
            payment_status: p.paymentStatus,
            total_cost: pur.totalCost,
            by_name: pur.by,
            device_id: pur.deviceId,
          };
        }),
      purchase_items: lines.map(({ p, l }) => ({
        id: l.itemId,
        purchase_id: (p.payload.purchase as Row).id,
        product_id: l.productId,
        batch_id: l.batchId,
        qty: l.qty,
        unit_cost: l.unitCost,
        line_cost: l.lineCost,
      })),
      batches: lines.map(({ p, l }) => ({
        id: l.batchId,
        product_id: l.productId,
        purchase_id: (p.payload.purchase as Row).id,
        batch_code: l.batchCode || null,
        received_at: (p.payload.purchase as Row).receivedAt,
        use_by: l.useBy || null,
        storage_note: l.storageNote || null,
        initial_qty: l.qty,
        unit_cost: l.unitCost,
      })),
      movements: [
        ...lines.map(({ p, l }) => ({
          id: l.movementId,
          product_id: l.productId,
          batch_id: l.batchId,
          type: "purchase",
          qty_delta: l.qty,
          unit_cost: l.unitCost,
          ref_type: "purchase",
          ref_id: (p.payload.purchase as Row).id,
          reason: null,
          batch_code: l.batchCode || null,
          use_by: l.useBy || null,
          by_name: (p.payload.purchase as Row).by,
          at: (p.payload.purchase as Row).receivedAt,
        })),
        ...[...this.movements.values()]
          .filter((m) => after(String(m.receivedAt)) && m.deviceId !== device)
          .map((m) => ({
            id: m.id,
            product_id: m.productId,
            batch_id: m.batchId || null,
            type: m.type,
            qty_delta: m.qtyDelta,
            unit_cost: m.unitCost,
            ref_type: null,
            ref_id: null,
            reason: m.reason ?? null,
            batch_code: m.batchCode ?? null,
            use_by: m.useBy || null,
            by_name: m.by,
            at: m.at,
          })),
        ...this.saleRows
          .filter((s) => after(s.receivedAt) && (s.sale as Row).deviceId !== device)
          .flatMap((s) =>
            (s.items as Row[]).map((it) => ({
              id: `${it.id}-move`,
              product_id: it.productId,
              batch_id: null,
              type: "sale",
              qty_delta: -Number(it.qty),
              unit_cost: it.unitCost,
              ref_type: "sale",
              ref_id: (s.sale as Row).id,
              reason: null,
              batch_code: null,
              use_by: null,
              by_name: (s.sale as Row).cashierName,
              at: (s.sale as Row).createdAt,
            })),
          ),
      ],
      sale_lines: this.saleRows
        .filter((s) => after(s.receivedAt) && (s.sale as Row).deviceId !== device)
        .flatMap((s) =>
          (s.items as Row[]).map((it) => ({
            id: it.id,
            sale_id: (s.sale as Row).id,
            product_id: it.productId,
            qty: it.qty,
            net: it.net,
            cost:
              it.saleUnit === "kg"
                ? Math.floor((Number(it.unitCost) * Number(it.qty) + 500) / 1000)
                : Number(it.unitCost) * Number(it.qty),
            at: (s.sale as Row).createdAt,
            customer_id: (s.sale as Row).customerId ?? null,
          })),
        ),
    };
  }

  /** Mirrors members_feed(). */
  private membersFeed(since: string | null) {
    const after = (t: string) => !since || t > since;
    return {
      now: new Date().toISOString(),
      customers: [...this.customers.values()].filter((c) => after(c.updated_at)),
      promotions: [...this.promotions.values()].filter((p) => after(p.updated_at)),
    };
  }

  private handle(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case "sync_category": {
        const name = String(a.p_name).trim().toLowerCase();
        const hit = [...this.categories.values()].find((c) => c.name.toLowerCase() === name);
        if (hit) return hit.id;
        this.categories.set(String(a.p_id), {
          id: String(a.p_id),
          name: String(a.p_name),
          sort_order: Number(a.p_sort),
        });
        return a.p_id;
      }
      case "sync_product": {
        const p = a.p as Row;
        if (!this.categories.has(String(p.categoryId))) throw new CloudRejection("category missing", "23503");
        const cur = this.products.get(String(p.id));
        const imageOk = p.imageId && this.images.has(String(p.imageId)) ? p.imageId : null;
        const row = (version: number) => ({
          id: p.id as string,
          category_id: p.categoryId,
          name: p.name,
          description: p.description,
          sku: p.sku || null,
          barcode: p.barcode || null,
          sale_unit: p.saleUnit,
          price: p.price,
          cost: p.cost,
          min_stock_qty: p.minStockQty,
          active: p.active,
          image_id: imageOk ?? (p.imageId ? (cur?.image_id ?? null) : null),
          version,
          created_at: p.createdAt,
          updated_at: new Date().toISOString(),
        });
        if (!cur) {
          this.products.set(String(p.id), row(1));
          return { status: "created", version: 1 };
        }
        if (a.p_base_version !== cur.version) return { status: "conflict", server: structuredClone(cur) };
        const next = row(cur.version + 1);
        const same = [
          "category_id",
          "name",
          "description",
          "sku",
          "barcode",
          "sale_unit",
          "price",
          "cost",
          "min_stock_qty",
          "active",
          "image_id",
        ].every((k) => (next as Row)[k] === cur[k]);
        if (same) return { status: "unchanged", version: cur.version };
        this.products.set(String(p.id), next);
        return { status: "updated", version: next.version };
      }
      case "sync_product_image": {
        const prod = this.products.get(String(a.p_product_id));
        if (!prod) throw new CloudRejection("product not synced yet", "23503");
        this.images.set(String(a.p_id), {
          id: a.p_id,
          product_id: a.p_product_id,
          storage_path: a.p_path,
          mime: a.p_mime,
          width: a.p_width,
          height: a.p_height,
        });
        if (a.p_make_current && prod.image_id !== a.p_id) {
          prod.image_id = a.p_id;
          prod.version += 1;
        }
        return prod.version;
      }
      case "sync_movement": {
        const m = a.m as Row;
        if (m.type === "purchase")
          throw new CloudRejection("purchase movements are synced with their purchase", "22023");
        if (m.batchId && !this.batchIds().has(String(m.batchId)))
          throw new CloudRejection("batch not synced yet", "23503");
        if (this.movements.has(String(m.id))) return "duplicate";
        this.movements.set(String(m.id), { ...m, receivedAt: new Date().toISOString() });
        return "inserted";
      }
      case "sync_supplier": {
        const p = a.p as Row;
        const id = String(p.id);
        const now = new Date().toISOString();
        if (this.suppliers.has(id)) {
          this.suppliers.set(id, { ...this.supplierRow(p), updated_at: now });
          return id;
        }
        const name = String(p.name).trim().toLowerCase();
        const hit = [...this.suppliers.values()].find((x) => x.name.toLowerCase() === name);
        if (hit) return hit.id;
        this.suppliers.set(id, { ...this.supplierRow(p), updated_at: now });
        return id;
      }
      case "sync_purchase": {
        const payload = a.payload as Row;
        const pur = payload.purchase as Row;
        const id = String(pur.id);
        const c = canonical(payload);
        const prev = this.purchases.get(id);
        if (prev) {
          if (prev.canonical === c) return "duplicate";
          throw new CloudRejection("purchase already synced with different content", "23505");
        }
        if (!this.suppliers.has(String(pur.supplierId))) throw new CloudRejection("supplier not synced yet", "23503");
        let total = 0;
        for (const l of payload.lines as Row[]) {
          const prod = this.products.get(String(l.productId));
          if (!prod) throw new CloudRejection("product not synced yet", "23503");
          const qty = Number(l.qty);
          const cost = Number(l.unitCost);
          const line = prod.sale_unit === "kg" ? Math.floor((cost * qty + 500) / 1000) : cost * qty;
          if (line !== l.lineCost) throw new CloudRejection("line cost does not match", "22023");
          total += line;
        }
        if (total !== pur.totalCost) throw new CloudRejection("purchase total does not match its lines", "22023");
        const now = new Date().toISOString();
        this.purchases.set(id, { canonical: c, payload, paymentStatus: "unpaid", at: now, updatedAt: now });
        return "inserted";
      }
      case "set_purchase_payment": {
        const p = this.purchases.get(String(a.p_id));
        if (!p) throw new CloudRejection("purchase not synced yet", "23503");
        p.paymentStatus = String(a.p_status);
        p.updatedAt = new Date().toISOString();
        return a.p_status;
      }
      case "sync_customer": {
        const p = a.p as Row;
        const id = String(p.id);
        const cur = this.customers.get(id);
        if (cur && cur.member_no !== p.memberNo) throw new CloudRejection("member numbers cannot change", "22023");
        if (!cur && [...this.customers.values()].some((c) => c.member_no === p.memberNo))
          throw new CloudRejection("member number already used", "23505");
        if (p.wantsDelivery && !p.deliveryAddress) throw new CloudRejection("delivery needs an address", "22023");
        if (p.marketingConsent && !p.contactNumber)
          throw new CloudRejection("promo messages need a mobile number", "22023");
        this.customers.set(id, {
          id,
          member_no: p.memberNo,
          name: p.name,
          birth_year: p.birthYear,
          gender: p.gender,
          contact_number: p.contactNumber || null,
          privacy_consent_at: p.privacyConsentAt,
          marketing_consent: p.marketingConsent,
          marketing_consent_at: p.marketingConsentAt || null,
          wants_delivery: p.wantsDelivery ?? false,
          delivery_consent_at: p.wantsDelivery ? p.deliveryConsentAt || null : null,
          delivery_address: p.wantsDelivery ? p.deliveryAddress || null : null,
          delivery_landmark: p.wantsDelivery ? p.deliveryLandmark || null : null,
          active: p.active,
          notes: p.notes || null,
          registered_at: p.registeredAt,
          registered_by: p.registeredBy,
          device_id: p.deviceId || null,
          updated_at: new Date().toISOString(),
        });
        return id;
      }
      case "sync_promotion": {
        const p = a.p as Row;
        if (p.scope === "items" && p.kind !== "percent") throw new CloudRejection("items must be percent", "23514");
        this.promotions.set(String(p.id), {
          id: String(p.id),
          name: p.name,
          description: p.description || null,
          kind: p.kind,
          value: p.value,
          scope: p.scope,
          product_ids: p.productIds,
          category_ids: p.categoryIds,
          members_only: p.membersOnly,
          min_purchase: p.minPurchase,
          starts_on: p.startsOn || null,
          ends_on: p.endsOn || null,
          active: p.active,
          updated_by: p.updatedBy,
          updated_at: new Date().toISOString(),
        });
        return p.id;
      }
      case "members_feed":
        return this.membersFeed(a.p_since as string | null);
      case "inventory_feed":
        return this.feed(a.p_since as string | null, String(a.p_device));
      case "sync_sale": {
        const payload = a.payload as Row;
        const id = String((payload.sale as Row).id);
        const c = canonical(payload);
        const prev = this.sales.get(id);
        if (prev !== undefined) {
          if (prev === c) return "duplicate";
          throw new CloudRejection("sale already synced with different content", "23505");
        }
        for (const it of payload.items as Row[]) {
          if (!this.products.has(String(it.productId))) throw new CloudRejection("product missing", "23503");
        }
        const customerId = (payload.sale as Row).customerId;
        if (customerId && !this.customers.has(String(customerId)))
          throw new CloudRejection("the member is not in the cloud yet", "23503");
        this.sales.set(id, c);
        this.saleRows.push({ ...payload, receivedAt: new Date().toISOString() });
        return "inserted";
      }
      case "sync_shift": {
        const p = a.p as Row;
        const prev = this.shifts.get(String(p.id));
        if (!prev) {
          this.shifts.set(String(p.id), { ...p });
          return "inserted";
        }
        if (p.closedAt && !prev.closedAt) {
          this.shifts.set(String(p.id), { ...prev, ...p });
          return "closed";
        }
        return "unchanged";
      }
      case "sync_drawer_event": {
        const p = a.p as Row;
        if (!this.shifts.has(String(p.shiftId))) throw new CloudRejection("shift not in the cloud yet", "23503");
        if (this.drawerEvents.has(String(p.id))) return "duplicate";
        this.drawerEvents.set(String(p.id), { ...p });
        return "inserted";
      }
      case "member_visits": {
        const counts = new Map<string, { visits: number; last_at: string }>();
        for (const json of this.sales.values()) {
          const sale = (JSON.parse(json) as { sale: { customerId?: string | null; createdAt: string } }).sale;
          if (!sale.customerId) continue;
          const c = counts.get(sale.customerId) ?? { visits: 0, last_at: sale.createdAt };
          c.visits++;
          if (sale.createdAt > c.last_at) c.last_at = sale.createdAt;
          counts.set(sale.customerId, c);
        }
        return [...counts].map(([customer_id, c]) => ({ customer_id, ...c }));
      }
      case "employees_feed":
        return { now: new Date().toISOString(), employees: this.employees };
      case "store_stock":
        return [...this.products.keys()].map((id) => ({ product_id: id, stock_qty: this.stockOf(id) }));
      default:
        throw new Error(`fake: unknown rpc ${fn}`);
    }
  }
}
