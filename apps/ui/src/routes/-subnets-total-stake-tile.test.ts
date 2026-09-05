import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #12014: the old #6271 regression required summing raw alpha across
// different subnet assets. A measured number still needs a common unit.
// Keep the unsupported headline absent until a certified TAO valuation can
// replace it. The rendered unit/sort/recovery behavior is covered in
// directory-secondary-state.spec.ts.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const page = read("./-subnets-index-page.tsx");

describe("#12014 the subnet hero does not imply a common alpha asset", () => {
  it("does not sum per-subnet token quantities into a headline", () => {
    expect(page).not.toContain("row.total_stake_alpha");
    expect(page).not.toContain('label: "Total stake"');
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
});
