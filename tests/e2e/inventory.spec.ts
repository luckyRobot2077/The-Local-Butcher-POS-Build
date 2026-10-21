import { expect, test } from "@playwright/test";
import { addItem, loadSamples, setManagerPin, startPos } from "./helpers";

/** Manila business date `days` from now, as YYYY-MM-DD. */
function manilaDate(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(d);
}

test("receive a supplier delivery with a batch, see alerts and movement report", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);
  await addItem(page, "Liempo (Pork Belly)", "1");
  await page.getByTestId("checkout").click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("confirm-sale").click();
  await page.getByTestId("new-sale").click();

  await page.getByRole("link", { name: "Inventory" }).click();
  await setManagerPin(page);
  await expect(page.getByTestId("expiry-alerts")).toContainText("No batches near their use-by date.");

  // Receive 10.5 kg of belly at ₱300/kg from a new supplier, use by tomorrow.
  await page.getByRole("tab", { name: "Receive" }).click();
  await page.getByRole("button", { name: "New" }).click();
  await page.getByTestId("supplier-name").fill("Jun's Farm");
  await page.getByTestId("supplier-save").click();
  await expect(page.getByTestId("receive-supplier")).toHaveValue(/.+/);
  const line = page.getByTestId("receive-line").first();
  await line.getByLabel("Product").selectOption({ label: "Liempo (Pork Belly)" });
  await line.getByLabel(/Quantity/).fill("10.5");
  await line.getByLabel(/Cost/).fill("300");
  await line.getByLabel(/Batch/).fill("L-9");
  await line.getByLabel(/Use-by/).fill(manilaDate(1));
  await expect(page.getByTestId("receive-total")).toHaveText("₱3,150.00");
  await page.getByTestId("receive-save").click();

  // It lands in Purchases, unpaid; mark it paid.
  await expect(page.getByTestId("purchase-list")).toContainText("Jun's Farm");
  await expect(page.getByTestId("purchase-list")).toContainText("Not paid");
  await page.getByTestId("purchase-list").getByRole("button").first().click();
  await page.getByTestId("purchase-payment").selectOption("paid");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("purchase-list")).toContainText("Paid");

  // Use-by tomorrow raises a food-safety alert, separate from demand alerts.
  await page.getByRole("tab", { name: "Alerts" }).click();
  await expect(page.getByTestId("expiry-alerts")).toContainText("Liempo (Pork Belly)");
  await expect(page.getByTestId("expiry-alerts")).toContainText("batch L-9");

  // The movement report lists the product with its sale.
  await page.getByRole("tab", { name: "Movement" }).click();
  const row = page.getByTestId("movement-table").getByRole("row").filter({ hasText: "Liempo (Pork Belly)" });
  await expect(row).toContainText("0 days ago");
  await expect(row).toContainText("New / not enough data");

  // Stock went up by 10.5 kg (9 sample − 1 sold + 10.5) and the batch shows on the product.
  await page.getByRole("link", { name: "Products" }).click();
  await page.getByTestId("product-row").filter({ hasText: "Liempo" }).click();
  await expect(page.getByText("18.500 kg").first()).toBeVisible();
  await expect(page.getByTestId("batches-on-hand")).toContainText("Batch L-9");

  // The quick "delivery" adjustment points to the full receiving screen.
  await page.getByRole("button", { name: "Adjust stock" }).click();
  await page.getByRole("link", { name: "Inventory → Receive" }).click();
  await expect(page.getByTestId("receive-save")).toBeVisible();
});
