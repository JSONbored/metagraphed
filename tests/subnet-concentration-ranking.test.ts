// GET /api/v1/chain/concentration/subnets (#9717): every subnet ranked by how
// widely one lens of its distribution is spread.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildConcentration,
  buildSubnetConcentrationRanking,
  parseConcentrationRankingQuery,
  CONCENTRATION_LENSES,
  CONCENTRATION_RANKING_SORTS,
  DEFAULT_CONCENTRATION_LENS,
  DEFAULT_CONCENTRATION_RANKING_SORT,
} from "../src/concentration.ts";
import type { Row } from "./row-type.ts";

const CAPTURED = "2026-08-07T06:35:25.540Z";

function neuron(overrides: Row = {}): Row {
  return {
    netuid: 1,
    stake_tao: 10,
    emission_tao: 1,
    coldkey: "ck-a",
    validator_permit: 0,
    captured_at: CAPTURED,
    ...overrides,
  };
}

/**
 * Two subnets with deliberately opposite reward shapes.
 *
 * netuid 1 -- five holders each earning 2: perfectly even. Nakamoto 3, gini 0.
 * netuid 2 -- one holder taking 100 and four taking 1: a near-monopoly.
 *             Nakamoto 1, gini high.
 *
 * The whole board exists to tell those two apart, so the fixture makes the
 * difference unmistakable rather than marginal.
 */
function twoSubnets(): Row[] {
  const even = [1, 2, 3, 4, 5].map((i) =>
    neuron({ netuid: 1, coldkey: `even-${i}`, emission_tao: 2, stake_tao: 2 }),
  );
  const skewed = [
    neuron({ netuid: 2, coldkey: "whale", emission_tao: 100, stake_tao: 100 }),
    ...[1, 2, 3, 4].map((i) =>
      neuron({
        netuid: 2,
        coldkey: `small-${i}`,
        emission_tao: 1,
        stake_tao: 1,
      }),
    ),
  ];
  return [...even, ...skewed];
}

describe("buildSubnetConcentrationRanking", () => {
  test("is the SAME computation the per-subnet route serves", () => {
    // The guarantee the route's description makes, asserted rather than
    // assumed: if these ever diverge, a subnet's rank and its own detail page
    // disagree and nothing else would notice.
    const rows = twoSubnets();
    const ranked = buildSubnetConcentrationRanking(rows, { limit: 10 });
    for (const netuid of [1, 2]) {
      const mine = ranked.subnets.find((row) => row.netuid === netuid)!;
      const direct = buildConcentration(
        rows.filter((row) => row.netuid === netuid),
        netuid,
      ).emission!;
      for (const key of [
        "holders",
        "total",
        "gini",
        "hhi",
        "hhi_normalized",
        "nakamoto_coefficient",
        "top_1pct_share",
        "top_5pct_share",
        "top_10pct_share",
        "top_20pct_share",
        "entropy",
        "entropy_normalized",
      ] as const) {
        assert.deepEqual(
          (mine as Row)[key],
          (direct as Row)[key],
          `${key} diverged from buildConcentration on netuid ${netuid}`,
        );
      }
      assert.equal(mine.neuron_count, 5);
      assert.equal(mine.unmeasured, false);
    }
  });

  test("defaults rank the most widely shared subnet first", () => {
    const ranked = buildSubnetConcentrationRanking(twoSubnets(), { limit: 10 });
    assert.equal(ranked.lens, DEFAULT_CONCENTRATION_LENS);
    assert.equal(ranked.sort, DEFAULT_CONCENTRATION_RANKING_SORT);
    assert.equal(ranked.order, "desc");
    assert.deepEqual(
      ranked.subnets.map((row) => row.netuid),
      [1, 2],
    );
    assert.equal(ranked.subnets[0].nakamoto_coefficient, 3);
    assert.equal(ranked.subnets[1].nakamoto_coefficient, 1);
  });

  test("each sort key gets its OWN widest-first direction", () => {
    // The trap this guards: one shared default direction would rank the most
    // CONCENTRATED subnet first under `gini` while ranking the most SPREAD one
    // first under `nakamoto_coefficient` -- the same request phrased two ways
    // returning opposite answers.
    const rows = twoSubnets();
    const byNakamoto = buildSubnetConcentrationRanking(rows, {
      sort: "nakamoto_coefficient",
      limit: 10,
    });
    const byGini = buildSubnetConcentrationRanking(rows, {
      sort: "gini",
      limit: 10,
    });
    assert.equal(byNakamoto.order, "desc");
    assert.equal(byGini.order, "asc");
    assert.equal(byNakamoto.subnets[0].netuid, 1);
    assert.equal(byGini.subnets[0].netuid, 1, "the even subnet leads both");
  });

  test("an explicit order overrides the per-key default", () => {
    const ranked = buildSubnetConcentrationRanking(twoSubnets(), {
      sort: "nakamoto_coefficient",
      order: "asc",
      limit: 10,
    });
    assert.equal(ranked.order, "asc");
    assert.deepEqual(
      ranked.subnets.map((row) => row.netuid),
      [2, 1],
    );
  });

  test("every sort key orders, and every lens resolves", () => {
    const rows = twoSubnets();
    for (const sort of CONCENTRATION_RANKING_SORTS) {
      const ranked = buildSubnetConcentrationRanking(rows, { sort, limit: 10 });
      assert.equal(ranked.sort, sort);
      assert.equal(ranked.subnets.length, 2);
    }
    for (const lens of CONCENTRATION_LENSES) {
      const ranked = buildSubnetConcentrationRanking(rows, { lens, limit: 10 });
      assert.equal(ranked.lens, lens);
      assert.equal(ranked.subnet_count, 2);
    }
  });

  test("a lens with no positive distribution sorts LAST in EITHER direction", () => {
    // The failure this prevents: nulls riding to the top of an ascending gini
    // ranking, so a subnet nobody measured reads as the most perfectly equal
    // subnet on the network -- the exact shape of an answer that is wrong and
    // says it is right.
    const rows = [
      ...twoSubnets(),
      // netuid 3 has neurons and stake but zero emission: measurable under the
      // stake lens, unmeasurable under emission.
      ...[1, 2, 3].map((i) =>
        neuron({
          netuid: 3,
          coldkey: `idle-${i}`,
          emission_tao: 0,
          stake_tao: 7,
        }),
      ),
    ];
    for (const order of ["asc", "desc"] as const) {
      const ranked = buildSubnetConcentrationRanking(rows, {
        sort: "gini",
        order,
        limit: 10,
      });
      const last = ranked.subnets[ranked.subnets.length - 1];
      assert.equal(
        last.netuid,
        3,
        `unmeasured subnet floated on order=${order}`,
      );
      assert.equal(last.unmeasured, true);
      assert.equal(last.gini, null);
      assert.equal(last.nakamoto_coefficient, null);
      assert.equal(last.holders, null);
      // The shell facts survive: the subnet exists and has neurons, which is
      // itself the reason "unmeasured" is not the same as "absent".
      assert.equal(last.neuron_count, 3);
    }
    // Measured under a lens that DOES have a distribution.
    const byStake = buildSubnetConcentrationRanking(rows, {
      lens: "stake",
      limit: 10,
    });
    assert.equal(
      byStake.subnets.find((row) => row.netuid === 3)!.unmeasured,
      false,
    );
    assert.equal(byStake.measured_subnet_count, 3);
  });

  test("unmeasured rows sink from either side of the comparison", () => {
    // Both arms of the unmeasured tie-break, not just the one a three-element
    // sort happens to reach: an unmeasured subnet placed BEFORE the measured
    // ones and another placed AFTER, so the comparator meets an unmeasured row
    // as its left operand and as its right operand.
    const dead = (netuid: number) =>
      [1, 2].map((i) =>
        neuron({ netuid, coldkey: `dead-${netuid}-${i}`, emission_tao: 0 }),
      );
    const ranked = buildSubnetConcentrationRanking(
      [...dead(0), ...twoSubnets(), ...dead(9)],
      { limit: 10 },
    );
    assert.deepEqual(
      ranked.subnets.map((row) => row.netuid),
      [1, 2, 0, 9],
    );
    assert.deepEqual(
      ranked.subnets.map((row) => row.unmeasured),
      [false, false, true, true],
    );
    assert.equal(ranked.subnet_count, 4);
    assert.equal(ranked.measured_subnet_count, 2);
  });

  test("reports the counts and the network rollup", () => {
    const rows = [
      ...twoSubnets(),
      neuron({ netuid: 4, coldkey: "solo", emission_tao: 9 }),
    ];
    const ranked = buildSubnetConcentrationRanking(rows, { limit: 10 });
    assert.equal(ranked.subnet_count, 3);
    assert.equal(ranked.measured_subnet_count, 3);
    assert.equal(ranked.returned, 3);
    assert.equal(ranked.neuron_count, 11);
    assert.equal(ranked.captured_at, CAPTURED);
    // netuid 4 is one coldkey taking the whole lens -- the strongest single
    // signal that a subnet is not worth a newcomer's registration fee.
    assert.equal(ranked.network.single_holder_subnet_count, 1);
    assert.equal(typeof ranked.network.median_gini, "number");
    assert.equal(typeof ranked.network.median_nakamoto_coefficient, "number");
    assert.equal(typeof ranked.network.median_top_1pct_share, "number");
  });

  test("the median takes the midpoint of an even sample", () => {
    // Two measured subnets -> the median is the mean of the pair, not either
    // one of them. Exercised explicitly because an off-by-one here is silent.
    const ranked = buildSubnetConcentrationRanking(twoSubnets(), { limit: 10 });
    const [a, b] = ranked.subnets.map((row) => row.nakamoto_coefficient!);
    assert.equal(ranked.network.median_nakamoto_coefficient, (a + b) / 2);
  });

  test("limit caps the page without distorting the counts", () => {
    const ranked = buildSubnetConcentrationRanking(twoSubnets(), { limit: 1 });
    assert.equal(ranked.subnets.length, 1);
    assert.equal(ranked.returned, 1);
    assert.equal(ranked.limit, 1);
    // The counts describe the NETWORK, not the page -- a caller who asked for
    // one row must still be told there are two subnets.
    assert.equal(ranked.subnet_count, 2);
    assert.equal(ranked.measured_subnet_count, 2);
  });

  test("ties break on netuid, so the order is total", () => {
    const rows = [3, 1, 2].flatMap((netuid) =>
      [1, 2].map((i) =>
        neuron({ netuid, coldkey: `${netuid}-${i}`, emission_tao: 5 }),
      ),
    );
    const ranked = buildSubnetConcentrationRanking(rows, { limit: 10 });
    assert.deepEqual(
      ranked.subnets.map((row) => row.netuid),
      [1, 2, 3],
    );
  });

  test("junk netuids never land in subnet 0's group", () => {
    // Number("") is 0 and Number("abc") is NaN; either coerced into a group key
    // would silently attribute rows to the root subnet.
    const rows = [
      neuron({ netuid: 0, coldkey: "root" }),
      neuron({ netuid: "" }),
      neuron({ netuid: "   " }),
      neuron({ netuid: "abc" }),
      neuron({ netuid: -1 }),
      neuron({ netuid: 1.5 }),
      neuron({ netuid: null }),
      neuron({ netuid: undefined }),
    ];
    const ranked = buildSubnetConcentrationRanking(rows, { limit: 10 });
    assert.deepEqual(
      ranked.subnets.map((row) => row.netuid),
      [0],
    );
    assert.equal(ranked.subnets[0].neuron_count, 1);
    // A numeric-string netuid is a legitimate D1 cell and must still group.
    const stringy = buildSubnetConcentrationRanking(
      [neuron({ netuid: "7" }), neuron({ netuid: 7, coldkey: "ck-b" })],
      { limit: 10 },
    );
    assert.deepEqual(
      stringy.subnets.map((row) => row.netuid),
      [7],
    );
    assert.equal(stringy.subnets[0].neuron_count, 2);
  });

  test("takes the NEWEST capture stamp, not the first row's", () => {
    const ranked = buildSubnetConcentrationRanking(
      [
        neuron({ netuid: 1, captured_at: "2026-08-01T00:00:00.000Z" }),
        neuron({ netuid: 2, captured_at: "2026-08-09T00:00:00.000Z" }),
        neuron({ netuid: 3, captured_at: "2026-08-05T00:00:00.000Z" }),
      ],
      { limit: 10 },
    );
    assert.equal(ranked.captured_at, "2026-08-09T00:00:00.000Z");
  });

  test("an empty / non-array read yields a schema-stable empty ranking", () => {
    for (const rows of [[], null, undefined]) {
      const ranked = buildSubnetConcentrationRanking(rows, { limit: 20 });
      assert.equal(ranked.schema_version, 1);
      assert.equal(ranked.subnet_count, 0);
      assert.equal(ranked.measured_subnet_count, 0);
      assert.equal(ranked.returned, 0);
      assert.equal(ranked.neuron_count, 0);
      assert.equal(ranked.captured_at, null);
      assert.deepEqual(ranked.subnets, []);
      // Medians over nothing are null, never 0 -- a zero gini would state that
      // the network is perfectly equal on a read that measured nothing.
      assert.equal(ranked.network.median_gini, null);
      assert.equal(ranked.network.median_nakamoto_coefficient, null);
      assert.equal(ranked.network.median_top_1pct_share, null);
      assert.equal(ranked.network.single_holder_subnet_count, 0);
    }
  });
});

describe("parseConcentrationRankingQuery", () => {
  const BOUNDS = { limitDefault: 20, limitMax: 512 };
  const parse = (qs: string) =>
    parseConcentrationRankingQuery(new URLSearchParams(qs), BOUNDS);

  test("an empty query is the documented defaults", () => {
    assert.deepEqual(parse(""), {
      lens: DEFAULT_CONCENTRATION_LENS,
      sort: DEFAULT_CONCENTRATION_RANKING_SORT,
      // Null, NOT a direction: the builder picks widest-first per sort key, and
      // defaulting here would flatten that into one direction for every key.
      order: null,
      limit: 20,
    });
  });

  test("accepts every published lens and sort", () => {
    for (const lens of CONCENTRATION_LENSES) {
      assert.deepEqual((parse(`lens=${lens}`) as Row).lens, lens);
    }
    for (const sort of CONCENTRATION_RANKING_SORTS) {
      assert.deepEqual((parse(`sort=${sort}`) as Row).sort, sort);
    }
    for (const order of ["asc", "desc"]) {
      assert.deepEqual((parse(`order=${order}`) as Row).order, order);
    }
  });

  test("names the offending parameter and lists what is valid", () => {
    const lens = parse("lens=vibes") as { error: Row };
    assert.equal(lens.error.parameter, "lens");
    assert.match(
      lens.error.message as string,
      /"vibes" is not a supported lens/,
    );
    assert.match(lens.error.message as string, /emission/);

    const sort = parse("sort=whatever") as { error: Row };
    assert.equal(sort.error.parameter, "sort");
    assert.match(sort.error.message as string, /nakamoto_coefficient/);

    const order = parse("order=sideways") as { error: Row };
    assert.equal(order.error.parameter, "order");
    assert.match(order.error.message as string, /asc, desc/);
  });

  test("an out-of-range limit is REJECTED, never clamped", () => {
    // Clamping hands back a truncated ranking the caller believes is complete,
    // which on a screening board is the difference between "these are the ten
    // best" and "these are ten of them".
    for (const bad of [
      "0",
      "-1",
      "513",
      "1.5",
      "abc",
      "",
      " ",
      "1e3",
      "0x10",
    ]) {
      const result = parse(`limit=${encodeURIComponent(bad)}`) as {
        error: Row;
      };
      assert.ok(
        "error" in result,
        `limit=${JSON.stringify(bad)} should have been rejected`,
      );
      assert.equal(result.error.parameter, "limit");
      assert.match(result.error.message as string, /between 1 and 512/);
    }
    assert.deepEqual((parse("limit=1") as Row).limit, 1);
    assert.deepEqual((parse("limit=512") as Row).limit, 512);
    assert.deepEqual((parse("limit=200") as Row).limit, 200);
  });
});
