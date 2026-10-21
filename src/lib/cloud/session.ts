import type { SupabaseClient } from "@supabase/supabase-js";
import { getDb, type PosDatabase } from "@/lib/db/db";
import { ensureDevice, setCashierName } from "@/lib/db/config";
import { CloudRejection, type CloudApi } from "./api";
import { getCloudIdentity, setCloudIdentity, type CloudIdentity } from "./identity";

interface WhoAmIRow {
  user_id: string | null;
  store_id: string | null;
  store_name: string | null;
  display_name: string | null;
  role: CloudIdentity["role"] | null;
  can_edit_photos: boolean | null;
  can_edit_descriptions: boolean | null;
  can_edit_names: boolean | null;
  can_edit_prices: boolean | null;
  can_edit_categories: boolean | null;
  discount_limit_bp: number | null;
  has_store: boolean;
}

export type AccountState =
  | { kind: "signed_out" }
  | { kind: "needs_store" } // signed in, database has no store yet: may create it as owner
  | { kind: "not_staff"; email: string } // signed in, store exists, not added as staff
  | { kind: "ready"; identity: CloudIdentity };

export async function signIn(sb: SupabaseClient, email: string, password: string) {
  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error)
    throw new CloudRejection(
      error.message === "Invalid login credentials" ? "Wrong email or password." : error.message,
    );
}

export async function signOut(sb: SupabaseClient, db: PosDatabase = getDb()) {
  await sb.auth.signOut();
  await setCloudIdentity(undefined, db);
}

/**
 * Asks the server who is signed in, registers this device with the store
 * when needed, and stores the result locally so it is known offline.
 */
export async function refreshAccount(
  sb: SupabaseClient,
  api: CloudApi,
  db: PosDatabase = getDb(),
): Promise<AccountState> {
  const { data } = await sb.auth.getSession();
  const email = data.session?.user.email ?? "";
  if (!data.session) {
    await setCloudIdentity(undefined, db);
    return { kind: "signed_out" };
  }
  const rows = await api.rpc<WhoAmIRow[]>("whoami", {});
  const me = rows[0];
  if (!me?.user_id) {
    await setCloudIdentity(undefined, db);
    return me?.has_store ? { kind: "not_staff", email } : { kind: "needs_store" };
  }
  const previous = await getCloudIdentity(db);
  const device = await ensureDevice(db);
  let deviceRegistered = previous?.deviceRegistered === true && previous.storeId === me.store_id;
  if (!deviceRegistered) {
    await api.rpc<string>("register_device", {
      p_device_id: device.deviceId,
      p_device_code: device.deviceCode,
      p_label: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 120) : "device",
    });
    deviceRegistered = true;
    // From now on this device belongs to the server's store.
    await db.config.put({ key: "device", value: { ...device, storeId: me.store_id } });
  }
  const identity: CloudIdentity = {
    userId: me.user_id,
    email,
    storeId: me.store_id!,
    storeName: me.store_name!,
    displayName: me.display_name!,
    role: me.role!,
    canEditPhotos: !!me.can_edit_photos,
    canEditDescriptions: !!me.can_edit_descriptions,
    canEditNames: !!me.can_edit_names,
    canEditPrices: !!me.can_edit_prices,
    canEditCategories: !!me.can_edit_categories,
    discountLimitBp: me.discount_limit_bp ?? 0,
    deviceRegistered,
    confirmedAt: new Date().toISOString(),
  };
  await setCloudIdentity(identity, db);
  await setCashierName(identity.displayName, db);
  return { kind: "ready", identity };
}

export async function createStore(api: CloudApi, storeName: string, ownerName: string) {
  await api.rpc<string>("bootstrap_owner", { p_store_name: storeName.trim(), p_display_name: ownerName.trim() });
}

export async function addStaff(api: CloudApi, email: string, name: string, role: CloudIdentity["role"]) {
  await api.rpc<string>("add_staff", { p_email: email.trim(), p_display_name: name.trim(), p_role: role });
}
