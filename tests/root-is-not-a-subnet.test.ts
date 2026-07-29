import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { readFileSync } from "node:fs";
import { MCP_INSTRUCTIONS } from "../src/mcp-server.ts";

// #8638: netuid 0 is ROOT, not a subnet. We published 129 as a subnet count --
// most consequentially through `registry_summary`, the tool an agent calls to
// ask how big Bittensor is, and through MCP_INSTRUCTIONS, the first thing every
// connecting agent reads. The data layer had it right all along (the coverage
// artifact splits application_subnet_count / root_subnet_count); the published
// counts and the prose reached for the wrong number.
describe("root is not a subnet (#8638)", () => {
  test("registry-summary counts APPLICATION subnets, not every netuid", () => {
    // Pinned against the generator source rather than a built artifact: the
    // artifact is only produced by a full `npm run build`, and the defect was
    // in which expression the field was assigned.
    const source = readFileSync(
      new URL("../scripts/build-artifacts.ts", import.meta.url),
      "utf8",
    );
    const block = source.slice(
      source.indexOf('artifactFile("registry-summary.json")'),
      source.indexOf('artifactFile("registry-summary.json")') + 1200,
    );
    assert.match(block, /subnet_count:\s*mergedSubnets\.filter\(/);
    assert.match(block, /subnet_type === "application"/);
    // The exact regression: counting the whole merged list includes root.
    assert.doesNotMatch(block, /subnet_count:\s*mergedSubnets\.length/);
  });

  test("MCP instructions never state a subnet count that includes root", () => {
    // Every agent reads this string on connect, so a wrong number here
    // propagates straight into agent answers about Bittensor.
    assert.doesNotMatch(MCP_INSTRUCTIONS, /\b129\s+subnets\b/i);
    assert.doesNotMatch(MCP_INSTRUCTIONS, /~129/);
  });

  test("no source file claims '129 subnets' in user-facing prose", () => {
    // 129 is the netuid count. Saying "129 subnets" is the bug; saying
    // "129 netuids" is correct and allowed.
    for (const file of [
      "../src/mcp-server.ts",
      "../src/economics-trends.ts",
      "../workers/data-api.ts",
      "../apps/ui/src/lib/metagraphed/agent-prompt.ts",
      "../apps/ui/src/components/metagraphed/agent-live-card.tsx",
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.doesNotMatch(
        text,
        /\b129\s+subnets\b/i,
        `${file} says "129 subnets"`,
      );
    }
  });
});
