import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8818: ActivityEventRollup must phase each tile from its own query so a
// failed summary cannot paint Events/Kinds/TAO as 0 beside a real axon figure.
const source = readFileSync(
  fileURLToPath(new URL("./-subnets-netuid-page.tsx", import.meta.url)),
  "utf8",
);

const rollup = source.slice(
  source.indexOf("function ActivityEventRollup"),
  source.indexOf("// Subnets have no per-subnet event_kinds"),
);

describe("subnets.$netuid ActivityEventRollup (#8818)", () => {
  it("no longer fabricates event counts via ?? 0", () => {
    expect(rollup).not.toContain("summary?.total_events ?? 0");
    expect(rollup).not.toContain("summary?.kind_count ?? 0");
    expect(rollup).not.toContain("axon?.removals ?? 0");
  });

  it("phases summary and axon tiles independently via statPhase + StatUnavailable", () => {
    expect(rollup).toContain("statPhase(summaryResult)");
    expect(rollup).toContain("statPhase(axonResult)");
    expect(rollup).toContain("StatUnavailable");
  });
});
