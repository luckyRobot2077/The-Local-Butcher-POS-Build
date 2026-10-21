import path from "node:path";
import { expect, test } from "@playwright/test";
import { addItem, loadSamples, setManagerPin, startPos } from "./helpers";

test("edit photo, description and price inside POS mode with manager PIN", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);

  // Sell one first so we can check the old price is kept.
  await addItem(page, "Liempo (Pork Belly)", "1");
  await page.getByTestId("checkout").click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("confirm-sale").click();
  await page.getByTestId("new-sale").click();

  await page.getByRole("link", { name: "Products" }).click();
  await page.getByTestId("product-row").filter({ hasText: "Liempo" }).click();
  await page.getByTestId("edit-product").click();
  await setManagerPin(page);

  await page.getByTestId("photo-gallery").setInputFiles(path.join(__dirname, "fixtures", "pork-belly.jpg"));
  await expect(page.getByAltText("Product photo preview")).toBeVisible();
  await page.getByTestId("product-description").fill("Skin-on belly, great for lechon kawali.");
  await page.getByTestId("product-price").fill("360");
  await page.getByTestId("save-product").click();
  await expect(page.getByText("Give a reason for the price or cost change.")).toBeVisible();
  await page.getByTestId("price-reason").fill("Supplier price increase");
  await page.getByTestId("save-product").click();

  // Product details show the new price, photo and the price log.
  await expect(page.getByText("Skin-on belly, great for lechon kawali.")).toBeVisible();
  await expect(page.getByText(/price: ₱350\.00 → ₱360\.00/)).toBeVisible();
  await expect(page.getByRole("img", { name: "Liempo (Pork Belly)" }).first()).toBeVisible();

  // Selling screen uses the new price; the earlier sale keeps ₱350.
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Sell" }).click();
  await expect(page.getByTestId("product-tile").filter({ hasText: "Liempo" })).toContainText("₱360.00/kg");
  await page.getByRole("link", { name: "History" }).click();
  await page.getByTestId("history-row").first().click();
  await expect(page.getByTestId("receipt-preview")).toContainText("1.000 kg @ ₱350.00/kg");
});

test("cashier cannot edit prices without the PIN, and big discounts need approval", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);

  // Create the PIN, then lock manager mode again.
  await page.getByRole("link", { name: "Products" }).click();
  await page.getByTestId("add-product").click();
  await setManagerPin(page, "1357");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: /Manager · Lock/ }).click();

  // Wrong PIN refuses editing.
  await page.getByTestId("product-row").filter({ hasText: "Kasim" }).click();
  await page.getByTestId("edit-product").click();
  await page.getByLabel("Manager PIN").fill("0000");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Wrong PIN.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("save-product")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 20% discount is above the default 10% cashier limit.
  await page.getByRole("link", { name: "Sell" }).click();
  await addItem(page, "Whole Chicken", "1");
  await page.getByRole("button", { name: "+ Order discount" }).click();
  await page.getByTestId("discount-value").fill("20");
  await page.getByTestId("discount-reason").fill("Suki");
  await page.getByTestId("discount-apply").click();
  await expect(page.getByRole("heading", { name: "Manager approval" })).toBeVisible();
  await page.getByLabel("Manager PIN").fill("1357");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("cart-total")).toHaveText("₱156.00");
  await page.getByTestId("checkout").click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("confirm-sale").click();
  await expect(page.getByTestId("receipt-preview")).toContainText("Order 20% off");
  await expect(page.getByTestId("receipt-preview")).toContainText("-₱39.00");
});
