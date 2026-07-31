import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8818: the Positions KPI tile rendered `formatNumber(portfolio?.position_count ?? 0)`
// with the hint "no positions" whenever accountPortfolioQuery failed -- a wallet whose
// portfolio request errored was presented as a wallet that holds nothing. Fix reuses
// statPhase()/StatUnavailable (the same mechanism as the homepage KPI panels and the
// About "At a glance" sidebar) so the tile can distinguish pending/error/ready instead
// of collapsing a failed query into a fabricated zero.
//
// `accounts.$ss58` composes TanStack Router/Query context a rendered test can't easily
// stand up, so this suite is node-environment source assertions, mirroring
// subnets-total-stake-tile.test.ts's own convention.
const source = readFileSync(
  fileURLToPath(new URL("./-accounts-ss58-page.tsx", import.meta.url)),
  "utf8",
);

const positionsTile = source.slice(
  source.indexOf('eyebrow="Positions"'),
  source.indexOf('eyebrow="First seen"'),
);

describe("accounts.$ss58 Positions KPI tile (#8818)", () => {
  it("no longer fabricates a zero position count when the portfolio query fails", () => {
    expect(source).not.toContain("portfolio?.position_count ?? 0");
  });

  it("consults statPhase for the portfolio query", () => {
    expect(source).toContain("statPhase(portfolioResult)");
  });

  it("renders StatUnavailable on error and a skeleton while pending", () => {
    expect(positionsTile).toContain('portfolioPhase === "error"');
    expect(positionsTile).toContain("<StatUnavailable");
    expect(positionsTile).toContain('portfolioPhase === "pending"');
    expect(positionsTile).toContain("<Skeleton");
  });

  it("reaches the real position_count only on the ready branch", () => {
    expect(positionsTile).toContain("formatNumber(portfolio?.position_count)");
  });
});
