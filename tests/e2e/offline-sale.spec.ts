import { expect, test } from "@playwright/test";
import { addItem, loadSamples, startPos, waitForServiceWorker } from "./helpers";

/**
 * Phase 1 milestone: a real cash sale can be completed and recovered after
 * an app restart while the internet is disconnected.
 */
test("offline cash sale survives an app restart", async ({ page, context }) => {
  await startPos(page);
  await loadSamples(page);
  await waitForServiceWorker(page);

  // Cut the network, then reload: the POS must open from the device cache.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("reachability")).toHaveText("Offline");
  await expect(page.getByTestId("product-tile").first()).toBeVisible();

  await addItem(page, "Liempo (Pork Belly)", "1.25"); // ₱350/kg × 1.25 = ₱437.50
  await addItem(page, "Whole Chicken", "2"); // ₱195 × 2 = ₱390.00
  await expect(page.getByTestId("cart-total")).toHaveText("₱827.50");

  await page.getByTestId("checkout").click();
  await page.getByTestId("tendered-input").fill("1000");
  await expect(page.getByTestId("change-amount")).toHaveText("₱172.50");
  await page.getByTestId("confirm-sale").click();
  await expect(page.getByTestId("sale-saved")).toBeVisible();
  const receipt = page.getByTestId("receipt-preview");
  await expect(receipt).toContainText("NON-FISCAL TEST RECEIPT");
  await expect(receipt).toContainText("1.250 kg @ ₱350.00/kg");
  await expect(receipt).toContainText("₱827.50");
  await expect(receipt).toContainText("₱172.50");
  const receiptNo = (await receipt.textContent())!.match(/[A-Z0-9]{4}-\d{6}/)![0];

  // "Restart" the app: close the page and open a new one, still offline.
  await page.close();
  const again = await context.newPage();
  await again.goto("/pos/history");
  await expect(again.getByTestId("reachability")).toHaveText("Offline");
  const row = again.getByTestId("history-row").filter({ hasText: receiptNo });
  await expect(row).toContainText("₱827.50");
  await expect(row).toContainText("Not synced");
  await expect(again.getByTestId("pending-count")).toContainText("1 unsynced");

  // Reprint from history does not create another sale.
  await row.click();
  await again.evaluate(() => (window.print = () => {}));
  await again.getByTestId("print-receipt").click();
  await expect(again.getByTestId("receipt-preview")).toContainText("REPRINT");
  await again.keyboard.press("Escape");
  await expect(again.getByTestId("history-row")).toHaveCount(1);

  // Stock was reduced through the ledger.
  await again.getByRole("link", { name: "Products" }).click();
  await expect(again.getByTestId("product-row").filter({ hasText: "Liempo" })).toContainText("7.750 kg in stock");
  await expect(again.getByTestId("product-row").filter({ hasText: "Whole Chicken" })).toContainText("13 pcs in stock");

  // The inventory screen also opens offline (straight from the device cache).
  const inv = await context.newPage();
  await inv.goto("/pos/inventory?tab=receive");
  await expect(inv.getByTestId("reachability")).toHaveText("Offline");
  await expect(inv.getByText("Inventory shows costs, suppliers and profit")).toBeVisible();

  // So do members: a card can be registered without internet.
  await inv.goto("/pos/members");
  await expect(inv.getByTestId("register-member")).toBeVisible();

  await context.setOffline(false);
});

test("@phone collapsible cart and cash sale on a phone", async ({ page }) => {
  await startPos(page, "Ben");
  await loadSamples(page);
  await addItem(page, "Kasim", "0.5"); // ₱170.00
  await page.getByTestId("open-cart").click();
  await expect(page.getByTestId("cart-total")).toHaveText("₱170.00");
  await page.getByTestId("checkout").click();
  await page.getByRole("button", { name: "Exact" }).click();
  await expect(page.getByTestId("change-amount")).toHaveText("₱0.00");
  await page.getByTestId("confirm-sale").click();
  await expect(page.getByTestId("sale-saved")).toBeVisible();
});
