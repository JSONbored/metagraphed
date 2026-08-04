import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetValidatorEconomicsPayload,
  handleSubnetValidatorEconomics,
} from "../workers/request-handlers/entities.ts";

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
    // A SELECT * here would drag ~20 unused columns per UID across 256 rows.
    assert.doesNotMatch(sql[0], /SELECT \*/);
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
