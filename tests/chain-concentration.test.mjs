import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainConcentration,
  loadChainConcentration,
} from "../src/concentration.mjs";
import { handleRequest } from "../workers/api.mjs";
import { readNeuronsCacheStamp } from "../workers/request-handlers/analytics.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// buildChainConcentration reuses the (separately tested) computeConcentration /
// groupByEntity primitives, so these tests target the NETWORK-specific wiring:
// subnet_count, the cross-subnet coldkey collapse, the validator lens, the newest
// stamp, and null-safety. A three-row, two-subnet fixture where one coldkey spans
// both subnets exercises every network-only branch at once.
const NET_ROWS = [
  {
    stake_tao: 10,
    emission_tao: 1,
    coldkey: "ck-a",
    validator_permit: 1,
    netuid: 1,
    captured_at: "2026-06-27T00:00:00Z",
  },
  {
    // same coldkey as row 1 but a DIFFERENT subnet — collapses to one entity.
    stake_tao: 20,
    emission_tao: 2,
    coldkey: "ck-a",
    validator_permit: 1,
    netuid: 2,
    captured_at: "2026-06-27T00:00:00Z",
  },
  {
    stake_tao: 30,
    emission_tao: 3,
    coldkey: "ck-b",
    validator_permit: 0,
    netuid: 2,
    captured_at: "2026-06-27T00:00:00Z",
  },
];

describe("buildChainConcentration", () => {
  test("counts distinct subnets and aggregates coldkeys across them", () => {
    const out = buildChainConcentration(NET_ROWS);
    assert.equal(out.schema_version, 1);
    assert.equal(out.subnet_count, 2); // netuids {1, 2}
    assert.equal(out.neuron_count, 3);
    assert.equal(out.entity_count, 2); // coldkeys {ck-a, ck-b}
    assert.equal(out.uids_per_entity, 1.5); // 3 / 2
    assert.equal(out.captured_at, "2026-06-27T00:00:00Z");

    // per-UID lens: three holders (10, 20, 30), total 60.
    assert.equal(out.stake.holders, 3);
    assert.equal(out.stake.total, 60);

    // entity lens: ck-a's two subnets collapse to 30, so the network control
    // distribution is a uniform {30, 30} — two holders, Gini 0.
    assert.equal(out.entity_stake.holders, 2);
    assert.equal(out.entity_stake.total, 60);
    assert.equal(out.entity_stake.gini, 0);
    assert.equal(out.entity_emission.holders, 2);
    assert.equal(out.entity_emission.total, 6);

    // validator lens: only the two permit=1 rows (10 + 20 = 30).
    assert.equal(out.validator_stake.holders, 2);
    assert.equal(out.validator_stake.total, 30);
  });

  test("takes the newest captured_at across mixed epoch-ms / ISO stamps", () => {
    const out = buildChainConcentration([
      { stake_tao: 5, coldkey: "a", netuid: 1, captured_at: 1_700_000_000_000 },
      { stake_tao: 5, coldkey: "b", netuid: 1, captured_at: 1_700_000_001_000 },
    ]);
    assert.equal(out.captured_at, new Date(1_700_000_001_000).toISOString());
  });

  test("validator lens is null when no UID holds a validator permit", () => {
    const out = buildChainConcentration([
      { stake_tao: 10, coldkey: "a", validator_permit: 0, netuid: 1 },
      { stake_tao: 20, coldkey: "b", validator_permit: 0, netuid: 1 },
    ]);
    assert.equal(out.validator_stake, null);
    assert.equal(out.stake.holders, 2);
  });

  test("coerces string netuid cells and rejects blank/null/invalid ones", () => {
    const out = buildChainConcentration([
      { stake_tao: 1, coldkey: "a", netuid: "5" }, // numeric string from D1
      { stake_tao: 1, coldkey: "b", netuid: 5 }, // same subnet, not double-counted
      { stake_tao: 1, coldkey: "c", netuid: null }, // never counts as subnet 0
      { stake_tao: 1, coldkey: "d" }, // missing netuid entirely
      { stake_tao: 1, coldkey: "e", netuid: -3 }, // negative -> rejected by the >=0 guard
      { stake_tao: 1, coldkey: "f", netuid: "x" }, // non-numeric -> NaN, rejected by isInteger
    ]);
    assert.equal(out.subnet_count, 1); // still only subnet 5
  });

  test("is schema-stable-zero on a cold store (no rows)", () => {
    assert.deepEqual(buildChainConcentration([]), {
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      entity_count: 0,
      uids_per_entity: null,
      captured_at: null,
      stake: null,
      emission: null,
      entity_stake: null,
      entity_emission: null,
      validator_stake: null,
    });
  });

  test("treats a non-array argument as a cold store", () => {
    const out = buildChainConcentration(null);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.stake, null);
  });

  test("tolerates junk rows (null, non-object) and still measures the real ones", () => {
    const out = buildChainConcentration([
      null,
      "nope",
      {
        stake_tao: 10,
        emission_tao: 1,
        coldkey: "ck-a",
        netuid: 1,
        captured_at: "2026-06-27T00:00:00Z",
      },
    ]);
    assert.equal(out.subnet_count, 1);
    assert.equal(out.stake.holders, 1);
    assert.equal(out.stake.total, 10);
    assert.equal(out.captured_at, "2026-06-27T00:00:00Z");
  });
});

describe("loadChainConcentration", () => {
  // A D1 stub that records the SQL/params so the read shape can be asserted.
  function captureD1(rows = []) {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return rows;
    };
    return { d1, calls };
  }

  test("reads every subnet's neurons in one pass — no netuid filter", async () => {
    const { d1, calls } = captureD1([
      {
        stake_tao: 100,
        emission_tao: 2,
        coldkey: "ck-a",
        validator_permit: 1,
        netuid: 1,
        captured_at: "2026-06-27T00:00:00Z",
      },
      {
        stake_tao: 50,
        emission_tao: 1,
        coldkey: "ck-b",
        validator_permit: 0,
        netuid: 2,
        captured_at: "2026-06-27T00:00:00Z",
      },
    ]);
    const data = await loadChainConcentration(d1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM neurons/);
    // whole network, not one subnet: no WHERE/netuid filter, no bound params.
    assert.doesNotMatch(calls[0].sql, /WHERE/);
    assert.deepEqual(calls[0].params, []);
    assert.equal(data.subnet_count, 2);
    assert.equal(data.stake.holders, 2);
  });

  test("returns a schema-stable null block on a cold D1", async () => {
    const { d1 } = captureD1([]);
    const data = await loadChainConcentration(d1);
    assert.equal(data.subnet_count, 0);
    assert.equal(data.neuron_count, 0);
    assert.equal(data.stake, null);
    assert.equal(data.validator_stake, null);
  });
});

describe("GET /api/v1/chain/concentration", () => {
  // A METAGRAPH_HEALTH_DB stub: the MAX(captured_at) cache stamp and the network
  // neurons read both hit `FROM neurons`, so route the stamp query first.
  function neuronsEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                all: () =>
                  Promise.resolve({
                    results: /MAX\(captured_at\)/.test(sql)
                      ? [{ captured_at: 1_700_000_000_000 }]
                      : rows,
                  }),
              };
            },
          };
        },
      },
    };
  }

  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/concentration${q}`);

  test("aggregates the neurons tier across all subnets", async () => {
    const res = await handleRequest(
      req(),
      neuronsEnv([
        {
          stake_tao: 10,
          emission_tao: 1,
          coldkey: "ck-a",
          validator_permit: 1,
          netuid: 1,
          captured_at: 1_700_000_000_000,
        },
        {
          stake_tao: 20,
          emission_tao: 2,
          coldkey: "ck-b",
          validator_permit: 0,
          netuid: 2,
          captured_at: 1_700_000_000_000,
        },
      ]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 2);
    assert.equal(body.data.neuron_count, 2);
    assert.equal(body.data.entity_count, 2);
    assert.equal(body.data.stake.holders, 2);
    assert.equal(body.data.stake.total, 30);
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(req("?window=7d"), neuronsEnv([]), {});
    assert.equal(res.status, 400);
  });
});

describe("readNeuronsCacheStamp", () => {
  function stampEnv(results) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return { bind: () => ({ all: () => Promise.resolve({ results }) }) };
        },
      },
    };
  }

  test("returns the newest captured_at across all subnets as a string", async () => {
    const stamp = await readNeuronsCacheStamp(
      stampEnv([{ captured_at: 1_700_000_000_000 }]),
    );
    assert.equal(stamp, "1700000000000");
  });

  test("returns null on a cold store (null or non-positive stamp)", async () => {
    assert.equal(
      await readNeuronsCacheStamp(stampEnv([{ captured_at: null }])),
      null,
    );
    assert.equal(
      await readNeuronsCacheStamp(stampEnv([{ captured_at: 0 }])),
      null,
    );
  });

  test("returns null when D1 is unbound (fallback rows)", async () => {
    assert.equal(await readNeuronsCacheStamp({}), null);
  });
});

describe("chain/concentration edge cache", () => {
  let originalCaches;
  afterEach(() => {
    globalThis.caches = originalCaches;
  });

  // A Map-backed stand-in for the Workers cache so withEdgeCache actually engages
  // and invokes the neurons stamp resolver (mirrors analytics-edge-cache.test).
  function neuronsEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /MAX\(captured_at\)/.test(sql)
                    ? [{ captured_at: 1_700_000_000_000 }]
                    : rows,
                }),
            }),
          };
        },
      },
    };
  }

  test("engages the edge cache, busting on the newest neuron captured_at", async () => {
    originalCaches = globalThis.caches;
    const store = new Map();
    globalThis.caches = {
      default: {
        async match(request) {
          const cached = store.get(request.url);
          return cached ? cached.clone() : undefined;
        },
        async put(request, response) {
          store.set(request.url, response.clone());
        },
      },
    };
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/concentration"),
      neuronsEnv([
        {
          stake_tao: 10,
          emission_tao: 1,
          coldkey: "ck-a",
          validator_permit: 1,
          netuid: 1,
          captured_at: 1_700_000_000_000,
        },
      ]),
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    // A non-null stamp resolver + 200 means the response was cached: proof the
    // stamp resolver arrow ran and returned the network captured_at.
    assert.equal(store.size, 1);
  });
});
