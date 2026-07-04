import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetColdkeys,
  loadSubnetColdkeys,
  SUBNET_COLDKEYS_LIMIT,
} from "../src/subnet-coldkeys.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const NETUID = 7;

// A subnet where coldkey ck-a controls two UIDs (a validator + a miner) and ck-b one miner,
// plus an unattributed (null-coldkey) neuron that stays in the subnet totals but forms no entity.
const ROWS = [
  {
    coldkey: "ck-a",
    stake_tao: 1000,
    emission_tao: 40,
    validator_permit: 1,
    captured_at: 1_750_000_000_000,
    block_number: 100,
  },
  {
    coldkey: "ck-a",
    stake_tao: 200,
    emission_tao: 10,
    validator_permit: 0,
    captured_at: 1_750_000_000_000,
    block_number: 101,
  },
  {
    coldkey: "ck-b",
    stake_tao: 300,
    emission_tao: 15,
    validator_permit: 0,
    captured_at: 1_750_000_000_000,
    block_number: 99,
  },
  {
    coldkey: null, // unattributed neuron
    stake_tao: 100,
    emission_tao: 5,
    validator_permit: 0,
    captured_at: 1_750_000_000_000,
    block_number: 98,
  },
];

describe("buildSubnetColdkeys", () => {
  test("cold / empty → schema-stable empty card", () => {
    for (const rows of [null, undefined, [], "nope"]) {
      const d = buildSubnetColdkeys(rows, NETUID);
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, NETUID);
      assert.equal(d.captured_at, null);
      assert.equal(d.block_number, null);
      assert.equal(d.neuron_count, Array.isArray(rows) ? rows.length : 0);
      assert.equal(d.coldkey_count, 0);
      assert.equal(d.total_stake_tao, 0);
      assert.equal(d.ownership_concentration, null); // no positive stake
      assert.deepEqual(d.coldkeys, []);
    }
  });

  test("rolls neurons up by controlling coldkey, biggest owner first", () => {
    const d = buildSubnetColdkeys(ROWS, NETUID);
    assert.equal(d.neuron_count, 4); // all rows, incl. the unattributed one
    assert.equal(d.coldkey_count, 2); // ck-a, ck-b (null excluded)
    assert.equal(d.total_stake_tao, 1600); // 1000+200+300+100 (incl. unattributed)
    assert.equal(d.total_emission_tao, 70);
    assert.equal(d.captured_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(d.block_number, 101); // max block across rows

    const [a, b] = d.coldkeys;
    assert.equal(a.coldkey, "ck-a"); // 1200 stake sorts first
    assert.equal(a.uid_count, 2);
    assert.equal(a.validator_count, 1);
    assert.equal(a.miner_count, 1);
    assert.equal(a.total_stake_tao, 1200);
    assert.equal(a.total_emission_tao, 50);
    assert.equal(a.stake_share, 0.75); // 1200 / 1600
    assert.equal(b.coldkey, "ck-b");
    assert.equal(b.uid_count, 1);
    assert.equal(b.stake_share, 0.1875); // 300 / 1600
  });

  test("ownership_concentration is over the per-coldkey stakes", () => {
    const d = buildSubnetColdkeys(ROWS, NETUID);
    assert.equal(d.ownership_concentration.holders, 2); // ck-a, ck-b
    assert.equal(d.ownership_concentration.total, 1500); // 1200 + 300
  });

  test("all-zero-stake subnet → null shares and null concentration", () => {
    const d = buildSubnetColdkeys(
      [
        { coldkey: "ck-a", stake_tao: 0, emission_tao: 0, validator_permit: 1 },
        { coldkey: "ck-b", stake_tao: 0, emission_tao: 0, validator_permit: 0 },
      ],
      NETUID,
    );
    assert.equal(d.coldkey_count, 2);
    assert.equal(d.total_stake_tao, 0);
    assert.equal(d.coldkeys[0].stake_share, null);
    assert.equal(d.ownership_concentration, null);
  });

  test("coerces numeric-string cells, drops junk block/captured_at, skips blank coldkey", () => {
    const d = buildSubnetColdkeys(
      [
        {
          coldkey: "ck-a",
          stake_tao: "500", // numeric string
          emission_tao: "junk", // non-numeric → 0
          validator_permit: "1", // still counts as validator
          captured_at: "1750000000000", // numeric-string epoch
          block_number: "9000000001", // numeric-string block (D1 INTEGER-as-string)
        },
        {
          coldkey: "", // blank coldkey → unattributed, skipped as an entity
          stake_tao: 10,
          block_number: 9e9, // large but valid integer
        },
        { coldkey: 42, stake_tao: 5 }, // non-string coldkey → unattributed, no block
      ],
      NETUID,
    );
    assert.equal(d.coldkey_count, 1); // only ck-a
    assert.equal(d.coldkeys[0].total_stake_tao, 500);
    assert.equal(d.coldkeys[0].total_emission_tao, 0); // junk emission → 0
    assert.equal(d.coldkeys[0].validator_count, 1); // "1" permit
    assert.equal(d.captured_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(d.block_number, 9_000_000_001); // numeric-string block coerced, max wins
    assert.equal(d.neuron_count, 3); // all rows counted
    assert.equal(d.total_stake_tao, 515); // 500 + 10 + 5
  });

  test("caps the leaderboard at SUBNET_COLDKEYS_LIMIT", () => {
    const rows = Array.from({ length: SUBNET_COLDKEYS_LIMIT + 10 }, (_, i) => ({
      coldkey: `ck-${i}`,
      stake_tao: i + 1,
      emission_tao: 0,
      validator_permit: 0,
    }));
    const d = buildSubnetColdkeys(rows, NETUID);
    assert.equal(d.coldkey_count, SUBNET_COLDKEYS_LIMIT + 10); // all counted
    assert.equal(d.coldkeys.length, SUBNET_COLDKEYS_LIMIT); // but leaderboard capped
    assert.equal(d.coldkeys[0].coldkey, `ck-${SUBNET_COLDKEYS_LIMIT + 9}`); // biggest first
  });

  test("loadSubnetColdkeys reads neurons for the netuid and shapes them", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return ROWS;
    };
    const d = await loadSubnetColdkeys(d1, NETUID);
    assert.match(captured.sql, /FROM neurons WHERE netuid = \?/);
    assert.deepEqual(captured.params, [NETUID]);
    assert.equal(d.coldkey_count, 2);
    assert.equal(d.coldkeys[0].coldkey, "ck-a");
  });
});

describe("GET /api/v1/subnets/{netuid}/coldkeys", () => {
  function neuronsEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /FROM neurons WHERE netuid/.test(sql) ? rows : [],
                }),
            }),
          };
        },
      },
    };
  }

  test("returns the coldkey ownership leaderboard", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/subnets/${NETUID}/coldkeys`),
      neuronsEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.coldkey_count, 2);
    assert.equal(body.data.coldkeys[0].coldkey, "ck-a");
    assert.equal(body.data.coldkeys[0].stake_share, 0.75);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/coldkeys.json`,
    );
  });

  test("rejects an unknown query parameter with 400", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/subnets/${NETUID}/coldkeys?bogus=1`,
      ),
      neuronsEnv(ROWS),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("cold store → 200 with an empty card", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/subnets/${NETUID}/coldkeys`),
      neuronsEnv([]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.coldkey_count, 0);
    assert.deepEqual(body.data.coldkeys, []);
    assert.equal(body.data.ownership_concentration, null);
  });
});
