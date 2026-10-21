import { expect, type Page } from "@playwright/test";

export async function startPos(page: Page, cashier = "Ana") {
  await page.goto("/pos");
  await page.getByLabel("Cashier name").fill(cashier);
  await page.getByRole("button", { name: "Start selling" }).click();
  await expect(page.getByTestId("cashier-chip")).toContainText(cashier);
}

export async function loadSamples(page: Page) {
  await page.getByTestId("load-samples").click();
  await expect(page.getByTestId("load-samples")).toHaveCount(0);
  await expect(page.getByTestId("product-tile")).toHaveCount(16);
}

export async function waitForServiceWorker(page: Page) {
  await page.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg?.active && reg.active.state === "activated";
    },
    undefined,
    { timeout: 30_000 },
  );
}

export async function addItem(page: Page, name: string, qty: string) {
  await page.getByTestId("product-tile").filter({ hasText: name }).click();
  await page.getByTestId("qty-input").fill(qty);
  await page.getByTestId("qty-confirm").click();
}

export async function setManagerPin(page: Page, pin = "2468") {
  await expect(page.getByRole("heading", { name: "Set a manager PIN" })).toBeVisible();
  await page.getByLabel("New PIN").fill(pin);
  await page.getByLabel("Repeat PIN").fill(pin);
  await page.getByRole("button", { name: "Save PIN" }).click();
}
