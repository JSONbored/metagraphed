import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import {
  ROUTES,
  THEMES,
  VIEWPORT,
  allowedFamilies,
  allowedSizes,
  TRACKING_NORMAL,
  RADII,
  DOT_MAX_PX,
  CONTRACT_RADIUS_PX,
} from "./token-inventory.config.ts";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.ts";
import { gotoThroughRestart } from "./server-restart.ts";

// The design contract as a gate (#11605). For every route × theme, sweep the
// computed styles under <main> and assert the counts the contract fixes:
//
//   families ⊆ allowed(route)      sizes ⊆ {10,11,13,16,28,40(,64)}
//   letter-spacing ∈ {normal, th}  radii ⊆ {0, 4px, 50% on dots}
//   pills == 0                     resting box-shadow == none (tooltips excepted)
//
// This is deliberately NOT a baseline diff. The token layer is one file; if a
// route regresses one of these counts, the fix is in that file, not in a
// snapshot. Failures print the offending histogram so the value is findable.

type Histogram = Record<string, number>;
type Sweep = {
  families: Histogram;
  sizes: Histogram;
  tracking: Histogram;
  radii: Histogram;
  pills: string[];
  shadows: string[];
  /** Text inside <thead th> that is not 10px / 600 / uppercase. */
  thOffenders: string[];
  textNodes: number;
};

const THEME_STORAGE_KEY = "mg-theme";

function sweepMain([dotMax, contractRadiusPx]: [number, number]): Sweep {
  const root = document.querySelector("main") ?? document.body;
  const families: Histogram = {};
  const sizes: Histogram = {};
  const tracking: Histogram = {};
  const radii: Histogram = {};
  const pills: string[] = [];
  const shadows: string[] = [];
  const thOffenders: string[] = [];
  let textNodes = 0;
  const describe = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .join(".")}`;
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
    );
    if (hasText) {
      textNodes++;
      const fam = cs.fontFamily.split(",")[0]!.replace(/["']/g, "").trim();
      families[fam] = (families[fam] ?? 0) + 1;
      sizes[cs.fontSize] = (sizes[cs.fontSize] ?? 0) + 1;
      // <th> carries the one allowed tracking; its descendants inherit it.
      const isTh = el.closest("thead th") != null;
      const ls = isTh ? "th" : cs.letterSpacing;
      tracking[ls] = (tracking[ls] ?? 0) + 1;
      // The header cell is the one place uppercase + tracking exist, and it
      // is 10px / 600 there -- a sort button or span inside it included.
      if (
        isTh &&
        (cs.fontSize !== "10px" || cs.fontWeight !== "600" || cs.textTransform !== "uppercase")
      ) {
        thOffenders.push(`${describe(el)} → ${cs.fontSize}/${cs.fontWeight}/${cs.textTransform}`);
      }
    }
    const r = cs.borderRadius;
    if (r !== "0px") {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        // Invisible helper; ignore.
      } else {
        const px = parseFloat(r);
        // "Round" means the corners meet: a percentage, rounded-full's 9999px,
        // or a pixel radius of at least half the short side. The contract's
        // own 4px is exempt -- a 4px-radius progress bar 3px tall is the one
        // radius the contract allows, not a pill.
        const round =
          r.includes("%") ||
          px >= 999 ||
          (px > contractRadiusPx && px >= Math.min(rect.width, rect.height) / 2);
        const isDot = rect.width <= dotMax && rect.height <= dotMax;
        if (round && isDot) {
          radii["50%"] = (radii["50%"] ?? 0) + 1;
        } else {
          radii[r] = (radii[r] ?? 0) + 1;
          if (round && rect.width > rect.height + 1 && rect.width > dotMax) {
            pills.push(describe(el));
          }
        }
      }
    }
    if (cs.boxShadow !== "none") {
      const tooltip = el.closest('[role="tooltip"], [data-mg-tooltip]');
      // Inset hairline "shadows" are borders in disguise; allow 0-blur insets.
      const insetOnly = cs.boxShadow
        .split(/,(?![^(]*\))/)
        .every((part) => /inset/.test(part) && /\b0px\s+0px\b/.test(part.replace(/inset/, "")));
      if (!tooltip && !insetOnly) shadows.push(`${describe(el)} → ${cs.boxShadow}`);
    }
  }
  return { families, sizes, tracking, radii, pills, shadows, thOffenders, textNodes };
}

for (const route of ROUTES) {
  test.describe(route, () => {
    const harPath = harPathForRoute(route);
    if (!existsSync(harPath)) {
      throw new Error(
        `Missing HAR fixture for ${route}: ${harPath}. Run ` +
          `\`npm run test:e2e:record-har --workspace=apps/ui\` against a live dev server first.`,
      );
    }
    for (const theme of THEMES) {
      test(`token inventory holds in ${theme}`, async ({ page }) => {
        await page.setViewportSize(VIEWPORT);
        await page.addInitScript(
          ([key, value]) => {
            try {
              window.localStorage.setItem(key as string, value as string);
            } catch {
              /* storage blocked */
            }
          },
          [THEME_STORAGE_KEY, theme],
        );
        await page.routeFromHAR(harPath, {
          url: "**/api.metagraph.sh/**",
          notFound: "fallback",
          update: false,
        });
        for (const pattern of DATED_ENDPOINT_PATTERNS) {
          const fixture = findHarFixture(harPath, pattern);
          if (fixture) {
            await page.route(pattern, (route) => route.fulfill(fixture));
          }
        }
        await gotoThroughRestart(page, route);
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(300);

        const s = await page.evaluate(sweepMain, [DOT_MAX_PX, CONTRACT_RADIUS_PX] as [
          number,
          number,
        ]);
        const pretty = JSON.stringify(s, null, 1);
        expect(s.textNodes, `no text rendered on ${route}`).toBeGreaterThan(0);

        const families = Object.keys(s.families);
        const allowed = allowedFamilies(route);
        expect(
          families.filter((f) => !allowed.includes(f)),
          `font families outside the contract on ${route} (${theme}):\n${pretty}`,
        ).toEqual([]);

        const sizes = Object.keys(s.sizes);
        const okSizes = allowedSizes(route);
        expect(
          sizes.filter((v) => !okSizes.has(v)),
          `font sizes outside the contract on ${route} (${theme}):\n${pretty}`,
        ).toEqual([]);

        expect(
          Object.keys(s.tracking).filter((v) => v !== TRACKING_NORMAL && v !== "th"),
          `letter-spacing outside the contract on ${route} (${theme}):\n${pretty}`,
        ).toEqual([]);

        expect(
          Object.keys(s.radii).filter((v) => !RADII.has(v)),
          `border radii outside the contract on ${route} (${theme}):\n${pretty}`,
        ).toEqual([]);

        expect(s.pills, `pill-shaped elements on ${route} (${theme})`).toEqual([]);
        expect(s.shadows, `resting box-shadows on ${route} (${theme})`).toEqual([]);
        expect(
          s.thOffenders,
          `table-header text that is not 10px / 600 / uppercase on ${route} (${theme})`,
        ).toEqual([]);
      });
    }
  });
}
