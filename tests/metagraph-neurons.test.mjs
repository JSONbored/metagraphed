import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatNeuron,
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildNeuronDetail,
  loadSubnetValidators,
} from "../src/metagraph-neurons.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// A D1 `neurons` row (booleans as 0/1 INTEGER, stake/emission already TAO floats).
const ROW = {
  uid: 0,
  hotkey: "5Hk1",
  coldkey: "5Co1",
  active: 1,
  validator_permit: 1,
  rank: 1,
  trust: 0.5,
  validator_trust: 0.99,
  consensus: 0.4,
  incentive: 0.1,
  dividends: 0.2,
  emission_tao: 22.1,
  stake_tao: 1000.5,
  registered_at_block: 6702485,
  is_immunity_period: 0,
  axon: "1.2.3.4:8091",
  block_number: 8454388,
  captured_at: 1750000000000,
};
const MINER = { ...ROW, uid: 5, validator_permit: 0, hotkey: "5Hk5" };

describe("metagraph-neurons builders", () => {
  test("formatNeuron coerces 0/1 INTEGER flags to real booleans", () => {
    const n = formatNeuron(ROW);
    assert.equal(n.active, true);
    assert.equal(n.validator_permit, true);
    assert.equal(n.is_immunity_period, false);
    assert.equal(n.stake_tao, 1000.5);
    assert.equal(n.hotkey, "5Hk1");
    assert.equal(n.axon, "1.2.3.4:8091");
  });

  test("formatNeuron is null-safe", () => {
    assert.equal(formatNeuron(null), null);
    assert.equal(formatNeuron(undefined), null);
  });

  test("formatNeuron defaults every missing field to null/false", () => {
    // Exercises the ?? null + Boolean(falsy) branches (sparse chain row).
    const n = formatNeuron({ uid: 3 });
    assert.equal(n.uid, 3);
    assert.equal(n.hotkey, null);
    assert.equal(n.coldkey, null);
    assert.equal(n.rank, null);
    assert.equal(n.trust, null);
    assert.equal(n.validator_trust, null);
    assert.equal(n.consensus, null);
    assert.equal(n.incentive, null);
    assert.equal(n.dividends, null);
    assert.equal(n.emission_tao, null);
    assert.equal(n.stake_tao, null);
    assert.equal(n.registered_at_block, null);
    assert.equal(n.axon, null);
    assert.equal(n.active, false);
    assert.equal(n.validator_permit, false);
    assert.equal(n.is_immunity_period, false);
  });

  test("buildSubnetMetagraph stamps count + ISO captured_at", () => {
    const data = buildSubnetMetagraph([ROW, MINER], 7);
    assert.equal(data.netuid, 7);
    assert.equal(data.neuron_count, 2);
    assert.equal(data.block_number, 8454388);
    assert.equal(typeof data.captured_at, "string"); // epoch ms → ISO
    assert.equal(data.neurons.length, 2);
    // empty snapshot → schema-stable empty payload (cold-store safe).
    const empty = buildSubnetMetagraph([], 7);
    assert.equal(empty.neuron_count, 0);
    assert.equal(empty.captured_at, null);
    assert.deepEqual(empty.neurons, []);
  });

  test("buildSubnetValidators counts validators", () => {
    const data = buildSubnetValidators([ROW], 7);
    assert.equal(data.validator_count, 1);
    assert.equal(data.validators[0].validator_permit, true);
  });

  test("builders drop malformed rows and count only real neurons", () => {
    // A null/non-object row can't be a Neuron, so it must not leak into the
    // array — and the count tracks the array (neuron_count === neurons.length),
    // matching the blocks/extrinsics feed builders' .filter(Boolean).
    const data = buildSubnetMetagraph([ROW, null, MINER, undefined], 7);
    assert.equal(data.neurons.length, 2);
    assert.equal(data.neuron_count, 2);
    assert.ok(data.neurons.every(Boolean));
    const vals = buildSubnetValidators([ROW, null], 7);
    assert.equal(vals.validators.length, 1);
    assert.equal(vals.validator_count, 1);
  });

  test("buildNeuronDetail returns neuron:null for a cold/absent row", () => {
    assert.equal(buildNeuronDetail(null, 7).neuron, null);
    assert.equal(buildNeuronDetail(ROW, 7).neuron.uid, 0);
  });
});

describe("metagraph-neurons loaders", () => {
  // A d1 runner that filters by validator_permit and APPLIES the SQL's ORDER BY
  // (parsing the real clause), so a missing tie-break would actually reorder the
  // result — not a circular check that passes regardless.
  function orderingD1(rows) {
    return async (sql) => {
      let r = rows.filter((x) => x.validator_permit === 1);
      const order = /ORDER BY (.+?)(?:$|\bLIMIT\b)/.exec(sql);
      if (order) {
        const keys = order[1]
          .split(",")
          .map((part) => part.trim().split(/\s+/));
        r = [...r].sort((a, b) => {
          for (const [col, dir] of keys) {
            const delta = (a[col] - b[col]) * (dir === "DESC" ? -1 : 1);
            if (delta !== 0) return delta;
          }
          return 0;
        });
      }
      return r;
    };
  }

  test("loadSubnetValidators ranks by stake, breaking equal-stake ties by uid", async () => {
    const d1 = orderingD1([
      { uid: 9, validator_permit: 1, stake_tao: 100 },
      { uid: 2, validator_permit: 1, stake_tao: 100 }, // tie with uid 9
      { uid: 5, validator_permit: 1, stake_tao: 250 },
      { uid: 4, validator_permit: 0, stake_tao: 999 }, // not a validator
    ]);
    const data = await loadSubnetValidators(d1, 7);
    // 250 first; the two 100-stake validators tie → uid ascending (2 before 9).
    assert.deepEqual(
      data.validators.map((v) => v.uid),
      [5, 2, 9],
    );
    assert.equal(data.validator_count, 3); // the miner is excluded
  });
});

// D1 mock honoring the handlers' WHERE clauses.
function neuronsD1(rows) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            all() {
              let r = rows;
              if (sql.includes("validator_permit = 1")) {
                r = r.filter((x) => x.validator_permit === 1);
              }
              if (sql.includes("AND uid = ?")) {
                r = r.filter((x) => x.uid === params[1]);
              }
              return Promise.resolve({ results: r });
            },
          };
        },
      };
    },
  };
}

const getJson = async (path, env) => {
  const res = await handleRequest(
    new Request(`https://api.metagraph.sh${path}`),
    env,
    {},
  );
  return { res, body: await res.json() };
};

describe("metagraph routes (#1304/#1305) via the Worker", () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: neuronsD1([ROW, MINER]),
  };

  test("GET /subnets/{n}/metagraph returns all neurons", async () => {
    const { res, body } = await getJson("/api/v1/subnets/7/metagraph", env);
    assert.equal(res.status, 200);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.neuron_count, 2);
    assert.equal(body.data.neurons[0].validator_permit, true);
  });

  test("?validator_permit=true filters to validators", async () => {
    const { body } = await getJson(
      "/api/v1/subnets/7/metagraph?validator_permit=true",
      env,
    );
    assert.equal(body.data.neurons.length, 1);
    assert.equal(body.data.neurons[0].uid, 0);
  });

  test("GET /subnets/{n}/concentration computes per-UID, entity, and validator metrics", async () => {
    const { res, body } = await getJson("/api/v1/subnets/7/concentration", env);
    assert.equal(res.status, 200);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.neuron_count, 2);
    assert.equal(body.data.stake.holders, 2); // 2 UIDs
    assert.equal(body.data.emission.holders, 2);
    // ROW + MINER share coldkey "5Co1" → one controlling entity.
    assert.equal(body.data.entity_count, 1);
    assert.equal(body.data.uids_per_entity, 2);
    assert.equal(body.data.entity_stake.holders, 1);
    // Only ROW carries a validator permit.
    assert.equal(body.data.validator_stake.holders, 1);
    assert.equal(typeof body.data.stake.gini, "number");
    assert.equal(typeof body.data.stake.nakamoto_coefficient, "number");
  });

  test("GET /subnets/{n}/concentration/history routes to the trend handler", async () => {
    const dailyEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: neuronsD1([
        { snapshot_date: "2026-06-27", stake_tao: 100, emission_tao: 5 },
        { snapshot_date: "2026-06-27", stake_tao: 1, emission_tao: 1 },
      ]),
    };
    const { res, body } = await getJson(
      "/api/v1/subnets/7/concentration/history?window=7d",
      dailyEnv,
    );
    assert.equal(res.status, 200);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "7d");
    assert.equal(Array.isArray(body.data.points), true);
    assert.equal(body.data.point_count, 1); // both rows share one snapshot_date
  });

  test("GET /subnets/{n}/turnover routes to the turnover handler", async () => {
    // Two-query handler: a MIN/MAX boundary probe, then the boundary rows.
    const turnoverEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                all() {
                  if (/MIN\(snapshot_date\)/.test(sql)) {
                    return Promise.resolve({
                      results: [
                        { start_date: "2026-05-28", end_date: "2026-06-27" },
                      ],
                    });
                  }
                  return Promise.resolve({
                    results: [
                      {
                        snapshot_date: "2026-05-28",
                        uid: 0,
                        hotkey: "V1",
                        validator_permit: 1,
                      },
                      {
                        snapshot_date: "2026-06-27",
                        uid: 0,
                        hotkey: "V1",
                        validator_permit: 1,
                      },
                    ],
                  });
                },
              };
            },
          };
        },
      },
    };
    const { res, body } = await getJson(
      "/api/v1/subnets/7/turnover?window=30d",
      turnoverEnv,
    );
    assert.equal(res.status, 200);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.comparable, true);
    assert.equal(body.data.validators_start, 1);
  });

  test("GET /subnets/{n}/stake-flow routes to the stake-flow handler", async () => {
    const stakeFlowEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                all() {
                  if (/SUM\(amount_tao\)/.test(sql)) {
                    return Promise.resolve({
                      results: [
                        {
                          event_kind: "StakeAdded",
                          total_tao: 300,
                          event_count: 6,
                          last_observed: 1717900000000,
                        },
                        {
                          event_kind: "StakeRemoved",
                          total_tao: 100,
                          event_count: 3,
                          last_observed: 1717800000000,
                        },
                      ],
                    });
                  }
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
    };
    const { res, body } = await getJson(
      "/api/v1/subnets/7/stake-flow?window=30d",
      stakeFlowEnv,
    );
    assert.equal(res.status, 200);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.total_staked_tao, 300);
    assert.equal(body.data.total_unstaked_tao, 100);
    assert.equal(body.data.net_flow_tao, 200);
    // account_events provenance + newest event timestamp in the window.
    assert.equal(body.meta.source, "chain-events");
    assert.equal(body.meta.generated_at, 1717900000000);
  });

  test("GET /subnets/{n}/validators returns only validators", async () => {
    const { body } = await getJson("/api/v1/subnets/7/validators", env);
    assert.equal(body.data.validator_count, 1);
    assert.equal(body.data.validators[0].validator_permit, true);
  });

  test("GET /subnets/{n}/neurons/{uid} returns the neuron", async () => {
    const { res, body } = await getJson("/api/v1/subnets/7/neurons/0", env);
    assert.equal(res.status, 200);
    assert.equal(body.data.neuron.uid, 0);
  });

  test("GET /subnets/{n}/neurons/{uid} for an absent uid → 200 neuron:null", async () => {
    const { res, body } = await getJson("/api/v1/subnets/7/neurons/999", env);
    assert.equal(res.status, 200);
    assert.equal(body.data.neuron, null);
  });

  test("an unsupported query param → 400", async () => {
    const { res } = await getJson("/api/v1/subnets/7/metagraph?bogus=1", env);
    assert.equal(res.status, 400);
  });
});
