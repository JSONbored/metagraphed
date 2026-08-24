import { chromium } from "playwright";
import { harPathForRoute } from "../har-path.ts";
const r = process.env.ROUTE;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
const p = await ctx.newPage();
await p.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, ["mg-theme", "dark"]);
try { await p.routeFromHAR(harPathForRoute(r), { url: "**/api.metagraph.sh/**", notFound: "fallback", update: false }); } catch {}
await p.goto("http://127.0.0.1:8080" + r, { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForLoadState("networkidle").catch(() => {});
await p.waitForTimeout(1200);
console.log(JSON.stringify(await p.evaluate(() => {
  const t = document.querySelector(".mg-dt table");
  const dt = document.querySelector(".mg-dt");
  const th = t.querySelector("thead th");
  const tr = t.querySelector("tbody tr");
  const c = (el) => { const s = getComputedStyle(el); return { font: s.fontFamily.split(",")[0].replace(/"/g,""), size: s.fontSize, weight: s.fontWeight, ls: s.letterSpacing, color: s.color, pad: s.padding, align: s.textAlign, tt: s.textTransform }; };
  return {
    card: { bg: getComputedStyle(dt).backgroundColor, border: getComputedStyle(dt).border, radius: getComputedStyle(dt).borderRadius },
    pageBg: getComputedStyle(document.body).backgroundColor,
    th: { ...c(th), h: Math.round(th.getBoundingClientRect().height), html: th.innerHTML.slice(0,200) },
    rowH: Math.round(tr.getBoundingClientRect().height),
    rowBorder: getComputedStyle(tr.querySelector("td")).borderBottom,
    tds: [...tr.querySelectorAll("td")].map((d) => ({ txt: d.innerText.replace(/\s+/g," ").trim().slice(0,16), ...c(d) })),
  };
}), null, 1));
await b.close();
