import { expect, test, type Route } from "@playwright/test";

/**
 * Back Office against a fake Supabase (request interception). The report SQL
 * itself is tested on PostgreSQL in supabase/tests/back_office_test.sql.
 */
const userId = "00000000-0000-0000-0000-0000000000a1";

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

test("owner signs in to the Back Office, sees charts, adds an expense and downloads CSV", async ({ page }) => {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const expenses: { id: string; category: string; amount: number; spentOn: string; note: string | null }[] = [];

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
      const { email } = req.postDataJSON();
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
      calls.push({ fn, body });
      switch (fn) {
        case "whoami":
          return json(200, [
            {
              user_id: userId,
              store_id: "s",
              store_name: "The Local Butcher",
              display_name: "Josh",
              role: "owner",
              has_store: true,
            },
          ]);
        case "office_report":
          return json(200, fakeReport(body.p_from as string | null, body.p_to as string, expenses));
        case "record_expense": {
          const p = body.p as { id: string; category: string; amount: number; spentOn: string; note: string };
          const i = expenses.findIndex((e) => e.id === p.id);
          const row = { id: p.id, category: p.category, amount: p.amount, spentOn: p.spentOn, note: p.note || null };
          if (i >= 0) expenses[i] = row;
          else expenses.push(row);
          return json(200, p.id);
        }
        case "office_sales_lines":
          return json(200, [
            {
              business_date: body.p_to,
              created_at: `${body.p_to}T02:00:00+00:00`,
              receipt_no: "AB12-000001",
              cashier: "Ana",
              payment_method: "cash",
              member_no: null,
              product: "Liempo",
              category: "Pork",
              unit: "kg",
              qty: 1000,
              unit_price: 36000,
              gross: 36000,
              discount: 0,
              net: 36000,
              cost: 29500,
            },
          ]);
      }
      return json(404, { code: "PGRST202", message: `no function ${fn}` });
    }
    return json(404, { message: "not faked" });
  });

  await page.goto("/office");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct-horse");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByTestId("office-report")).toBeVisible();
  expect(calls.find((c) => c.fn === "office_report")?.body.p_from).toBeTruthy();
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
  await page.screenshot({ path: test.info().outputPath("office-year.png"), fullPage: true });

  const download = page.waitForEvent("download");
  await page.getByTestId("csv-lines").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^sale-lines_.*\.csv$/);
  const text = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(text).toString()).toContain('"Liempo","Pork","kg","1.000","360.00"');
});

test("cashiers are told the Back Office is for owners and managers", async ({ page }) => {
  await page.route("http://supabase.fake.test/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers });
    const now = Math.floor(Date.now() / 1000);
    const body =
      url.pathname === "/auth/v1/token"
        ? {
            access_token: "t",
            token_type: "bearer",
            expires_in: 3600,
            expires_at: now + 3600,
            refresh_token: "r",
            user: {
              id: userId,
              aud: "authenticated",
              role: "authenticated",
              email: "ana@example.test",
              app_metadata: {},
              user_metadata: {},
              created_at: new Date().toISOString(),
            },
          }
        : [
            {
              user_id: userId,
              store_id: "s",
              store_name: "The Local Butcher",
              display_name: "Ana",
              role: "cashier",
              has_store: true,
            },
          ];
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
  });
  await page.goto("/office");
  await page.getByLabel("Email").fill("ana@example.test");
  await page.getByLabel("Password").fill("pw");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Ana, the Back Office is for owner and manager accounts.")).toBeVisible();
});
