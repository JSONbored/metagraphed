import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6271 (historical): /subnets showed no stake figure at all. Six prior PR
// attempts were closed by the maintainer -- the recurring mistakes: (1) a
// static latest value instead of an actual trend, (2) cramming a 5th tile
// into a fixed-column grid producing an orphaned single tile at mobile/tablet
// widths, and (3) an out-of-sync Suspense fallback skeleton count causing a
// layout shift when data loads.
//
// #8248 replaced the card strip with `SubnetsCompactStats`, an inline text
// line. #11613 replaced THAT with the hero's `FactStrip`, so the specific
// shape this file used to pin -- an AsyncPanel, a statPhase ternary, a Coins
// glyph -- is gone twice over.
//
// What survives every one of those rewrites is the PROPERTY the six closed
// PRs kept getting wrong, and it is the only thing asserted here now: the
// total-stake figure is summed from the economics rows the page already
// holds, and it is never a hardcoded number.
//
// Source assertions rather than a render: the page composes TanStack
// Router/Query context a node-environment test cannot stand up.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const page = read("./-subnets-index-page.tsx");

describe("#6271 the /subnets stake figure is measured, not written down", () => {
  it("sums it from the economics rows rather than stating a number", () => {
    expect(page).toContain('economicsQuery({ fields: "directory" })');
    expect(page).toMatch(/const totalStake = econRows\.reduce\(/);
    expect(page).toContain("row.total_stake_alpha ?? 0");
  });

  it("reads the ALPHA field, which is the one /api/v1/economics serves", () => {
    // The TAO twin does not exist on that route -- 0 of 129 rows carried one
    // when this was checked against production -- and reading it resolved
    // undefined for every subnet (#11612).
    expect(page).not.toContain("total_stake_tao");
  });

  it("never hardcodes a stake figure", () => {
    // A literal with a τ or α beside it is the failure mode the six closed
    // PRs kept reintroducing.
    expect(page).not.toMatch(/["'`]\s*[\d,.]+\s*[MkK]?\s*[τα]/);
  });

  it("keeps the retired card strip and its successor both gone", () => {
    for (const retired of [
      "function SubnetsStatStrip",
      "<SubnetsHighlights",
      "<SubnetsStatStrip",
      "function SubnetsCompactStats",
      "<AsyncPanel",
      "<PanelSkeleton",
    ]) {
      expect(page, `${retired} is back on /subnets`).not.toContain(retired);
    }
  });

  it("states the figure once, in the hero, so no second copy can drift", () => {
    expect((page.match(/label: "Total stake"/g) ?? []).length).toBe(1);
  });
});
