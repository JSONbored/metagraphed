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
  /** Measure labels the page states more than once (#11693). */
  repeatedMeasures: string[];
  /** Tables wider than the card they sit in (#11696). */
  wideTables: string[];
  /** Peers laid out by one primitive whose heights disagree (#11698). */
  raggedPeers: string[];
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
  const repeatedMeasures: string[] = [];
  const wideTables: string[] = [];
  const raggedPeers: string[] = [];
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
    // list -- and /accounts, which this first MISSED. Compared on each row's
    // ENTITY KEY, not its text: /accounts printed the same eleven accounts
    // twice with two different percent formatters ("9%" against "9.0%"), so a
    // text comparison called them two different lists while a reader saw one
    // account listed twice showing two different numbers for it.
    //
    // It was never ASSERTED, either -- see the expect() this feeds (#11693).
    const grids = [...section.querySelectorAll(".mg-rank-grid")].map(
      (grid) =>
        new Set(
          [...grid.querySelectorAll(".mg-rank-grid-row")].map(
            (row) =>
              row.getAttribute("data-entity") ??
              (row.textContent ?? "").replace(/\s+/g, " ").trim(),
          ),
        ),
    );
    // OVERLAP, not an exact signature. An exact join is one row from useless:
    // a duplicated `CompositionBreakdown` legend differs only in what it calls
    // its residual row ("Other" against "rest"), and that single cell made two
    // otherwise identical eleven-row lists compare as different -- the gate
    // passed on an injected duplicate that a reader sees as the same ten
    // operators printed twice.
    for (let i = 0; i < grids.length; i += 1) {
      for (let j = i + 1; j < grids.length; j += 1) {
        const a = grids[i]!;
        const b = grids[j]!;
        if (a.size === 0 || b.size === 0) continue;
        let shared = 0;
        for (const key of a) if (b.has(key)) shared += 1;
        const overlap = shared / Math.min(a.size, b.size);
        if (overlap >= 0.8) {
          repeatedLegends.push(
            `${describeEl(section)} renders the same ranked list twice ` +
              `(${shared} of ${Math.min(a.size, b.size)} rows shared)`,
          );
        }
      }
    }
  }
  // ONE MEASURE, ONE PLACE (#11693). A labelled scalar -- a `FactStrip` cell or
  // a `FactSentence` chip -- states its label once per page.
  //
  // Five heroes broke it. /validators printed "median take 18.0%" as a chip
  // directly above "Median take 18.0%" as a cell; /validators/{hotkey} did it
  // with four of six numbers; /accounts/{ss58} with four; and the subnet detail
  // page stated "Total stake" in its hero AND in Momentum's legend, reading two
  // different series, so one page said 2.63M α and 2.62M α about one subnet at
  // one moment. That last one is why this compares LABELS and not values: the
  // defect shows up as one label with two numbers, and a value comparison would
  // have called that two different facts.
  const measures = new Map<string, { count: number; values: Set<string> }>();
  const noteMeasure = (label: string, value: string) => {
    const key = label.trim().toLowerCase().replace(/[.:]$/, "");
    if (!key || !value.trim()) return;
    const seen = measures.get(key) ?? { count: 0, values: new Set<string>() };
    seen.count += 1;
    seen.values.add(value.trim());
    measures.set(key, seen);
  };
  // A `FactStrip` cell says which half is which: `<dt>` is the label, `<dd>`
  // the value. Read them rather than splitting the text, so "Alpha price" and
  // "Alpha price 30d ago" stay two labels -- a regex that stops at the first
  // digit collapses them, and the second is a different measure of the same
  // series, which is exactly the shape the fix for this defect takes.
  for (const cell of root.querySelectorAll<HTMLElement>(".mg-fact")) {
    const dt = cell.querySelector("dt");
    const dd = cell.querySelector("dd");
    if (!dt || !dd) continue;
    noteMeasure(
      (dt.textContent ?? "").replace(/\s+/g, " "),
      (dd.textContent ?? "").replace(/\s+/g, " "),
    );
  }
  // A chip is one run of text, so its label is the leading run before the
  // first digit or dash. A chip with no number at all ("unofficial", "open
  // source") is a claim, not a measure, and is skipped.
  for (const chip of root.querySelectorAll<HTMLElement>(".mg-fact-chip")) {
    const text = (chip.textContent ?? "").replace(/\s+/g, " ").trim();
    const match = /^([^0-9\u2014\u2013]*[A-Za-z)])\s*(.+)$/.exec(text);
    if (match) noteMeasure(match[1]!, match[2]!);
  }
  for (const [label, { count, values }] of measures) {
    if (count < 2) continue;
    repeatedMeasures.push(
      `"${label}" stated ${count} times` +
        (values.size > 1 ? ` and they disagree: ${[...values].join(" / ")}` : ""),
    );
  }
  // PEERS LAID OUT BY ONE PRIMITIVE ARE THE SAME HEIGHT.
  //
  // A `FactStrip` cell's label length is DATA, not design -- "Extrinsics
  // 2026-08-22" carries a date, "Candidates awaiting review" is four words --
  // so at 375px one card wrapped, the grid row stretched to the tallest, and
  // the strip came out visibly ragged. Eighteen routes did it, and the
  // instance a reader happened to notice was the eighteenth (#11698).
  //
  // Same shape wherever a primitive lays peers in a row or a grid: a table row
  // whose one wrapping cell had 300 characters was 395px tall beside 56px
  // neighbours. Four pixels of slack, because a border or a sub-pixel rounding
  // difference is not raggedness.
  const PEER_GROUPS: readonly (readonly [string, string])[] = [
    [".mg-facts", ".mg-fact"],
    [".mg-rank-grid", ".mg-rank-grid-row"],
    [".mg-leaders", ".mg-leader"],
    [".mg-rails-rows", ".mg-rails-row"],
    [".mg-dt tbody", "tr"],
  ];
  for (const [parentSel, childSel] of PEER_GROUPS) {
    for (const parent of root.querySelectorAll<HTMLElement>(parentSel)) {
      // A table in CARDS mode stacks each row's cells as a label/value list,
      // so a row with more to say is taller BY DESIGN -- that is the point of
      // the mode. Only the grid form promises equal rows.
      if (parent.closest('.mg-dt[data-mobile="cards"]')) continue;
      const kids = [...parent.querySelectorAll<HTMLElement>(`:scope > ${childSel}`)];
      if (kids.length < 3) continue;
      const heights = kids.map((k) => Math.round(k.getBoundingClientRect().height));
      const min = Math.min(...heights);
      const max = Math.max(...heights);
      if (max - min <= 4) continue;
      const tallest = kids[heights.indexOf(max)];
      raggedPeers.push(
        `${parentSel} > ${childSel}: ${min}px to ${max}px across ${kids.length} — tallest is ` +
          JSON.stringify((tallest?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48)),
      );
    }
  }
  // A TABLE THAT FITS ITS CARD.
  //
  // Seven tables were wider than the card they sat in -- /apis/endpoints by
  // 338px -- because a full URL took 390-711px of the row and the columns to
  // its right went off the edge into a horizontal scroll nothing announced. A
  // URL is something a reader copies, not something they compare down a
  // column, so it belongs under the row (#11696).
  //
  // What this can still catch, now that `table-layout: fixed` stops CONTENT
  // from widening a table: declared widths that sum past the card. Verified by
  // injection -- widening one column to 900px reports
  // "div#directory.mg-dt is 652px wider than its card", while putting the
  // 711px URL column back does NOT, because fixed layout truncates it instead.
  // That is the fix working, not a hole: the failure mode that remains is a
  // column set declared wider than the space it has.
  //
  // A COLUMN THAT SAYS ONE THING is the other half of #11696 and is NOT
  // asserted here. Constancy is a property of the data, not of the design:
  // `Severity: warning` on all twelve incidents and `Subnet: SN51` on all 156
  // of one provider's surfaces are true today and false after the next probe
  // pass, so a gate on it goes red for reasons nobody chose. The columns that
  // were constant BY CONSTRUCTION -- a capture timestamp shared by every row
  // of one polled page, a permit column on a list of permit-holders -- are
  // demoted at their definition instead, where the reason lives in a comment
  // next to the code that made it true.
  for (const table of root.querySelectorAll<HTMLElement>(".mg-dt")) {
    const box = table.querySelector<HTMLElement>(".mg-dt-viewport");
    const grid = table.querySelector<HTMLElement>("table");
    if (!box || !grid) continue;
    const over = Math.round(grid.getBoundingClientRect().width - box.getBoundingClientRect().width);
    if (over > 2) {
      wideTables.push(`${describeEl(table)} is ${over}px wider than its card`);
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
    repeatedMeasures,
    wideTables,
    raggedPeers,
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

          // The same ranked list twice in one section (#11683). This was
          // COLLECTED and never asserted from the day it was written (#11685):
          // the sweep computed the finding, returned it in the payload, and
          // nothing looked at it, so the gate could not fail and the /accounts
          // duplicate it exists to catch was found by hand months later.
          if (!(route in SPECIMEN_ROUTES)) {
            expect(
              s.repeatedLegends,
              `a section rendering the same ranked list twice on ${route} (${viewport.name}, ${theme})`,
            ).toEqual([]);
          }

          // One measure, one place (#11693). A label stated twice is either the
          // reader reading the same number twice or -- worse, and this happened
          // on the subnet detail page -- reading two different numbers under
          // one name. Specimen routes are exempt: /design/primitives documents
          // `EntityHero` and `FactStrip` with the same four facts on purpose,
          // which is the page's subject rather than a slip.
          if (!(route in SPECIMEN_ROUTES)) {
            expect(
              s.repeatedMeasures,
              `the same measure stated twice on ${route} (${viewport.name}, ${theme})`,
            ).toEqual([]);
          }

          // A table wider than its card: the reader loses the right-hand
          // columns to a scroll nothing announces.
          //
          // DESKTOP ONLY. A seven-column table cannot fit a 375px phone or a
          // 768px tablet, and scrolling one sideways there is the ordinary
          // answer -- asserting it everywhere would be asserting that the
          // table has no more than three columns. At the width the layout was
          // designed for there is no such excuse.
          if (!(route in SPECIMEN_ROUTES) && viewport.name === "desktop") {
            expect(
              s.wideTables,
              `a table wider than its card on ${route} (${viewport.name}, ${theme})`,
            ).toEqual([]);
          }

          // Peers from one primitive at different heights: a strip of cards
          // where one wrapped, a list where one row has more to say.
          if (!(route in SPECIMEN_ROUTES)) {
            expect(
              s.raggedPeers,
              `peers laid out by one primitive disagree on height on ${route} (${viewport.name}, ${theme})`,
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
