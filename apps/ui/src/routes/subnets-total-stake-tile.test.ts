import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6271 (historical): /subnets showed no stake figure at all. Six prior PR
// attempts were closed by the maintainer -- the recurring mistakes: (1) a
// static latest value instead of an actual trend, (2) cramming a 5th StatTile
// into a fixed-column grid producing an orphaned single tile at mobile/tablet
// widths, and (3) an out-of-sync Suspense fallback skeleton count causing a
// layout shift when data loads. The original fix (`SubnetsStatStrip`) reused
// economics-panel.tsx's StatTile+Sparkline+flex-wrap pattern.
//
// #8248 replaced that whole 5-tile card strip (plus the separate
// SubnetsHighlights ops-card row above it) with `SubnetsCompactStats` -- a
// single inline text line (Active / Healthy / Total stake / a freshness chip
// shown only when stale) per the redesign's "masthead trim, ≤4 facts, no
// cards" requirement. The total-stake figure itself is still a real number
// sourced live (now summed from economicsQuery(), the same rows the table's
// own Total stake column reads, instead of the trend endpoint) rather than a
// hardcoded placeholder -- these assertions pin THAT property surviving the
// redesign, not the retired card-strip's specific shape.
//
// `subnets.index.tsx` composes TanStack Router/Query context a rendered test
// can't easily stand up, so this suite is node-environment source assertions,
// mirroring leaderboards-csv-export-menu.test.ts's own convention.
const source = readFileSync(
  fileURLToPath(new URL("./-subnets-index-page.tsx", import.meta.url)),
  "utf8",
);

const strip = source.slice(
  source.indexOf("function SubnetsCompactStats"),
  source.indexOf("function SubnetsDomainsRollup"),
);

describe("subnets.index.tsx compact masthead stats (post-#8248)", () => {
  it("no longer renders the retired card-strip components", () => {
    expect(source).not.toContain("function SubnetsStatStrip");
    expect(source).not.toContain("<SubnetsHighlights");
    expect(source).not.toContain("<SubnetsStatStrip");
  });

  it("renders Total stake as a real live figure, not a static placeholder", () => {
    expect(strip).toContain("Total stake");
    expect(strip).toContain("economicsQuery()");
    expect(strip).toContain("formatTao(totalStake)");
  });

  it("phases Total stake via statPhase so a failed economics query cannot fabricate 0 τ (#8818)", () => {
    expect(strip).toContain("statPhase(economicsRes)");
    expect(strip).toContain('StatUnavailable variant="inline"');
    expect(strip).toContain("economicsRows.length === 0 ? (");
    // formatTao must sit behind the ready branch, not on an unguarded path
    expect(strip).toMatch(/economicsPhase === "error"[\s\S]*formatTao\(totalStake\)/);
    // Coins glyph only accompanies a real figure — never beside StatUnavailable
    // (desktop/tablet double-icon look that closed #8933).
    expect(strip).toMatch(
      /economicsPhase === "error"[\s\S]*<>\s*<Coins[\s\S]*formatTao\(totalStake\)/,
    );
    const errorBranch = strip.slice(
      strip.indexOf('economicsPhase === "error"'),
      strip.indexOf("economicsRows.length === 0"),
    );
    expect(errorBranch).not.toContain("<Coins");
  });

  it("caps the masthead at Active / Healthy / Total stake, plus a freshness chip shown only when stale", () => {
    expect(strip).toContain("active");
    expect(strip).toContain("Healthy");
    expect(strip).toContain("isStaleFreshness(generatedAt)");
    expect(strip).toContain("stale ? (");
  });

  it("renders as an inline text row, not a card/grid layout that could produce an orphaned tile", () => {
    expect(strip).not.toMatch(/grid grid-cols-\d/);
    expect(strip).not.toContain("<StatTile");
  });

  it("the Suspense fallback for the compact-stats AsyncPanel is a single skeleton, not a per-tile count that can drift out of sync", () => {
    const fallback = source.slice(
      source.indexOf('context="subnets summary"'),
      source.indexOf("<SubnetsCompactStats"),
    );
    expect((fallback.match(/<PanelSkeleton/g) ?? []).length).toBe(1);
  });
});
