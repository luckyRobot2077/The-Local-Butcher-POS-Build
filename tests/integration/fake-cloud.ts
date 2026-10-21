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
  saleRows: Row[] = [];

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
    return n;
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
        if (this.movements.has(String(m.id))) return "duplicate";
        this.movements.set(String(m.id), m);
        return "inserted";
      }
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
        this.sales.set(id, c);
        this.saleRows.push(payload);
        return "inserted";
      }
      case "store_stock":
        return [...this.products.keys()].map((id) => ({ product_id: id, stock_qty: this.stockOf(id) }));
      default:
        throw new Error(`fake: unknown rpc ${fn}`);
    }
  }
}
