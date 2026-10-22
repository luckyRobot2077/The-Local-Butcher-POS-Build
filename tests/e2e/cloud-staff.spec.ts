import { expect, test } from "@playwright/test";
import { loadSamples, startPos } from "./helpers";
import { fakeSupabase, pinRecord, sha256Hex, totpNow, whoami } from "./fake-supabase";

const OWNER_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/**
 * Counter sign-in with employee badges, and owner approval with an
 * authenticator code, after the device downloads the staff list.
 */
test("staff sign in with badge + PIN; price changes need an owner badge + authenticator code", async ({ page }) => {
  await fakeSupabase(page, {
    whoami: whoami("cashier"),
    register_device: () => "10000000-0000-0000-0000-000000000001",
    sync_category: (b) => b.p_id,
    sync_product: () => ({ status: "created", version: 1 }),
    sync_movement: () => "inserted",
    store_stock: () => [],
    members_feed: () => ({ now: new Date().toISOString(), customers: [], promotions: [] }),
    member_visits: () => [],
    employees_feed: () => ({
      now: new Date().toISOString(),
      employees: [
        {
          id: "50000000-0000-0000-0000-000000000001",
          employee_no: "E-0001",
          name: "Josh",
          role: "owner",
          active: true,
          badge_hash: sha256Hex("TLB-STAFF:owner"),
          ...pinRecord("2468"),
          totp_secret: OWNER_SECRET,
        },
        {
          id: "50000000-0000-0000-0000-000000000002",
          employee_no: "E-0002",
          name: "Ana Reyes",
          role: "cashier",
          active: true,
          badge_hash: sha256Hex("TLB-STAFF:ana"),
          ...pinRecord("1357"),
          totp_secret: null,
        },
      ],
    }),
  });

  await startPos(page);
  await loadSamples(page);
  await page.getByRole("link", { name: "Device" }).click();
  await page.getByLabel("Email").fill("counter@example.test");
  await page.getByLabel("Password").fill("correct-horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("sync-panel")).toBeVisible();
  await page.getByTestId("sync-now").click();

  // Once the staff list arrives, the POS asks for a badge.
  const signIn = page.getByRole("dialog", { name: "Sign in to the POS" });
  await expect(signIn).toBeVisible({ timeout: 20_000 });
  await signIn.getByTestId("badge-input").fill("TLB-STAFF:nobody");
  await signIn.getByTestId("badge-input").press("Enter");
  await expect(signIn.getByText("This badge is not recognised")).toBeVisible();
  await signIn.getByTestId("badge-input").fill("TLB-STAFF:ana");
  await signIn.getByTestId("badge-input").press("Enter");
  await signIn.getByTestId("staff-pin").fill("9999");
  await signIn.getByRole("button", { name: "Start selling" }).click();
  await expect(signIn.getByText("Wrong PIN.")).toBeVisible();
  await signIn.getByTestId("staff-pin").fill("1357");
  await signIn.getByRole("button", { name: "Start selling" }).click();
  await expect(page.getByTestId("cashier-chip")).toHaveText("Ana Reyes · Sign out");

  // A cashier changing a price needs the owner's badge and a fresh authenticator code.
  await page.getByRole("link", { name: "Products" }).click();
  const liempo = page.locator('[data-testid="product-row"][data-product="Liempo (Pork Belly)"]');
  await liempo.getByTestId("row-price").click();
  const approve = page.getByRole("dialog", { name: "Owner or manager approval" });
  await approve.getByTestId("badge-input").fill("TLB-STAFF:ana");
  await approve.getByTestId("badge-input").press("Enter");
  await expect(approve.getByText("A cashier badge cannot approve this.")).toBeVisible();
  await approve.getByTestId("badge-input").fill("TLB-STAFF:owner");
  await approve.getByTestId("badge-input").press("Enter");
  await approve.getByTestId("approver-code").fill("000000");
  await approve.getByRole("button", { name: "Approve" }).click();
  await expect(approve.getByText("Wrong or already used code")).toBeVisible();
  const code = totpNow(OWNER_SECRET);
  await approve.getByTestId("approver-code").fill(code);
  await approve.getByRole("button", { name: "Approve" }).click();
  await expect(approve).toBeHidden();
  await liempo.getByTestId("row-price").fill("360");
  await liempo.getByTestId("row-reason").fill("Supplier price increase");
  await liempo.getByTestId("row-save").click();
  await expect(liempo.getByTestId("row-save")).toBeHidden();

  // The same code cannot be used again on this device.
  await page.getByRole("button", { name: /Manager · Lock/ }).click();
  await liempo.getByTestId("row-price").click();
  await approve.getByTestId("badge-input").fill("TLB-STAFF:owner");
  await approve.getByTestId("badge-input").press("Enter");
  await approve.getByTestId("approver-code").fill(code);
  await approve.getByRole("button", { name: "Approve" }).click();
  await expect(approve.getByText("Wrong or already used code")).toBeVisible();
  await approve.getByRole("button", { name: "Close" }).click();

  // Signing out hands the counter to the next employee.
  await page.getByTestId("cashier-chip").click();
  await expect(signIn).toBeVisible();
  await signIn.getByTestId("badge-input").fill("TLB-STAFF:owner");
  await signIn.getByTestId("badge-input").press("Enter");
  await signIn.getByTestId("staff-pin").fill("2468");
  await signIn.getByRole("button", { name: "Start selling" }).click();
  await expect(page.getByTestId("cashier-chip")).toHaveText("Josh · Sign out");
});
