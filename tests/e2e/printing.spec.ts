import { expect, test } from "@playwright/test";
import { addItem, capturePrintFrame, loadSamples, pdfPages, startPos } from "./helpers";

test("receipt prints on its own 58 mm page with nothing cut off", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);
  await addItem(page, "Liempo (Pork Belly)", "1.25");
  await page.getByTestId("checkout").click();
  await page.getByTestId("tendered-input").fill("1000");
  await page.getByTestId("confirm-sale").click();
  await expect(page.getByTestId("sale-saved")).toBeVisible();

  await capturePrintFrame(page);
  await page.getByTestId("print-receipt").click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", /NON-FISCAL TEST RECEIPT/);
  const html = (await page.locator("body").getAttribute("data-printed"))!;
  expect(html).toContain('src="/brand/logo-receipt.png"');

  // Same origin as the app, so the logo loads as it does in the print frame.
  const printPage = await page.context().newPage();
  await printPage.goto("/api/health");
  await printPage.setContent(html);
  await expect(printPage.locator("img")).toHaveJSProperty("complete", true);
  expect(await printPage.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  // The longest line fits the printable width.
  const fits = await printPage.evaluate(() => {
    const pre = document.querySelector("pre")!;
    return pre.scrollWidth <= pre.clientWidth + 1 && pre.getBoundingClientRect().width <= document.body.clientWidth;
  });
  expect(fits).toBe(true);
  // Sized to the receipt's length, as the app does before printing.
  await printPage.evaluate(() => {
    const mm = Math.ceil((document.body.getBoundingClientRect().height * 25.4) / 96) + 2;
    const style = document.createElement("style");
    style.textContent = `@page { size: 58mm ${mm}mm; margin: 0; }`;
    document.head.appendChild(style);
  });
  const pdf = pdfPages(await printPage.pdf({ preferCSSPageSize: true }));
  await printPage.close();
  expect(pdf.count).toBe(1);
  expect(pdf.width).toBeCloseTo(164.4, 0); // 58 mm
});
