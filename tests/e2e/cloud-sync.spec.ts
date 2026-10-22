import { expect, test, type Route } from "@playwright/test";
import { addItem, loadSamples, startPos } from "./helpers";

/**
 * Exercises the real supabase-js wiring (sign-in, RPC calls, sync status UI)
 * against a fake Supabase served by request interception. The SQL behind
 * these RPCs is tested on PostgreSQL by `npm run test:db`.
 */
test("sign in, register the device and sync a sale exactly once", async ({ page }) => {
  const rpcCalls: { fn: string; body: Record<string, unknown> }[] = [];
  const sales = new Map<string, string>();
  const userId = "00000000-0000-0000-0000-0000000000a1";

  await page.route("http://supabase.fake.test/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });
    if (req.method() === "OPTIONS") {
      return route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        },
      });
    }
    if (url.pathname === "/auth/v1/token") {
      const { email, password } = req.postDataJSON();
      if (password !== "correct-horse")
        return json(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: "fake-access-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: "fake-refresh",
        user: {
          id: userId,
          aud: "authenticated",
          role: "authenticated",
          email,
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      });
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/").pop()!;
      const body = req.postDataJSON() ?? {};
      expect(req.headers()["authorization"]).toBe("Bearer fake-access-token");
      rpcCalls.push({ fn, body });
      switch (fn) {
        case "whoami":
          return json(200, [
            {
              user_id: userId,
              store_id: "10000000-0000-0000-0000-000000000001",
              store_name: "The Local Butcher",
              display_name: "Josh",
              role: "owner",
              can_edit_photos: true,
              can_edit_descriptions: true,
              can_edit_names: true,
              can_edit_prices: true,
              can_edit_categories: true,
              discount_limit_bp: 10000,
              has_store: true,
            },
          ]);
        case "register_device":
          return json(200, "10000000-0000-0000-0000-000000000001");
        case "sync_category":
          return json(200, body.p_id);
        case "sync_product":
          return json(200, { status: "created", version: 1 });
        case "sync_movement":
          return json(200, "inserted");
        case "sync_sale": {
          const payload = body.payload as { sale: { id: string } };
          const key = JSON.stringify(payload);
          const prev = sales.get(payload.sale.id);
          if (prev && prev !== key) return json(409, { code: "23505", message: "different content" });
          sales.set(payload.sale.id, key);
          return json(200, prev ? "duplicate" : "inserted");
        }
        case "store_stock":
          return json(200, []);
        case "inventory_feed":
          return json(200, {
            now: new Date().toISOString(),
            suppliers: [],
            purchases: [],
            purchase_items: [],
            batches: [],
            movements: [],
            sale_lines: [],
          });
        case "members_feed":
          return json(200, { now: new Date().toISOString(), customers: [], promotions: [] });
        case "member_visits":
          return json(200, []);
        case "employees_feed":
          return json(200, { now: new Date().toISOString(), employees: [] });
      }
      return json(404, { code: "PGRST202", message: `no function ${fn}` });
    }
    if (url.pathname.startsWith("/rest/v1/")) return json(200, []);
    return json(404, { message: "not faked" });
  });

  await startPos(page);
  await loadSamples(page);
  await addItem(page, "Whole Chicken", "1");
  await page.getByTestId("checkout").click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("confirm-sale").click();
  await page.getByTestId("new-sale").click();
  await expect(page.getByTestId("pending-count")).toContainText("1 unsynced");

  await page.getByRole("link", { name: "Device" }).click();
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong email or password.")).toBeVisible();
  await page.getByLabel("Password").fill("correct-horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("sync-panel")).toBeVisible();
  await expect(page.getByText("Registered", { exact: true }).last()).toBeVisible();
  expect(rpcCalls.find((c) => c.fn === "register_device")).toBeTruthy();

  await page.getByTestId("sync-now").click();
  await expect(page.getByTestId("pending-count")).toContainText("0 unsynced");
  await expect(page.getByTestId("sync-panel")).toContainText("Waiting to send: 0");
  await page.getByTestId("sync-now").click();
  await expect(page.getByTestId("sync-panel")).toContainText("Problems: 0");
  await expect(page.getByTestId("sync-panel")).not.toContainText("Last attempt");
  await expect(page.getByTestId("sync-panel")).not.toContainText("Inventory reports");
  await expect(page.getByTestId("sync-panel")).not.toContainText("Members and programs");
  expect(rpcCalls.filter((c) => c.fn === "members_feed").length).toBeGreaterThan(0);
  expect(rpcCalls.filter((c) => c.fn === "inventory_feed").length).toBeGreaterThan(0);

  expect(rpcCalls.filter((c) => c.fn === "sync_sale")).toHaveLength(1);
  expect(rpcCalls.filter((c) => c.fn === "sync_product")).toHaveLength(16);
  expect(sales.size).toBe(1);
  // The cashier shown on sales is now the signed-in staff member.
  await expect(page.getByTestId("cashier-chip")).toContainText("Josh");
});
