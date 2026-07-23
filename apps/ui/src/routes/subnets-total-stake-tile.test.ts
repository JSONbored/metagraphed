import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6271: /subnets showed no stake figure at all. Six prior PR attempts were
// closed by the maintainer -- the recurring mistakes: (1) a static latest
// value instead of an actual trend (explicitly blocked by the AI reviewer on
// one attempt for not delivering "the promised trend surface"), (2) cramming
// a 5th StatTile into the existing `grid-cols-2 md:grid-cols-4` layout,
// producing an orphaned single tile on the last row at mobile/tablet widths
// ("Looks really bad" -- the most recent rejection, today), and (3) an
// out-of-sync Suspense fallback skeleton count causing a layout shift when
// data loads ("Broken implementation/breaks pre-existing things"). The fix
// reuses economics-panel.tsx's own already-proven StatTile+Sparkline+
// flex-wrap pattern instead of inventing a new one. `subnets.index.tsx`
// composes TanStack Router/Query context a rendered test can't easily stand
// up, so this suite is node-environment source assertions, mirroring
// leaderboards-csv-export-menu.test.ts's own convention.
const source = readFileSync(fileURLToPath(new URL("./subnets.index.tsx", import.meta.url)), "utf8");

const strip = source.slice(
  source.indexOf("function SubnetsStatStrip"),
  source.indexOf("function ExcludeToggle"),
);

describe("subnets.index.tsx Total stake tile", () => {
  it("uses flex-wrap for the stat strip, not a fixed-column grid", () => {
    expect(strip).toContain("flex flex-wrap");
    expect(strip).not.toMatch(/grid grid-cols-\d/);
  });

  it("renders a Total stake StatTile with a Sparkline chart, not a static value", () => {
    expect(strip).toContain('eyebrow="Total stake"');
    expect(strip).toContain("<Sparkline");
    expect(strip).toContain("stakeSeries");
  });

  it("sources the trend from economicsTrendsQuery, the same series explorer.tsx already charts", () => {
    expect(source).toMatch(/import\s*\{[^}]*economicsTrendsQuery[^}]*\}/s);
    expect(strip).toContain("useSuspenseQuery(economicsTrendsQuery())");
  });

  it("the AsyncPanel fallback skeleton count matches the real tile count (5), avoiding a layout shift on load", () => {
    const fallback = source.slice(
      source.indexOf('context="subnets summary"'),
      source.indexOf("<SubnetsStatStrip"),
    );
    const skeletonCount = (fallback.match(/<PanelSkeleton height="xs" \/>/g) ?? []).length;
    const tileCount = (strip.match(/<StatTile/g) ?? []).length;
    expect(skeletonCount).toBe(tileCount);
    expect(skeletonCount).toBe(5);
  });

  it("guards the sparkline with a length check so a cold/single-point series never crashes Sparkline", () => {
    expect(strip).toMatch(/stakeSeries\.length > 1/);
  });
});
