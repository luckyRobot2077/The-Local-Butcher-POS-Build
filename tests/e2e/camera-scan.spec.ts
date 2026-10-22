import { expect, test } from "@playwright/test";
import { startPos } from "./helpers";
import { writeQrVideo } from "./qr-video";

/**
 * The camera scanner, with Chromium's fake camera playing a video of a
 * member card QR code. The code is for a member this device does not
 * have, so the scan ends at "not found" showing exactly what was read.
 */
const code = "TLBM1:00000000-0000-4000-8000-000000000000";
test.use({
  permissions: ["camera"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${writeQrVideo(code, "unknown-member")}`,
    ],
  },
});

test("reads a member card QR code from the camera", async ({ page }) => {
  await startPos(page);
  await page.getByRole("link", { name: "Members" }).click();
  await page.getByRole("button", { name: "Scan card" }).click();
  await page.getByTestId("scan-camera").click();
  await expect(page.getByTestId("member-not-found")).toContainText(code, { timeout: 20_000 });
});
