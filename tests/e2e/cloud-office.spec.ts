import { expect, test, type Page } from "@playwright/test";
import { fakeSupabase, whoami } from "./fake-supabase";

/**
 * Back Office against a fake Supabase (request interception). The report SQL
 * itself is tested on PostgreSQL in supabase/tests/back_office_test.sql.
 */

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A believable report for any range: a few sales a day, weekends busier. */
function fakeReport(
  from: string | null,
  to: string,
  expenses: { id: string; category: string; amount: number; spentOn: string; note: string | null }[],
) {
  const start = from ?? addDays(to, -89);
  const daily: {
    date: string;
    revenue: number;
    cogs: number;
    transactions: number;
    discounts: number;
    expenses: number;
  }[] = [];
  for (let d = start; d <= to; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const seed = Number(d.replace(/-/g, "")) % 97;
    const revenue = (dow === 0 || dow === 6 ? 1_800_000 : 1_100_000) + seed * 9_000;
    const exp = expenses.filter((e) => e.spentOn === d).reduce((a, e) => a + e.amount, 0);
    daily.push({
      date: d,
      revenue,
      cogs: Math.round(revenue * 0.78),
      transactions: 18 + (seed % 9),
      discounts: seed * 300,
      expenses: exp,
    });
  }
  const sum = (k: "revenue" | "cogs" | "transactions" | "discounts" | "expenses") =>
    daily.reduce((a, x) => a + x[k], 0);
  const revenue = sum("revenue");
  const cogs = sum("cogs");
  const exp = sum("expenses");
  const tx = sum("transactions");
  const products = [
    ["Pork Liempo", "kg", 0.31],
    ["Pork Kasim", "kg", 0.18],
    ["Beef Brisket", "kg", 0.14],
    ["Whole Chicken", "piece", 0.12],
    ["Chicken Thigh", "kg", 0.09],
    ["Salmon Belly", "kg", 0.07],
    ["Longganisa", "piece", 0.04],
    ["Vinegar", "piece", 0.03],
    ["Atchara", "piece", 0.02],
  ] as const;
  return {
    from: start,
    to,
    days: daily.length,
    totals: {
      revenue,
      grossSales: revenue + sum("discounts"),
      transactions: tx,
      average: Math.round(revenue / tx),
      discounts: sum("discounts"),
      cogs,
      grossProfit: revenue - cogs,
      expenses: exp,
      netProfit: revenue - cogs - exp,
      refunds: 0,
    },
    daily,
    byCategory: [
      { name: "Pork", revenue: Math.round(revenue * 0.49), cost: Math.round(revenue * 0.49 * 0.8) },
      { name: "Beef", revenue: Math.round(revenue * 0.14), cost: Math.round(revenue * 0.14 * 0.82) },
      { name: "Chicken", revenue: Math.round(revenue * 0.21), cost: Math.round(revenue * 0.21 * 0.76) },
      { name: "Salmon", revenue: Math.round(revenue * 0.07), cost: Math.round(revenue * 0.07 * 0.7) },
      { name: "Fresh Goods", revenue: Math.round(revenue * 0.04), cost: Math.round(revenue * 0.04 * 0.75) },
      { name: "Condiments", revenue: Math.round(revenue * 0.05), cost: Math.round(revenue * 0.05 * 0.6) },
    ],
    products: products.map(([name, unit, share], i) => ({
      id: `40000000-0000-0000-0000-00000000000${i}`,
      name,
      unit,
      qty: unit === "kg" ? Math.round((revenue * share) / 36) : Math.round((revenue * share) / 25000),
      revenue: Math.round(revenue * share),
      cost: Math.round(revenue * share * (0.7 + i * 0.02)),
      lines: Math.round(tx * share),
    })),
    byPayment: [
      { method: "cash", revenue: Math.round(revenue * 0.72), transactions: Math.round(tx * 0.75) },
      { method: "gcash", revenue: revenue - Math.round(revenue * 0.72), transactions: tx - Math.round(tx * 0.75) },
    ],
    byCashier: [
      { name: "Ana", revenue: Math.round(revenue * 0.6), transactions: Math.round(tx * 0.6), discounts: 0 },
      {
        name: "Josh",
        revenue: revenue - Math.round(revenue * 0.6),
        transactions: tx - Math.round(tx * 0.6),
        discounts: 0,
      },
    ],
    byHour: Array.from({ length: 24 }, (_, h) => {
      const w = h < 6 || h > 19 ? 0 : [1, 4, 6, 7, 5, 4, 3, 3, 4, 6, 7, 6, 3, 1][h - 6];
      return { hour: h, revenue: Math.round((revenue * w) / 60), transactions: Math.round((tx * w) / 60) };
    }),
    byWeekday: Array.from({ length: 7 }, (_, w) => ({
      weekday: w,
      revenue: daily
        .filter((x) => new Date(`${x.date}T00:00:00Z`).getUTCDay() === w)
        .reduce((a, x) => a + x.revenue, 0),
      transactions: daily
        .filter((x) => new Date(`${x.date}T00:00:00Z`).getUTCDay() === w)
        .reduce((a, x) => a + x.transactions, 0),
    })),
    discounts: [
      { source: "promotion", name: "Senior Tuesday", amount: Math.round(sum("discounts") * 0.6), uses: 14 },
      { source: "manual", name: "Suki", amount: sum("discounts") - Math.round(sum("discounts") * 0.6), uses: 9 },
    ],
    expenses: {
      byCategory: Object.entries(
        expenses
          .filter((e) => e.spentOn >= start && e.spentOn <= to)
          .reduce<Record<string, number>>((a, e) => ({ ...a, [e.category]: (a[e.category] ?? 0) + e.amount }), {}),
      ).map(([category, amount]) => ({ category, amount })),
      list: expenses.filter((e) => e.spentOn >= start && e.spentOn <= to),
    },
    members: {
      total: 48,
      newInRange: 6,
      active: 21,
      repeat: 13,
      memberRevenue: Math.round(revenue * 0.38),
      memberTransactions: Math.round(tx * 0.3),
      promoOptIns: 31,
      top: [
        { name: "Maria Santos", memberNo: "M-AB12-0001", visits: 9, spent: 1_245_000 },
        { name: "Jose Reyes", memberNo: "M-AB12-0007", visits: 6, spent: 830_000 },
        { name: "Liza Cruz", memberNo: "M-AB12-0012", visits: 4, spent: 512_500 },
      ],
      byGender: [
        { gender: "female", members: 29 },
        { gender: "male", members: 17 },
        { gender: "undisclosed", members: 2 },
      ],
      byAge: [
        { band: "25-34", members: 14 },
        { band: "35-44", members: 18 },
        { band: "45-54", members: 9 },
        { band: "55+", members: 5 },
        { band: "Unknown", members: 2 },
      ],
    },
    inventory: {
      stockValue: 18_450_000,
      purchases: Math.round(cogs * 1.05),
      losses: [
        { type: "trim_loss", value: 245_000, entries: 6 },
        { type: "spoilage", value: 120_000, entries: 2 },
      ],
      lowStock: [
        { id: "a", name: "Beef Brisket", unit: "kg", qty: 850, min: 2000, category: "Beef" },
        { id: "b", name: "Salmon Belly", unit: "kg", qty: 0, min: 1000, category: "Salmon" },
      ],
    },
    recent: [
      {
        id: "s1",
        receiptNo: "AB12-000231",
        at: `${to}T08:12:00Z`,
        total: 74_500,
        cashier: "Ana",
        method: "cash",
        member: true,
      },
      {
        id: "s2",
        receiptNo: "AB12-000230",
        at: `${to}T07:40:00Z`,
        total: 36_000,
        cashier: "Ana",
        method: "gcash",
        member: false,
      },
    ],
  };
}

const SESSION = {
  token: "session-token",
  employeeId: "50000000-0000-0000-0000-000000000001",
  employeeNo: "E-0001",
  name: "Josh",
  role: "owner",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

async function signIn(page: Page, email = "owner@example.test") {
  await page.goto("/office");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse");
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function unlock(page: Page, badge: string, code: string) {
  await expect(page.getByTestId("office-unlock")).toBeVisible();
  await page.getByTestId("badge-input").fill(badge);
  await page.getByTestId("badge-input").press("Enter");
  await page.getByTestId("office-code").fill(code);
  await page.getByRole("button", { name: "Open", exact: true }).click();
}

test("Back Office opens with a badge and authenticator code; charts, expenses and CSV", async ({ page }) => {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const expenses: { id: string; category: string; amount: number; spentOn: string; note: string | null }[] = [];
  const withToken = (body: Record<string, unknown>, ok: () => unknown) =>
    body.p_token === SESSION.token
      ? ok()
      : { status: 403, body: { code: "42501", message: "the Back Office is locked: scan your badge" } };

  await fakeSupabase(
    page,
    {
      whoami: whoami("owner"),
      office_status: () => ({ setupOpen: false, accountRole: "owner", employees: 2 }),
      office_unlock: (b) =>
        b.p_badge === "TLB-STAFF:owner" && b.p_code === "123456"
          ? SESSION
          : { error: "Wrong or used code. Wait for a new code in the authenticator app and try again." },
      office_lock: () => null,
      office_report: (b) => withToken(b, () => fakeReport(b.p_from as string | null, b.p_to as string, expenses)),
      record_expense: (b) =>
        withToken(b, () => {
          const p = b.p as { id: string; category: string; amount: number; spentOn: string; note: string };
          const i = expenses.findIndex((e) => e.id === p.id);
          const row = { id: p.id, category: p.category, amount: p.amount, spentOn: p.spentOn, note: p.note || null };
          if (i >= 0) expenses[i] = row;
          else expenses.push(row);
          return p.id;
        }),
      office_sales_lines: (b) =>
        withToken(b, () => [
          {
            business_date: b.p_to,
            created_at: `${b.p_to}T02:00:00+00:00`,
            receipt_no: "AB12-000001",
            cashier: "Ana",
            payment_method: "cash",
            member_no: "M-AB12-0001",
            product: "Liempo",
            category: "Pork",
            unit: "kg",
            qty: 1000,
            unit_price: 36000,
            gross: 36000,
            discount: 3600,
            net: 32400,
            cost: 29500,
            item_discount: 0,
            order_discount_share: 3600,
            discount_names: "Suki 10% (whole sale)",
            discount_approved_by: "Josh",
          },
        ]),
    },
    calls,
  );

  await signIn(page);
  await unlock(page, "TLB-STAFF:owner", "000000");
  await expect(page.getByText("Wrong or used code")).toBeVisible();
  await page.getByTestId("office-code").fill("123456");
  await page.getByRole("button", { name: "Open", exact: true }).click();

  await expect(page.getByTestId("office-report")).toBeVisible();
  await expect(page.getByTestId("office-who")).toContainText("Josh (owner, E-0001)");
  expect(calls.find((c) => c.fn === "office_report")?.body).toMatchObject({ p_token: SESSION.token });
  await expect(page.getByTestId("kpi-sales")).toContainText("₱");
  await expect(page.getByTestId("chart-trend").locator(".recharts-line")).toHaveCount(2);
  await expect(page.getByTestId("by-hour").locator(".recharts-bar-rectangle").first()).toBeVisible();
  await expect(page.getByTestId("best-sellers")).toContainText("Pork Liempo");
  await expect(page.getByTestId("low-stock")).toContainText("Salmon Belly");
  await expect(page.getByTestId("top-members")).toContainText("Maria Santos");
  await page.screenshot({ path: test.info().outputPath("office-7d.png"), fullPage: true });

  // Expense: saved, then shows in the report.
  await page.getByLabel("Amount (₱)").fill("1,500");
  await page.getByLabel("Note (optional)").fill("Helper wages");
  await page.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByTestId("expenses-by-category")).toContainText("₱1,500.00");
  expect(calls.find((c) => c.fn === "record_expense")?.body.p).toMatchObject({ category: "wages", amount: 150000 });
  await expect(page.getByTestId("kpi-net")).toContainText("After ₱1,500.00 expenses");

  // Ranges: all history sends no start date; a year groups by week.
  await page.getByTestId("range-all").click();
  await expect.poll(() => calls.filter((c) => c.fn === "office_report").at(-1)?.body.p_from).toBeNull();
  await page.getByTestId("range-year").click();
  await expect(page.getByText("trend grouped by week", { exact: false })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByTestId("csv-lines").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^sale-lines_.*\.csv$/);
  const text = Buffer.concat(await (await file.createReadStream()).toArray()).toString();
  expect(text).toContain('"Discount given"');
  expect(text).toContain('"36.00","Suki 10% (whole sale)","0.00","36.00","Josh","324.00"');

  // A reload keeps the session for this tab; Lock ends it.
  await page.reload();
  await expect(page.getByTestId("office-report")).toBeVisible();
  await page.getByTestId("office-lock").click();
  await expect(page.getByTestId("office-unlock")).toBeVisible();
  expect(calls.some((c) => c.fn === "office_lock")).toBe(true);
});

test("first-time setup: owner ID, badge, Google Authenticator, then the Staff page", async ({ page }) => {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  let setupOpen = true;
  const staff: Record<string, unknown>[] = [];
  await fakeSupabase(
    page,
    {
      whoami: whoami("owner"),
      office_status: () => ({ setupOpen, accountRole: "owner", employees: staff.length }),
      save_employee: (b) => {
        const p = b.p as Record<string, unknown>;
        const no = `E-000${staff.length + 1}`;
        staff.push({
          id: p.id,
          employeeNo: no,
          name: p.name,
          role: p.role,
          active: true,
          hasPin: !!p.pin,
          authenticator: false,
        });
        return { id: p.id, employeeNo: no };
      },
      confirm_totp: (b) => {
        if (b.p_code !== "654321") return false;
        setupOpen = false;
        const e = staff.find((x) => x.id === b.p_employee);
        if (e) e.authenticator = true;
        return true;
      },
      office_unlock: (b) => (b.p_code === "111111" ? SESSION : { error: "Wrong or used code." }),
      office_report: () => fakeReport(null, new Date().toISOString().slice(0, 10), []),
      office_employees: () => staff,
    },
    calls,
  );

  await signIn(page);
  await expect(page.getByTestId("office-setup")).toBeVisible();
  await page.getByLabel("New PIN").fill("2468");
  await page.getByLabel("Repeat PIN").fill("2468");
  await page.getByRole("button", { name: "Create my owner ID" }).click();

  await expect(page.getByTestId("badge-panel")).toBeVisible();
  const save = calls.find((c) => c.fn === "save_employee")!.body;
  const p = save.p as {
    role: string;
    badgeHash: string;
    totpSecret: string;
    pin: { hash: string; iterations: number };
  };
  expect(save.p_token).toBeNull();
  expect(p.role).toBe("owner");
  expect(p.badgeHash).toMatch(/^[0-9a-f]{64}$/);
  expect(p.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
  expect(p.pin.iterations).toBe(210000);
  expect(JSON.stringify(save)).not.toContain("2468");
  expect(JSON.stringify(save)).not.toContain("TLB-STAFF:");

  await expect(page.getByTestId("badge-panel").getByRole("img")).toBeVisible();
  await page.getByTestId("office-setup").screenshot({ path: test.info().outputPath("setup-badge.png") });
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("totp-secret")).toHaveText(p.totpSecret.match(/.{1,4}/g)!.join(" "));
  await page.getByTestId("totp-confirm-code").fill("000000");
  await page.getByRole("button", { name: "Link the app" }).click();
  await expect(page.getByText("That code did not match")).toBeVisible();
  await page.getByTestId("totp-confirm-code").fill("654321");
  await page.getByRole("button", { name: "Link the app" }).click();
  await page.getByTestId("setup-open-code").fill("111111");
  await page.getByRole("button", { name: "Open the Back Office" }).click();
  await expect(page.getByTestId("office-report")).toBeVisible();
  const unlockCall = calls.find((c) => c.fn === "office_unlock")!.body;
  expect(String(unlockCall.p_badge)).toMatch(/^TLB-STAFF:[0-9a-f]{32}$/);

  // Staff page: add a cashier with a PIN; the badge is shown for printing.
  await page.getByTestId("office-tab-staff").click();
  await expect(page.getByTestId("employee-list")).toContainText("E-0001");
  await page.getByTestId("add-employee").click();
  await page.getByLabel("Employee name").fill("Ana Reyes");
  await page.getByLabel("New PIN").fill("1357");
  await page.getByLabel("Repeat PIN").fill("1357");
  await page.getByRole("button", { name: "Create and make badge" }).click();
  await expect(page.getByTestId("badge-panel")).toBeVisible();
  const add = calls.filter((c) => c.fn === "save_employee").at(-1)!.body;
  expect(add).toMatchObject({ p_token: SESSION.token, p: { name: "Ana Reyes", role: "cashier" } });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("employee-list")).toContainText("Ana Reyes");
});

test("a cashier badge cannot open the Back Office", async ({ page }) => {
  await fakeSupabase(page, {
    whoami: whoami("cashier"),
    office_status: () => ({ setupOpen: false, accountRole: "cashier", employees: 3 }),
    office_unlock: () => ({ error: "Only owner and manager badges open the Back Office." }),
  });
  await signIn(page, "ana@example.test");
  await unlock(page, "TLB-STAFF:ana", "123456");
  await expect(page.getByText("Only owner and manager badges open the Back Office.")).toBeVisible();
});

test("the Back Office asks for the database update when migration 10 is missing", async ({ page }) => {
  await fakeSupabase(page, { whoami: whoami("owner") });
  await signIn(page);
  await expect(page.getByText("The cloud database needs an update")).toBeVisible();
});

test("Shifts page: every device's shifts with times, cash count, no-sale openings and CSV", async ({ page }) => {
  const shift = {
    id: "90000000-0000-0000-0000-000000000001",
    device_code: "AB12",
    device_label: "Counter tablet",
    opened_at: "2026-10-22T00:00:00Z",
    opened_by: "Ana Reyes",
    opening_float: 100000,
    closed_at: "2026-10-22T10:00:00Z",
    closed_by: "Ana Reyes",
    counted_cash: 132000,
    expected_cash: 132400,
    note: "Gave extra change",
    cash_sales: 32400,
    gcash_sales: 0,
    sale_count: 1,
    sales: [
      {
        receipt_no: "AB12-000001",
        cashier: "Ana Reyes",
        started_at: "2026-10-22T01:58:30Z",
        paid_at: "2026-10-22T02:00:00Z",
        total: 32400,
        method: "cash",
      },
    ],
    events: [
      {
        kind: "no_sale",
        at: "2026-10-22T03:00:00Z",
        by: "Ana Reyes",
        approved_by: "Josh",
        reason: "Change for a customer",
      },
    ],
  };
  await fakeSupabase(page, {
    whoami: whoami("owner"),
    office_status: () => ({ setupOpen: false, accountRole: "owner", employees: 2 }),
    office_unlock: () => SESSION,
    office_report: (b) => fakeReport(b.p_from as string | null, b.p_to as string, []),
    office_shifts: (b) =>
      b.p_token === SESSION.token ? { shifts: [shift] } : { status: 403, body: { code: "42501", message: "locked" } },
  });
  await signIn(page);
  await unlock(page, "TLB-STAFF:owner", "123456");
  await page.getByTestId("office-tab-shifts").click();
  const row = page.getByTestId("office-shift");
  await expect(row).toContainText("Ana Reyes");
  await expect(row.getByTestId("office-shift-difference")).toHaveText("Short by ₱4.00");
  await row.locator("summary").click();
  const entries = row.getByTestId("timeline-entry");
  await expect(entries).toHaveCount(5);
  await expect(entries.nth(0)).toContainText("Shift started");
  await expect(entries.nth(1)).toContainText("Sale AB12-000001 started");
  await expect(entries.nth(2)).toContainText("Sale AB12-000001 paid");
  await expect(entries.nth(3)).toContainText("approved by Josh");
  await expect(entries.nth(4)).toContainText("counted ₱1,320.00, expected ₱1,324.00");
  const download = page.waitForEvent("download");
  await page.getByTestId("shifts-csv").click();
  const csv = await (await download).createReadStream().then(
    (s) =>
      new Promise<string>((resolve) => {
        let t = "";
        s.on("data", (c) => (t += c));
        s.on("end", () => resolve(t));
      }),
  );
  expect(csv.split("\r\n")).toHaveLength(6);
  expect(csv).toContain('"Drawer opened, no sale"');
});
