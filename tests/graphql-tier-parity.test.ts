import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  checkTierParity,
  readTierSources,
} from "../scripts/validate-graphql-tier-parity.ts";

const sources = readTierSources();

describe("graphql tier parity gate (#10217)", () => {
  test("every GraphQL field reads the same tier ladder as its route", () => {
    const report = checkTierParity(sources);
    assert.deepEqual(
      report.violations,
      [],
      "a GraphQL field skipping a tier its route reads answers a confident zero",
    );
    assert.ok(
      report.compared >= 10,
      `only ${report.compared} route(s) compared — the ladder scan found almost nothing`,
    );
  });

  test("it FAILS when a resolver drops the projection tier", () => {
    // Exactly the regression that shipped: chain_transfers fell past the tier
    // holding the data straight to the empty card, and answered
    // transfer_count 0 while REST answered 2,883,743 for the same window.
    const graphqlSource = sources.graphqlSource.replace(
      /\(\(await loadChainTransfersFromArtifact\([\s\S]*?\)\) as Row \| null\) \?\?\n/,
      "",
    );
    assert.notEqual(
      graphqlSource,
      sources.graphqlSource,
      "the fixture rung must exist to be removed",
    );
    const report = checkTierParity({ ...sources, graphqlSource });
    assert.ok(
      report.violations.some((v) => v.startsWith("chain_transfers ")),
      `expected the dropped rung to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("a DECLARED divergence is accepted, and a stale one fails", () => {
    const graphqlSource = sources.graphqlSource.replace(
      /\(\(await loadChainTransfersFromArtifact\([\s\S]*?\)\) as Row \| null\) \?\?\n/,
      "",
    );
    const route = "/api/v1/chain/transfers";
    const accepted = checkTierParity({
      ...sources,
      graphqlSource,
      declared: { [route]: "under test" },
    });
    assert.ok(
      !accepted.violations.some((v) => v.includes(route)),
      "a declared divergence must not be reported",
    );
    assert.deepEqual(accepted.stale, []);

    // Against the UNBROKEN tree the divergence is gone, so the exemption has
    // to go with it. This is what stops the list from growing.
    const fixed = checkTierParity({
      ...sources,
      declared: { [route]: "under test" },
    });
    assert.deepEqual(fixed.stale, [route]);
  });
});
