import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildProviderEmissionsLeaderboard } from "../src/provider-emissions.mjs";

const economics = {
  subnets: [
    { netuid: 1, emission_share: 0.1, emission_tao: 10 },
    { netuid: 2, emission_share: 0.25, emission_tao: 25 },
    { netuid: 3, emission_share: 0.05, emission_tao: null },
    { netuid: 4, emission_share: 0.4, emission_tao: 40 },
  ],
};

describe("buildProviderEmissionsLeaderboard", () => {
  test("sums each provider's backed-subnet emission and ranks descending", () => {
    const providers = {
      providers: [
        {
          id: "alpha",
          name: "Alpha",
          kind: "team",
          authority: "official",
          netuids: [1, 2],
        },
        {
          id: "beta",
          name: "Beta",
          kind: "team",
          authority: "community",
          netuids: [4],
        },
        { id: "gamma", name: "Gamma", netuids: [3] },
      ],
    };
    const rows = buildProviderEmissionsLeaderboard(providers, economics);
    assert.deepEqual(
      rows.map((r) => [r.rank, r.id, r.emission_share, r.emission_tao]),
      [
        [1, "beta", 0.4, 40], // 0.4
        [2, "alpha", 0.35, 35], // 0.1 + 0.25
        [3, "gamma", 0.05, null], // 0.05, no tao reported
      ],
    );
  });

  test("counts total vs emission-matched subnets separately", () => {
    const providers = {
      providers: [
        { id: "p", name: "P", netuids: [1, 999, 2] }, // 999 has no economics row
      ],
    };
    const [row] = buildProviderEmissionsLeaderboard(providers, economics);
    assert.equal(row.subnet_count, 3);
    assert.equal(row.emission_subnet_count, 2);
    assert.equal(row.emission_share, 0.35);
    assert.equal(row.emission_tao, 35);
  });

  test("a provider whose subnets carry no emission data sorts last with 0 share, still listed", () => {
    const providers = {
      providers: [
        { id: "empty", name: "Empty", netuids: [999] },
        { id: "real", name: "Real", netuids: [4] },
      ],
    };
    const rows = buildProviderEmissionsLeaderboard(providers, economics);
    assert.equal(rows[0].id, "real");
    assert.equal(rows[1].id, "empty");
    assert.equal(rows[1].emission_share, 0);
    assert.equal(rows[1].emission_tao, null);
    assert.equal(rows[1].emission_subnet_count, 0);
  });

  test("emission_tao stays null when no matched subnet reports a rate, even with share", () => {
    const [row] = buildProviderEmissionsLeaderboard(
      { providers: [{ id: "g", name: "G", netuids: [3] }] },
      economics,
    );
    assert.equal(row.emission_share, 0.05);
    assert.equal(row.emission_tao, null);
  });

  test("coerces numeric-string emission fields and ignores non-finite ones", () => {
    const rows = buildProviderEmissionsLeaderboard(
      { providers: [{ id: "p", name: "P", netuids: [10, 11, 12] }] },
      {
        subnets: [
          { netuid: 10, emission_share: "0.2", emission_tao: "5" },
          { netuid: 11, emission_share: "not-a-number", emission_tao: NaN },
          { netuid: 12, emission_share: 0.3, emission_tao: Infinity },
        ],
      },
    );
    assert.equal(rows[0].emission_share, 0.5); // 0.2 + 0.3, the bad share skipped
    assert.equal(rows[0].emission_tao, 5); // only the "5" contributes
  });

  test("tolerates non-array / non-finite netuids and missing fields", () => {
    const rows = buildProviderEmissionsLeaderboard(
      {
        providers: [
          { id: "a", netuids: null },
          { id: "b", netuids: [1, "x", null, 2] },
        ],
      },
      economics,
    );
    const b = rows.find((r) => r.id === "b");
    const a = rows.find((r) => r.id === "a");
    assert.equal(b.emission_share, 0.35); // 1 + 2, junk entries skipped
    assert.equal(a.subnet_count, 0);
    assert.equal(a.emission_share, 0);
    assert.equal(a.name, null);
  });

  test("breaks emission ties by tao then name for a stable order", () => {
    const rows = buildProviderEmissionsLeaderboard(
      {
        providers: [
          { id: "z", name: "Zeta", netuids: [1] },
          { id: "a", name: "Aria", netuids: [1] },
        ],
      },
      economics,
    );
    // equal share (0.1) and equal tao (10) -> name ascending: Aria before Zeta
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Aria", "Zeta"],
    );
  });

  test("skips economics rows with a missing / non-finite netuid", () => {
    const rows = buildProviderEmissionsLeaderboard(
      { providers: [{ id: "p", name: "P", netuids: [1] }] },
      {
        subnets: [
          { netuid: null, emission_share: 0.9 }, // no netuid -> not indexed
          { netuid: "nope", emission_share: 0.9 }, // non-finite -> not indexed
          { netuid: 1, emission_share: 0.1, emission_tao: 10 },
        ],
      },
    );
    assert.equal(rows[0].emission_share, 0.1); // the un-keyed rows never match
  });

  test("tie-break falls through name -> id -> empty string without throwing", () => {
    // equal share (0.1) + equal tao (10); neither has a name, one has no id
    const rows = buildProviderEmissionsLeaderboard(
      {
        providers: [
          { id: "b", netuids: [1] },
          { netuids: [1] }, // no name, no id -> "" side of the fallback
        ],
      },
      economics,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, null); // "" < "b" -> the name/id-less row ranks first
    assert.equal(rows[1].id, "b");
  });

  test("tie on share orders a tao-bearing provider ahead of a tao-null one", () => {
    // netuid 3 has share 0.05 tao null; craft another subnet with the same share
    // but a real tao so the tao tie-break (?? 0) is exercised on a real value.
    const rows = buildProviderEmissionsLeaderboard(
      {
        providers: [
          { id: "notao", name: "NoTao", netuids: [3] }, // 0.05, tao null
          { id: "withtao", name: "WithTao", netuids: [30] }, // 0.05, tao 7
        ],
      },
      {
        subnets: [
          { netuid: 3, emission_share: 0.05, emission_tao: null },
          { netuid: 30, emission_share: 0.05, emission_tao: 7 },
        ],
      },
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      ["withtao", "notao"],
    );
  });

  test("a full tie among name/id-less providers still sorts (empty-string keys on both sides)", () => {
    // Three providers all tied on share (0.1) and tao (10); two of them have
    // neither name nor id, so both sides of the localeCompare fall all the way
    // to "" during the pairwise comparisons.
    const rows = buildProviderEmissionsLeaderboard(
      {
        providers: [
          { netuids: [1] }, // no name, no id -> ""
          { netuids: [1] }, // no name, no id -> ""
          { id: "m", name: "M", netuids: [1] },
        ],
      },
      economics,
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.rank),
      [1, 2, 3],
    );
  });

  test("empty / missing artifacts yield an empty leaderboard, not a throw", () => {
    assert.deepEqual(buildProviderEmissionsLeaderboard(null, null), []);
    assert.deepEqual(buildProviderEmissionsLeaderboard({}, {}), []);
    assert.deepEqual(
      buildProviderEmissionsLeaderboard({ providers: [] }, economics),
      [],
    );
  });
});
