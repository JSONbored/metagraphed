import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChainColdkeys,
  loadChainColdkeys,
  CHAIN_COLDKEYS_LIMIT,
} from "../src/chain-coldkeys.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// A network where ck-a runs neurons on two subnets (a validator on 1, a miner on 5), ck-b a miner
// on subnet 5, plus an unattributed (null-coldkey) neuron that stays in the totals but forms no entity.
const ROWS = [
  {
    netuid: 1,
    coldkey: "ck-a",
    stake_tao: 1000,
    emission_tao: 40,
    validator_permit: 1,
    captured_at: 1_750_000_000_000,
    block_number: 100,
  },
  {
    netuid: 5,
    coldkey: "ck-a",
    stake_tao: 200,
    emission_tao: 10,
    validator_permit: 0,
    captured_at: 1_750_000_000_000,
    block_number: 101,
  },
  {
    netuid: 5,
    coldkey: "ck-b",
    stake_tao: 300,
    emission_tao: 15,
    validator_permit: 0,
    captured_at: 1_750_000_000_000,
    block_number: 99,
  },
  {
    netuid: 5,
    coldkey: null, // unattributed
    stake_tao: 100,
    emission_tao: 5,
    validator_permit: 0,
    captured_at: 1_750_000_000_000,
    block_number: 98,
  },
];

describe("buildChainColdkeys", () => {
  test("cold / empty → schema-stable empty card", () => {
    for (const rows of [null, undefined, [], "nope"]) {
      const d = buildChainColdkeys(rows);
      assert.equal(d.schema_version, 1);
      assert.equal(d.captured_at, null);
      assert.equal(d.block_number, null);
      assert.equal(d.subnet_count, 0);
      assert.equal(d.neuron_count, Array.isArray(rows) ? rows.length : 0);
      assert.equal(d.coldkey_count, 0);
      assert.equal(d.total_stake_tao, 0);
      assert.equal(d.ownership_concentration, null);
      assert.deepEqual(d.coldkeys, []);
    }
  });

  test("rolls all neurons up by controlling coldkey with subnet reach, biggest first", () => {
    const d = buildChainColdkeys(ROWS);
    assert.equal(d.neuron_count, 4);
    assert.equal(d.subnet_count, 2); // netuids 1 and 5
    assert.equal(d.coldkey_count, 2); // ck-a, ck-b (null excluded)
    assert.equal(d.total_stake_tao, 1600); // 1000+200+300+100 (incl. unattributed)
    assert.equal(d.total_emission_tao, 70);
    assert.equal(d.captured_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(d.block_number, 101); // max block

    const [a, b] = d.coldkeys;
    assert.equal(a.coldkey, "ck-a"); // 1200 stake sorts first
    assert.equal(a.subnet_count, 2); // spans netuids 1 and 5
    assert.equal(a.uid_count, 2);
    assert.equal(a.validator_count, 1);
    assert.equal(a.miner_count, 1);
    assert.equal(a.total_stake_tao, 1200);
    assert.equal(a.stake_share, 0.75); // 1200 / 1600
    assert.equal(b.coldkey, "ck-b");
    assert.equal(b.subnet_count, 1);
    assert.equal(b.stake_share, 0.1875); // 300 / 1600
  });

  test("ownership_concentration is over the per-coldkey stakes", () => {
    const d = buildChainColdkeys(ROWS);
    assert.equal(d.ownership_concentration.holders, 2);
    assert.equal(d.ownership_concentration.total, 1500); // 1200 + 300
  });

  test("all-zero-stake network → null shares and null concentration", () => {
    const d = buildChainColdkeys([
      { netuid: 1, coldkey: "ck-a", stake_tao: 0, validator_permit: 1 },
      { netuid: 2, coldkey: "ck-b", stake_tao: 0, validator_permit: 0 },
    ]);
    assert.equal(d.coldkey_count, 2);
    assert.equal(d.total_stake_tao, 0);
    assert.equal(d.coldkeys[0].stake_share, null);
    assert.equal(d.ownership_concentration, null);
  });

  test("coerces numeric-string cells, drops junk block/captured_at, skips blank coldkey", () => {
    const d = buildChainColdkeys([
      {
        netuid: "1", // numeric string
        coldkey: "ck-a",
        stake_tao: "500",
        emission_tao: "junk", // non-numeric → 0
        validator_permit: "1", // still a validator
        captured_at: "1750000000000", // numeric-string epoch
        block_number: "9000000001", // numeric-string block (D1 INTEGER-as-string)
      },
      { netuid: "x", coldkey: "", stake_tao: 10, block_number: 9e9 }, // blank coldkey + junk netuid
      { netuid: 3, coldkey: 42, stake_tao: 5 }, // non-string coldkey → unattributed
    ]);
    assert.equal(d.coldkey_count, 1); // only ck-a
    assert.equal(d.subnet_count, 2); // netuid "1" and 3 (junk "x" dropped)
    assert.equal(d.coldkeys[0].total_stake_tao, 500);
    assert.equal(d.coldkeys[0].total_emission_tao, 0);
    assert.equal(d.coldkeys[0].validator_count, 1);
    assert.equal(d.coldkeys[0].subnet_count, 1); // ck-a only on netuid 1
    assert.equal(d.captured_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(d.block_number, 9_000_000_001); // numeric-string block coerced, max wins
    assert.equal(d.neuron_count, 3);
    assert.equal(d.total_stake_tao, 515);
  });

  test("breaks stake+uid ties by coldkey name; a negative-number block is not a height", () => {
    const d = buildChainColdkeys([
      // three coldkeys, identical stake AND uid_count, supplied out of order so the
      // coldkey-name tiebreak runs in both directions.
      {
        netuid: 1,
        coldkey: "ck-c",
        stake_tao: 100,
        validator_permit: 0,
        block_number: -5,
      },
      { netuid: 1, coldkey: "ck-a", stake_tao: 100, validator_permit: 0 },
      { netuid: 1, coldkey: "ck-b", stake_tao: 100, validator_permit: 0 },
    ]);
    assert.deepEqual(
      d.coldkeys.map((c) => c.coldkey),
      ["ck-a", "ck-b", "ck-c"],
    );
    assert.equal(d.block_number, null); // -5 rejected (a block height is >= 0)
  });

  test("a coldkey row with a junk netuid counts the neuron but adds no subnet", () => {
    const d = buildChainColdkeys([
      { netuid: 1, coldkey: "ck-a", stake_tao: 100, validator_permit: 0 },
      { netuid: "bad", coldkey: "ck-a", stake_tao: 50, validator_permit: 0 }, // junk netuid
    ]);
    assert.equal(d.coldkeys[0].uid_count, 2); // both rows counted
    assert.equal(d.coldkeys[0].subnet_count, 1); // only netuid 1 (junk dropped)
    assert.equal(d.subnet_count, 1);
  });

  test("caps the leaderboard at CHAIN_COLDKEYS_LIMIT", () => {
    const rows = Array.from({ length: CHAIN_COLDKEYS_LIMIT + 10 }, (_, i) => ({
      netuid: 1,
      coldkey: `ck-${i}`,
      stake_tao: i + 1,
      validator_permit: 0,
    }));
    const d = buildChainColdkeys(rows);
    assert.equal(d.coldkey_count, CHAIN_COLDKEYS_LIMIT + 10);
    assert.equal(d.coldkeys.length, CHAIN_COLDKEYS_LIMIT);
    assert.equal(d.coldkeys[0].coldkey, `ck-${CHAIN_COLDKEYS_LIMIT + 9}`);
  });

  test("loadChainColdkeys reads all neurons and shapes them", async () => {
    let captured;
    const d1 = async (sql) => {
      captured = sql;
      return ROWS;
    };
    const d = await loadChainColdkeys(d1);
    assert.match(captured, /FROM neurons/);
    assert.doesNotMatch(captured, /WHERE/); // network-wide read, no netuid filter
    assert.equal(d.coldkey_count, 2);
    assert.equal(d.coldkeys[0].coldkey, "ck-a");
  });
});

describe("GET /api/v1/chain/coldkeys", () => {
  function neuronsEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results:
                    /FROM neurons/.test(sql) && !/neuron_daily/.test(sql)
                      ? rows
                      : [],
                }),
            }),
          };
        },
      },
    };
  }

  test("returns the network-wide coldkeys leaderboard", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/coldkeys"),
      neuronsEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.coldkey_count, 2);
    assert.equal(body.data.subnet_count, 2);
    assert.equal(body.data.coldkeys[0].coldkey, "ck-a");
    assert.equal(body.data.coldkeys[0].stake_share, 0.75);
    assert.equal(body.meta.artifact_path, "/metagraph/chain/coldkeys.json");
  });

  test("rejects an unknown query parameter with 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/coldkeys?bogus=1"),
      neuronsEnv(ROWS),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("cold store → 200 with an empty card", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/coldkeys"),
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
