// Direct unit tests for workers/data-api-tier.ts's tryDataApiTier -- every
// caller across workers/request-handlers/*.mjs shares this one function, so
// its fallback branches (each of which now also bumps
// currentDataApiTierFallbackGeneration() to invalidate an in-flight
// withEdgeCache write, #5090) are tested directly here rather than only
// incidentally through individual handler tests.
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  DATA_API_TIER_RETRY_ATTEMPTS,
  currentDataApiTierFallbackGeneration,
  hasNeuronCapitalPolicy,
  normalizeNeuronCapitalForRoute,
  readExplorerDirectoryCacheStamp,
  tryDataApiTier,
} from "../workers/data-api-tier.ts";
import { mockEnv, type AnyFn } from "./row-type.ts";

// The flag these branch tests pass is a stand-in -- only its membership in
// membership is the TYPE now (#10190), not a runtime set. METAGRAPH_HEALTH_SOURCE
// is the durable choice: #10660 pins "HEALTH is never a forward flag" as a CI
// invariant (src/health-status-live.ts documents why), so it cannot drift into the
// set and silently invert the "returns null" branch below.

function dataApi(handler: AnyFn) {
  return { fetch: handler };
}

function req() {
  return new Request("https://api.metagraph.sh/api/v1/health");
}

test("readExplorerDirectoryCacheStamp: returns the current minute epoch", async () => {
  const now = 1_780_000_000_000;
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
  const result = await readExplorerDirectoryCacheStamp(
    mockEnv({ METAGRAPH_NEURONS_SOURCE: "data-api" }),
  );
  nowSpy.mockRestore();
  assert.equal(result, `minute:${Math.floor(now / 60_000)}`);
});

test("readExplorerDirectoryCacheStamp: declines without the active lane", async () => {
  assert.equal(
    await readExplorerDirectoryCacheStamp(
      mockEnv({ METAGRAPH_NEURONS_SOURCE: "retired" }),
    ),
    null,
  );
});

test("an unforwardable flag no longer COMPILES -- membership moved into the type (#10190)", () => {
  // The 222 dead call sites this parameter's width allowed were swept blind
  // by #10804; the type is what stops the class returning. If this stops
  // erroring, the union widened and the sweep can silently regrow.
  const call = () =>
    // @ts-expect-error METAGRAPH_HEALTH_SOURCE cannot forward and cannot be asked to
    tryDataApiTier(mockEnv({}), req(), "METAGRAPH_HEALTH_SOURCE");
  assert.equal(typeof call, "function");
});

test("tryDataApiTier: a retired VALUE returns null without touching DATA_API or bumping the fallback generation", async () => {
  const before = currentDataApiTierFallbackGeneration();
  let called = false;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "retired",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({});
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(result, null);
  assert.equal(called, false);
  assert.equal(currentDataApiTierFallbackGeneration(), before);
});

test("tryDataApiTier: a DATA_API-D1 flag set to 'd1' FORWARDS to DATA_API", async () => {
  // The neurons dispatcher lives in DATA_API ahead of its Hyperdrive gate, so
  // "d1" on this flag must still forward -- short-circuiting here would make
  // the fully-seeded D1 tables unreachable and serve empties.
  let called = false;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({ data: { neurons: [1] } });
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(called, true);
  assert.deepEqual(result, { data: { neurons: [1] } });
});

test("tryDataApiTier: the hyperparams and account-identity flags set to 'd1' FORWARD to DATA_API", async () => {
  // Their dispatchers (matchHyperparamsIdentityStoreRoute) live in DATA_API
  // ahead of its Hyperdrive gate, same as the neurons one -- and the
  // cold-tier fallback depends on the forward too: DATA_API 503s while its
  // table is empty, which is what sends the serving handler on to the
  // lakehouse cold-tier reader instead of a schema-stable mask.
  for (const flagName of [
    "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
    "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
  ] as const) {
    let called = false;
    const env = mockEnv({
      [flagName]: "data-api",
      DATA_API: dataApi(async () => {
        called = true;
        return Response.json({ data: { ok: true } });
      }),
    });
    const result = await tryDataApiTier(env, req(), flagName);
    assert.equal(called, true, `${flagName} must forward on "data-api"`);
    assert.deepEqual(result, { data: { ok: true } });
  }
});

test("tryDataApiTier: a non-2xx from a forwarded 'd1' flag degrades to null (the cold-tier handoff)", async () => {
  // The D1 dispatcher answers 503 while its table is pre-first-sync empty;
  // the null return is what lets the serving handler fall through to the
  // lakehouse cold-tier snapshot.
  const env = mockEnv({
    METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "data-api",
    DATA_API: dataApi(
      async () =>
        new Response(JSON.stringify({ error: "d1 tier cold" }), {
          status: 503,
        }),
    ),
  });
  const result = await tryDataApiTier(
    env,
    req(),
    "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
  );
  assert.equal(result, null);
});

test("tryDataApiTier: a retired value short-circuits even with DATA_API bound", async () => {
  // Health and subnet-snapshot D1 loaders live in THIS worker; forwarding
  // their "d1" to DATA_API would hit Postgres-only legs there. The allowlist
  // is per-flag on purpose.
  let called = false;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "retired",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({});
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(result, null);
  assert.equal(called, false);
});

test("tryDataApiTier: 'retired' on the neurons flag short-circuits too", async () => {
  let called = false;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "retired",
    DATA_API: dataApi(async () => {
      called = true;
      return Response.json({});
    }),
  });
  assert.equal(
    await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE"),
    null,
  );
  assert.equal(called, false);
});

test("tryDataApiTier: no DATA_API binding falls back and bumps the fallback generation", async () => {
  const before = currentDataApiTierFallbackGeneration();
  const env = mockEnv({ METAGRAPH_NEURONS_SOURCE: "data-api" });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentDataApiTierFallbackGeneration(), before + 1);
});

test("tryDataApiTier: DATA_API.fetch throwing falls back and bumps the fallback generation", async () => {
  const before = currentDataApiTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => {
      throw new Error("network down");
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentDataApiTierFallbackGeneration(), before + 1);
});

test("tryDataApiTier: a non-2xx DATA_API response falls back and bumps the fallback generation", async () => {
  const before = currentDataApiTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => new Response(null, { status: 502 })),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentDataApiTierFallbackGeneration(), before + 1);
});

test("tryDataApiTier: an unparseable response body falls back and bumps the fallback generation", async () => {
  const before = currentDataApiTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentDataApiTierFallbackGeneration(), before + 1);
});

test("tryDataApiTier: a JSON body that isn't an object (a bare string) falls back and bumps the fallback generation", async () => {
  const before = currentDataApiTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => Response.json("unexpected")),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(result, null);
  assert.equal(currentDataApiTierFallbackGeneration(), before + 1);
});

test("tryDataApiTier: a successful JSON object response is returned as-is without bumping the fallback generation", async () => {
  const before = currentDataApiTierFallbackGeneration();
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () =>
      Response.json({ schema_version: 1, block_count: 5 }),
    ),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.deepEqual(result, { schema_version: 1, block_count: 5 });
  assert.equal(currentDataApiTierFallbackGeneration(), before);
});

test("tryDataApiTier: rewrites a HEAD request to GET before forwarding to DATA_API", async () => {
  let receivedMethod: string | undefined;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async (request: Request) => {
      receivedMethod = request.method;
      return Response.json({ ok: true });
    }),
  });
  await tryDataApiTier(
    env,
    new Request("https://api.metagraph.sh/api/v1/health", { method: "HEAD" }),
    "METAGRAPH_NEURONS_SOURCE",
  );
  assert.equal(receivedMethod, "GET");
});

// ---- the transient retry (#10665) ----
//
// The neurons tier degraded to the schema-stable empty response in BURSTS for
// sixteen days, with clean days in between. That shape is a transient -- the
// DATA_API service binding failing to produce a response while that Worker is
// mid-deploy -- and degrading on the first refusal turned each blip into a
// confidently wrong answer served to a caller. One retry is the difference
// between a slow correct answer and a fast wrong one.

test("tryDataApiTier: a 5xx is asked a second time, and a recovered retry ANSWERS", async () => {
  const before = currentDataApiTierFallbackGeneration();
  let calls = 0;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 503 })
        : Response.json({ schema_version: 1, recovered: true });
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(calls, 2, "the first 5xx must not be the final answer");
  assert.deepEqual(result, { schema_version: 1, recovered: true });
  assert.equal(
    currentDataApiTierFallbackGeneration(),
    before,
    "a recovered retry is not a fallback and must not invalidate an edge write",
  );
});

test("tryDataApiTier: a transport THROW is retried too, and a recovered retry answers", async () => {
  // A thrown subrequest and a 5xx are the same fault from two sides: the
  // binding could not reach a Worker able to answer.
  let calls = 0;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Network connection lost.");
      return Response.json({ schema_version: 1 });
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(calls, 2);
  assert.deepEqual(result, { schema_version: 1 });
});

test("tryDataApiTier: a 4xx is NOT retried -- it will be exactly as wrong twice", async () => {
  let calls = 0;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => {
      calls += 1;
      return new Response(null, { status: 400 });
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(calls, 1, "retrying a bad request only doubles the load");
  assert.equal(result, null);
});

test("tryDataApiTier: a 2xx is not retried", async () => {
  let calls = 0;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => {
      calls += 1;
      return Response.json({ ok: true });
    }),
  });
  await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(calls, 1);
});

test("tryDataApiTier: the retry is capped at one extra ask", async () => {
  // A DATA_API that is genuinely down must degrade quickly rather than hold
  // every request open behind an unbounded retry loop.
  let calls = 0;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => {
      calls += 1;
      return new Response(null, { status: 502 });
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(calls, DATA_API_TIER_RETRY_ATTEMPTS);
  assert.equal(calls, 2, "the cap is one retry, stated as a number here too");
  assert.equal(result, null);
});

test("tryDataApiTier: a persistent transport throw still degrades after the cap", async () => {
  const before = currentDataApiTierFallbackGeneration();
  let calls = 0;
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async () => {
      calls += 1;
      throw new Error("Network connection lost.");
    }),
  });
  const result = await tryDataApiTier(env, req(), "METAGRAPH_NEURONS_SOURCE");
  assert.equal(calls, DATA_API_TIER_RETRY_ATTEMPTS);
  assert.equal(result, null);
  assert.equal(currentDataApiTierFallbackGeneration(), before + 1);
});

test("tryDataApiTier: the failing request PATH is in the message, masked", async () => {
  // #10665 was unanswerable for sixteen days because the capture named the
  // FLAG and never the request: "DATA_API returned 502" with no way to tell
  // which of the twenty-nine neurons-gated routes produced it. The path is
  // masked with the analytics labeller so a per-account route cannot turn one
  // recurring fault into one message per address.
  const seen: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void seen.push(args.join(" "));
  try {
    const env = mockEnv({
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: dataApi(async () => new Response(null, { status: 503 })),
    });
    await tryDataApiTier(
      env,
      new Request("https://api.metagraph.sh/api/v1/subnets/64/metagraph"),
      "METAGRAPH_NEURONS_SOURCE",
    );
  } finally {
    console.error = realError;
  }
  const line = seen.join("\n");
  assert.match(line, /\/api\/v1\/subnets\/:n\/metagraph/);
  assert.ok(
    !line.includes("/64/"),
    "the netuid must be masked, or one fault becomes one message per subnet",
  );
});

// During independent Worker rollouts the binding can still serve the old
// voting-weight-derived financial payload. Guard it once for REST and MCP.
const VALIDATOR_HOTKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const LEGACY_VALIDATOR_CAPITAL_FIELDS = [
  "total_stake_tao",
  "root_stake_tao",
  "alpha_stake_tao",
  "apy_estimate",
  "stake_dominance",
] as const;
const CURRENT_VALIDATOR_CAPITAL = Object.fromEntries(
  LEGACY_VALIDATOR_CAPITAL_FIELDS.map((field) => [field, null]),
);

async function readValidatorPayload(path: string, body: unknown) {
  const before = currentDataApiTierFallbackGeneration();
  const forwarded: string[] = [];
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: dataApi(async (request: Request) => {
      forwarded.push(request.url);
      return Response.json(body);
    }),
  });
  const request = new Request(`https://api.metagraph.sh${path}`);
  const result = await tryDataApiTier(env, request, "METAGRAPH_NEURONS_SOURCE");
  assert.deepEqual(forwarded, [request.url], "one fetch with the original network scope");
  return { result, before, after: currentDataApiTierFallbackGeneration() };
}

test.each(
  LEGACY_VALIDATOR_CAPITAL_FIELDS.flatMap((field) =>
    [0, 125].map((value) => ({ field, value })),
  ),
)("global validator $field=$value declines the already-selected legacy page", async ({ field, value }) => {
  const { result, before, after } = await readValidatorPayload(
    "/api/v1/validators?sort=total_stake&limit=1",
    { limit: 1, validator_count: 100, validators: [{ hotkey: VALIDATOR_HOTKEY, ...CURRENT_VALIDATOR_CAPITAL, [field]: value }] },
  );
  assert.equal(result, null);
  assert.equal(after, before + 1);
});

test.each([
  "/api/v1/validators",
  "/api/v1/mainnet/validators",
  "/api/v1/finney/validators/",
  "/api/v1/testnet/validators",
  "/api/v1/test/validators",
  "/api/v1/mainnet/finney/validators",
])("fresh null capital preserves membership and emission on %s", async (path) => {
  const body = {
    validators: [{
      hotkey: VALIDATOR_HOTKEY,
      total_stake_tao: null,
      root_stake_tao: null,
      alpha_stake_tao: null,
      apy_estimate: null,
      apy_estimate_eligible_subnet_count: 0,
      stake_dominance: null,
      realized_return_1d: null,
      realized_return_1d_as_of: null,
      realized_return_1w: null,
      realized_return_1w_as_of: null,
      realized_return_1m: null,
      realized_return_1m_as_of: null,
      total_emission_tao: 12,
      avg_validator_trust: 0.8,
      subnets: [{ netuid: 3, uid: 4, stake_alpha: 180 }],
    }],
  };
  const { result, before, after } = await readValidatorPayload(path, body);
  assert.deepEqual(result, body);
  assert.equal(after, before);
});

test.each([false, true])("old realized returns alone preserve current membership with wrapped=%s", async (wrapped) => {
  const validator = {
    hotkey: VALIDATOR_HOTKEY,
    total_stake_tao: null,
    root_stake_tao: null,
    alpha_stake_tao: null,
    apy_estimate: null,
    apy_estimate_eligible_subnet_count: 3,
    stake_dominance: null,
    realized_return_1d: 0,
    realized_return_1d_as_of: "2026-10-16",
    realized_return_1w: -0.5,
    realized_return_1w_as_of: "2026-10-10",
    realized_return_1m: 0.25,
    realized_return_1m_as_of: "2026-09-17",
    total_emission_tao: 12,
    avg_validator_trust: 0.9,
    subnets: [{ netuid: 3, uid: 4, stake_alpha: 180 }],
  };
  const page = { validator_count: 1, validators: [validator] };
  const body = wrapped ? { data: page, generatedAt: "capture" } : page;
  const expected = {
    ...page,
    validators: [{
      ...validator,
      apy_estimate_eligible_subnet_count: 0,
      realized_return_1d: null,
      realized_return_1d_as_of: null,
      realized_return_1w: null,
      realized_return_1w_as_of: null,
      realized_return_1m: null,
      realized_return_1m_as_of: null,
    }],
  };
  const { result, before, after } = await readValidatorPayload("/api/v1/validators", body);
  assert.deepEqual(result, wrapped ? { data: expected, generatedAt: "capture" } : expected);
  assert.equal(after, before);
  assert.equal(validator.realized_return_1w, -0.5);
});

test("wrapped legacy validator pages decline too, without retrying or repairing a limited subset", async () => {
  const { result, before, after } = await readValidatorPayload(
    "/api/v1/testnet/validators?limit=1",
    { data: { validators: [null, { total_stake_tao: 100 }] }, generatedAt: "capture" },
  );
  assert.equal(result, null);
  assert.equal(after, before + 1);
});

test.each([
  { label: "capital", operator: { total_stake_tao: 0 } },
  { label: "APY", operator: { apy_estimate: 0 } },
  { label: "dominance", operator: { stake_dominance: 0 } },
  { label: "child capital", operator: { total_stake_tao: null, hotkeys: [{ total_stake_tao: 0 }] } },
])("legacy operator $label declines instead of retaining a financially-selected primary", async ({ operator }) => {
  const { result, before, after } = await readValidatorPayload(
    "/api/v1/validators/operators",
    { operators: [{
      total_stake_tao: null,
      apy_estimate: null,
      stake_dominance: null,
      hotkeys: [{ total_stake_tao: null }],
      ...operator,
    }] },
  );
  assert.equal(result, null);
  assert.equal(after, before + 1);
});

test("wrapped operator capital declines while current null operators pass unchanged", async () => {
  const rejected = await readValidatorPayload(
    "/api/v1/mainnet/validators/operators",
    { data: { operators: [{ total_stake_tao: 7 }] } },
  );
  assert.equal(rejected.result, null);
  assert.equal(rejected.after, rejected.before + 1);
  const body = {
    data: { operators: [{
      total_stake_tao: null,
      apy_estimate: null,
      stake_dominance: null,
      total_emission_tao: 3,
      hotkeys: [{ hotkey: VALIDATOR_HOTKEY, total_stake_tao: null, take: 0.1 }],
    }] },
    generatedAt: "capture",
  };
  const accepted = await readValidatorPayload("/api/v1/test/validators/operators", body);
  assert.deepEqual(accepted.result, body);
  assert.equal(accepted.after, accepted.before);
});

test.each([false, true])("validator detail nulls legacy capital with wrapped=%s", async (wrapped) => {
  const detail = {
    hotkey: VALIDATOR_HOTKEY,
    total_stake_tao: 1000,
    root_stake_tao: 0,
    alpha_stake_tao: 1000,
    apy_estimate: 0.25,
    apy_estimate_eligible_subnet_count: 3,
    total_emission_tao: 12,
    avg_validator_trust: 0.9,
    take: 0.18,
    realized_return_1d: 0,
    realized_return_1d_as_of: "2026-10-16",
    realized_return_1w: -0.5,
    realized_return_1w_as_of: "2026-10-10",
    realized_return_1m: 0.25,
    realized_return_1m_as_of: "2026-09-17",
    subnets: [{ netuid: 3, uid: 4, stake_alpha: 180, validator_trust: 0.9 }],
  };
  const body = wrapped ? { data: detail, generatedAt: "capture" } : detail;
  const expected = {
    ...detail,
    total_stake_tao: null,
    root_stake_tao: null,
    alpha_stake_tao: null,
    apy_estimate: null,
    apy_estimate_eligible_subnet_count: 0,
    realized_return_1d: null,
    realized_return_1d_as_of: null,
    realized_return_1w: null,
    realized_return_1w_as_of: null,
    realized_return_1m: null,
    realized_return_1m_as_of: null,
  };
  const { result, before, after } = await readValidatorPayload(
    `/api/v1/finney/validators/${VALIDATOR_HOTKEY}`,
    body,
  );
  assert.deepEqual(result, wrapped ? { data: expected, generatedAt: "capture" } : expected);
  assert.equal(after, before);
  assert.equal(detail.total_stake_tao, 1000, "the original source fixture is unmodified");
});

test.each([false, true])("history strips only existing financial point fields with wrapped=%s", async (wrapped) => {
  const point = {
    snapshot_date: "2026-10-17",
    total_stake_tao: 1000,
    rewards_per_1000_tao: 12,
    rewards_per_1000_alpha: 7,
    stake_share: 0.5,
    dividend_efficiency: 1.2,
    total_emission_tao: 4,
    stake_alpha: 180,
    take: 0.18,
    validator_trust: 0.9,
    dividends: 0.6,
    validator_permit: false,
  };
  const sparse = { snapshot_date: "2026-10-16", total_emission_tao: null };
  const history = { take_u16: 11796, points: [point, sparse, null] };
  const body = wrapped ? { data: history, meta: { source: "capture" } } : history;
  const expected = {
    ...history,
    points: [{
      ...point,
      total_stake_tao: null,
      rewards_per_1000_tao: null,
      rewards_per_1000_alpha: null,
      stake_share: null,
      dividend_efficiency: null,
    }, sparse, null],
  };
  const { result, before, after } = await readValidatorPayload(
    `/api/v1/testnet/validators/${VALIDATOR_HOTKEY}/history?window=30d`,
    body,
  );
  assert.deepEqual(result, wrapped ? { data: expected, meta: { source: "capture" } } : expected);
  assert.equal(after, before);
});

test.each([
  "/api/v1/validators/economics",
  "/api/v1/validators/economics/history",
  "/api/v1/validators/operators/history",
  `/api/v1/validators/${VALIDATOR_HOTKEY}/nominators`,
  "/api/v1/subnets/3/validators",
  "/api/v1/testnet/subnets/3/metagraph",
  `/api/v1/validators/${VALIDATOR_HOTKEY}/history/extra`,
  "/api/v1/unrecognized/validators",
])("the validator capital guard does not intercept %s", async (path) => {
  const body = { total_stake_tao: 0, apy_estimate: 0, validators: [{ total_stake_tao: 1 }] };
  const { result, before, after } = await readValidatorPayload(path, body);
  assert.deepEqual(result, body);
  assert.equal(after, before);
});

test("the capital guard stays scoped to the neurons flag", async () => {
  const before = currentDataApiTierFallbackGeneration();
  const body = { validators: [{ total_stake_tao: 1 }] };
  const env = mockEnv({
    METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "data-api",
    DATA_API: dataApi(async () => Response.json(body)),
  });
  const result = await tryDataApiTier(
    env,
    new Request("https://api.metagraph.sh/api/v1/validators"),
    "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
  );
  assert.deepEqual(result, body);
  assert.equal(currentDataApiTierFallbackGeneration(), before);
});

test.each([
  { path: "/api/v1/validators", body: {}, decline: true },
  { path: "/api/v1/validators/operators", body: { operators: [null, {}] }, decline: true },
  { path: `/api/v1/validators/${VALIDATOR_HOTKEY}/history`, body: { points: null }, decline: false },
  { path: "/api/v1/compare/validators", body: { validators: null }, decline: false },
])("missing collections do not become fabricated measurements on $path", async ({ path, body, decline }) => {
  const { result, before, after } = await readValidatorPayload(path, body);
  assert.deepEqual(result, decline ? null : body);
  assert.equal(after, before + (decline ? 1 : 0));
});

const CURRENT_ACCOUNT = {
  hotkey: VALIDATOR_HOTKEY,
  total_stake_tao: null,
  stake_dominance: null,
  total_emission_tao: 7,
  subnet_count: 2,
  subnets: [{ netuid: 1, uid: 3, stake_alpha: null, emission_alpha: 4 }],
};

test.each([
  { total_stake_tao: 0 },
  { total_stake_tao: 90 },
  { stake_dominance: 0 },
  { subnets: [{ netuid: 1, uid: 3, stake_alpha: 0 }] },
])("accounts decline legacy financial selection including $total_stake_tao", async (legacy) => {
  const body = {
    data: { account_count: 200, limit: 1, accounts: [{ ...CURRENT_ACCOUNT, ...legacy }] },
    meta: { source: "old-service" },
  };
  const { result, before, after } = await readValidatorPayload(
    "/api/v1/mainnet/accounts?sort=subnet_count&limit=1",
    body,
  );
  assert.equal(result, null);
  assert.equal(after, before + 1);
});

test.each(["/api/v1/accounts", "/api/v1/finney/accounts/", "/api/v1/testnet/accounts"])(
  "accounts with unavailable capital retain independent evidence on %s",
  async (path) => {
    const body = { account_count: 1, accounts: [CURRENT_ACCOUNT] };
    const { result, before, after } = await readValidatorPayload(path, body);
    assert.deepEqual(result, body);
    assert.equal(after, before);
  },
);

test.each([
  { priced_registered_stake_tao: 0 },
  { rankings: { stake: [CURRENT_ACCOUNT], emission: [], reach: [] } },
  { rankings: { stake: [], emission: [{ ...CURRENT_ACCOUNT, total_stake_tao: 0 }], reach: [] } },
  { rankings: { stake: [], emission: [], reach: [{ ...CURRENT_ACCOUNT, stake_dominance: 0 }] } },
])("holder directories decline old selection rather than stripping it", async (legacy) => {
  const body = {
    priced_registered_stake_tao: null,
    rankings: { stake: [], emission: [CURRENT_ACCOUNT], reach: [CURRENT_ACCOUNT] },
    ...legacy,
  };
  const { result, before, after } = await readValidatorPayload(
    "/api/v1/accounts/directory",
    body,
  );
  assert.equal(result, null);
  assert.equal(after, before + 1);
});

test("current holder rankings preserve independent emission and reach with wrapper metadata", async () => {
  const body = {
    data: {
      priced_registered_stake_tao: null,
      rankings: { stake: [], emission: [CURRENT_ACCOUNT], reach: [CURRENT_ACCOUNT] },
    },
    generatedAt: "capture",
  };
  const { result, before, after } = await readValidatorPayload("/api/v1/accounts/directory", body);
  assert.deepEqual(result, body);
  assert.equal(after, before);
});

test.each([false, true])("full portfolio membership is copied safely with wrapped=%s", async (wrapped) => {
  const portfolio = {
    ss58: VALIDATOR_HOTKEY,
    captured_at: "2026-10-17T00:00:00.000Z",
    total_stake_tao: 1000,
    total_emission_tao: 9,
    overall_yield: 0.9,
    stake_concentration: { hhi: 0.8 },
    positions: [
      { netuid: 7, uid: 3, stake_alpha: 900, yield: 0.1, emission_alpha: 5, trust: 0.8 },
      { netuid: 1, uid: 4, stake_alpha: 100, yield: 0.2, emission_alpha: 4, trust: null },
    ],
  };
  const body = wrapped ? { data: portfolio, meta: { source: "capture" } } : portfolio;
  const expected = {
    ...portfolio,
    total_stake_tao: null,
    overall_yield: null,
    stake_concentration: null,
    positions: [portfolio.positions[1], portfolio.positions[0]].map((position) => ({
      ...position,
      stake_alpha: null,
      yield: null,
    })),
  };
  const { result, before, after } = await readValidatorPayload(
    `/api/v1/finney/accounts/${VALIDATOR_HOTKEY}/portfolio`,
    body,
  );
  assert.deepEqual(result, wrapped ? { data: expected, meta: { source: "capture" } } : expected);
  assert.equal(after, before);
  assert.equal(portfolio.positions[0]!.stake_alpha, 900);
});

test.each([
  "/api/v1/accounts/top-holders",
  `/api/v1/accounts/${VALIDATOR_HOTKEY}`,
  `/api/v1/accounts/${VALIDATOR_HOTKEY}/positions`,
  `/api/v1/accounts/${VALIDATOR_HOTKEY}/subnets`,
  `/api/v1/accounts/${VALIDATOR_HOTKEY}/subnets/1/history`,
  `/api/v1/accounts/${VALIDATOR_HOTKEY}/balance`,
])("account financial guards do not intercept independent route %s", async (path) => {
  const body = { total_stake_tao: 15, stake_alpha: 30, yield: 0.5 };
  const { result, before, after } = await readValidatorPayload(path, body);
  assert.deepEqual(result, body);
  assert.equal(after, before);
});

test("the shared policy vocabulary recognizes canonical families and preserves unrelated values", () => {
  for (const route of [
    "/api/v1/accounts",
    "/api/v1/accounts/directory",
    "/api/v1/accounts/{ss58}/portfolio",
    "/api/v1/validators",
    "/api/v1/validators/operators",
    "/api/v1/validators/{hotkey}",
    "/api/v1/validators/{hotkey}/history",
    "/api/v1/compare/validators",
  ]) {
    assert.equal(hasNeuronCapitalPolicy(route), true, route);
  }
  const body = { total_stake_tao: 100, free_tao: 20, net_flow_tao: -5 };
  for (const route of [
    "/api/v1/accounts/{ss58}/balance",
    "/api/v1/accounts/{ss58}/stake-flow",
    "/api/v1/accounts/top-holders",
    "/api/v1/validators/economics",
    "/api/v1/subnets/{netuid}/validators",
    "/api/v1/validators/",
    "/api/v1/unknown",
  ]) {
    assert.equal(hasNeuronCapitalPolicy(route), false, route);
    assert.equal(normalizeNeuronCapitalForRoute(route, body), body);
  }
});

test.each(LEGACY_VALIDATOR_CAPITAL_FIELDS)(
  "a missing required validator financial field %s declines without manufacturing null provenance",
  async (field) => {
    const incomplete = Object.fromEntries(
      Object.entries(CURRENT_VALIDATOR_CAPITAL).filter(([key]) => key !== field),
    );
    const { result, before, after } = await readValidatorPayload(
      "/api/v1/validators",
      { validators: [incomplete] },
    );
    assert.equal(result, null);
    assert.equal(after, before + 1);
  },
);

test.each([null, false, 4, [], {}])("malformed validator row %j declines the whole capped page", async (row) => {
  const { result, before, after } = await readValidatorPayload(
    "/api/v1/validators",
    { validators: [CURRENT_VALIDATOR_CAPITAL, row] },
  );
  assert.equal(result, null);
  assert.equal(after, before + 1);
});

test.each([
  {},
  { operators: null },
  { operators: [null] },
  { operators: [{ total_stake_tao: null, apy_estimate: null, stake_dominance: null }] },
  { operators: [{ total_stake_tao: null, apy_estimate: null, stake_dominance: null, hotkeys: null }] },
  { operators: [{ total_stake_tao: null, apy_estimate: null, stake_dominance: null, hotkeys: [null] }] },
  { operators: [{ total_stake_tao: null, apy_estimate: null, stake_dominance: null, hotkeys: [{}] }] },
  ...["total_stake_tao", "apy_estimate", "stake_dominance"].map((missing) => ({
    operators: [Object.fromEntries(Object.entries({
      total_stake_tao: null,
      apy_estimate: null,
      stake_dominance: null,
      hotkeys: [{ total_stake_tao: null }],
    }).filter(([key]) => key !== missing))],
  })),
])("malformed or incomplete operator capital cannot establish safe selection", async (body) => {
  const { result, before, after } = await readValidatorPayload(
    "/api/v1/validators/operators",
    body,
  );
  assert.equal(result, null);
  assert.equal(after, before + 1);
});

test.each([false, true])("comparison normalization preserves order, clocks and strict keys with wrapped=%s", async (wrapped) => {
  const comparison = {
    schema_version: 1,
    netuid: 3,
    validator_count: 2,
    validators: [
      {
        hotkey: VALIDATOR_HOTKEY,
        total_stake_tao: 0,
        apy_estimate: 0.5,
        apy_estimate_eligible_subnet_count: 4,
        total_emission_tao: 12,
        take: 0.18,
        subnet_context: { netuid: 3, uid: 5, stake_alpha: 180, validator_trust: 0.9 },
      },
      { hotkey: "sparse", subnet_context: null },
    ],
  };
  const meta = { network: "mainnet", generated_at: "2026-10-17T03:00:00.000Z" };
  const body = wrapped ? { data: comparison, meta } : comparison;
  const expected = {
    ...comparison,
    validators: [{
      ...comparison.validators[0],
      total_stake_tao: null,
      apy_estimate: null,
      apy_estimate_eligible_subnet_count: 0,
    }, comparison.validators[1]],
  };
  const { result, before, after } = await readValidatorPayload(
    `/api/v1/mainnet/compare/validators?hotkeys=${VALIDATOR_HOTKEY}&netuid=3`,
    body,
  );
  assert.deepEqual(result, wrapped ? { data: expected, meta } : expected);
  assert.equal(after, before);
  assert.equal(comparison.validators[0]!.total_stake_tao, 0);
});

test("the reusable normalizer has no fallback counter side effects", () => {
  const before = currentDataApiTierFallbackGeneration();
  assert.equal(normalizeNeuronCapitalForRoute("/api/v1/validators", { validators: [{}] }), null);
  assert.equal(normalizeNeuronCapitalForRoute("/api/v1/validators/operators", {}), null);
  const detail = { hotkey: "short", total_stake_tao: 12, stake_dominance: 0.2, captured_at: "detail-clock" };
  const result = normalizeNeuronCapitalForRoute("/api/v1/validators/{hotkey}", detail)!;
  assert.equal(result.total_stake_tao, null);
  assert.equal(result.stake_dominance, null);
  assert.equal(result.captured_at, "detail-clock");
  assert.equal(detail.total_stake_tao, 12);
  assert.equal(currentDataApiTierFallbackGeneration(), before);
  const comparison = { validators: [null, {}], generated_at: "comparison-clock" };
  assert.deepEqual(normalizeNeuronCapitalForRoute("/api/v1/compare/validators", comparison), comparison);
});
