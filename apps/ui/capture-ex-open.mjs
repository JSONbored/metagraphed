import { chromium } from "playwright";
import path from "path";
import fs from "fs";

const OUT = "D:/Bittensor/SN74/Peter/metagraphed-screenshots-tmp";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
await page.addInitScript(() => localStorage.setItem("mg-theme", "light"));
await page.goto("http://127.0.0.1:8100/extrinsics", {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /Filters/i }).click();
await page.waitForTimeout(400);
const bar = page.locator(".sticky.top-nav").first();
await bar.scrollIntoViewIfNeeded();
const box = await bar.boundingBox();
const file = path.join(OUT, "verify-extrinsics-filters-open.png");
if (box) {
  await page.screenshot({
    path: file,
    clip: {
      x: 0,
      y: Math.max(0, box.y - 4),
      width: 375,
      height: Math.min(320, box.height + 16),
    },
  });
}
console.log("wrote", file, "h=", box?.height);
await browser.close();
