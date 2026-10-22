import { expect, test } from "@playwright/test";
import { addItem, setManagerPin, startPos } from "./helpers";

/** A day at the counter: start the shift, sell, open the drawer without a sale, count and close. */
test("shift: starting cash, sale times, no-sale opening with approval, cash count and timeline", async ({ page }) => {
  await startPos(page);
  await page.getByTestId("load-samples").click();

  // Selling waits for the shift and its starting cash.
  const start = page.getByRole("dialog", { name: "Start a shift" });
  await expect(start).toBeVisible();
  await expect(start.getByTestId("open-shift")).toBeDisabled();
  await page.screenshot({ path: "test-results/shift-start.png" });
  await start.getByRole("button", { name: "₱1,000" }).click();
  await start.getByTestId("open-shift").click();
  await expect(start).toBeHidden();

  // A cash sale (₱350) and a GCash sale (₱175).
  await addItem(page, "Liempo", "1");
  await page.getByTestId("checkout").click();
  await page.getByTestId("tendered-input").fill("500");
  await page.getByTestId("confirm-sale").click();
  await page.getByTestId("new-sale").click();
  await addItem(page, "Liempo", "0.5");
  await page.getByTestId("checkout").click();
  await page.getByRole("radio", { name: "GCash" }).click();
  await page.getByTestId("confirm-sale").click();
  await page.getByTestId("new-sale").click();

  // Opening the drawer without a sale needs a reason and the manager.
  await page.getByTestId("shift-button").click();
  const panel = page.getByTestId("shift-panel");
  await expect(panel).toContainText("Started");
  await expect(panel).toContainText("₱350.00");
  await page.getByTestId("no-sale").click();
  await page.getByLabel("Change for a customer").check();
  await page.getByTestId("no-sale-confirm").click();
  await setManagerPin(page);
  await expect(page.getByTestId("no-sale-done")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // Closing: count the drawer; ₱1,000 + ₱350 expected, ₱1,345 counted.
  await page.getByTestId("shift-button").click();
  await page.getByTestId("close-shift").click();
  await page.getByTestId("counted-cash").fill("1345");
  await page.getByTestId("confirm-close-shift").click();
  await expect(page.getByTestId("expected-cash")).toHaveText("₱1,350.00");
  await expect(page.getByTestId("cash-difference")).toHaveText("Short by ₱5.00");
  await page.screenshot({ path: "test-results/shift-closed.png" });
  await page.getByTestId("shift-closed-done").click();

  // The next shift starts before more sales.
  await expect(page.getByRole("dialog", { name: "Start a shift" })).toBeVisible();
  await page.getByTestId("opening-float").fill("0");
  await page.getByTestId("open-shift").click();

  // History → Shifts shows each time stamp in order.
  await page.getByRole("link", { name: "History" }).click();
  await page.getByRole("tab", { name: "Shifts" }).click();
  const rows = page.getByTestId("shift-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Open now");
  await expect(rows.nth(1)).toContainText("Short by ₱5.00");
  await rows.nth(1).click();
  const types = await page
    .getByTestId("timeline-entry")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
  expect(types).toEqual([
    "shift_open",
    "sale_started",
    "sale_paid",
    "sale_started",
    "sale_paid",
    "no_sale",
    "shift_close",
  ]);
  await expect(page.getByTestId("shift-timeline")).toContainText("approved by Manager PIN");
  await page.screenshot({ path: "test-results/shift-timeline.png" });
});
