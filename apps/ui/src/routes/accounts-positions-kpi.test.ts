import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8818: Positions KPI must not fabricate "0" / "no positions" from a failed
// accountPortfolioQuery. Node-environment source assertions (same convention
// as subnets-total-stake-tile.test.ts).
const source = readFileSync(
  fileURLToPath(new URL("./-accounts-ss58-page.tsx", import.meta.url)),
  "utf8",
);

describe("accounts.$ss58 Positions KPI (#8818)", () => {
  it("no longer fabricates position_count via ?? 0", () => {
    expect(source).not.toContain("portfolio?.position_count ?? 0");
  });

  it("phases the Positions tile through statPhase + StatUnavailable", () => {
    expect(source).toContain("statPhase(portfolioResult)");
    expect(source).toContain("portfolioPhase");
    expect(source).toContain("StatUnavailable");
  });
});
