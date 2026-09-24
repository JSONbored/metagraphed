import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { foldSummaryGroups } from "../src/account-feeds-cold-tier.ts";
import { buildAccountSummary } from "../src/account-events.ts";
const SS58 = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

const AGG = {
  c: 6,
  fb: 8_700_000,
  lb: 8_760_000,
  fo: 1_784_000_000_000,
  lo: 1_785_000_000_000,
};
/**
 * The ONE grouped read that replaced three (#9386).
 *
 * `GROUP BY event_kind, netuid` over the same `scan` CTE the three separate reads
 * aggregated. These rows must fold back to AGG exactly: 4 + 2 = 6 events, min/max
 * block and observed spanning both groups, and two distinct netuids.
 */
const GROUPS = [
  {
    kind: "AxonServed",
    netuid: 55,
    count: 4,
    fb: 8_700_000,
    lb: 8_750_000,
    fo: 1_784_000_000_000,
    lo: 1_784_900_000_000,
  },
  {
    kind: "NeuronRegistered",
    netuid: 7,
    count: 2,
    fb: 8_710_000,
    lb: 8_760_000,
    fo: 1_784_100_000_000,
    lo: 1_785_000_000_000,
  },
];

function card(groups: Record<string, unknown>[]) {
  const folded = foldSummaryGroups(groups);
  return buildAccountSummary(SS58, {
    ...folded,
    scanned: Number(folded.agg.c),
    complete: true,
    recent: [],
  });
}
describe("account summary fold semantics", () => {
  test("preserves independent totals, extrema and kinds across subnets", () => {
    const result = card(GROUPS);
    assert.equal(result.event_count, 6);
    assert.equal(result.subnet_count, 2);
    assert.equal(result.first_block, AGG.fb);
    assert.equal(result.last_block, AGG.lb);
    assert.equal(result.event_scan_capped, false);
    assert.deepEqual(result.event_kinds, [
      { kind: "AxonServed", count: 4 },
      { kind: "NeuronRegistered", count: 2 },
    ]);
  });
  test("merges one kind across subnets and keeps extrema regardless of group order", () => {
    const rows = [
      { kind: "A", netuid: 1, count: 3, fb: 50, lb: 900, fo: 50, lo: 900 },
      { kind: "A", netuid: 2, count: 5, fb: 10, lb: 100, fo: 10, lo: 100 },
    ];
    for (const groups of [rows, rows.toReversed()]) {
      const result = card(groups);
      assert.deepEqual(result.event_kinds, [{ kind: "A", count: 8 }]);
      assert.equal(result.subnet_count, 2);
      assert.equal(result.first_block, 10);
      assert.equal(result.last_block, 900);
    }
  });
  test("null subnets and kinds remain distinct groups without phantom named kinds", () => {
    const result = foldSummaryGroups([
      { kind: null, netuid: null, count: 2 },
      { kind: "A", netuid: 1, count: 1 },
      { kind: "A", netuid: null, count: 1 },
    ]);
    assert.deepEqual(result.kinds, [
      { kind: null, count: 2 },
      { kind: "A", count: 2 },
    ]);
    assert.equal(result.agg.sc, 2);
    assert.equal(result.agg.c, 4);
  });
  test("null or unreadable bounds never become a fake genesis and invalid counts never become NaN", () => {
    const result = card([
      {
        kind: "A",
        netuid: 1,
        count: "invalid",
        fb: null,
        lb: null,
        fo: null,
        lo: null,
      },
      {
        kind: "B",
        netuid: 2,
        count: 3,
        fb: "invalid",
        lb: Infinity,
        fo: undefined,
        lo: NaN,
      },
    ]);
    assert.equal(result.event_count, 3);
    assert.equal(result.first_block, null);
    assert.equal(result.last_block, null);
  });
  test("an empty complete fold is a measured zero", () => {
    assert.deepEqual(foldSummaryGroups([]), {
      agg: { c: 0, fb: null, lb: null, fo: null, lo: null, sc: 0 },
      kinds: [],
    });
  });
});
describe("all three account-summary surfaces go through the one composer", () => {
  const sources = {
    REST: "workers/request-handlers/entities.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  // #9263 tightened this from "every surface calls the loader" to "every
  // surface calls the SAME composer". Three call sites each assembling the
  // card themselves is how one of them ends up a version behind: #9257 wired
  // the event half into all three, and all three still shipped an empty
  // `registrations` because that leg was assembled separately.
  test("every surface calls answerAccountSummary, not its own assembly", () => {
    for (const [surface, path] of Object.entries(sources)) {
      const source = readFileSync(path, "utf8");
      assert.match(
        source,
        /answerAccountSummary\(/,
        `${surface} (${path}) would keep answering the all-zero card`,
      );
      assert.doesNotMatch(
        source,
        /loadAccountSummaryColdTier\(/,
        `${surface} (${path}) must not compose the card itself`,
      );
    }
  });

  test("and the composer is the only thing that calls the loader", () => {
    assert.match(
      readFileSync("src/account-summary-card.ts", "utf8"),
      /loadAccountSummaryColdTier\(/,
    );
  });
});
