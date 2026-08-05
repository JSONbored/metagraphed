import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetValidatorEconomicsPayload,
  buildValidatorEconomicsRankingPayload,
  handleSubnetValidatorEconomics,
  handleValidatorEconomicsRanking,
  buildSubnetValidatorEconomicsHistoryPayload,
  handleSubnetValidatorEconomicsHistory,
} from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";

// The composer for GET /api/v1/subnets/{netuid}/validator-economics (#9323, #9327).
//
// Every branch here is a null-coalesce over a tier that can legitimately be cold, so
// the tests drive the ABSENCE paths as hard as the present ones. A confident 0 from
// any of them reads as "free to validate", which is the failure this route degrades to
// avoid (#9285, #9114, #9121).

type Row = Record<string, unknown>;

// Minimal D1 stub: `.prepare().bind().all()` for the neuron scan and
// `.prepare().bind().first()` for the single hyperparameter row.
function fakeDb(neurons: Row[], hyper: Row | null = null) {
  const sql: string[] = [];
  return {
    sql,
    db: {
      prepare(query: string) {
        sql.push(query);
        const isHyper = /subnet_hyperparams/.test(query);
        return {
          bind() {
            return {
              all: async () => ({ results: neurons }),
              first: async () => (isHyper ? hyper : null),
            };
          },
        };
      },
    },
  };
}

// The economics artifact the reserves, cap and emission are read from. Shaped like a
// real /api/v1/economics row.
function economicsArtifact(over: Row = {}) {
  return {
    ok: true,
    data: {
      generated_at: "2026-08-03T00:00:00.000Z",
      subnets: [
        {
          netuid: 7,
          tao_in_pool_tao: 1000,
          alpha_in_pool: 100_000,
          max_validators: 64,
          tao_in_emission_tao: 0.01,
          ...over,
        },
      ],
    },
  };
}

function envWith({
  neurons = [] as Row[],
  hyper = null as Row | null,
  economics = economicsArtifact() as unknown,
} = {}) {
  const { db, sql } = fakeDb(neurons, hyper);
  return {
    sql,
    env: {
      METAGRAPH_HEALTH_DB: db,
      // readArtifact reads economics.json out of R2 (it is an R2-only artifact),
      // so the archive bucket is what has to answer. Anything else misses.
      METAGRAPH_ARCHIVE: {
        get: async (key: string) =>
          /economics\.json/.test(key)
            ? {
                json: async () => (economics as { data: unknown }).data,
                text: async () =>
                  JSON.stringify((economics as { data: unknown }).data),
              }
            : null,
      },
    } as never,
  };
}

// The three non-D1 reads are live RPC behind caches. Stubbing them is what lets the
// tests exercise the REAL derivation rather than the "chain parameters unavailable"
// degrade every unstubbed call would produce.
function deps(
  over: {
    threshold?: number | null;
    taoWeight?: number | null;
    burn?: number | null;
  } = {},
) {
  const { threshold = 1000, taoWeight = 0.18, burn = 2.5 } = over;
  return {
    loadParams: (async () => ({
      stake_threshold_tao: threshold,
      tao_weight: taoWeight,
    })) as never,
    loadBurn: (async () => ({ burn_tao: burn })) as never,
  };
}

const permitted = (uid: number, over: Row = {}): Row => ({
  uid,
  stake_tao: 5000,
  validator_permit: 1,
  dividends: 0.5,
  active: 1,
  take: 0.18,
  ...over,
});

describe("buildSubnetValidatorEconomicsPayload", () => {
  test("reads only the columns the derivation needs", async () => {
    const { env, sql } = envWith({ neurons: [permitted(0)] });
    await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.match(sql[0], /FROM neurons WHERE netuid = \?/);
    assert.match(sql[0], /stake_tao/);
    assert.match(sql[0], /take/);
    // The owner exception needs the hotkey to find the owner's UID; without it
    // selected, every owner-below-threshold subnet stays permanently degraded.
    assert.match(sql[0], /hotkey/);
    // A SELECT * here would drag ~20 unused columns per UID across 256 rows.
    assert.doesNotMatch(sql[0], /SELECT \*/);
  });

  // end to end: the owner hotkey lives on the economics artifact and the UID it
  // names lives in D1, so this is the one place the two tiers have to meet.
  test("threads the owner hotkey from the economics tier into the permit model", async () => {
    const neurons = [
      permitted(0, { hotkey: "5V0", stake_tao: 5000 }),
      // The owner, holding a permit the stake rule cannot explain — SN5's shape.
      permitted(9, { hotkey: "5OWNER", stake_tao: 0 }),
    ];
    const withoutOwner = await buildSubnetValidatorEconomicsPayload(
      envWith({ neurons }).env,
      7,
      deps(),
    );
    assert.equal(
      withoutOwner.data.degraded_reason,
      "permit model disagrees with observed permits on this subnet",
    );
    assert.equal(withoutOwner.data.permit_floor_units, null);

    const withOwner = await buildSubnetValidatorEconomicsPayload(
      envWith({
        neurons,
        economics: economicsArtifact({ owner_hotkey: "5OWNER" }),
      }).env,
      7,
      deps(),
    );
    assert.equal(withOwner.data.degraded_reason, null);
    assert.equal(withOwner.data.permit_floor_units, 1000);
    assert.equal(
      (withOwner.data.model_agreement as Row | null)?.agreement,
      1,
      "the owner exception reproduces the chain exactly",
    );
  });

  test("publishes the model-free fields even while the floor is withheld", async () => {
    // cap_binding, uids_above_threshold, validator_slots_open and
    // root_tao_to_clear_threshold are counted off the live threshold and the observed
    // permits — none of them needs the floor model that has drifted.
    const { env } = envWith({
      neurons: [
        permitted(0, { hotkey: "5V0", stake_tao: 5000 }),
        permitted(9, { hotkey: "5OWNER", stake_tao: 0 }),
      ],
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.permit_floor_units, null, "still withheld");
    assert.equal(data.cap_binding, false);
    assert.equal(data.uids_above_threshold, 1);
    assert.equal(data.validator_slots_open, 62, "64 slots less 2 permits");
    assert.equal(data.root_tao_to_clear_threshold, 1000 / 0.18);
  });

  test("treats a result set with no rows array as empty, not as a crash", async () => {
    // D1's `.all()` is not guaranteed to carry `results` — a cold or shimmed
    // binding can return a bare object, and reading `.results` off it would
    // throw inside the request rather than degrade.
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare: () => ({
          bind: () => ({ all: async () => ({}), first: async () => null }),
        }),
      },
      METAGRAPH_ARCHIVE: { get: async () => null },
    } as never;
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.netuid, 7);
    assert.equal(data.permit_floor_units, null);
    assert.equal(data.degraded_reason, "max_validators unavailable");
  });

  test("carries the netuid and a stable schema_version", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.netuid, 7);
    assert.equal(data.schema_version, 1);
  });

  test("degrades with a stated reason when the D1 binding is absent", async () => {
    // An unbound database must not read as "this subnet has no validators".
    const { data } = await buildSubnetValidatorEconomicsPayload(
      { METAGRAPH_ARCHIVE: { get: async () => null } } as never,
      7,
      deps(),
    );
    assert.equal(data.permit_floor_units, null);
    assert.ok(typeof data.degraded_reason === "string");
  });

  test("maps a null take to null rather than to zero", async () => {
    // Counting an unrecorded take as 0 would drag the median toward a floor
    // nobody set.
    const { env } = envWith({
      neurons: [
        permitted(0, { take: null }),
        permitted(1, { take: 0.18, stake_tao: 4000 }),
      ],
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    const takes = data.takes as Row;
    assert.deepEqual(takes.distribution, [0.18]);
    assert.equal(takes.sample_size, 1);
  });

  test("treats a missing stake or dividend as zero, not as NaN", async () => {
    const { env } = envWith({
      neurons: [permitted(0, { stake_tao: null, dividends: null })],
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    // Reaching the payload at all proves the coercion held; a NaN would have
    // propagated into every derived figure.
    assert.equal(Number.isNaN(data.permit_floor_units as number), false);
  });

  test("reads active and validator_permit as the 0/1 flags D1 stores", async () => {
    const { env } = envWith({
      neurons: [
        permitted(0, { active: 0 }),
        permitted(1, { validator_permit: 0, stake_tao: 4000 }),
      ],
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    const composition = data.composition as Row;
    assert.equal(composition.permitted, 1, "only uid 0 holds a permit");
    assert.equal(composition.active, 0, "and it is inactive");
  });

  test("prefers the hyperparameter cap over the economics-row cap", async () => {
    // subnet_hyperparams is the chain's own value; the economics row is a capture
    // that can lag it.
    const { env } = envWith({
      neurons: [permitted(0)],
      hyper: { max_validators: 8, min_childkey_take_ratio: 0 },
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.max_validators, 8);
    assert.equal(data.min_childkey_take_ratio, 0);
  });

  test("falls back to the economics-row cap when the hyperparameter row is cold", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.max_validators, 64);
    assert.equal(data.min_childkey_take_ratio, null);
  });

  test("reports the cap as unknown when neither tier carries it", async () => {
    const { env } = envWith({
      neurons: [permitted(0)],
      economics: economicsArtifact({ max_validators: null }),
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.max_validators, null);
  });

  test("withholds the costs when the pool reserves are cold, keeping the floors", async () => {
    const { env } = envWith({
      neurons: [permitted(0)],
      economics: economicsArtifact({
        tao_in_pool_tao: null,
        alpha_in_pool: null,
      }),
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.permit_floor_cost_tao, null);
    assert.equal(data.permit_entry_cost_tao, null);
  });

  test("leaves the emission gate unknown when the economics row is absent", async () => {
    // null is not a closed gate. Conflating them would tell an operator a subnet
    // pays nothing when we simply did not look.
    const { env } = envWith({
      neurons: [permitted(0)],
      economics: { ok: true, data: { generated_at: null, subnets: [] } },
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.emission_gate_open, null);
    assert.equal(data.tao_inflow_per_day, null);
  });

  test("publishes field_sources labelling the derived fields honestly", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    const sources = data.field_sources as Record<string, Row>;
    // There is no storage item behind a derived floor, so claiming `measured`
    // would overstate what the chain actually says.
    assert.equal(sources.permit_floor_units.kind, "reconstructed");
    assert.equal(sources.permit_floor_units.storage, null);
    // ...while the echoed governance parameters genuinely are single reads.
    assert.equal(sources.tao_weight.kind, "measured");
    assert.equal(sources.stake_threshold_units.kind, "measured");
  });

  test("returns the artifact timestamp the envelope's meta needs", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const { generatedAt } = await buildSubnetValidatorEconomicsPayload(
      env,
      7,
      deps(),
    );
    assert.equal(generatedAt, "2026-08-03T00:00:00.000Z");
  });
});

describe("buildSubnetValidatorEconomicsPayload — the non-D1 reads", () => {
  test("prices the entry cost from the burn", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.registration_cost_tao, 2.5);
    assert.ok(
      (data.permit_entry_cost_tao as number) >
        (data.permit_floor_cost_tao as number),
      "entry is the floor cost PLUS the burn",
    );
  });

  test("survives a burn read that throws, keeping the floor cost", async () => {
    // The burn is live RPC and allowed to fail. Withholding the whole row over it
    // would lose the floors, which are still true without it.
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, {
      ...deps(),
      loadBurn: (async () => {
        throw new Error("rpc down");
      }) as never,
    });
    assert.equal(data.registration_cost_tao, null);
    assert.equal(data.permit_entry_cost_tao, null);
    assert.ok(data.permit_floor_cost_tao !== null);
  });

  test("treats a non-numeric burn as unread rather than as zero", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, {
      ...deps(),
      loadBurn: (async () => ({ burn_tao: null })) as never,
    });
    assert.equal(data.registration_cost_tao, null);
  });

  test("degrades every derived field when the threshold is unreadable", async () => {
    // StakeThreshold is sudo-settable. Substituting a remembered 1,000 would keep
    // publishing confident floors straight through the change that invalidated them.
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(
      env,
      7,
      deps({ threshold: null }),
    );
    assert.equal(data.permit_floor_units, null);
    assert.equal(data.stake_threshold_units, null);
    assert.equal(data.degraded_reason, "chain parameters unavailable");
  });

  test("echoes the governance parameters the floors were computed against", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.equal(data.stake_threshold_units, 1000);
    assert.equal(data.tao_weight, 0.18);
    // Root is not split, so this clears the threshold everywhere at once.
    assert.ok(
      Math.abs((data.root_tao_to_clear_threshold as number) - 1000 / 0.18) <
        1e-9,
    );
  });

  test("survives a params read returning nothing at all", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, {
      ...deps(),
      loadParams: (async () => null) as never,
    });
    assert.equal(data.stake_threshold_units, null);
    assert.equal(data.tao_weight, null);
  });

  test("publishes the three validator counts separately", async () => {
    // Permitted / active / earning are three different sets and the route's whole
    // point is refusing to collapse them into one "validator count".
    const { env } = envWith({
      neurons: [
        permitted(0, { stake_tao: 9000, active: 1, dividends: 0.5 }),
        permitted(1, { stake_tao: 8000, active: 1, dividends: 0 }),
        permitted(2, { stake_tao: 7000, active: 0, dividends: 0 }),
      ],
    });
    const { data } = await buildSubnetValidatorEconomicsPayload(env, 7, deps());
    assert.deepEqual(data.composition, {
      permitted: 3,
      active: 2,
      earning: 1,
    });
    assert.equal(data.validator_slots_open, 61);
    assert.equal(data.uids_above_threshold, 3);
  });
});

describe("handleSubnetValidatorEconomics", () => {
  const call = (path: string, env: unknown) => {
    const url = new URL("https://api.metagraph.sh" + path);
    return handleSubnetValidatorEconomics(
      new Request(url.toString()),
      env as never,
      Number(url.pathname.split("/")[4]),
      url,
    );
  };

  test("rejects an unknown query parameter rather than ignoring it", async () => {
    // Silently dropping a param the caller believed in is how a filtered request
    // comes back looking unfiltered.
    const { env } = envWith({ neurons: [permitted(0)] });
    const res = await call(
      "/api/v1/subnets/7/validator-economics?window=30d",
      env,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, "invalid_query");
  });

  test("rejects a netuid outside the u16 range", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const res = await call("/api/v1/subnets/99999/validator-economics", env);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, "invalid_netuid");
  });

  test("wraps the payload in the standard success envelope with meta", async () => {
    const { env } = envWith({ neurons: [permitted(0)] });
    const res = await call("/api/v1/subnets/7/validator-economics", env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, true);
    assert.equal((body.data as Row).netuid, 7);
    assert.equal(typeof body.meta, "object");
  });
});

// #9324: the cross-subnet ranking composer. One scan, one artifact read, grouped
// per netuid — the branches worth driving are the ones where a tier is cold for
// SOME subnets but not others, which is the normal steady state, not an edge case.
describe("buildValidatorEconomicsRankingPayload", () => {
  const scanRow = (netuid: number, uid: number, over: Row = {}): Row => ({
    netuid,
    uid,
    stake_tao: 5000,
    validator_permit: 1,
    dividends: 0.5,
    active: 1,
    take: 0.18,
    ...over,
  });

  // Routes by table, not by call order: the ranking makes three bulk reads
  // (neuron scan, latest burn per subnet, hyperparams) and a stub that answered
  // all of them with the neuron scan would feed burn rows into the burn map.
  function rankEnv(scan: Row[], burn: Row[] = [], hyper: Row[] = []) {
    const sql: string[] = [];
    return {
      sql,
      env: {
        METAGRAPH_HEALTH_DB: {
          prepare(query: string) {
            sql.push(query);
            const results = /subnet_burn_history/.test(query)
              ? burn
              : /subnet_hyperparams/.test(query)
                ? hyper
                : scan;
            return { all: async () => ({ results }) };
          },
        },
      } as never,
    };
  }

  const economicsFor = (rows: Row[]) => async () => ({
    rows,
    generatedAt: "2026-08-03T00:00:00.000Z",
  });

  const rankDeps = (rows: Row[]) => ({
    loadParams: (async () => ({
      stake_threshold_tao: 1000,
      tao_weight: 0.18,
    })) as never,
    loadEconomics: economicsFor(rows) as never,
  });

  const pool = (netuid: number, over: Row = {}): Row => ({
    netuid,
    tao_in_pool_tao: 1000,
    alpha_in_pool: 100_000,
    max_validators: 64,
    tao_in_emission_tao: 0.01,
    ...over,
  });

  test("excludes root from the scan — it is not a weight-copy target", () => {
    const { env, sql } = rankEnv([]);
    return buildValidatorEconomicsRankingPayload(env, {}, rankDeps([])).then(
      () => {
        assert.match(sql[0], /WHERE netuid != 0/);
        assert.match(sql[0], /ORDER BY netuid, uid/);
      },
    );
  });

  // on the CROSS-SUBNET route: the owner exception has to reach here too, or
  // every owner-below-threshold subnet lands in `excluded` and drops out of the ranking
  // entirely — which is how 13 subnets were missing from it.
  test("applies the owner exception per subnet from the economics rows", async () => {
    const scan = [
      scanRow(5, 0, { hotkey: "5V0", stake_tao: 5000 }),
      scanRow(5, 9, { hotkey: "5OWNER", stake_tao: 0 }),
    ];
    const withoutOwner = await buildValidatorEconomicsRankingPayload(
      rankEnv(scan).env,
      {},
      rankDeps([pool(5)]),
    );
    // Without the owner the floor is withheld, so the subnet cannot be priced and
    // drops out of the ranking entirely — not merely flagged within it.
    assert.deepEqual(withoutOwner.data.rows, []);
    assert.equal((withoutOwner.data.excluded as Row[])[0]?.netuid, 5);
    const withOwner = await buildValidatorEconomicsRankingPayload(
      rankEnv(scan).env,
      {},
      rankDeps([pool(5, { owner_hotkey: "5OWNER" })]),
    );
    assert.equal((withOwner.data.rows as Row[])[0]?.degraded_reason, null);
    assert.equal((withOwner.data.rows as Row[])[0]?.permit_floor_units, 1000);
  });

  test("derives one row per subnet from a single grouped scan", async () => {
    const { env } = rankEnv([
      scanRow(5, 0),
      scanRow(5, 1, { stake_tao: 4000 }),
      scanRow(7, 0),
    ]);
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(5), pool(7)]),
    );
    assert.equal(data.total, 2);
    assert.deepEqual((data.rows as Row[]).map((r) => r.netuid).sort(), [5, 7]);
  });

  test("echoes the governance parameters once for the whole ranking", async () => {
    const { env } = rankEnv([scanRow(5, 0)]);
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(5)]),
    );
    assert.equal(data.stake_threshold_units, 1000);
    assert.equal(data.tao_weight, 0.18);
    assert.ok(
      Math.abs((data.root_tao_to_clear_threshold as number) - 1000 / 0.18) <
        1e-9,
    );
  });

  test("leaves the root figure null when tao_weight is unusable", async () => {
    const { env } = rankEnv([scanRow(5, 0)]);
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      {
        loadParams: (async () => ({
          stake_threshold_tao: 1000,
          tao_weight: 0,
        })) as never,
        loadEconomics: economicsFor([pool(5)]) as never,
      },
    );
    assert.equal(data.root_tao_to_clear_threshold, null);
  });

  test("survives a params read returning nothing", async () => {
    const { env } = rankEnv([scanRow(5, 0)]);
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      {
        loadParams: (async () => null) as never,
        loadEconomics: economicsFor([pool(5)]) as never,
      },
    );
    assert.equal(data.stake_threshold_units, null);
    assert.equal(data.root_tao_to_clear_threshold, null);
  });

  test("a subnet missing from the economics artifact is excluded, not priced at zero", async () => {
    // The normal steady state: a freshly registered subnet is in `neurons`
    // before it lands in the economics capture.
    const { env } = rankEnv([scanRow(5, 0), scanRow(99, 0)]);
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(5)]),
    );
    assert.deepEqual(
      (data.rows as Row[]).map((r) => r.netuid),
      [5],
    );
    assert.deepEqual(data.excluded, [
      { netuid: 99, reason: "earning_floor_cost_tao is unavailable" },
    ]);
  });

  test("degrades every subnet rather than guessing when the D1 binding is absent", async () => {
    const { data } = await buildValidatorEconomicsRankingPayload(
      {} as never,
      {},
      rankDeps([pool(5)]),
    );
    assert.equal(data.total, 0);
    assert.deepEqual(data.rows, []);
  });

  test("passes the sort and filters through to the ranking", async () => {
    const { env } = rankEnv([scanRow(5, 0), scanRow(7, 0)]);
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      { sort: "tao_inflow_per_day", emissionGateOpen: false },
      rankDeps([pool(5), pool(7)]),
    );
    assert.equal(data.sort, "tao_inflow_per_day");
    assert.equal(data.order, "desc");
    // Both subnets have an open gate, so filtering for closed drops both.
    assert.equal(data.total, 0);
    assert.equal((data.excluded as Row[]).length, 2);
  });

  test("keeps a subnet whose economics row omits the cap, reporting it as unknown", async () => {
    // A capture that landed the subnet but not its cap: the row still ranks on
    // the fields it HAS, and the cap reads unknown rather than being invented.
    const { env } = rankEnv([scanRow(5, 0)]);
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(5, { max_validators: null })]),
    );
    // No cap means no floor derivation, so the row is excluded from a
    // cost-ranked list rather than ranked on a number that does not exist.
    assert.equal(data.total, 0);
    assert.deepEqual(data.excluded, [
      { netuid: 5, reason: "earning_floor_cost_tao is unavailable" },
    ]);
  });

  test("tolerates a scan result carrying no rows array", async () => {
    // Same D1 shape guard the per-subnet composer has: `.all()` is not
    // guaranteed to carry `results`.
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare: () => ({ all: async () => ({}) }),
      },
    } as never;
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(5)]),
    );
    assert.equal(data.total, 0);
    assert.deepEqual(data.rows, []);
  });

  test("carries the artifact timestamp for the envelope meta", async () => {
    const { env } = rankEnv([scanRow(5, 0)]);
    const { generatedAt } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(5)]),
    );
    assert.equal(generatedAt, "2026-08-03T00:00:00.000Z");
  });

  // #9455: the ranking used to publish null for every burn-derived field and for
  // min_childkey_take_ratio, because the burn had no cached tier and the
  // hyperparams row was never read here. Both are now ONE bulk read for every
  // subnet, so the row carries what the per-subnet route reports.
  test("reads the latest burn per subnet and the childkey ratio in bulk", async () => {
    const { env, sql } = rankEnv(
      [scanRow(5, 0), scanRow(6, 0)],
      [
        { netuid: 5, burn_tao: 0.5 },
        { netuid: 6, burn_tao: 2 },
      ],
      [
        { netuid: 5, min_childkey_take_ratio: 0.12 },
        { netuid: 6, min_childkey_take_ratio: 0.2 },
      ],
    );
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(5), pool(6)]),
    );
    // One query per table, never one per subnet -- the property the route's
    // "no 128 per-subnet round trips" contract rests on.
    assert.equal(sql.filter((q) => /subnet_burn_history/.test(q)).length, 1);
    assert.equal(sql.filter((q) => /subnet_hyperparams/.test(q)).length, 1);

    const rows = data.rows as Row[];
    const five = rows.find((r) => r.netuid === 5) as Row;
    assert.equal(five.registration_cost_tao, 0.5);
    assert.equal(five.min_childkey_take_ratio, 0.12);
    // The entry costs are the floors plus the burn, so a present burn is what
    // turns them from null into a real number.
    assert.ok(
      (five.permit_entry_cost_tao as number) >
        (five.permit_floor_cost_tao as number),
    );
    assert.ok((five.earning_entry_cost_tao as number) > 0);
  });

  test("a genuine zero burn or ratio is reported as 0, never null", async () => {
    // netuid 76 reads a true zero burn on mainnet and is the cheapest
    // registration on the network; `?? null` rather than `||` is what keeps
    // that distinguishable from "we could not read it".
    const { env } = rankEnv(
      [scanRow(76, 0)],
      [{ netuid: 76, burn_tao: 0 }],
      [{ netuid: 76, min_childkey_take_ratio: 0 }],
    );
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(76)]),
    );
    const row = (data.rows as Row[])[0];
    assert.equal(row.registration_cost_tao, 0);
    assert.equal(row.min_childkey_take_ratio, 0);
  });

  test("a subnet missing from either bulk read still ranks, with nulls", async () => {
    // The burn tier is a rolling capture, so a newly-registered subnet can be
    // absent from it. That must cost the field, never the row.
    const { env } = rankEnv([scanRow(9, 0)], [], []);
    const { data } = await buildValidatorEconomicsRankingPayload(
      env,
      {},
      rankDeps([pool(9)]),
    );
    const row = (data.rows as Row[])[0];
    assert.equal(row.netuid, 9);
    assert.equal(row.registration_cost_tao, null);
    assert.equal(row.min_childkey_take_ratio, null);
    // The floors do not depend on the burn, so they must still be published.
    assert.ok((row.permit_floor_cost_tao as number) > 0);
  });
});

describe("handleValidatorEconomicsRanking", () => {
  const call = (qs: string, env: unknown) => {
    const url = new URL(
      "https://api.metagraph.sh/api/v1/validators/economics" + qs,
    );
    return handleValidatorEconomicsRanking(
      new Request(url.toString()),
      env as never,
      url,
    );
  };
  const env = { METAGRAPH_ARCHIVE: { get: async () => null } } as never;

  test("rejects an unsupported sort by name", async () => {
    const res = await call("?sort=nonsense", env);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    // The message names the supported set, so a caller can correct the request
    // without reading the docs.
    assert.match(
      String((body.error as Row).message),
      /nonsense.*earning_floor_cost_tao/s,
    );
  });

  test("rejects an unknown query parameter", async () => {
    const res = await call("?window=30d", env);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, "invalid_query");
  });

  test("rejects a limit above the published ceiling", async () => {
    const res = await call("?limit=100000", env);
    assert.equal(res.status, 400);
  });

  test("rejects a negative offset", async () => {
    const res = await call("?offset=-1", env);
    assert.equal(res.status, 400);
  });

  test("accepts a supported sort and returns the standard envelope", async () => {
    const res = await call("?sort=validator_headroom&limit=5", env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, true);
    assert.equal((body.data as Row).sort, "validator_headroom");
  });

  test("treats an absent filter as BOTH and an explicit false as false", async () => {
    const bothRes = await call("", env);
    assert.equal(bothRes.status, 200);
    const falseRes = await call("?emission_gate_open=false", env);
    assert.equal(falseRes.status, 200);
  });
});

// Router-level: the two routes have to be REACHABLE, not merely implemented. A
// handler that works but is never dispatched is the same as no handler, and the
// per-route unit tests above cannot tell the difference.
describe("validator-economics routing", () => {
  const routerEnv = {
    METAGRAPH_ARCHIVE: { get: async () => null },
  } as never;

  test("dispatches the per-subnet route", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/validator-economics",
      ),
      routerEnv,
      {},
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).netuid, 7);
  });

  test("dispatches the cross-subnet ranking", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/validators/economics"),
      routerEnv,
      {},
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(typeof (body.data as Row).sort, "string");
    assert.equal(Array.isArray((body.data as Row).rows), true);
  });

  test("the ranking's query validation applies through the router too", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/validators/economics?sort=nonsense",
      ),
      routerEnv,
      {},
    );
    assert.equal(res.status, 400);
  });
});

describe("buildSubnetValidatorEconomicsHistoryPayload", () => {
  function historyEnv(
    neuronRows: Row[],
    emissionRows: Row[] = [],
    capRows: Row[] = [],
  ) {
    const sql: string[] = [];
    const binds: unknown[][] = [];
    return {
      sql,
      binds,
      env: {
        METAGRAPH_HEALTH_DB: {
          prepare(query: string) {
            sql.push(query);
            // Three different reads share this stub, so each has to be told apart by
            // its table — returning the neuron rows for all of them would let a
            // broken cap query pass by accident.
            const table = /subnet_snapshots/.test(query)
              ? "emission"
              : /subnet_hyperparams_history/.test(query)
                ? "cap"
                : "neurons";
            return {
              bind(...args: unknown[]) {
                binds.push(args);
                return {
                  all: async () => ({
                    results:
                      table === "emission"
                        ? emissionRows
                        : table === "cap"
                          ? capRows
                          : neuronRows,
                  }),
                };
              },
            };
          },
        },
      } as never,
    };
  }

  const dayRow = (snapshot_date: string, over: Row = {}): Row => ({
    snapshot_date,
    stake_tao: 5000,
    validator_permit: 1,
    dividends: 0.5,
    active: 1,
    ...over,
  });

  test("reads the daily rollups, bounded by the window and a row cap", async () => {
    const { env, sql, binds } = historyEnv([dayRow("2026-08-01")]);
    await buildSubnetValidatorEconomicsHistoryPayload(env, 7, "7d");
    assert.match(
      sql[0],
      /FROM neuron_daily WHERE netuid = \? AND snapshot_date >= \?/,
    );
    assert.match(sql[0], /LIMIT \?/);
    // The owner's unconditional permit has to be identifiable to stay out of the
    // observed floor.
    assert.match(sql[0], /hotkey/);
    assert.equal(binds[0][0], 7);
    // The cutoff is a date string, not a timestamp — snapshot_date is TEXT.
    assert.match(String(binds[0][1]), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof binds[0][2], "number");
  });

  // the series was not self-contained. `permit_floor_alpha` is the observed
  // floor regardless of cap state, so reading it needs the cap — which lived only on
  // the current record, making the join wrong for any subnet whose cap had moved.
  test("stamps the cap and the full-set flag onto every point", async () => {
    const { env } = historyEnv([
      dayRow("2026-08-01"),
      dayRow("2026-08-01", { stake_tao: 3000 }),
    ]);
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      env,
      7,
      "7d",
      {
        loadEconomicsRow: (async () => ({
          row: { max_validators: 2 },
          generatedAt: null,
        })) as never,
      },
    );
    const points = data.points as Array<Row>;
    assert.equal(points[0].max_validators, 2);
    assert.equal(points[0].permit_set_full, true, "2 permitted for 2 slots");
    assert.equal(
      points[0].max_validators_source,
      "current",
      "no change-log entry reaches this day, so the live cap is reported AS the live cap",
    );
  });

  // Stamping today's cap onto an old point manufactures a transition that never
  // happened — the reason the cap was left out of the series in the first place. The
  // change-log is what makes it publishable: the cap in force on a day is the newest
  // entry at or before it.
  test("resolves the cap per day from the hyperparameter change-log", async () => {
    const { env, sql } = historyEnv(
      [dayRow("2026-08-01"), dayRow("2026-08-03")],
      [],
      [
        // Raised from 8 to 64 on 2026-08-02.
        { observed_at: Date.parse("2026-07-01T00:00:00Z"), max_validators: 8 },
        { observed_at: Date.parse("2026-08-02T12:00:00Z"), max_validators: 64 },
      ],
    );
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      env,
      7,
      "30d",
      {
        loadEconomicsRow: (async () => ({
          row: { max_validators: 64 },
          generatedAt: null,
        })) as never,
      },
    );
    assert.match(sql[2], /FROM subnet_hyperparams_history/);
    // The change-log is deliberately NOT bounded by the window: the cap on day one is
    // whatever the last change before the window set.
    assert.doesNotMatch(sql[2], /observed_at >= \?/);
    const byDate = new Map(
      (data.points as Array<Row>).map((p) => [p.snapshot_date, p]),
    );
    assert.equal(byDate.get("2026-08-01")?.max_validators, 8);
    assert.equal(byDate.get("2026-08-01")?.max_validators_source, "observed");
    assert.equal(byDate.get("2026-08-03")?.max_validators, 64);
    assert.equal(byDate.get("2026-08-03")?.max_validators_source, "observed");
  });

  test("keeps the owner's unconditional permit out of the observed floor", async () => {
    const { env } = historyEnv([
      dayRow("2026-08-01", { stake_tao: 4000, hotkey: "5V0" }),
      dayRow("2026-08-01", { stake_tao: 0, hotkey: "5OWNER" }),
    ]);
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      env,
      7,
      "7d",
      {
        loadEconomicsRow: (async () => ({
          row: { max_validators: 64, owner_hotkey: "5OWNER" },
          generatedAt: null,
        })) as never,
      },
    );
    const points = data.points as Array<Row>;
    assert.equal(
      points[0].permit_floor_alpha,
      4000,
      "a 0 here reads as free to validate",
    );
    assert.equal(points[0].validators_permitted, 2);
  });

  test("a cold economics tier leaves the cap null rather than guessing", async () => {
    const { env } = historyEnv([dayRow("2026-08-01")]);
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      env,
      7,
      "7d",
      {
        loadEconomicsRow: (async () => ({
          row: null,
          generatedAt: null,
        })) as never,
      },
    );
    const points = data.points as Array<Row>;
    assert.equal(points[0].max_validators, null);
    assert.equal(points[0].permit_set_full, null);
  });

  test("joins the emission series from subnet_snapshots", async () => {
    const { env, sql } = historyEnv(
      [dayRow("2026-08-01")],
      [{ snapshot_date: "2026-08-01", tao_in_emission_tao: 0.01 }],
    );
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      env,
      7,
      "30d",
    );
    assert.match(sql[1], /FROM subnet_snapshots/);
    const points = data.points as Row[];
    assert.equal(points[0].emission_gate_open, true);
  });

  test("echoes the window it actually served", async () => {
    const { env } = historyEnv([dayRow("2026-08-01")]);
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      env,
      7,
      "90d",
    );
    assert.equal(data.window, "90d");
    assert.equal(data.netuid, 7);
  });

  test("labels the series as observed rather than derived", async () => {
    const { env } = historyEnv([dayRow("2026-08-01")]);
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      env,
      7,
      "30d",
    );
    const sources = data.field_sources as Record<string, Row>;
    // These come straight off a snapshot, unlike the live route's derived floors.
    assert.equal(sources.permit_floor_alpha.kind, "measured");
    assert.equal(sources.validators_permitted.kind, "measured");
  });

  test("degrades to an empty series when the D1 binding is absent", async () => {
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      {} as never,
      7,
      "30d",
    );
    assert.deepEqual(data.points, []);
  });

  test("tolerates a result set with no rows array", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare: () => ({ bind: () => ({ all: async () => ({}) }) }),
      },
    } as never;
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      env,
      7,
      "30d",
    );
    assert.deepEqual(data.points, []);
  });
});

describe("handleSubnetValidatorEconomicsHistory", () => {
  const call = (path: string, env: unknown) => {
    const url = new URL("https://api.metagraph.sh" + path);
    return handleSubnetValidatorEconomicsHistory(
      new Request(url.toString()),
      env as never,
      Number(url.pathname.split("/")[4]),
      url,
    );
  };
  const env = {} as never;

  test("rejects an unsupported window by name", async () => {
    const res = await call(
      "/api/v1/subnets/7/validator-economics/history?window=1y",
      env,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.match(String((body.error as Row).message), /window must be one of/);
  });

  test("rejects an unknown query parameter", async () => {
    const res = await call(
      "/api/v1/subnets/7/validator-economics/history?sort=cost",
      env,
    );
    assert.equal(res.status, 400);
  });

  test("rejects a netuid outside the u16 range", async () => {
    const res = await call(
      "/api/v1/subnets/99999/validator-economics/history",
      env,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, "invalid_netuid");
  });

  test("defaults the window and returns the standard envelope", async () => {
    const res = await call(
      "/api/v1/subnets/7/validator-economics/history",
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, true);
    assert.equal((body.data as Row).window, "30d");
  });

  test("is reachable through the router", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/validator-economics/history?window=7d",
      ),
      {} as never,
      {},
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).window, "7d");
  });
});
