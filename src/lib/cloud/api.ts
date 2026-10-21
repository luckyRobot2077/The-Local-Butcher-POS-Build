import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The small surface of Supabase the sync engine uses. Kept as an interface
 * so the engine can be tested against an in-memory fake.
 */
export interface CloudApi {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  select<T>(table: string, columns: string): Promise<T[]>;
  upload(path: string, blob: Blob, contentType: string): Promise<void>;
  download(path: string): Promise<Blob>;
}

/** An error from the server that retrying will not fix (permission, validation, conflict). */
export class CloudRejection extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Network or availability problem: keep the work queued and try later. */
export class CloudUnavailable extends Error {}

export const PHOTO_BUCKET = "product-images";

let client: SupabaseClient | null | undefined;

export function cloudConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** Browser Supabase client (anon key + the signed-in user's session), or null if not configured. */
export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  client =
    url && key
      ? createClient(url, key, {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: "tlb-auth" },
        })
      : null;
  return client;
}

function classify(error: { message: string; code?: string; status?: number } | null): never {
  const msg = error?.message ?? "Unknown error";
  // PostgREST passes Postgres SQLSTATE codes through. Class 42 (privileges),
  // 22 (data), 23 (constraints), P0 (raised) and PGRST errors are real rejections.
  const code = error?.code;
  if (code && /^(42|22|23|P0|PGRST)/.test(code)) throw new CloudRejection(msg, code);
  if (error?.status && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    throw new CloudRejection(msg, code ?? String(error.status));
  }
  throw new CloudUnavailable(msg);
}

export function supabaseApi(sb: SupabaseClient): CloudApi {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      let res;
      try {
        res = await sb.rpc(fn, args);
      } catch (e) {
        throw new CloudUnavailable(e instanceof Error ? e.message : String(e));
      }
      if (res.error) classify({ ...res.error, status: res.status });
      return res.data as T;
    },
    async select<T>(table: string, columns: string) {
      let res;
      try {
        res = await sb.from(table).select(columns);
      } catch (e) {
        throw new CloudUnavailable(e instanceof Error ? e.message : String(e));
      }
      if (res.error) classify({ ...res.error, status: res.status });
      return (res.data ?? []) as T[];
    },
    async upload(path, blob, contentType) {
      const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType, upsert: false });
      // Same image id uploaded before (e.g. the confirmation was lost): fine.
      if (error && !/exists|duplicate/i.test(error.message)) {
        const status = (error as { statusCode?: string }).statusCode;
        if (status && /^4/.test(status)) throw new CloudRejection(error.message, status);
        throw new CloudUnavailable(error.message);
      }
    },
    async download(path) {
      const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(path);
      if (error || !data) throw new CloudUnavailable(error?.message ?? "download failed");
      return data;
    },
  };
}
