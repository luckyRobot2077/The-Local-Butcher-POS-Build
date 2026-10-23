import { expect, test } from "@playwright/test";
import { loadSamples, setManagerPin, startPos } from "./helpers";

test("five wrong manager PINs lock approval for 5 minutes, even after a reload", async ({ page }) => {
  await startPos(page);
  await loadSamples(page);
  await page.getByRole("link", { name: "Products" }).click();
  await page.getByTestId("add-product").click();
  await setManagerPin(page, "1357");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: /Manager · Lock/ }).click();

  await page.getByTestId("add-product").click();
  for (let i = 0; i < 4; i++) {
    await page.getByLabel("Manager PIN").fill("0000");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Wrong PIN.")).toBeVisible();
  }
  await page.getByLabel("Manager PIN").fill("0000");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Too many wrong tries. Try again in 5 minutes.")).toBeVisible();

  // The right PIN is refused while locked, and a reload does not reset the lock.
  await page.reload();
  await page.getByTestId("add-product").click();
  await page.getByLabel("Manager PIN").fill("1357");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Too many wrong tries\. Try again in [45] minutes\./)).toBeVisible();
  await expect(page.getByTestId("save-product")).toHaveCount(0);
});
