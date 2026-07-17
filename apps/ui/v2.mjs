import { chromium } from "playwright";
const b = await chromium.launch();
for (const [route, label] of [
  ["/accounts/not-an-ss58", "invalid account"],
  ["/validators/not-an-ss58", "invalid validator"],
  ["/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5", "VALID account"],
  ["/validators/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5", "VALID validator"],
]) {
  for (const [side, port] of [["before", 8081], ["after", 8080]]) {
    const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://localhost:${port}${route}`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2200);
    const title = await page.title();
    const robots = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "-");
    console.log(`  ${label.padEnd(18)} ${side.padEnd(6)} title="${title.slice(0, 40)}" robots=${robots}`);
    await page.close();
  }
}
await b.close();
