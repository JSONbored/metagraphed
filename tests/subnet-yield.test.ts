import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  buildSubnetYield,
  loadSubnetYield,
  parseSubnetYieldHistoryWindow,
  buildSubnetYieldHistory,
} from "../src/subnet-yield.ts";
import type { Row } from "./row-type.ts";

// Reads public/metagraph/openapi.json (the final published document), not
// schemas/api-components.schema.json: SubnetYieldArtifact became a
// types-epic B batch 2 (#8056) Zod-generated component, so the hand-edited
// bundle no longer declares it at all -- mirrors tests/
// validate-classification-enum-parity.test.ts's identical rationale for
// Classification.
const apiComponents = JSON.parse(
  readFileSync(
    new URL("../public/metagraph/openapi.json", import.meta.url),
    "utf8",
  ),
);

const CAPTURED = 1717000000000;

// One neurons-snapshot row.
function neuron(
  uid: number,
  {
    validator = false,
    stake,
    emission,
    captured = CAPTURED,
    block = 5000,
  }: {
    validator?: boolean;
    stake?: number | string | null;
    emission?: number | string | null;
    captured?: number | string | null;
    block?: number | string | null;
  } = {},
) {
  return {
    uid,
    hotkey: `5Hk${uid}`,
    validator_permit: validator ? 1 : 0,
    stake_tao: stake,
    emission_tao: emission,
    captured_at: captured,
    block_number: block,
  };
}

function assertUnknownYield(data: Row) {
  for (const field of [
    "subnet_yield",
    "mean_yield",
    "median_yield",
    "p25_yield",
    "p75_yield",
    "p90_yield",
  ])
    assert.equal(data[field], null, field);
}

describe("buildSubnetYield", () => {
  test("cold / empty input yields zero observations and unknown holdings", () => {
    for (const rows of [[], null, undefined]) {
      const d = buildSubnetYield(rows, 7);
      assert.equal(d.schema_version, 2);
      assert.equal(d.netuid, 7);
      assert.equal(d.captured_at, null);
      assert.equal(d.block_number, null);
      assert.equal(d.neuron_count, 0);
      assert.equal(d.validator_count, 0);
      assert.equal(d.miner_count, 0);
      assert.equal(d.total_stake_alpha, null);
      assert.equal(d.total_emission_alpha, 0);
      assertUnknownYield(d);
      assert.deepEqual(d.neurons, []);
      assert.deepEqual(d.degraded, { reason: "holdings_unqualified" });
    }
  });

  const set = [
    neuron(0, { validator: true, stake: 10, emission: 1 }),
    neuron(1, { validator: true, stake: 10, emission: 2 }),
    neuron(2, { stake: 10, emission: 3 }),
    neuron(3, { stake: 10, emission: 4 }),
  ];

  test("retains voting weights, role counts, subnet emission and snapshot metadata", () => {
    const d = buildSubnetYield(set, 7) as Row;
    assert.equal(d.schema_version, 2);
    assert.equal(d.neuron_count, 4);
    assert.equal(d.validator_count, 2);
    assert.equal(d.miner_count, 2);
    assert.equal(d.total_stake_alpha, null);
    assert.equal(d.total_emission_alpha, 10);
    assert.equal(d.captured_at, new Date(CAPTURED).toISOString());
    assert.equal(d.block_number, 5000);
    assertUnknownYield(d);
    assert.deepEqual(d.degraded, { reason: "holdings_unqualified" });
    const u3 = d.neurons.find((n: Row) => n.uid === 3);
    assert.equal(u3.voting_weight, 10);
    assert.equal(u3.stake_tao, null);
    assert.equal(u3.emission_tao, 4);
    assert.equal(u3.yield, null);
    assert.equal(u3.vs_median, null);
    assert.equal(u3.role, "miner");
  });

  test("sums thousands of same-token emissions in exact rao space (#2922)", () => {
    // Same-subnet emission remains an observation and keeps the exact-sum regression.
    const rows = [];
    let expectedEmissionRao = 0n;
    for (let i = 0; i < 5000; i += 1) {
      const emission = 12.345678901 + i * 0.000000001;
      rows.push(
        neuron(i, { stake: 1234.987654321 + i * 0.000000001, emission }),
      );
      expectedEmissionRao += BigInt(Math.round(emission * 1e9));
    }
    const expectedEmission =
      Number(expectedEmissionRao / 1_000_000_000n) +
      Number(expectedEmissionRao % 1_000_000_000n) / 1e9;
    const d = buildSubnetYield(rows, 7);
    assert.equal(d.total_stake_alpha, null);
    assert.equal(
      d.total_emission_alpha,
      Math.round(expectedEmission * 1e9) / 1e9,
    );
    assert.equal(d.neuron_count, 5000);
    assertUnknownYield(d);
  });

  test("weighted-stake scale changes observations without qualifying return statistics", () => {
    const baseline = buildSubnetYield(set, 7) as Row;
    const scaled = buildSubnetYield(
      set.map((row) => ({ ...row, stake_tao: 1000 })),
      7,
    ) as Row;
    assert.equal(scaled.total_emission_alpha, baseline.total_emission_alpha);
    assert.deepEqual(
      scaled.neurons.map((n: Row) => n.voting_weight),
      [1000, 1000, 1000, 1000],
    );
    assert.equal(scaled.total_stake_alpha, null);
    assertUnknownYield(baseline);
    assertUnknownYield(scaled);
  });

  test("orders UIDs without inventing above/below-median classifications", () => {
    const d = buildSubnetYield(
      [
        neuron(2, { stake: 10, emission: 3 }),
        neuron(0, { stake: 10, emission: 1 }),
        neuron(1, { stake: 10, emission: 2 }),
      ],
      7,
    ) as Row;
    assert.deepEqual(
      d.neurons.map((n: Row) => n.uid),
      [0, 1, 2],
    );
    for (const row of d.neurons) {
      assert.equal(row.stake_tao, null);
      assert.equal(row.yield, null);
      assert.equal(row.vs_median, null);
    }
    assertUnknownYield(d);
  });

  test("even-count observations cannot qualify a median or its classifications", () => {
    const d = buildSubnetYield(
      [
        neuron(0, { stake: 10, emission: 2 }),
        neuron(1, { stake: 10, emission: 4 }),
      ],
      7,
    ) as Row;
    assertUnknownYield(d);
    assert.deepEqual(
      d.neurons.map((n: Row) => n.vs_median),
      [null, null],
    );
    assert.deepEqual(
      d.neurons.map((n: Row) => n.emission_tao),
      [2, 4],
    );
  });

  test("a zero voting weight is an observed zero, while holdings and yield remain null", () => {
    const d = buildSubnetYield(
      [
        neuron(0, { validator: true, stake: 10, emission: 2 }),
        neuron(1, { stake: 0, emission: 5 }),
      ],
      7,
    ) as Row;
    const u1 = d.neurons.find((n: Row) => n.uid === 1);
    assert.equal(u1.voting_weight, 0);
    assert.equal(u1.stake_tao, null);
    assert.equal(u1.emission_tao, 5);
    assert.equal(u1.yield, null);
    assert.equal(u1.vs_median, null);
    assert.equal(d.neuron_count, 2);
    assert.equal(d.total_emission_alpha, 7);
    assertUnknownYield(d);
  });

  test("skips malformed UIDs but retains observations with unreadable quantity cells", () => {
    const d = buildSubnetYield(
      [
        { uid: null, validator_permit: 1, stake_tao: 9, emission_tao: 9 },
        { uid: 1.5, stake_tao: 9, emission_tao: 9 },
        neuron(2, {
          stake: "n/a",
          emission: "n/a",
          captured: "bad",
          block: "bad",
        }),
      ],
      7,
    ) as Row;
    assert.equal(d.neuron_count, 1);
    assert.equal(d.neurons[0].uid, 2);
    assert.equal(d.neurons[0].voting_weight, null);
    assert.equal(d.neurons[0].emission_tao, null);
    assert.equal(d.captured_at, null);
    assert.equal(d.block_number, null);
  });

  test("blank/null/negative/non-numeric quantity cells stay null without erasing UIDs", () => {
    for (const invalid of ["", "   ", null, -1, "n/a", Infinity]) {
      const weight = buildSubnetYield(
        [neuron(1, { stake: invalid, emission: 2 })],
        7,
      ) as Row;
      assert.equal(weight.neuron_count, 1, `weight=${String(invalid)}`);
      assert.equal(weight.neurons[0].voting_weight, null);
      assert.equal(weight.neurons[0].stake_tao, null);
      assert.equal(weight.neurons[0].yield, null);
      assert.equal(weight.total_emission_alpha, 2);

      const emission = buildSubnetYield(
        [neuron(2, { stake: 10, emission: invalid })],
        7,
      ) as Row;
      assert.equal(emission.neuron_count, 1);
      assert.equal(emission.neurons[0].voting_weight, 10);
      assert.equal(emission.neurons[0].emission_tao, null);
      assert.equal(emission.neurons[0].yield, null);
      assert.equal(emission.total_emission_alpha, 0);
      assertUnknownYield(emission);
    }
  });

  test("published schema retains nullable observations and the version 2 degradation", () => {
    const schema = apiComponents.components.schemas.SubnetYieldArtifact;
    assert.equal(schema.properties.schema_version.const, 2);
    assert.ok(schema.required.includes("degraded"));
    const row = schema.properties.neurons.items;
    for (const field of [
      "emission_tao",
      "voting_weight",
      "stake_tao",
      "yield",
    ]) {
      assert.deepEqual(row.properties[field].anyOf, [
        { type: "number" },
        { type: "null" },
      ]);
      assert.ok(row.required.includes(field));
    }
  });

  test("blank emission contributes no observed emission or fabricated yield", () => {
    const d = buildSubnetYield(
      [
        neuron(1, { stake: 100, emission: "   " }),
        neuron(2, { stake: 100, emission: 10 }),
      ],
      7,
    ) as Row;
    assert.equal(d.total_stake_alpha, null);
    assert.equal(d.total_emission_alpha, 10);
    assert.equal(d.neurons[0].emission_tao, null);
    assertUnknownYield(d);
  });

  test("a null block_number stays null, not a fabricated genesis 0", () => {
    const d = buildSubnetYield(
      [neuron(0, { stake: 10, emission: 1, block: null })],
      7,
    );
    assert.equal(d.block_number, null);
  });

  test("blank uid and block_number cells stay null (not uid/block 0)", () => {
    for (const blank of ["", "   "]) {
      const skipped = buildSubnetYield(
        [{ ...neuron(1, { stake: 1, emission: 1 }), uid: blank }],
        7,
      );
      assert.equal(skipped.neuron_count, 0, `uid=${JSON.stringify(blank)}`);
      const block = buildSubnetYield(
        [neuron(1, { stake: 1, emission: 1, block: blank })],
        7,
      );
      assert.equal(
        block.block_number,
        null,
        `block_number=${JSON.stringify(blank)}`,
      );
    }
  });

  test("coerces string-typed captured_at cells to ISO timestamps", () => {
    const d = buildSubnetYield(
      [neuron(0, { stake: 10, emission: 1, captured: "1717000000000" })],
      7,
    );
    assert.equal(d.captured_at, new Date(CAPTURED).toISOString());
  });

  test("a null captured_at stays null, not a fabricated epoch 1970", () => {
    const d = buildSubnetYield(
      [neuron(0, { stake: 10, emission: 1, captured: null })],
      7,
    );
    assert.equal(d.captured_at, null);
  });

  test("drops blank or out-of-range captured_at strings to null", () => {
    for (const captured of ["", "   ", "not-a-date", "8640000000000001"]) {
      const d = buildSubnetYield(
        [neuron(0, { stake: 10, emission: 1, captured })],
        7,
      );
      assert.equal(d.captured_at, null, `captured=${JSON.stringify(captured)}`);
    }
  });

  test("UID order is independent of emission/weight ratios and missing hotkeys stay null", () => {
    const d = buildSubnetYield(
      [
        neuron(5, { stake: 10, emission: 2 }),
        neuron(2, { stake: 5, emission: 1 }),
        { uid: 7, stake_tao: 0, emission_tao: 1 },
        neuron(1, { stake: 0, emission: 3 }),
      ],
      7,
    ) as Row;
    assert.deepEqual(
      d.neurons.map((n: Row) => n.uid),
      [1, 2, 5, 7],
    );
    assert.equal(d.neurons.find((n: Row) => n.uid === 7).hotkey, null);
    assert.deepEqual(
      d.neurons.map((n: Row) => n.yield),
      [null, null, null, null],
    );
  });

  test("numeric-string permit and quantity cells retain their observation semantics", () => {
    const d = buildSubnetYield(
      [
        { uid: 0, validator_permit: "0", stake_tao: "10", emission_tao: "1" },
        { uid: 1, validator_permit: "1", stake_tao: "20", emission_tao: "2" },
      ],
      7,
    ) as Row;
    assert.equal(d.validator_count, 1);
    assert.equal(d.miner_count, 1);
    assert.equal(d.neurons[0].role, "miner");
    assert.equal(d.neurons[1].role, "validator");
    assert.deepEqual(
      d.neurons.map((n: Row) => n.voting_weight),
      [10, 20],
    );
    assert.deepEqual(
      d.neurons.map((n: Row) => n.emission_tao),
      [1, 2],
    );
  });

  test("rounds observed emissions to rao precision without deriving a yield", () => {
    const d = buildSubnetYield(
      [neuron(0, { stake: 3, emission: 1.1234567894 })],
      7,
    ) as Row;
    assert.equal(d.neurons[0].emission_tao, 1.123456789);
    assert.equal(d.total_emission_alpha, 1.123456789);
    assert.equal(d.neurons[0].voting_weight, 3);
    assert.equal(d.neurons[0].yield, null);
  });
});

describe("loadSubnetYield", () => {
  test("reads the neurons snapshot for the subnet and shapes it", async () => {
    const calls: Row[] = [];
    const runner = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [
        neuron(0, { validator: true, stake: 10, emission: 2 }),
        neuron(1, { stake: 5, emission: 3 }),
      ];
    };
    const d = await loadSubnetYield(runner, 7);
    assert.match(calls[0].sql, /FROM neurons WHERE netuid = \?/);
    assert.match(calls[0].sql, /ORDER BY uid/);
    assert.equal(calls[0].params[0], 7);
    assert.equal(d.neuron_count, 2);
    assert.equal(d.netuid, 7);
  });

  test("a cold store yields an empty card", async () => {
    const d = await loadSubnetYield(async () => [], 7);
    assert.equal(d.neuron_count, 0);
    assert.deepEqual(d.neurons, []);
  });

  test("a non-array result degrades to an empty card", async () => {
    const d = await loadSubnetYield(
      (async () => null) as unknown as Parameters<typeof loadSubnetYield>[0],
      7,
    );
    assert.deepEqual(d.neurons, []);
  });
});

describe("parseSubnetYieldHistoryWindow", () => {
  test("accepts 7d / 30d / 90d", () => {
    assert.deepEqual(parseSubnetYieldHistoryWindow("7d"), {
      label: "7d",
      days: 7,
    });
    assert.deepEqual(parseSubnetYieldHistoryWindow("30d"), {
      label: "30d",
      days: 30,
    });
    assert.deepEqual(parseSubnetYieldHistoryWindow("90d"), {
      label: "90d",
      days: 90,
    });
  });

  test("defaults a missing/blank window to 30d", () => {
    assert.equal((parseSubnetYieldHistoryWindow(undefined) as Row).days, 30);
    assert.equal((parseSubnetYieldHistoryWindow("") as Row).days, 30);
    assert.equal((parseSubnetYieldHistoryWindow(null) as Row).days, 30);
  });

  test("rejects unsupported windows (incl. the longer history windows)", () => {
    for (const bad of ["1y", "all", "bogus", "0d"]) {
      const { error } = parseSubnetYieldHistoryWindow(bad) as Row;
      assert.equal(error.parameter, "window");
      assert.match(error.message, /7d, 30d, 90d/);
    }
  });
});

describe("buildSubnetYieldHistory", () => {
  test("retains per-day counts newest first, with unqualified rates null", () => {
    // Rows arrive snapshot_date DESC; both days carry observations, but their
    // weighted stake does not qualify investment return rates.
    const rows = [
      {
        snapshot_date: "2026-06-27",
        stake_tao: 100,
        emission_tao: 10,
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-27",
        stake_tao: 100,
        emission_tao: 5,
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-26",
        stake_tao: 100,
        emission_tao: 10,
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-26",
        stake_tao: 100,
        emission_tao: 10,
        validator_permit: 0,
      },
    ];
    const data = buildSubnetYieldHistory(rows, 7, { window: "30d" }) as Row;
    assert.equal(data.schema_version, 2);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.point_count, 2);
    assert.deepEqual(
      data.points.map((point: Row) => point.snapshot_date),
      ["2026-06-27", "2026-06-26"],
    );
    assert.equal(data.points[0].neuron_count, 2);
    assert.equal(data.points[0].validator_count, 1);
    assert.deepEqual(data.degraded, { reason: "holdings_unqualified" });
    for (const point of data.points) {
      assert.equal(point.yield_count, 0);
      assert.equal(point.neuron_count, 2);
      assert.equal(point.validator_count, 1);
      assertUnknownYield(point);
    }
  });

  test("zero and nonzero weighted-stake UIDs both remain counted without yield", () => {
    const data = buildSubnetYieldHistory(
      [
        { snapshot_date: "2026-06-27", stake_tao: 100, emission_tao: 10 },
        { snapshot_date: "2026-06-27", stake_tao: 0, emission_tao: 5 }, // observed zero voting weight
      ],
      1,
      { window: "7d" },
    ) as Row;
    assert.equal(data.points[0].neuron_count, 2);
    assert.equal(data.points[0].yield_count, 0);
    assertUnknownYield(data.points[0]);
  });

  test("drops the oldest (possibly partial) day when the read was capped", () => {
    const rows = [
      { snapshot_date: "2026-06-27", stake_tao: 100, emission_tao: 10 },
      { snapshot_date: "2026-06-26", stake_tao: 100, emission_tao: 10 },
    ];
    const data = buildSubnetYieldHistory(rows, 1, {
      window: "7d",
      capped: true,
    }) as Row;
    assert.equal(data.point_count, 1);
    assert.equal(data.points[0].snapshot_date, "2026-06-27");
  });

  test("skips rows with no snapshot_date and is cold-store safe", () => {
    const data = buildSubnetYieldHistory(
      [
        { snapshot_date: null, stake_tao: 5, emission_tao: 1 },
        { snapshot_date: "2026-06-27", stake_tao: 100, emission_tao: 10 },
      ],
      3,
      { window: "30d" },
    );
    assert.equal(data.point_count, 1);
    for (const rows of [[], "nope", null]) {
      const empty = buildSubnetYieldHistory(
        rows as unknown as Parameters<typeof buildSubnetYieldHistory>[0],
        3,
        { window: "30d" },
      );
      assert.equal(empty.point_count, 0);
      assert.deepEqual(empty.points, []);
      assert.equal(empty.window, "30d");
    }
  });

  test("blank quantity cells preserve dated observations without fabricated rates", () => {
    const data = buildSubnetYieldHistory(
      [
        { snapshot_date: "2026-06-27", stake_tao: null, emission_tao: 10 },
        { snapshot_date: "2026-06-27", stake_tao: "", emission_tao: 10 },
        { snapshot_date: "2026-06-27", stake_tao: 100, emission_tao: "   " },
        {
          snapshot_date: "2026-06-27",
          stake_tao: 100,
          emission_tao: 10,
          validator_permit: 1,
        },
      ],
      7,
      { window: "7d" },
    ) as Row;
    assert.equal(data.point_count, 1);
    assert.equal(data.points[0].neuron_count, 4);
    assert.equal(data.points[0].validator_count, 1);
    assert.equal(data.points[0].yield_count, 0);
    assertUnknownYield(data.points[0]);
  });

  test("a day with zero voting weight retains counts and unknown rate metrics", () => {
    const data = buildSubnetYieldHistory(
      [{ snapshot_date: "2026-06-27", stake_tao: 0, emission_tao: 5 }],
      1,
      { window: "7d" },
    ) as Row;
    assert.equal(data.points[0].yield_count, 0);
    assert.equal(data.points[0].median_yield, null);
    assert.equal(data.points[0].mean_yield, null);
    assert.equal(data.points[0].subnet_yield, null);
    assert.equal(data.points[0].neuron_count, 1);
  });

  test("an omitted window is emitted as null", () => {
    assert.equal(buildSubnetYieldHistory([], 5).window, null);
  });
});
