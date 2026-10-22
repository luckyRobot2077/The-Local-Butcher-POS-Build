import { expect, type Page } from "@playwright/test";

export async function startPos(page: Page, cashier = "Ana") {
  await page.goto("/pos");
  await page.getByLabel("Cashier name").fill(cashier);
  await page.getByRole("button", { name: "Start selling" }).click();
  await expect(page.getByTestId("cashier-chip")).toContainText(cashier);
}

export async function loadSamples(page: Page, openingFloat = "1000") {
  await page.getByTestId("load-samples").click();
  await expect(page.getByTestId("load-samples")).toHaveCount(0);
  await expect(page.getByTestId("product-tile")).toHaveCount(16);
  await startShift(page, openingFloat);
}

/** Selling waits for a shift: the starting cash in the drawer. */
export async function startShift(page: Page, openingFloat = "1000") {
  const dialog = page.getByRole("dialog", { name: "Start a shift" });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("opening-float").fill(openingFloat);
  await dialog.getByTestId("open-shift").click();
  await expect(dialog).toBeHidden();
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

/**
 * Notes the page each print sends to its hidden frame in body[data-printed].
 * Headless Chrome finishes "printing" at once and the frame is removed, so
 * it is recorded as it is added.
 */
export async function capturePrintFrame(page: Page) {
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLIFrameElement && "printFrame" in n.dataset)
            document.body.dataset.printed = n.getAttribute("srcdoc") ?? "";
    }).observe(document.body, { childList: true });
  });
}

/** Page count and first page size (points) of a PDF made by page.pdf(). */
export function pdfPages(pdf: Buffer) {
  const text = pdf.toString("latin1");
  const box = text.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/)!;
  return { count: text.match(/\/Type\s*\/Page\b/g)?.length ?? 0, width: Number(box[1]), height: Number(box[2]) };
}
