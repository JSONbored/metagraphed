import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatNeuron,
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildNeuronDetail,
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

  test("buildNeuronDetail returns neuron:null for a cold/absent row", () => {
    assert.equal(buildNeuronDetail(null, 7).neuron, null);
    assert.equal(buildNeuronDetail(ROW, 7).neuron.uid, 0);
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
