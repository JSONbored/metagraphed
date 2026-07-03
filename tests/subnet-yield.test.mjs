import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSubnetYield, loadSubnetYield } from "../src/subnet-yield.mjs";

const CAPTURED = 1717000000000;

// One neurons-snapshot row.
function neuron(
  uid,
  {
    validator = false,
    stake,
    emission,
    captured = CAPTURED,
    block = 5000,
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

describe("buildSubnetYield", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const rows of [[], null, undefined]) {
      const d = buildSubnetYield(rows, 7);
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.captured_at, null);
      assert.equal(d.block_number, null);
      assert.equal(d.neuron_count, 0);
      assert.equal(d.validator_count, 0);
      assert.equal(d.miner_count, 0);
      assert.equal(d.total_stake_tao, 0);
      assert.equal(d.subnet_yield, null);
      assert.equal(d.mean_yield, null);
      assert.equal(d.median_yield, null);
      assert.equal(d.p25_yield, null);
      assert.deepEqual(d.neurons, []);
    }
  });

  const set = [
    neuron(0, { validator: true, stake: 10, emission: 1 }), // yield 0.1
    neuron(1, { validator: true, stake: 10, emission: 2 }), // yield 0.2
    neuron(2, { stake: 10, emission: 3 }), // miner, yield 0.3
    neuron(3, { stake: 10, emission: 4 }), // miner, yield 0.4
  ];

  test("computes per-UID yield, role split, totals, and subnet aggregate yield", () => {
    const d = buildSubnetYield(set, 7);
    assert.equal(d.neuron_count, 4);
    assert.equal(d.validator_count, 2);
    assert.equal(d.miner_count, 2);
    assert.equal(d.total_stake_tao, 40);
    assert.equal(d.total_emission_tao, 10);
    assert.equal(d.subnet_yield, 0.25); // 10/40
    assert.equal(d.captured_at, new Date(CAPTURED).toISOString());
    assert.equal(d.block_number, 5000);
    const u3 = d.neurons.find((n) => n.uid === 3);
    assert.equal(u3.yield, 0.4);
    assert.equal(u3.role, "miner");
  });

  test("computes mean, conventional median, and nearest-rank percentiles", () => {
    const d = buildSubnetYield(set, 7);
    assert.equal(d.mean_yield, 0.25); // (0.1+0.2+0.3+0.4)/4
    assert.equal(d.median_yield, 0.25); // even count -> (0.2+0.3)/2
    assert.equal(d.p25_yield, 0.1); // p25/p75/p90 stay nearest-rank
    assert.equal(d.p75_yield, 0.3);
    assert.equal(d.p90_yield, 0.4);
  });

  test("labels each UID above/below/at the median and ranks by yield desc", () => {
    // Odd count so the median is a real UID's yield, exercising all three labels.
    const d = buildSubnetYield(
      [
        neuron(0, { stake: 10, emission: 1 }), // yield 0.1
        neuron(1, { stake: 10, emission: 2 }), // yield 0.2 (== median)
        neuron(2, { stake: 10, emission: 3 }), // yield 0.3
      ],
      7,
    );
    assert.equal(d.median_yield, 0.2); // odd count -> middle value
    assert.deepEqual(
      d.neurons.map((n) => n.uid),
      [2, 1, 0], // yield desc
    );
    assert.equal(d.neurons.find((n) => n.uid === 0).vs_median, "below");
    assert.equal(d.neurons.find((n) => n.uid === 1).vs_median, "at");
    assert.equal(d.neurons.find((n) => n.uid === 2).vs_median, "above");
  });

  test("median averages the two middle values for an even count (not lower-middle)", () => {
    const d = buildSubnetYield(
      [
        neuron(0, { stake: 10, emission: 2 }), // yield 0.2
        neuron(1, { stake: 10, emission: 4 }), // yield 0.4
      ],
      7,
    );
    assert.equal(d.median_yield, 0.3); // (0.2 + 0.4) / 2, not the lower-middle 0.2
    assert.equal(d.neurons.find((n) => n.uid === 0).vs_median, "below"); // 0.2 < 0.3
    assert.equal(d.neurons.find((n) => n.uid === 1).vs_median, "above"); // 0.4 > 0.3
  });

  test("zero-stake UIDs get a null yield, are excluded from the distribution, and sink last", () => {
    const d = buildSubnetYield(
      [
        neuron(0, { validator: true, stake: 10, emission: 2 }), // yield 0.2
        neuron(1, { stake: 0, emission: 5 }), // no stake -> null yield
      ],
      7,
    );
    const u1 = d.neurons.find((n) => n.uid === 1);
    assert.equal(u1.yield, null);
    assert.equal(u1.vs_median, null);
    assert.equal(d.neurons[d.neurons.length - 1].uid, 1); // sinks to the bottom
    assert.equal(d.median_yield, 0.2); // only the defined yield counts
  });

  test("skips a malformed uid and coerces non-numeric stake/emission/stamp to 0/null", () => {
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
    );
    assert.equal(d.neuron_count, 1); // only uid 2 survived
    assert.equal(d.total_stake_tao, 0); // non-numeric -> 0
    assert.equal(d.neurons[0].yield, null); // 0 stake -> null
    assert.equal(d.captured_at, null); // non-finite stamp -> null
    assert.equal(d.block_number, null); // non-finite block -> null
  });

  test("a null D1 block_number stays null, not a fabricated genesis 0", () => {
    // block_number is a nullable INTEGER; Number(null) === 0 must not surface
    // as the real chain height 0 (the contract models it as ["integer","null"]).
    const d = buildSubnetYield(
      [neuron(0, { validator: true, stake: 10, emission: 1, block: null })],
      7,
    );
    assert.equal(d.block_number, null);
  });

  test("coerces string-typed captured_at cells to ISO timestamps", () => {
    const d = buildSubnetYield(
      [
        neuron(0, {
          validator: true,
          stake: 10,
          emission: 1,
          captured: "1717000000000",
        }),
      ],
      7,
    );
    assert.equal(d.captured_at, new Date(1717000000000).toISOString());
  });

  test("a null D1 captured_at stays null, not a fabricated epoch 1970", () => {
    const d = buildSubnetYield(
      [neuron(0, { validator: true, stake: 10, emission: 1, captured: null })],
      7,
    );
    assert.equal(d.captured_at, null);
  });

  test("drops blank or out-of-range captured_at strings to null", () => {
    for (const captured of ["", "   ", "not-a-date", "8640000000000001"]) {
      const d = buildSubnetYield(
        [neuron(0, { validator: true, stake: 10, emission: 1, captured })],
        7,
      );
      assert.equal(d.captured_at, null, `captured=${JSON.stringify(captured)}`);
    }
  });

  test("ties break by uid, extra zero-stake UIDs sink, and a missing hotkey is null", () => {
    const d = buildSubnetYield(
      [
        neuron(5, { stake: 10, emission: 2 }), // yield 0.2
        neuron(2, { stake: 5, emission: 1 }), // yield 0.2 (ties uid 5)
        { uid: 7, stake_tao: 0, emission_tao: 1 }, // null yield, no hotkey field
        neuron(9, { stake: 0, emission: 3 }), // null yield
      ],
      7,
    );
    // equal yields rank by uid ascending
    const defined = d.neurons.filter((n) => n.yield != null).map((n) => n.uid);
    assert.deepEqual(defined, [2, 5]);
    // both null-yield UIDs sink to the bottom
    const tail = d.neurons
      .slice(-2)
      .map((n) => n.uid)
      .sort((a, b) => a - b);
    assert.deepEqual(tail, [7, 9]);
    // a row with no hotkey field -> null
    assert.equal(d.neurons.find((n) => n.uid === 7).hotkey, null);
  });

  test("reads validator_permit as SQLite 0/1: a numeric-string '0' stays a miner", () => {
    const d = buildSubnetYield(
      [
        { uid: 0, validator_permit: "0", stake_tao: 10, emission_tao: 1 },
        { uid: 1, validator_permit: 1, stake_tao: 10, emission_tao: 1 },
      ],
      7,
    );
    assert.equal(d.validator_count, 1);
    assert.equal(d.miner_count, 1);
    assert.equal(d.neurons.find((n) => n.uid === 0).role, "miner");
    assert.equal(d.neurons.find((n) => n.uid === 1).role, "validator");
  });

  test("rounds tao + yield to rao precision", () => {
    const d = buildSubnetYield(
      [neuron(0, { stake: 3, emission: 1 })], // yield 0.333333333
      7,
    );
    assert.equal(d.neurons[0].yield, 0.333333333);
  });
});

describe("loadSubnetYield", () => {
  test("reads the neurons snapshot for the subnet and shapes it", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        neuron(0, { validator: true, stake: 10, emission: 2 }),
        neuron(1, { stake: 5, emission: 3 }),
      ];
    };
    const d = await loadSubnetYield(d1, 7);
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
    const d = await loadSubnetYield(async () => null, 7);
    assert.deepEqual(d.neurons, []);
  });
});
