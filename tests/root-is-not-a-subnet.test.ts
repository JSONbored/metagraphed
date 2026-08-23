import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { MCP_INSTRUCTIONS } from "../src/mcp-server.ts";

// #8638: netuid 0 is ROOT, not a subnet. We published 129 as a subnet count --
// most consequentially through `registry_summary`, the tool an agent calls to
// ask how big Bittensor is, and through MCP_INSTRUCTIONS, the first thing every
// connecting agent reads. The data layer had it right all along (the coverage
// artifact splits application_subnet_count / root_subnet_count); the published
// counts and the prose reached for the wrong number.
/**
 * The surfaces that answer "how many subnets are there?" in prose someone
 * reads as the answer: the MCP server's tool descriptions, the two backend
 * modules that phrase a count, and the prompt the UI hands an agent.
 */
const PROSE_SURFACES = [
  "../src/mcp-server.ts",
  "../src/economics-trends.ts",
  "../workers/data-api.ts",
  "../apps/ui/src/lib/metagraphed/agent-prompt.ts",
] as const;

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

  test("no user-facing prose surface claims '129 subnets'", () => {
    // 129 is the netuid count. Saying "129 subnets" is the bug; saying
    // "129 netuids" is correct and allowed.
    //
    // Deliberately a NAMED list rather than a tree sweep. "129 subnets" is a
    // true sentence in a measurement narrative -- src/contracts.ts's
    // emission-pipeline description says "measured 2026-08-06, 129 subnets a
    // day, no gaps", which is a fact about one capture, not a claim about how
    // big Bittensor is. A whole-tree sweep flags 30-odd of those. What this
    // pins is the handful of surfaces that answer "how many subnets are
    // there?" in prose a reader or an agent takes as the answer.
    //
    // The existence check is the other half: this list named five files until
    // #11627 retired agent-live-card.tsx, and the test then failed with an
    // ENOENT -- a stack trace about the filesystem instead of a sentence about
    // the codebase. A named list has to say so when one of its names goes.
    for (const file of PROSE_SURFACES) {
      const url = new URL(file, import.meta.url);
      assert.ok(
        existsSync(url),
        `${file} no longer exists. If the surface is retired, delete its entry ` +
          `from PROSE_SURFACES; if it moved, repoint the entry.`,
      );
      assert.doesNotMatch(
        readFileSync(url, "utf8"),
        /\b129\s+subnets\b/i,
        `${file} says "129 subnets"`,
      );
    }
  });
});
