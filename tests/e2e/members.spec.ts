import { expect, test } from "@playwright/test";
import { addItem, capturePrintFrame, loadSamples, pdfPages, setManagerPin, startPos } from "./helpers";

test("discount program and member card: register, attach to a sale, see history", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);

  // Owner sets up a members-only program (needs the manager PIN).
  await page.getByRole("link", { name: "Members" }).click();
  await page.getByRole("tab", { name: "Discount programs" }).click();
  await page.getByTestId("new-program").click();
  await setManagerPin(page);
  await page.getByTestId("program-name").fill("Member 10%");
  await page.getByTestId("program-value").fill("10");
  await page.getByTestId("program-members-only").check();
  await page.getByTestId("program-save").click();
  await expect(page.getByTestId("program-list")).toContainText("Member 10%");
  await expect(page.getByTestId("program-list")).toContainText("Running");

  // Register a member: name, age, gender, mobile, consent.
  await page.getByRole("tab", { name: "Members" }).click();
  await page.getByTestId("register-member").click();
  await page.getByTestId("member-name").fill("Maria Santos");
  await page.getByTestId("member-age").fill("38");
  await page.getByTestId("member-gender").selectOption("female");
  await page.getByTestId("member-contact").fill("0917 123 4567");
  await page.getByTestId("member-promo").check();
  await page.getByTestId("member-delivery").check();
  await page.getByTestId("member-address").fill("12 Mabini St, Brgy San Isidro, Quezon City");
  await page.getByTestId("member-landmark").fill("green gate");
  await page.getByTestId("member-save").click();
  await expect(page.getByTestId("member-privacy").locator("..")).toContainText("must agree");
  await page.getByTestId("member-privacy").check();
  await page.getByTestId("member-save").click();

  // The card with its QR code is generated straight away.
  await expect(page.getByTestId("member-card")).toBeVisible();
  const info = page.getByTestId("member-info");
  const memberNo = (await info.textContent())!.match(/M-[A-Z0-9]{4}-\d{4}/)![0];
  await expect(info).toContainText("0917 123 4567");
  await expect(page.getByTestId("member-delivery-info")).toContainText("12 Mabini St");
  await expect(page.getByTestId("member-delivery-info")).toContainText("Landmark: green gate");
  await expect(page.getByTestId("member-summary")).toContainText("0 visits");

  // Printing uses a frame holding only the card, so it comes out as one card-size page.
  await capturePrintFrame(page);
  await page.getByTestId("print-card").click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", /size: 85\.6mm 54mm/);
  const printPage = await page.context().newPage();
  await printPage.setContent((await page.locator("body").getAttribute("data-printed"))!);
  const pdf = pdfPages(await printPage.pdf({ preferCSSPageSize: true }));
  await printPage.close();
  // One page, 85.6 × 54 mm in points.
  expect(pdf.count).toBe(1);
  expect(pdf.width).toBeCloseTo(242.6, 0);
  expect(pdf.height).toBeCloseTo(153.1, 0);
  await page.keyboard.press("Escape");

  // At the counter the program waits for a member card.
  await page.getByRole("link", { name: "Sell" }).click();
  await addItem(page, "Liempo (Pork Belly)", "1");
  await page.getByTestId("program-select").selectOption({ label: "Member 10% (10% off · whole sale · members)" });
  await expect(page.getByTestId("program-note")).toContainText("for members");
  await expect(page.getByTestId("cart-total")).toHaveText("₱350.00");

  // A USB scanner (or typing) enters the member number and Enter.
  await page.getByTestId("add-member").click();
  await page.getByTestId("member-search").fill(memberNo.toLowerCase());
  await page.getByTestId("member-search").press("Enter");
  await expect(page.getByTestId("sale-member")).toContainText("Maria Santos");
  await expect(page.getByTestId("member-visits")).toHaveText("First visit");
  await expect(page.getByTestId("program-note")).toHaveCount(0);
  await expect(page.getByTestId("cart-total")).toHaveText("₱315.00");

  // No manager PIN needed for a program discount.
  await page.getByTestId("checkout").click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("confirm-sale").click();
  const receipt = page.getByTestId("receipt-preview");
  await expect(receipt).toContainText(memberNo);
  await expect(receipt).toContainText("Member 10% 10% off");
  await page.getByTestId("new-sale").click();

  // The purchase is in the member's history.
  await page.getByRole("link", { name: "Members" }).click();
  await page.getByTestId("member-list").getByText("Maria Santos").click();
  await expect(page.getByTestId("member-summary")).toContainText("1 visit · ₱315.00");

  // Next time at the counter, the cashier sees this is the member's second visit.
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Sell" }).click();
  await page.getByTestId("add-member").click();
  await page.getByTestId("member-search").fill(memberNo);
  await page.getByTestId("member-search").press("Enter");
  await expect(page.getByTestId("member-visits")).toContainText("Visit #2 · last came");
  await page.getByRole("link", { name: "Members" }).click();

  // Insights (manager) count the member sale.
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Insights" }).click();
  await expect(page.getByTestId("insight-tiles")).toContainText("1 of 1");
  await expect(page.getByTestId("export-contacts")).toContainText("Export 1 promo contact");
});
