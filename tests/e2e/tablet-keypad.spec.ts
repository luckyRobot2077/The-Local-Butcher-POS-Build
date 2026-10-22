import { expect, test, type Locator } from "@playwright/test";
import { addItem, loadSamples, setManagerPin, startPos } from "./helpers";

async function tap(keypad: Locator, keys: string) {
  for (const k of keys) await keypad.locator(`[data-key="${k}"]`).click();
}

/** Tablet selling without the system keyboard: the sell-screen numpad and the keypads in dialogs. */
test("numpad on the sell screen adds weights, peso amounts and pieces in one tap", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);
  const numpad = page.getByTestId("quick-keypad");
  const tile = (name: string) => page.getByTestId("product-tile").filter({ hasText: name });
  const lines = page.getByTestId("cart-lines").locator("li");

  // 0.5 kg of liempo at ₱350/kg.
  await tap(numpad, ".5");
  await expect(page.getByTestId("quick-entry-value")).toHaveText("0.5 kg / pcs");
  await tile("Liempo").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("quick-entry-message")).toHaveText("Added 0.500 kg Liempo (Pork Belly)");
  await expect(lines.first()).toContainText("₱175.00");

  // ₱100 worth of liver.
  await page.getByRole("radio", { name: "₱ amount" }).click();
  await tap(numpad, "100");
  await tile("Pork Liver").click();
  await expect(page.getByTestId("quick-entry-message")).toHaveText("Added ₱100.00 of Pork Liver");

  // A peso amount does not apply to a per-piece product; nothing is added and the number stays.
  await tap(numpad, "2");
  await tile("Whole Chicken").click();
  await expect(page.getByTestId("quick-entry-message")).toContainText("sold by the piece");
  await expect(page.getByTestId("quick-entry-value")).toHaveText("₱2");
  await page.getByRole("radio", { name: "kg / pcs" }).click();
  await tap(numpad, "2");
  await tile("Whole Chicken").click();
  await expect(lines).toHaveCount(3);
  await expect(page.getByTestId("cart-total")).toHaveText("₱665.00");
  await page.screenshot({ path: "test-results/tablet-sell.png" });

  // Held upright, the numpad moves under the sale and keeps the typed number.
  await tap(numpad, "1");
  await page.setViewportSize({ width: 800, height: 1280 });
  await expect(page.getByTestId("quick-entry-value")).toHaveText("1 kg / pcs");
  await page.screenshot({ path: "test-results/tablet-upright.png" });
  await numpad.getByRole("button", { name: "Clear" }).click();
  await page.setViewportSize({ width: 1280, height: 800 });

  // With nothing typed, tapping a product still opens the weight dialog, which has its own keys.
  await tile("Pork Ribs").click();
  const qtyKeys = page.getByRole("dialog").getByTestId("keypad");
  await tap(qtyKeys, "1.25");
  await expect(page.getByTestId("qty-input")).toHaveValue("1.25");
  await page.screenshot({ path: "test-results/tablet-weight.png" });
  await qtyKeys.getByRole("button", { name: "Delete" }).click();
  await tap(qtyKeys, "0");
  await expect(page.getByTestId("qty-amount")).toHaveText("₱324.00"); // 1.20 kg × ₱270;
  await page.getByTestId("qty-confirm").click();

  // Cash tendered on the checkout keypad.
  await page.getByTestId("checkout").click();
  const cash = page.getByTestId("tendered-keypad");
  await tap(cash, "1000");
  await expect(page.getByTestId("tendered-input")).toHaveValue("1000");
  await expect(page.getByTestId("change-amount")).toHaveText("₱11.00");
  await page.screenshot({ path: "test-results/tablet-checkout.png" });
  await page.getByTestId("confirm-sale").click();
  await expect(page.getByTestId("cart-lines").locator("li")).toHaveCount(1); // the empty-cart hint
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("number fields pop up the on-screen keys instead of the tablet keyboard", async ({ page }) => {
    await startPos(page);
    await loadSamples(page);
    await page.getByRole("link", { name: "Products" }).click();
    const liempo = page.locator('[data-testid="product-row"][data-product="Liempo (Pork Belly)"]');
    await liempo.getByTestId("row-price").click();

    // Setting the manager PIN with the pop-up keys.
    await expect(page.getByRole("heading", { name: "Set a manager PIN" })).toBeVisible();
    const popup = page.getByTestId("popup-keypad");
    await expect(page.getByLabel("New PIN")).toHaveAttribute("inputmode", "none");
    await page.getByLabel("New PIN").click();
    await tap(popup, "2468");
    await page.getByLabel("Repeat PIN").click();
    await expect(popup).toHaveCount(1);
    await tap(popup, "2468");
    await popup.getByRole("button", { name: "Done" }).click();
    await expect(popup).toHaveCount(0);
    await page.getByRole("button", { name: "Save PIN" }).click();

    // Then the price itself.
    await liempo.getByTestId("row-price").click();
    await popup.getByRole("button", { name: "Clear" }).click();
    await tap(popup, "365.5");
    await expect(liempo.getByTestId("row-price")).toHaveValue("365.5");
    await popup.getByRole("button", { name: "Done" }).click();
    await liempo.getByTestId("row-reason").fill("Supplier price increase");
    await liempo.getByTestId("row-save").click();
    await expect(liempo.getByTestId("row-price")).toHaveValue("365.50");
  });
});

test("a long discount program name does not push the sale panel off the screen", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);
  await page.getByRole("link", { name: "Members" }).click();
  await page.getByRole("tab", { name: "Discount programs" }).click();
  await page.getByTestId("new-program").click();
  await setManagerPin(page);
  await page.getByTestId("program-name").fill("Suki Saturday members-only whole sale discount");
  await page.getByTestId("program-value").fill("10");
  await page.getByTestId("program-save").click();
  await page.getByRole("link", { name: "Sell" }).click();
  await addItem(page, "Bones", "2");
  for (const [width, height] of [
    [1280, 800],
    [1024, 768],
    [800, 1280],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    if (width < 768) await page.getByTestId("open-cart").click();
    await expect(page.getByTestId("program-select")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `page wider than the screen at ${width}px`).toBe(0);
    const panel = await page.getByRole("complementary", { name: "Current sale" }).boundingBox();
    const checkout = await page.getByTestId("checkout").boundingBox();
    expect(checkout!.x + checkout!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
  }
});
