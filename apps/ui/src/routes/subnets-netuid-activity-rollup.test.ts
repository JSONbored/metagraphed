import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8818: ActivityEventRollup guarded only `if (!summary && !axon) return null`, so
// the strip rendered as soon as EITHER of its two source queries resolved -- a real
// "Axon removals 12" could sit beside three fabricated zeros (`summary?.total_events
// ?? 0` etc) whenever subnetEventSummaryQuery failed, which actively signalled that
// the data loaded fine. Fix phases each tile against its own source query via
// statPhase()/StatUnavailable and only early-returns while both queries are still
// pending, so a partial or full failure renders as StatUnavailable tiles instead of
// vanishing or fabricating zeros.
//
// `subnets.$netuid` composes TanStack Router/Query context a rendered test can't
// easily stand up, so this suite is node-environment source assertions, mirroring
// subnets-total-stake-tile.test.ts's own convention.
const source = readFileSync(
  fileURLToPath(new URL("./-subnets-netuid-page.tsx", import.meta.url)),
  "utf8",
);

const rollup = source.slice(
  source.indexOf("function ActivityEventRollup"),
  source.indexOf("function EventKindFilterChip"),
);

describe("subnets.$netuid ActivityEventRollup (#8818)", () => {
  it("no longer fabricates zeros for total_events, kind_count, category_count or removals", () => {
    expect(rollup).not.toContain("summary?.total_events ?? 0");
    expect(rollup).not.toContain("summary?.kind_count ?? 0");
    expect(rollup).not.toContain("summary?.category_count ?? 0");
    expect(rollup).not.toContain("axon?.removals ?? 0");
  });

  it("phases each source query independently via statPhase", () => {
    expect(rollup).toContain("statPhase(summaryResult)");
    expect(rollup).toContain("statPhase(axonResult)");
  });

  it("renders a StatUnavailable tile for each phased branch", () => {
    expect((rollup.match(/<StatUnavailable/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("only early-returns while both queries are pending, not on error", () => {
    expect(rollup).toContain('summaryPhase === "pending" && axonPhase === "pending"');
    expect(rollup).not.toContain("if (!summary && !axon) return null");
  });
});
