import { expect, test } from "@playwright/test";
import { loadSamples, setManagerPin, startPos } from "./helpers";

test("peso amount is charged exactly, and new categories and periods are there", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);

  // ₱100 of ₱350/kg liempo: charge ₱100.00, cut about 0.286 kg.
  await page.getByTestId("product-tile").filter({ hasText: "Liempo (Pork Belly)" }).click();
  await page.getByRole("radio", { name: "Peso amount" }).click();
  await page.getByTestId("qty-input").fill("100");
  await expect(page.getByTestId("qty-amount")).toHaveText("₱100.00");
  await expect(page.getByTestId("qty-weight")).toHaveText("Cut about 0.286 kg");
  await page.getByTestId("qty-confirm").click();
  await expect(page.getByTestId("cart-total")).toHaveText("₱100.00");
  await page.getByTestId("checkout").click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("confirm-sale").click();
  await expect(page.getByTestId("receipt-preview")).toContainText(/~0\.286 kg @ ₱350\.00\/kg +₱100\.00/);
  await page.getByTestId("new-sale").click();

  // The new categories are offered on the selling screen and product list.
  for (const name of ["Fresh Goods", "Condiments", "Side Dishes"]) {
    await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  }

  // Movement: last year and all history.
  await page.getByRole("link", { name: "Inventory" }).click();
  await setManagerPin(page);
  await page.getByRole("tab", { name: "Movement" }).click();
  await page.getByTestId("period-365").click();
  await expect(page.getByText(/\(365 days\)/)).toBeVisible();
  await page.getByTestId("period-all").click();
  await expect(page.getByText(/\(1 day\)/)).toBeVisible();

  // Starter pictures for products with no photo.
  await page.getByRole("link", { name: "Products" }).click();
  await page.getByTestId("add-pictures").click();
  await expect(page.getByText("Added 16 starter pictures.")).toBeVisible();
  await expect(page.getByTestId("add-pictures")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Pork Ribs" }).first()).toBeVisible();

  // Socials for the member card are kept in the store settings.
  await page.getByRole("link", { name: "Device" }).click();
  await page.getByTestId("social-facebook").fill("fb.com/thelocalbutcherargao");
  await page.getByTestId("social-whatsapp").fill("0917 123 4567");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("social-facebook")).toHaveValue("fb.com/thelocalbutcherargao");
  await expect(page.getByTestId("social-tiktok")).toHaveValue("");
});
