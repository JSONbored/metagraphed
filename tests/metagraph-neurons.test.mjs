import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatNeuron,
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildGlobalValidators,
  buildNeuronDetail,
  loadSubnetValidators,
  loadGlobalValidators,
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

  test("formatNeuron coerces string-typed D1 0/1 flags to real booleans", () => {
    // D1 can return an INTEGER flag column as a numeric string ("0"/"1"); the
    // bare Boolean() this replaced would have leaked Boolean("0") === true
    // and Boolean("") === false, so a string "0" flag would silently surface
    // as `active: true`. Same class as the formatRegistration fix in #2487.
    const n = formatNeuron({
      active: "0",
      validator_permit: "1",
      is_immunity_period: "0",
    });
    assert.equal(n.active, false);
    assert.equal(n.validator_permit, true);
    assert.equal(n.is_immunity_period, false);
  });

  test("formatNeuron coerces string-typed uid/registered_at_block, stake/emission, and ratio cells", () => {
    // D1 can return INTEGER / REAL columns as numeric strings ("3" not 3,
    // "1000.5" not 1000.5); the bare `?? null` pass-through this replaced would
    // have leaked strings into the API payload. Same shape as the coercion in
    // blocks.mjs (#2435), extrinsics.mjs (#2439), and account-events.mjs
    // (#2481, #2489). stake/emission additionally round to rao precision so
    // accumulated IEEE-754 float noise never reaches the payload. Ratio fields
    // use nullableNumber + round, matching buildGlobalValidators (#2611).
    const n = formatNeuron({
      uid: "3",
      registered_at_block: "6702485",
      stake_tao: "1000.5",
      emission_tao: "22.123456789",
      rank: "12",
      trust: "0.25",
      validator_trust: "0.4",
      consensus: "0.88",
      incentive: "0.01",
      dividends: "0.02",
    });
    assert.equal(n.uid, 3);
    assert.equal(typeof n.uid, "number");
    assert.equal(n.registered_at_block, 6702485);
    assert.equal(typeof n.registered_at_block, "number");
    assert.equal(n.stake_tao, 1000.5);
    assert.equal(typeof n.stake_tao, "number");
    assert.equal(n.emission_tao, 22.123456789);
    assert.equal(typeof n.emission_tao, "number");
    assert.equal(n.rank, 12);
    assert.equal(typeof n.rank, "number");
    assert.equal(n.trust, 0.25);
    assert.equal(typeof n.trust, "number");
    assert.equal(n.validator_trust, 0.4);
    assert.equal(n.consensus, 0.88);
    assert.equal(n.incentive, 0.01);
    assert.equal(n.dividends, 0.02);
  });

  test("formatNeuron nulls invalid or absent ratio cells", () => {
    const n = formatNeuron({
      rank: null,
      trust: "not-a-number",
      validator_trust: undefined,
    });
    assert.equal(n.rank, null);
    assert.equal(n.trust, null);
    assert.equal(n.validator_trust, null);
  });

  test("formatNeuron rounds stake_tao / emission_tao to rao precision (no IEEE-754 leak)", () => {
    // Regression for the Gittensory Orb follow-up blocker on #2503: stake_tao /
    // emission_tao must be rounded to 1e-9 (rao) precision so a noisy REAL
    // D1 cell (e.g. 22.1234567894) does not leak accumulated IEEE-754 noise
    // into the API payload. Mirrors toTaoOrNull in account-events.mjs and
    // roundTao in chain-analytics.mjs.
    const n = formatNeuron({
      stake_tao: "22.1234567894",
      emission_tao: "1000.50000000004",
    });
    // 22.1234567894 → 22.123456789 (9 dp); 1000.50000000004 → 1000.5
    assert.equal(n.stake_tao, 22.123456789);
    assert.equal(n.emission_tao, 1000.5);
    // And no extra precision sneaks past rao.
    assert.equal(String(n.stake_tao).split(".")[1]?.length ?? 0, 9);
    assert.equal(String(n.emission_tao).split(".")[1]?.length <= 9, true);
  });

  test("formatNeuron keeps null contract for explicit null cells (regression)", () => {
    // Regression for the Gittensory Orb blocker on #2503: the upstream
    // nonNegativeInt / nullableNumber helpers added in #2493 do not have
    // explicit `value == null` guards, so Number(null) === 0 leaks as 0
    // instead of falling through to null. A real D1 row with explicit null
    // cells must serialize as null (matches the missing-key behavior proven
    // by the existing `defaults every missing field to null/false` test).
    const n = formatNeuron({
      uid: null,
      registered_at_block: null,
      stake_tao: null,
      emission_tao: null,
    });
    assert.equal(n.uid, null);
    assert.equal(n.registered_at_block, null);
    assert.equal(n.stake_tao, null);
    assert.equal(n.emission_tao, null);
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

  test("coerces a string-typed D1 block_number to an integer in the snapshot stamp + neuron detail", () => {
    // block_number is a nullable D1 INTEGER that can come back as a numeric
    // string; the snapshot stamp (metagraph/validators) and neuron-detail top
    // level must emit an integer or null, never leak the string into the
    // ["integer","null"] contract field. Mirrors the buildGlobalValidators fix
    // (#2611) for the remaining emission sites.
    const meta = buildSubnetMetagraph([{ ...ROW, block_number: "8454388" }], 7);
    assert.equal(meta.block_number, 8454388);
    assert.equal(typeof meta.block_number, "number");
    const vals = buildSubnetValidators(
      [{ ...ROW, block_number: "8454388" }],
      7,
    );
    assert.equal(vals.block_number, 8454388);
    const detail = buildNeuronDetail({ ...ROW, block_number: "8454388" }, 7);
    assert.equal(detail.block_number, 8454388);
    assert.equal(typeof detail.block_number, "number");
    // a null block_number stays null (not a fabricated 0).
    assert.equal(
      buildNeuronDetail({ ...ROW, block_number: null }, 7).block_number,
      null,
    );
  });

  test("buildGlobalValidators groups validator identities across subnets", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 1,
          uid: 2,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: "100.1234567891",
          emission_tao: 5,
          validator_trust: "0.4",
          block_number: "10",
          captured_at: 1750000000000,
        },
        {
          ...ROW,
          netuid: 2,
          uid: 1,
          hotkey: "hk-a",
          coldkey: "ck-a2",
          stake_tao: 50,
          emission_tao: 9,
          validator_trust: 0.8,
          block_number: 11,
          captured_at: 1750000001000,
        },
        {
          ...ROW,
          netuid: 5,
          uid: 3,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 1,
          emission_tao: 2,
          validator_trust: 0.6,
          block_number: 12,
          captured_at: 1750000001000,
        },
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-b",
          coldkey: "ck-b",
          stake_tao: 500,
          emission_tao: 1,
          validator_trust: null,
          block_number: 9,
          captured_at: 1740000000000,
        },
        { ...ROW, netuid: 4, uid: 0, hotkey: null },
      ],
      { sort: "subnet_count", limit: 1 },
    );

    assert.equal(data.sort, "subnet_count");
    assert.equal(data.limit, 1);
    assert.equal(data.validator_count, 2);
    assert.equal(data.validators.length, 1);
    assert.equal(data.captured_at, new Date(1750000001000).toISOString());
    assert.equal(data.block_number, 12);
    const top = data.validators[0];
    assert.equal(top.hotkey, "hk-a");
    assert.equal(top.coldkey, "ck-a");
    assert.equal(top.coldkey_count, 2);
    assert.equal(top.subnet_count, 3);
    assert.equal(top.uid_count, 3);
    assert.equal("total_stake_tao" in top, false);
    assert.equal("total_emission_tao" in top, false);
    assert.equal(top.avg_validator_trust, 0.6);
    assert.equal(top.max_validator_trust, 0.8);
    assert.equal(top.latest_captured_at, new Date(1750000001000).toISOString());
    assert.equal(top.latest_block_number, 12);
    assert.deepEqual(
      top.subnets.map((s) => [s.netuid, s.uid]),
      [
        [1, 2],
        [2, 1],
        [5, 3],
      ],
    );
  });

  test("buildGlobalValidators is cold-safe and normalizes direct-call options", () => {
    const empty = buildGlobalValidators(null, {
      sort: "bogus",
      limit: "bogus",
    });
    assert.equal(empty.sort, "subnet_count");
    assert.equal(empty.limit, 20);
    assert.equal(empty.validator_count, 0);
    assert.deepEqual(empty.validators, []);

    const clamped = buildGlobalValidators(
      [{ ...ROW, netuid: 7, uid: 0, hotkey: "hk-a" }],
      { limit: 0 },
    );
    assert.equal(clamped.limit, 1);
    assert.equal(clamped.validator_count, 1);
    assert.equal(clamped.validators.length, 1);
  });

  test("buildGlobalValidators handles sparse identity rows and trust sorting", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 1,
          uid: 0,
          hotkey: "hk-low",
          coldkey: "",
          validator_trust: "not-a-number",
          stake_tao: -5,
          emission_tao: -1,
          block_number: 1,
          captured_at: "not-a-date",
        },
        {
          ...ROW,
          netuid: 2,
          uid: 0,
          hotkey: "hk-high",
          coldkey: "ck-high",
          validator_trust: 0.95,
          stake_tao: 10,
          emission_tao: 1,
          block_number: 2,
          captured_at: 1750000002000,
        },
      ],
      { sort: "avg_validator_trust", limit: 10 },
    );

    assert.equal(data.sort, "avg_validator_trust");
    assert.equal(data.captured_at, new Date(1750000002000).toISOString());
    assert.equal(data.block_number, 2);
    assert.equal(data.validators[0].hotkey, "hk-high");
    assert.equal(data.validators[0].avg_validator_trust, 0.95);
    assert.equal(data.validators[1].hotkey, "hk-low");
    assert.equal(data.validators[1].coldkey, null);
    assert.equal(data.validators[1].coldkey_count, 0);
    assert.equal(data.validators[1].avg_validator_trust, null);
    assert.equal(data.validators[1].max_validator_trust, null);
    assert.deepEqual(data.validators[1].subnets[0], {
      netuid: 1,
      uid: 0,
      stake_tao: 0,
      emission_tao: 0,
      validator_trust: null,
    });
  });

  test("buildGlobalValidators uses deterministic footprint tie-breakers", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 9,
          uid: 9,
          hotkey: "hk-z",
          coldkey: "ck-b",
          stake_tao: 5,
          emission_tao: 1,
        },
        {
          ...ROW,
          netuid: 8,
          uid: 4,
          hotkey: "hk-z",
          coldkey: "ck-a",
          stake_tao: 5,
          emission_tao: 1,
        },
        {
          ...ROW,
          netuid: 8,
          uid: 5,
          hotkey: "hk-z",
          coldkey: "ck-a",
          stake_tao: 5,
          emission_tao: 1,
        },
        {
          ...ROW,
          netuid: 3,
          uid: 7,
          hotkey: "hk-z",
          coldkey: "ck-c",
          stake_tao: 5,
          emission_tao: 2,
        },
        {
          ...ROW,
          netuid: 2,
          uid: 0,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 1,
          emission_tao: 1,
        },
      ],
      { sort: "subnet_count", limit: 10 },
    );

    assert.deepEqual(
      data.validators.map((validator) => validator.hotkey),
      ["hk-z", "hk-a"],
    );
    assert.equal(data.validators[0].coldkey, "ck-a");
    assert.deepEqual(
      data.validators[0].subnets.map((subnet) => [subnet.netuid, subnet.uid]),
      [
        [3, 7],
        [8, 4],
        [8, 5],
        [9, 9],
      ],
    );

    const alphabetical = buildGlobalValidators(
      [
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-b" },
        { ...ROW, netuid: 2, uid: 0, hotkey: "hk-a" },
      ],
      { sort: "uid_count", limit: 10 },
    );
    assert.deepEqual(
      alphabetical.validators.map((validator) => validator.hotkey),
      ["hk-a", "hk-b"],
    );
  });

  test("buildGlobalValidators reports a null block_number as null, not a fabricated 0", () => {
    // block_number is a nullable INTEGER column and the /validators query does not
    // filter it, so a validator's newest capture can carry block_number: null.
    // Number(null) === 0 must NOT surface as the real chain height 0 (block 0 is
    // the genesis block, a height the neuron was never captured at).
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 1,
          uid: 0,
          hotkey: "hk-null-block",
          block_number: null,
          captured_at: 2000,
        },
        {
          ...ROW,
          netuid: 2,
          uid: 1,
          hotkey: "hk-null-block",
          block_number: 99,
          captured_at: 1000,
        },
      ],
      { sort: "subnet_count", limit: 10 },
    );
    // Newest capture (captured_at 2000) has no block height → both the per-validator
    // and top-level block numbers must be null.
    assert.equal(data.block_number, null);
    assert.equal(data.validators[0].latest_block_number, null);
  });

  test("builders drop malformed rows and count only real neurons", () => {
    // A null/non-object row can't be a Neuron, so it must not leak into the
    // array — and the count tracks the array (neuron_count === neurons.length),
    // matching the blocks/extrinsics feed builders' .filter(Boolean).
    const data = buildSubnetMetagraph([ROW, null, MINER, undefined], 7);
    assert.equal(data.neurons.length, 2);
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

  test("loadGlobalValidators reads validator rows and applies requested ranking", async () => {
    let seenSql = "";
    let seenParams = null;
    const data = await loadGlobalValidators(
      async (sql, params) => {
        seenSql = sql;
        seenParams = params;
        return [
          {
            netuid: 1,
            uid: 0,
            hotkey: "hk-a",
            coldkey: "ck-a",
            stake_tao: 10,
            emission_tao: 7,
            validator_trust: 0.7,
          },
          {
            netuid: 2,
            uid: 0,
            hotkey: "hk-b",
            coldkey: "ck-b",
            stake_tao: 100,
            emission_tao: 1,
            validator_trust: 0.5,
          },
        ];
      },
      { sort: "avg_validator_trust", limit: 1 },
    );
    assert.match(seenSql, /validator_permit = 1 AND hotkey IS NOT NULL/);
    assert.match(seenSql, /ORDER BY hotkey ASC/);
    assert.deepEqual(seenParams, []);
    assert.equal(data.validators.length, 1);
    assert.equal(data.validators[0].hotkey, "hk-a");
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

  test("GET /subnets/{n}/yield routes to the emission-yield handler", async () => {
    const { res, body } = await getJson("/api/v1/subnets/7/yield", env);
    assert.equal(res.status, 200);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.neuron_count, 2);
    assert.equal(Array.isArray(body.data.neurons), true);
    assert.equal(typeof body.data.validator_count, "number");
    // ranked by yield desc, so the per-UID yields are non-increasing
    const ys = body.data.neurons.map((n) => n.yield).filter((y) => y != null);
    assert.deepEqual(
      ys,
      [...ys].sort((a, b) => b - a),
    );
    assert.equal(body.meta.source, "metagraph-snapshot");
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
    // account_events provenance + newest event timestamp (ISO string) in the window.
    assert.equal(body.meta.source, "chain-events");
    assert.equal(body.meta.generated_at, new Date(1717900000000).toISOString());
  });

  test("GET /subnets/movers routes to the cross-subnet movers handler", async () => {
    const moversEnv = {
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
                        { start_date: "2026-05-31", end_date: "2026-06-30" },
                      ],
                    });
                  }
                  if (/GROUP BY netuid, snapshot_date/.test(sql)) {
                    return Promise.resolve({
                      results: [
                        {
                          netuid: 1,
                          snapshot_date: "2026-05-31",
                          neuron_count: 10,
                          validator_count: 3,
                          total_stake_tao: 100,
                          total_emission_tao: 5,
                        },
                        {
                          netuid: 1,
                          snapshot_date: "2026-06-30",
                          neuron_count: 12,
                          validator_count: 4,
                          total_stake_tao: 250,
                          total_emission_tao: 9,
                        },
                        {
                          netuid: 2,
                          snapshot_date: "2026-05-31",
                          neuron_count: 8,
                          validator_count: 2,
                          total_stake_tao: 50,
                          total_emission_tao: 4,
                        },
                        {
                          netuid: 2,
                          snapshot_date: "2026-06-30",
                          neuron_count: 8,
                          validator_count: 2,
                          total_stake_tao: 30,
                          total_emission_tao: 4,
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
      "/api/v1/subnets/movers?window=30d&sort=stake&limit=10",
      moversEnv,
    );
    assert.equal(res.status, 200);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.sort, "stake");
    assert.equal(body.data.start_date, "2026-05-31");
    assert.equal(body.data.end_date, "2026-06-30");
    assert.equal(body.data.subnet_count, 2);
    // subnet 1 (+150 stake) ranks above subnet 2 (-20)
    assert.equal(body.data.movers[0].netuid, 1);
    assert.equal(body.data.movers[0].stake_delta_tao, 150);
    assert.equal(body.data.movers[1].netuid, 2);
    assert.equal(body.data.movers[1].stake_delta_tao, -20);
    // neuron_daily provenance + end snapshot date as generated_at.
    assert.equal(body.meta.source, "metagraph-snapshot");
    assert.equal(body.meta.generated_at, "2026-06-30");
  });

  test("GET /subnets/{n}/validators returns only validators", async () => {
    const { body } = await getJson("/api/v1/subnets/7/validators", env);
    assert.equal(body.data.validator_count, 1);
    assert.equal(body.data.validators[0].validator_permit, true);
  });

  test("GET /validators returns the global validator leaderboard", async () => {
    const globalEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: neuronsD1([
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", stake_tao: 10 },
        { ...ROW, netuid: 2, uid: 1, hotkey: "hk-a", stake_tao: 20 },
        { ...ROW, netuid: 3, uid: 0, hotkey: "hk-b", stake_tao: 100 },
        { ...MINER, netuid: 4, uid: 0, hotkey: "hk-miner", stake_tao: 999 },
      ]),
    };
    const { res, body } = await getJson(
      "/api/v1/validators?sort=subnet_count&limit=2",
      globalEnv,
    );
    assert.equal(res.status, 200);
    assert.equal(body.data.sort, "subnet_count");
    assert.equal(body.data.limit, 2);
    assert.equal(body.data.validator_count, 2);
    assert.equal(body.data.validators[0].hotkey, "hk-a");
    assert.equal(body.data.validators[0].subnet_count, 2);
    assert.equal(body.data.validators[0].uid_count, 2);
    assert.equal(body.data.validators[1].hotkey, "hk-b");
    assert.equal(body.meta.artifact_path, "/metagraph/validators.json");
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("GET /validators defaults the sort when omitted", async () => {
    const globalEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: neuronsD1([
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", stake_tao: 10 },
      ]),
    };
    const { res, body } = await getJson("/api/v1/validators", globalEnv);

    assert.equal(res.status, 200);
    assert.equal(body.data.sort, "subnet_count");
    assert.equal(body.data.limit, 20);
    assert.equal(body.data.validators[0].hotkey, "hk-a");
  });

  test("GET /validators rejects invalid query params", async () => {
    const { res } = await getJson("/api/v1/validators?sort=bogus", env);
    assert.equal(res.status, 400);

    const unsupported = await getJson("/api/v1/validators?foo=bar", env);
    assert.equal(unsupported.res.status, 400);

    const badLimit = await getJson("/api/v1/validators?limit=0", env);
    assert.equal(badLimit.res.status, 400);
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
