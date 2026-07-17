import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainFees,
  buildChainSigners,
} from "../src/chain-analytics.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

function installMapCache() {
  const store = new Map();
  const putKeys = [];
  let matchCalls = 0;
  globalThis.caches = {
    default: {
      async match(request) {
        matchCalls += 1;
        const cached = store.get(request.url);
        return cached ? cached.clone() : undefined;
      },
      async put(request, response) {
        putKeys.push(request.url);
        store.set(request.url, response.clone());
      },
    },
  };
  return {
    store,
    putKeys,
    get matchCalls() {
      return matchCalls;
    },
  };
}

// D1 fully eliminated (2026-07-16): extrinsics'/blocks' D1 write path is
// retired (#4772) and the tables are dropped in production, so
// handleChainActivity now goes tryPostgresTier -> buildChainActivity([...])
// on any miss/outage, never a live D1 read. This mocks the Postgres tier
// instead of D1.
function chainActivityPostgresEnv() {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_EXTRINSICS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          window: "7d",
          observed_at: "2026-06-26T12:00:00.000Z",
          day_count: 2,
          days: [
            {
              day: "2026-06-25",
              block_count: 7200,
              extrinsic_count: 100,
              event_count: 30000,
              successful_extrinsics: 99,
              success_rate: 0.99,
              unique_signers: 40,
            },
            {
              day: "2026-06-24",
              block_count: 7100,
              extrinsic_count: 50,
              event_count: 29000,
              successful_extrinsics: 50,
              success_rate: 1,
              unique_signers: 20,
            },
          ],
        }),
    },
  };
}

const activityReq = (q = "") =>
  new Request(`https://api.metagraph.sh/api/v1/chain/activity${q}`);

test("buildChainActivity merges the extrinsics + blocks tiers by UTC day", () => {
  const out = buildChainActivity({
    window: "7d",
    observedAt: "2026-06-26T12:00:00.000Z",
    extrinsicRows: [
      {
        day: "2026-06-25",
        extrinsic_count: 100,
        successful_extrinsics: 99,
        unique_signers: 42,
      },
    ],
    blockRows: [{ day: "2026-06-25", block_count: 7200, event_count: 30000 }],
  });
  assert.equal(out.schema_version, 1);
  assert.equal(out.window, "7d");
  assert.equal(out.observed_at, "2026-06-26T12:00:00.000Z");
  assert.equal(out.day_count, 1);
  assert.deepEqual(out.days[0], {
    day: "2026-06-25",
    block_count: 7200,
    extrinsic_count: 100,
    event_count: 30000,
    successful_extrinsics: 99,
    success_rate: 0.99,
    unique_signers: 42,
  });
});

test("success_rate is successful/total, rounded to 4dp", () => {
  const [d] = buildChainActivity({
    window: "7d",
    extrinsicRows: [
      {
        day: "2026-06-25",
        extrinsic_count: 12345,
        successful_extrinsics: 12243,
      },
    ],
  }).days;
  assert.equal(d.success_rate, 0.9917); // 12243/12345 = 0.991737…
});

test("success_rate clamps a sub-perfect ratio that rounds to 1.0", () => {
  const [d] = buildChainActivity({
    window: "7d",
    extrinsicRows: [
      {
        day: "2026-06-25",
        extrinsic_count: 100_000,
        successful_extrinsics: 99_999,
      },
    ],
  }).days;
  assert.equal(d.success_rate, 0.9999); // 99_999/100_000 = 0.99999 → not 1
});

test("a day with zero extrinsics reports success_rate null, never NaN", () => {
  const out = buildChainActivity({
    window: "7d",
    blockRows: [{ day: "2026-06-25", block_count: 10, event_count: 5 }],
  });
  assert.equal(out.days[0].success_rate, null);
  assert.equal(out.days[0].extrinsic_count, 0);
  // null must survive a JSON round-trip (NaN would serialize to null silently).
  assert.equal(JSON.parse(JSON.stringify(out)).days[0].success_rate, null);
});

test("days are ordered newest-first", () => {
  const out = buildChainActivity({
    window: "30d",
    extrinsicRows: [
      { day: "2026-06-20", extrinsic_count: 1, successful_extrinsics: 1 },
      { day: "2026-06-25", extrinsic_count: 1, successful_extrinsics: 1 },
      { day: "2026-06-22", extrinsic_count: 1, successful_extrinsics: 1 },
    ],
  });
  assert.deepEqual(
    out.days.map((d) => d.day),
    ["2026-06-25", "2026-06-22", "2026-06-20"],
  );
});

test("a day present in only one tier still appears, zero-filled", () => {
  const out = buildChainActivity({
    window: "7d",
    extrinsicRows: [
      { day: "2026-06-25", extrinsic_count: 5, successful_extrinsics: 5 },
    ],
    blockRows: [{ day: "2026-06-24", block_count: 100, event_count: 200 }],
  });
  assert.equal(out.day_count, 2);
  const d25 = out.days.find((d) => d.day === "2026-06-25");
  const d24 = out.days.find((d) => d.day === "2026-06-24");
  assert.equal(d25.block_count, 0); // extrinsics-only day
  assert.equal(d25.event_count, 0);
  assert.equal(d24.extrinsic_count, 0); // blocks-only day
  assert.equal(d24.success_rate, null);
});

test("is schema-stable-zero on a cold store (no rows)", () => {
  const out = buildChainActivity({ window: "7d" });
  assert.deepEqual(out, {
    schema_version: 1,
    window: "7d",
    observed_at: null,
    day_count: 0,
    days: [],
  });
});

test("coerces D1 cell shapes (numeric strings, null, negatives) to non-negative ints", () => {
  const [d] = buildChainActivity({
    window: "7d",
    extrinsicRows: [
      {
        day: "2026-06-25",
        extrinsic_count: "100", // numeric string from D1
        successful_extrinsics: null, // SUM over no matching rows
        unique_signers: -3, // never negative
      },
    ],
  }).days;
  assert.equal(d.extrinsic_count, 100);
  assert.equal(d.successful_extrinsics, 0);
  assert.equal(d.unique_signers, 0);
  assert.equal(d.success_rate, 0); // 0/100
});

test("ignores junk rows (null, non-object, missing/non-string day)", () => {
  const out = buildChainActivity({
    window: "7d",
    extrinsicRows: [
      null,
      "nope",
      { extrinsic_count: 9 }, // no day
      { day: 20260625, extrinsic_count: 9 }, // non-string day
      { day: "2026-06-25", extrinsic_count: 1, successful_extrinsics: 1 },
    ],
  });
  assert.equal(out.day_count, 1);
  assert.equal(out.days[0].day, "2026-06-25");
});

// ---- handler (#1987) -------------------------------------------------------

test("GET /api/v1/chain/activity merges + groups the chain tiers by UTC day", async () => {
  const res = await handleRequest(
    activityReq("?window=7d"),
    chainActivityPostgresEnv(),
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.schema_version, 1);
  assert.equal(body.data.window, "7d");
  assert.equal(body.data.day_count, 2);
  // newest day first; extrinsics + blocks tiers merged on the same day.
  assert.equal(body.data.days[0].day, "2026-06-25");
  assert.equal(body.data.days[0].success_rate, 0.99); // 99/100
  assert.equal(body.data.days[0].block_count, 7200);
  assert.equal(body.data.days[0].unique_signers, 40);
  assert.equal(body.data.days[1].success_rate, 1); // 50/50
});

test("GET /api/v1/chain/activity rejects an unsupported window with 400", async () => {
  const res = await handleRequest(
    activityReq("?window=99d"),
    createLocalArtifactEnv(),
    {},
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_query");
});

test("GET /api/v1/chain/activity is schema-stable empty when D1 is cold", async () => {
  const res = await handleRequest(activityReq(), createLocalArtifactEnv(), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.day_count, 0);
  assert.deepEqual(body.data.days, []);
});

// ---- calls (#1989) builder + handler --------------------------------------

test("buildChainCalls computes share against the full-window total, not the LIMIT", () => {
  const out = buildChainCalls({
    window: "7d",
    total: 1000, // full-window count, larger than the summed rows (tail clipped)
    rows: [
      { call_module: "SubtensorModule", count: 600 },
      { call_module: "Balances", count: 150 },
    ],
  });
  assert.equal(out.total_extrinsics, 1000);
  assert.equal(out.call_count, 2);
  assert.equal(out.calls[0].share, 0.6); // 600/1000, not 600/750
  assert.equal(out.calls[1].share, 0.15);
  assert.equal(out.calls[0].call_function, null); // module grouping
});

test("buildChainCalls populates call_function only under module_function grouping", () => {
  const mf = buildChainCalls({
    window: "7d",
    groupBy: "module_function",
    total: 10,
    rows: [
      { call_module: "SubtensorModule", call_function: "add_stake", count: 5 },
    ],
  });
  assert.equal(mf.group_by, "module_function");
  assert.equal(mf.calls[0].call_function, "add_stake");
});

test("buildChainCalls is cold-stable (share null on empty window, junk dropped)", () => {
  const out = buildChainCalls({
    window: "7d",
    total: 0,
    rows: [null, { count: 9 }, { call_module: "X", count: 3 }],
  });
  assert.equal(out.call_count, 1); // junk (null, no-module) dropped
  assert.equal(out.calls[0].share, null); // zero-total denominator
});

test("buildChainCalls drops empty call_module and call_function buckets", () => {
  const moduleOnly = buildChainCalls({
    window: "7d",
    total: 10,
    rows: [
      { call_module: "", count: 5 },
      { call_module: "Balances", count: 3 },
    ],
  });
  assert.equal(moduleOnly.call_count, 1);
  assert.equal(moduleOnly.calls[0].call_module, "Balances");

  const moduleFunction = buildChainCalls({
    window: "7d",
    groupBy: "module_function",
    total: 10,
    rows: [
      { call_module: "Balances", call_function: "", count: 5 },
      { call_module: "Balances", call_function: "transfer", count: 2 },
    ],
  });
  assert.equal(moduleFunction.call_count, 1);
  assert.equal(moduleFunction.calls[0].call_function, "transfer");
});

// #4772 D1 retirement: the `extrinsics` D1 table is dropped in production, so
// handleChainCalls no longer runs a live D1 aggregation -- a Postgres-tier
// miss now falls straight through to buildChainCalls({total: 0, rows: []})
// (see workers/request-handlers/analytics.mjs's own #4772 comment on
// handleChainCalls). This mocks the Postgres tier (DATA_API) instead of D1 to
// exercise the real grouped/shared response; the junk-param 400 is unrelated
// to data-sourcing and is exercised on the same env.
test("GET /api/v1/chain/calls groups by call_module with honest share via the Postgres tier + 400 on junk param", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_EXTRINSICS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          window: "30d",
          group_by: "module",
          total_extrinsics: 120,
          call_count: 2,
          observed_at: "2026-06-26T00:00:00.000Z",
          calls: [
            {
              call_module: "SubtensorModule",
              call_function: null,
              count: 60,
              share: 0.5,
            },
            {
              call_module: "Balances",
              call_function: null,
              count: 30,
              share: 0.25,
            },
          ],
        }),
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/calls?window=30d&limit=2",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.total_extrinsics, 120);
  assert.equal(body.data.calls[0].share, 0.5); // 60/120 (full window), not 60/90

  const bad = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/calls?bogus=1"),
    env,
    {},
  );
  assert.equal(bad.status, 400);
});

// #4772 D1 retirement: the call_module scoping this used to verify across 3
// separate D1 queries now happens server-side in Postgres (workers/data-api.mjs's
// own dedicated coverage, not re-tested here) -- the handler's own contract is
// just to forward call_module + group_by on the request it hands to
// tryPostgresTier, and to pass the Postgres-tier body through untouched
// (mirrors the "GET /api/v1/chain/fees forwards call_module" test below).
test("GET /api/v1/chain/calls forwards call_module scoping to the Postgres tier for module-function groups", async () => {
  let requestedUrl;
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_EXTRINSICS_SOURCE: "postgres",
    DATA_API: {
      fetch: async (request) => {
        requestedUrl = new URL(request.url);
        return Response.json({
          schema_version: 1,
          window: "7d",
          group_by: "module_function",
          total_extrinsics: 80,
          call_count: 1,
          observed_at: "2026-06-26T00:00:00.000Z",
          calls: [
            {
              call_module: "SubtensorModule",
              call_function: "add_stake",
              count: 50,
              share: 0.625,
            },
          ],
        });
      },
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/calls?call_module=SubtensorModule&group_by=module_function&limit=1",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.group_by, "module_function");
  assert.equal(body.data.total_extrinsics, 80);
  assert.equal(body.data.calls[0].call_function, "add_stake");
  assert.equal(body.data.calls[0].share, 0.625);
  assert.equal(requestedUrl.searchParams.get("call_module"), "SubtensorModule");
  assert.equal(requestedUrl.searchParams.get("group_by"), "module_function");
});

test("GET /api/v1/chain/calls rejects inert group_by and non-canonical limits", async () => {
  const env = createLocalArtifactEnv();
  const long = "x".repeat(101);
  for (const [path, parameter] of [
    ["/api/v1/chain/calls?group_by=x1", "group_by"],
    ["/api/v1/chain/calls?limit=abc1", "limit"],
    ["/api/v1/chain/calls?limit=001", "limit"],
    ["/api/v1/chain/calls?limit=999999", "limit"],
    [`/api/v1/chain/calls?call_module=${long}`, "call_module"],
  ]) {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    assert.equal(res.status, 400, path);
    assert.equal((await res.json()).meta.parameter, parameter);
  }
});

// ---- signers (#1990) builder + handler ------------------------------------

test("buildChainSigners maps rows + is cold-stable", () => {
  const out = buildChainSigners({
    window: "7d",
    observedAt: "2026-06-26T00:00:00.000Z",
    rows: [
      {
        signer: "5Sig",
        tx_count: 100,
        total_fee_tao: 1.5,
        total_tip_tao: 0.1,
        last_tx_block: 8490000,
      },
      { signer: "", tx_count: 1 }, // empty signer dropped
    ],
  });
  assert.equal(out.signer_count, 1);
  assert.deepEqual(out.signers[0], {
    signer: "5Sig",
    tx_count: 100,
    total_fee_tao: 1.5,
    total_tip_tao: 0.1,
    last_tx_block: 8490000,
  });
  assert.deepEqual(buildChainSigners({ window: "7d" }), {
    schema_version: 1,
    window: "7d",
    sort: "tx_count",
    observed_at: null,
    signer_count: 0,
    signers: [],
  });
});

test("buildChainSigners echoes the selected sort", () => {
  assert.equal(
    buildChainSigners({ window: "7d", sort: "total_fee_tao" }).sort,
    "total_fee_tao",
  );
  assert.equal(
    buildChainSigners({ window: "7d", sort: "nope" }).sort,
    "tx_count",
  );
});

test("buildChainSigners nulls non-finite and negative last_tx_block", () => {
  const out = buildChainSigners({
    window: "7d",
    rows: [
      { signer: "5A", tx_count: 1, last_tx_block: -99 },
      { signer: "5B", tx_count: 2, last_tx_block: "nope" },
      { signer: "5C", tx_count: 3, last_tx_block: 12345 },
    ],
  });
  assert.equal(out.signer_count, 3);
  assert.equal(out.signers[0].last_tx_block, null);
  assert.equal(out.signers[1].last_tx_block, null);
  assert.equal(out.signers[2].last_tx_block, 12345);
});

test("buildChainSigners nulls blank and missing last_tx_block cells (not block 0)", () => {
  // Mirrors the blank-cell guard in counterparties.mjs (#3008): Number("") is 0.
  for (const bad of [null, undefined, "", "   "]) {
    const out = buildChainSigners({
      window: "7d",
      rows: [{ signer: "5A", tx_count: 1, last_tx_block: bad }],
    });
    assert.equal(
      out.signers[0].last_tx_block,
      null,
      `last_tx_block for ${JSON.stringify(bad)}`,
    );
  }
  const missing = buildChainSigners({
    window: "7d",
    rows: [{ signer: "5B", tx_count: 1 }],
  });
  assert.equal(missing.signers[0].last_tx_block, null);
  const numericString = buildChainSigners({
    window: "7d",
    rows: [{ signer: "5C", tx_count: 1, last_tx_block: "12345" }],
  });
  assert.equal(numericString.signers[0].last_tx_block, 12345);
});

// #4909/#6013: extrinsics' D1 write path is retired and the table is dropped
// in production, so handleChainSigners no longer queries D1 at all -- even a
// "warm" D1 mock (real rows) must not change the response. window/limit are
// still shape-validated for REST contract stability but no longer feed a read.
test("GET /api/v1/chain/signers never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
  let d1Called = false;
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare() {
        d1Called = true;
        throw new Error("D1 must not be queried -- extrinsics is retired");
      },
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/signers?window=7d&limit=10",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.sort, "tx_count");
  assert.deepEqual(body.data.signers, []);
  assert.equal(d1Called, false);
});

test("GET /api/v1/chain/signers echoes the requested sort with an empty leaderboard", async () => {
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/signers?sort=total_fee_tao",
    ),
    createLocalArtifactEnv(),
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.sort, "total_fee_tao");
  assert.deepEqual(body.data.signers, []);
});

test("GET /api/v1/chain/signers still shape-validates call_module even though it no longer feeds a read", async () => {
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/signers?call_module=Balances",
    ),
    createLocalArtifactEnv(),
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.signers, []);
});

test("GET /api/v1/chain/signers rejects unsupported sort values", async () => {
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/signers?sort=fees"),
    createLocalArtifactEnv(),
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.meta.parameter, "sort");
});

// #4909/#6013: account_events' D1 write path is retired and the table is
// dropped in production, so handleChainTransfers no longer queries D1 at all
// -- even a "warm" D1 mock (real rows) must not change the response.
test("GET /api/v1/chain/transfers never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
  let d1Called = false;
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare() {
        d1Called = true;
        throw new Error("D1 must not be queried -- account_events is retired");
      },
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfers?window=7d&limit=5",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.window, "7d");
  assert.equal(body.data.total_volume_tao, 0);
  assert.deepEqual(body.data.top_senders, []);
  assert.deepEqual(body.data.top_receivers, []);
  assert.equal(body.meta.source, "live-cron-prober");
  assert.equal(d1Called, false);
});

test("HEAD /api/v1/chain/transfers shares the GET edge cache", async () => {
  const originalCaches = globalThis.caches;
  const cache = installMapCache();
  const captured = [];
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_CONTROL: {
      async get(key) {
        return key === "health:meta"
          ? { last_run_at: "2026-07-02T00:00:00.000Z" }
          : null;
      },
    },
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            captured.push({ sql, params });
            return {
              all: () => {
                if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
                  return Promise.resolve({
                    results: [
                      {
                        transfer_count: 1,
                        total_volume_tao: 2,
                        unique_senders: 1,
                        unique_receivers: 1,
                      },
                    ],
                  });
                }
                if (/GROUP BY hotkey/.test(sql)) {
                  return Promise.resolve({
                    results: [
                      { address: "5Sender", volume_tao: 2, transfer_count: 1 },
                    ],
                  });
                }
                if (/GROUP BY coldkey/.test(sql)) {
                  return Promise.resolve({
                    results: [
                      {
                        address: "5Receiver",
                        volume_tao: 2,
                        transfer_count: 1,
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

  try {
    // #4909/#6013: account_events is retired, so this "warm" D1 mock is never
    // actually queried (captured stays empty throughout) -- the response is
    // always the schema-stable empty stub. What this test still exercises:
    // HEAD populates the edge cache and a subsequent GET reuses that body.
    const url = "https://api.metagraph.sh/api/v1/chain/transfers?window=7d";
    const first = await handleRequest(
      new Request(url, { method: "HEAD" }),
      env,
      {
        waitUntil(promise) {
          return promise;
        },
      },
    );
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "");
    assert.equal(captured.length, 0);
    assert.equal(cache.putKeys.length, 1);

    const second = await handleRequest(
      new Request(url, { method: "HEAD" }),
      env,
      {},
    );
    assert.equal(second.status, 200);
    assert.equal(await second.text(), "");
    assert.equal(captured.length, 0, "D1 is never queried");
    assert.equal(cache.matchCalls, 2);

    const get = await handleRequest(new Request(url), env, {});
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.data.total_volume_tao, 0);
    assert.equal(
      captured.length,
      0,
      "GET should reuse the HEAD-populated body",
    );
  } finally {
    globalThis.caches = originalCaches;
  }
});

test("GET /api/v1/chain/transfers rejects an unsupported window", async () => {
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/transfers?window=1y"),
    createLocalArtifactEnv(),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/chain/transfers rejects non-canonical limits", async () => {
  const env = createLocalArtifactEnv();
  for (const path of [
    "/api/v1/chain/transfers?limit=abc1",
    "/api/v1/chain/transfers?limit=001",
    "/api/v1/chain/transfers?limit=999999",
  ]) {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    assert.equal(res.status, 400, path);
  }
});

function transfersEnv({ senders = [], receivers = [], totals } = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              all: () => {
                if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
                  return Promise.resolve({
                    results: [
                      totals ?? {
                        transfer_count: 0,
                        total_volume_tao: 0,
                        unique_senders: 0,
                        unique_receivers: 0,
                      },
                    ],
                  });
                }
                if (/GROUP BY hotkey/.test(sql)) {
                  return Promise.resolve({ results: senders });
                }
                if (/GROUP BY coldkey/.test(sql)) {
                  return Promise.resolve({ results: receivers });
                }
                return Promise.resolve({ results: [] });
              },
            };
          },
        };
      },
    },
  };
}

const TRANSFERS_CSV_HEADER = "direction,address,volume_tao,transfer_count";
const TRANSFERS_SENDER_ROW = {
  address: "5Sa",
  volume_tao: 80,
  transfer_count: 5,
};
const TRANSFERS_RECEIVER_ROW = {
  address: "5Rx",
  volume_tao: 60,
  transfer_count: 4,
};
const TRANSFERS_TOTALS = {
  transfer_count: 10,
  total_volume_tao: 100,
  unique_senders: 4,
  unique_receivers: 6,
};

// #4909/#6013: even a "warm" D1 mock never reaches the response -- the CSV
// export is always header-only now (account_events is retired).
test("GET /api/v1/chain/transfers CSV export with ?format=csv is header-only even with a warm D1 mock", async () => {
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfers?window=7d&format=csv",
    ),
    transfersEnv({
      senders: [TRANSFERS_SENDER_ROW],
      receivers: [TRANSFERS_RECEIVER_ROW],
      totals: TRANSFERS_TOTALS,
    }),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(
    res.headers.get("content-disposition"),
    /attachment; filename="chain-transfers\.csv"/,
  );
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], TRANSFERS_CSV_HEADER);
});

test("GET /api/v1/chain/transfers honors Accept: text/csv the same as ?format=csv", async () => {
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/transfers", {
      headers: { accept: "text/csv" },
    }),
    transfersEnv({
      senders: [TRANSFERS_SENDER_ROW],
      receivers: [TRANSFERS_RECEIVER_ROW],
      totals: TRANSFERS_TOTALS,
    }),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
});

test("GET /api/v1/chain/transfers emits a header-only CSV on a cold store", async () => {
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/transfers?format=csv"),
    transfersEnv({}),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), TRANSFERS_CSV_HEADER);
});

test("GET /api/v1/chain/transfers rejects an unsupported format value with 400", async () => {
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/transfers?format=xml"),
    transfersEnv({}),
    {},
  );
  assert.equal(res.status, 400);
});

// #4832 Tier 2: METAGRAPH_ACCOUNT_EVENTS_SOURCE reused (same account_events
// table this handler already reads, no new flag) -- tryPostgresTier's own
// fallback contract is unit-tested in workers/postgres-tier.mjs's own tests,
// so these two just prove the wiring: a Postgres hit is served as-is with D1
// never queried, and a Postgres failure falls back to D1.
test("GET /api/v1/chain/transfers: flag=postgres serves the DATA_API response, D1 never queried", async () => {
  let d1Called = false;
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          window: "7d",
          observed_at: "2026-01-01T00:00:00.000Z",
          total_volume_tao: 999,
          transfer_count: 1,
          unique_senders: 1,
          unique_receivers: 1,
          top_sender_share: null,
          top_senders: [],
          top_receivers: [],
        }),
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        d1Called = true;
        throw new Error(
          "D1 must not be queried when Postgres serves the request",
        );
      },
    },
  };
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/transfers?window=7d"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.total_volume_tao, 999);
  assert.equal(d1Called, false);
});

// D1 is permanently skipped (#4909/#6013), so the only path that can ever
// populate top_senders/top_receivers with real rows is a Postgres-tier hit --
// this exercises the CSV row-mapping for both arrays.
test("GET /api/v1/chain/transfers: CSV export maps Postgres-tier senders/receivers", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          window: "7d",
          observed_at: "2026-01-01T00:00:00.000Z",
          total_volume_tao: 140,
          transfer_count: 9,
          unique_senders: 1,
          unique_receivers: 1,
          top_sender_share: 0.5714,
          top_senders: [TRANSFERS_SENDER_ROW],
          top_receivers: [TRANSFERS_RECEIVER_ROW],
        }),
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfers?window=7d&format=csv",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines[0], TRANSFERS_CSV_HEADER);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "sender,5Sa,80,5");
  assert.equal(lines[2], "receiver,5Rx,60,4");
});

test("GET /api/v1/chain/transfers: flag=postgres falls back to D1 when DATA_API fails", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () => {
        throw new Error("boom");
      },
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind: () => ({ all: () => Promise.resolve({ results: [] }) }),
        };
      },
    },
  };
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/transfers?window=7d"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.total_volume_tao, 0);
});

// #4909/#6013: account_events' D1 write path is retired and the table is
// dropped in production, so handleChainTransferPairs no longer queries D1 at
// all -- even a "warm" D1 mock (real rows) must not change the response.
test("GET /api/v1/chain/transfer-pairs never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
  let d1Called = false;
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare() {
        d1Called = true;
        throw new Error("D1 must not be queried -- account_events is retired");
      },
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfer-pairs?window=7d&limit=5&sort=count",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.window, "7d");
  assert.equal(body.data.sort, "count");
  assert.equal(body.data.total_volume_tao, 0);
  assert.equal(body.data.unique_pairs, 0);
  assert.equal(body.data.pair_count, 0);
  assert.deepEqual(body.data.pairs, []);
  assert.equal(body.meta.source, "live-cron-prober");
  assert.equal(d1Called, false);
});

function transferPairsEnv({ pairs = [], totals } = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              all: () =>
                Promise.resolve({
                  results: /WITH pair_totals/.test(sql)
                    ? [
                        totals ?? {
                          transfer_count: 0,
                          total_volume_tao: 0,
                          unique_pairs: 0,
                          top_pair_volume_tao: 0,
                        },
                      ]
                    : /ORDER BY/.test(sql)
                      ? pairs
                      : [],
                }),
            };
          },
        };
      },
    },
  };
}

const PAIRS_CSV_HEADER =
  "from,to,volume_tao,transfer_count,last_block,last_observed_at";
const PAIR_ROW = {
  from: "5Sa",
  to: "5Rx",
  volume_tao: 80,
  transfer_count: 5,
  last_block: "8454388",
  last_observed_at: Date.parse("2026-07-03T00:00:00.000Z"),
};
const PAIR_TOTALS = {
  transfer_count: 10,
  total_volume_tao: 100,
  unique_pairs: 4,
  top_pair_volume_tao: 80,
};

// #4909/#6013: even a "warm" D1 mock never reaches the response -- the CSV
// export is always header-only now (account_events is retired).
test("GET /api/v1/chain/transfer-pairs CSV export with ?format=csv is header-only even with a warm D1 mock", async () => {
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfer-pairs?window=7d&format=csv",
    ),
    transferPairsEnv({ pairs: [PAIR_ROW], totals: PAIR_TOTALS }),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(
    res.headers.get("content-disposition"),
    /attachment; filename="chain-transfer-pairs\.csv"/,
  );
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], PAIRS_CSV_HEADER);
});

test("GET /api/v1/chain/transfer-pairs honors Accept: text/csv the same as ?format=csv", async () => {
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/transfer-pairs", {
      headers: { accept: "text/csv" },
    }),
    transferPairsEnv({ pairs: [PAIR_ROW], totals: PAIR_TOTALS }),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
});

test("GET /api/v1/chain/transfer-pairs emits a header-only CSV on a cold store", async () => {
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfer-pairs?format=csv",
    ),
    transferPairsEnv({}),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), PAIRS_CSV_HEADER);
});

test("HEAD /api/v1/chain/transfer-pairs?format=csv returns the CSV headers with no body", async () => {
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfer-pairs?format=csv",
      { method: "HEAD" },
    ),
    transferPairsEnv({ pairs: [PAIR_ROW], totals: PAIR_TOTALS }),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal(await res.text(), "");
});

test("GET /api/v1/chain/transfer-pairs rejects an unsupported format value with 400", async () => {
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfer-pairs?format=xml",
    ),
    transferPairsEnv({}),
    {},
  );
  assert.equal(res.status, 400);
});

test("HEAD /api/v1/chain/transfer-pairs returns headers without a body", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              all: () =>
                Promise.resolve({
                  results: /WITH pair_totals/.test(sql)
                    ? [
                        {
                          transfer_count: 0,
                          total_volume_tao: 0,
                          unique_pairs: 0,
                          top_pair_volume_tao: 0,
                        },
                      ]
                    : [],
                }),
            };
          },
        };
      },
    },
  };
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/transfer-pairs", {
      method: "HEAD",
    }),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("GET /api/v1/chain/transfer-pairs validates sort, limit, and query keys", async () => {
  const env = createLocalArtifactEnv();
  for (const path of [
    "/api/v1/chain/transfer-pairs?sort=fee",
    "/api/v1/chain/transfer-pairs?limit=001",
    "/api/v1/chain/transfer-pairs?bogus=1",
  ]) {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    assert.equal(res.status, 400, path);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
  }
});

// #4832 Tier 2: METAGRAPH_ACCOUNT_EVENTS_SOURCE reused (same account_events
// table this handler already reads, no new flag) -- tryPostgresTier's own
// fallback contract is unit-tested in workers/postgres-tier.mjs's own tests,
// so these two just prove the wiring: a Postgres hit is served as-is with D1
// never queried, and a Postgres failure falls back to D1.
test("GET /api/v1/chain/transfer-pairs: flag=postgres serves the DATA_API response, D1 never queried", async () => {
  let d1Called = false;
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          window: "7d",
          sort: "volume",
          observed_at: "2026-01-01T00:00:00.000Z",
          total_volume_tao: 999,
          transfer_count: 1,
          unique_pairs: 1,
          pair_count: 1,
          top_pair_share: null,
          pairs: [],
        }),
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        d1Called = true;
        throw new Error(
          "D1 must not be queried when Postgres serves the request",
        );
      },
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfer-pairs?window=7d",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.total_volume_tao, 999);
  assert.equal(d1Called, false);
});

test("GET /api/v1/chain/transfer-pairs: flag=postgres falls back to D1 when DATA_API fails", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () => {
        throw new Error("boom");
      },
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind: () => ({ all: () => Promise.resolve({ results: [] }) }),
        };
      },
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/transfer-pairs?window=7d",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.total_volume_tao, 0);
});

// D1 fully eliminated (2026-07-16): extrinsics' D1 write path is retired
// (#4772) and the table is dropped in production, so the call_module scoping
// this used to verify across 3 separate D1 queries now happens server-side
// in Postgres -- the handler's own contract is just to forward call_module
// on the request it hands to tryPostgresTier.
test("GET /api/v1/chain/fees forwards call_module on the Postgres-tier request", async () => {
  let requestedUrl;
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_EXTRINSICS_SOURCE: "postgres",
    DATA_API: {
      fetch: async (request) => {
        requestedUrl = new URL(request.url);
        return Response.json({
          schema_version: 1,
          window: "7d",
          observed_at: null,
          day_count: 0,
          daily: [],
          top_fee_payers: [],
        });
      },
    },
  };
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/chain/fees?call_module=SubtensorModule",
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(requestedUrl.searchParams.get("call_module"), "SubtensorModule");
});

test("chain signers/fees reject an over-long call_module with 400", async () => {
  const env = createLocalArtifactEnv();
  const long = "x".repeat(101);
  for (const path of [
    `/api/v1/chain/signers?call_module=${long}`,
    `/api/v1/chain/fees?call_module=${long}`,
  ]) {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.meta.parameter, "call_module");
  }
});

test("GET /api/v1/chain/signers rejects non-canonical limits", async () => {
  const env = createLocalArtifactEnv();
  for (const path of [
    "/api/v1/chain/signers?limit=abc1",
    "/api/v1/chain/signers?limit=001",
    "/api/v1/chain/signers?limit=999999",
  ]) {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    assert.equal(res.status, 400, path);
    assert.equal((await res.json()).meta.parameter, "limit");
  }
});

// ---- fees (#1988) builder + handler ---------------------------------------

test("buildChainFees computes per-day averages + null avg on a zero-extrinsic day", () => {
  const out = buildChainFees({
    window: "7d",
    dailyRows: [
      {
        day: "2026-06-25",
        extrinsic_count: 100,
        total_fee_tao: 1.0,
        total_tip_tao: 0.5,
      },
      {
        day: "2026-06-26",
        extrinsic_count: 0,
        total_fee_tao: 0,
        total_tip_tao: 0,
      },
    ],
    medianRows: [
      {
        day: "2026-06-25",
        median_fee_tao: "0.004",
        median_tip_tao: 0.001,
      },
      {
        day: "2026-06-26",
        median_fee_tao: 0,
        median_tip_tao: 0,
      },
    ],
    payerRows: [
      {
        signer: "5Pay",
        total_fee_tao: 0.8,
        total_tip_tao: 0.1,
        extrinsic_count: 40,
      },
    ],
  });
  // newest-first ordering
  assert.deepEqual(
    out.daily.map((d) => d.day),
    ["2026-06-26", "2026-06-25"],
  );
  const d25 = out.daily.find((d) => d.day === "2026-06-25");
  assert.equal(d25.avg_fee_tao, 0.01); // 1.0/100
  assert.equal(d25.median_fee_tao, 0.004);
  assert.equal(d25.avg_tip_tao, 0.005);
  assert.equal(d25.median_tip_tao, 0.001);
  const d26 = out.daily.find((d) => d.day === "2026-06-26");
  assert.equal(d26.avg_fee_tao, null); // zero extrinsics → null, never NaN
  assert.equal(d26.median_fee_tao, null);
  assert.equal(d26.median_tip_tao, null);
  assert.equal(out.top_fee_payers[0].signer, "5Pay");
});

test("buildChainFees reports malformed median rows as null, not JSON numbers", () => {
  const out = buildChainFees({
    window: "7d",
    dailyRows: [
      {
        day: "2026-06-25",
        extrinsic_count: 2,
        total_fee_tao: 1,
        total_tip_tao: 1,
      },
    ],
    medianRows: [
      {
        day: "2026-06-25",
        median_fee_tao: "not-a-number",
        median_tip_tao: -1,
      },
      { day: 20260625, median_fee_tao: 1, median_tip_tao: 1 },
    ],
  });
  assert.equal(out.daily[0].median_fee_tao, null);
  assert.equal(out.daily[0].median_tip_tao, null);
  assert.equal(JSON.parse(JSON.stringify(out)).daily[0].median_fee_tao, null);
});

// D1 fully eliminated (2026-07-16): the COALESCE/median SQL-shape assertions
// this used to verify against D1 now apply to Postgres's own equivalent
// query in workers/data-api.mjs's chain-fees route (its own dedicated
// coverage, not re-tested here) -- this just proves the REST envelope
// passes the Postgres-tier body through untouched.
test("GET /api/v1/chain/fees returns daily series + top payers from the Postgres tier", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_EXTRINSICS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          window: "7d",
          observed_at: "2026-06-25T00:00:00.000Z",
          day_count: 1,
          daily: [
            {
              day: "2026-06-25",
              extrinsic_count: 50,
              total_fee_tao: 0.5,
              avg_fee_tao: 0.01,
              median_fee_tao: 0.006,
              total_tip_tao: 0,
              avg_tip_tao: 0,
              median_tip_tao: 0,
            },
          ],
          top_fee_payers: [
            {
              signer: "5Pay",
              total_fee_tao: 0.5,
              total_tip_tao: 0,
              extrinsic_count: 50,
            },
          ],
        }),
    },
  };
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/fees?window=7d"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.daily[0].avg_fee_tao, 0.01);
  assert.equal(body.data.daily[0].median_fee_tao, 0.006);
  assert.equal(body.data.daily[0].median_tip_tao, 0);
  assert.equal(body.data.top_fee_payers[0].signer, "5Pay");
});

test("GET /api/v1/chain/fees rejects non-canonical limits", async () => {
  const env = createLocalArtifactEnv();
  for (const path of [
    "/api/v1/chain/fees?limit=abc1",
    "/api/v1/chain/fees?limit=001",
    "/api/v1/chain/fees?limit=999999",
  ]) {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    assert.equal(res.status, 400, path);
    assert.equal((await res.json()).meta.parameter, "limit");
  }
});

test("the new chain routes are schema-stable empty when D1 is cold", async () => {
  for (const path of [
    "/api/v1/chain/calls",
    "/api/v1/chain/signers",
    "/api/v1/chain/fees",
  ]) {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200, `${path} cold → 200`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.schema_version, 1);
  }
});
