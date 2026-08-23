import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import {
  ROUTES,
  THEMES,
  VIEWPORTS,
  allowedFamilies,
  allowedSizes,
  TRACKING_NORMAL,
  RADII,
  DOT_MAX_PX,
  CONTRACT_RADIUS_PX,
  MAX_SECTIONS_PER_ROUTE,
  SPECIMEN_ROUTES,
} from "./token-inventory.config.ts";
import { NO_API_ROUTES } from "./overflow-check.config.ts";
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
  /** Text inside a data table's <thead th> that is not 10px / 600 / uppercase. */
  thOffenders: string[];
  /** Text inside a compare ledger's <thead th> that is not 13px / 600 sentence case. */
  compareHeadOffenders: string[];
  /** `section.mg-section` count -- the page-shape rule (#11604). */
  sections: number;
  /** Sections holding more than one table taller than 900px. */
  stackedTables: string[];
  /** Elements still carrying a class the v2 purge deleted (#11628). */
  deletedClasses: string[];
  /** Sections showing the same ranked list twice (#11683). */
  repeatedLegends: string[];
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
  const compareHeadOffenders: string[] = [];
  const stackedTables: string[] = [];
  const repeatedLegends: string[] = [];
  const deletedClasses: string[] = [];
  // Every class the v2 rebuild deleted. A page carrying one is either a stale
  // component that survived a rebase or a hand-rolled copy of a primitive; both
  // are the legacy grammar coming back, and neither shows up in a type error.
  const DELETED = [
    "mg-quick-tile",
    "mg-reveal",
    "mg-scanline",
    "mg-metric-tile",
    "mg-dot-grid",
    "mg-leaderboard",
    "mg-chip-rail",
    "mg-glyph-rule",
    "mg-section-rule",
    "mg-display-tight",
    "mg-fade-in",
    "mg-route-enter",
    "mg-row-flash",
    "mg-ticker",
    "mg-mega-",
    "mg-kpi-strip",
    "mg-hero-slab",
    "mg-hero-caption",
    "mg-accent-band",
    "mg-anchor-btn",
    "mg-hover-lift",
    "mg-row-hover",
    "mg-divider",
    "mg-rule",
    "mg-chip",
    "mg-value-pulse",
    "mg-skel-crossfade",
    "mg-query-shell",
    "mg-ghost-trigger",
    "mg-refreshing",
    "mg-actions",
  ];
  let textNodes = 0;
  const describeEl = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .join(".")}`;
  const sectionEls = [...root.querySelectorAll<HTMLElement>("section.mg-section")];
  const sections = sectionEls.length;
  // Per SECTION, not per page. Three tall tables in three sections are three
  // answers to three questions, which is what sectioning is for; two in ONE
  // section is the data wall -- the reader cannot see the second without
  // losing the first, and nothing on screen says why they are both there.
  for (const section of sectionEls) {
    const tall = [...section.querySelectorAll<HTMLElement>("table")].filter(
      (t) => t.getBoundingClientRect().height > 900,
    );
    if (tall.length > 1) {
      stackedTables.push(`${describeEl(section)} holds ${tall.length} tables over 900px`);
    }
    // The same ranked list rendered twice in one section. `CompositionBreakdown`
    // OWNS a `RankGrid` legend, so a page that also passes one into
    // `AnalyticsSection`'s `legend` slot prints the identical rows underneath
    // itself -- which /validators and /chain both did, 11 and 9 rows, on every
    // viewport, unnoticed because at 4 columns the two blocks read as one long
    // list. Compared on normalised text: the two DOM subtrees differ in
    // whitespace, so a raw comparison misses it.
    const signatures = [...section.querySelectorAll(".mg-rank-grid")].map((grid) =>
      [...grid.querySelectorAll(".mg-rank-grid-row")]
        .map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim())
        .join("|"),
    );
    const distinct = new Set(signatures.filter(Boolean));
    if (distinct.size < signatures.filter(Boolean).length) {
      repeatedLegends.push(`${describeEl(section)} renders the same ranked list twice`);
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const cs = getComputedStyle(el);
    for (const cls of String(el.className || "").split(/\s+/)) {
      // `mg-chip` matches exactly; the `mg-mega-` entry is a prefix, so both
      // forms are checked rather than only one.
      if (!cls) continue;
      if (DELETED.some((d) => (d.endsWith("-") ? cls.startsWith(d) : cls === d))) {
        deletedClasses.push(`${cls} on ${describeEl(el)}`);
      }
    }
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
      //
      // A compare ledger's column header is not a column LABEL: it is the
      // entity being compared, and a name set at 10px uppercase would be
      // unreadable. It carries its own contract, checked just below.
      const inCompare = el.closest("[data-mg-compare]") != null;
      if (
        isTh &&
        !inCompare &&
        (cs.fontSize !== "10px" || cs.fontWeight !== "600" || cs.textTransform !== "uppercase")
      ) {
        thOffenders.push(`${describeEl(el)} → ${cs.fontSize}/${cs.fontWeight}/${cs.textTransform}`);
      }
      // The ledger's own rule: the entity name reads as a name -- 13px, 600,
      // never uppercased -- and its qualifier is the 11px muted line. The
      // visually hidden label for the metric column is exempt.
      if (isTh && inCompare && !el.closest(".sr-only") && !["13px", "11px"].includes(cs.fontSize)) {
        compareHeadOffenders.push(
          `${describeEl(el)} → ${cs.fontSize}/${cs.fontWeight}/${cs.textTransform}`,
        );
      }
      if (isTh && inCompare && cs.textTransform === "uppercase" && !el.closest(".sr-only")) {
        compareHeadOffenders.push(`${describeEl(el)} → uppercased entity name`);
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
            pills.push(describeEl(el));
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
      if (!tooltip && !insetOnly) shadows.push(`${describeEl(el)} → ${cs.boxShadow}`);
    }
  }
  return {
    families,
    sizes,
    tracking,
    radii,
    pills,
    shadows,
    thOffenders,
    compareHeadOffenders,
    sections,
    stackedTables,
    deletedClasses,
    repeatedLegends,
    textNodes,
  };
}

for (const route of ROUTES) {
  test.describe(route, () => {
    const harPath = harPathForRoute(route);
    const needsFixture = !NO_API_ROUTES.has(route);
    if (needsFixture && !existsSync(harPath)) {
      throw new Error(
        `Missing HAR fixture for ${route}: ${harPath}. Run ` +
          `\`npm run test:e2e:record-har --workspace=apps/ui\` against a live dev server first.`,
      );
    }
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        test(`token inventory holds at ${viewport.name} in ${theme}`, async ({ page }) => {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
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
          if (needsFixture) {
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
            `font families outside the contract on ${route} (${viewport.name}, ${theme}):\n${pretty}`,
          ).toEqual([]);

          const sizes = Object.keys(s.sizes);
          const okSizes = allowedSizes(route);
          expect(
            sizes.filter((v) => !okSizes.has(v)),
            `font sizes outside the contract on ${route} (${viewport.name}, ${theme}):\n${pretty}`,
          ).toEqual([]);

          expect(
            Object.keys(s.tracking).filter((v) => v !== TRACKING_NORMAL && v !== "th"),
            `letter-spacing outside the contract on ${route} (${viewport.name}, ${theme}):\n${pretty}`,
          ).toEqual([]);

          expect(
            Object.keys(s.radii).filter((v) => !RADII.has(v)),
            `border radii outside the contract on ${route} (${viewport.name}, ${theme}):\n${pretty}`,
          ).toEqual([]);

          expect(s.pills, `pill-shaped elements on ${route} (${viewport.name}, ${theme})`).toEqual(
            [],
          );
          expect(s.shadows, `resting box-shadows on ${route} (${viewport.name}, ${theme})`).toEqual(
            [],
          );
          expect(
            s.thOffenders,
            `table-header text that is not 10px / 600 / uppercase on ${route} (${viewport.name}, ${theme})`,
          ).toEqual([]);

          expect(
            s.compareHeadOffenders,
            `compare-ledger header text that is not a 13px/11px sentence-case name on ${route} (${viewport.name}, ${theme})`,
          ).toEqual([]);

          // The page-shape rule (#11604): at most seven sections, because a page
          // that answers eight questions is two pages. `AnalyticsPage` throws on
          // this in development, but a route that mounts its sections by hand --
          // /design/primitives does, deliberately -- has no runtime guard, and
          // neither does a page whose eighth section only appears with data.
          if (!(route in SPECIMEN_ROUTES)) {
            expect(
              s.sections,
              `more than seven sections on ${route} (${viewport.name}, ${theme}) -- see the page-shape rule`,
            ).toBeLessThanOrEqual(MAX_SECTIONS_PER_ROUTE);
          }

          // One tall table per section. Two stacked inside one section is the
          // data wall that sectioning and `LoadMore` exist to prevent.
          if (!(route in SPECIMEN_ROUTES)) {
            expect(
              s.stackedTables,
              `a section holding more than one table taller than 900px on ${route} (${viewport.name}, ${theme})`,
            ).toEqual([]);
          }

          // A class the purge deleted, rendered by a live page: a stale component
          // survived a rebase, or someone hand-rolled a primitive.
          expect(
            s.deletedClasses,
            `classes deleted by the v2 purge still rendering on ${route} (${viewport.name}, ${theme})`,
          ).toEqual([]);
        });
      }
    }
  });
}
