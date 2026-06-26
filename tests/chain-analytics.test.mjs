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

// A D1 mock that routes the two grouped aggregations by table and records the
// bound SQL/params so a test can assert the query shape + the merged response.
function chainActivityEnv(captured = []) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            captured.push({ sql, params });
            const rows = /FROM extrinsics/.test(sql)
              ? [
                  {
                    day: "2026-06-25",
                    extrinsic_count: 100,
                    successful_extrinsics: 99,
                    unique_signers: 40,
                  },
                  {
                    day: "2026-06-24",
                    extrinsic_count: 50,
                    successful_extrinsics: 50,
                    unique_signers: 20,
                  },
                ]
              : /FROM blocks/.test(sql)
                ? [
                    {
                      day: "2026-06-25",
                      block_count: 7200,
                      event_count: 30000,
                    },
                    {
                      day: "2026-06-24",
                      block_count: 7100,
                      event_count: 29000,
                    },
                  ]
                : [];
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
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
  const captured = [];
  const res = await handleRequest(
    activityReq("?window=7d"),
    chainActivityEnv(captured),
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
  // two grouped aggregations, both window-bound by a numeric cutoff.
  const ex = captured.find((q) => /FROM extrinsics/.test(q.sql));
  const bl = captured.find((q) => /FROM blocks/.test(q.sql));
  assert.match(ex.sql, /GROUP BY day/);
  assert.match(ex.sql, /COUNT\(DISTINCT signer\)/);
  assert.match(bl.sql, /SUM\(event_count\)/);
  assert.equal(typeof ex.params[0], "number"); // observed_at cutoff
});

test("GET /api/v1/chain/activity rejects an unsupported window with 400", async () => {
  const res = await handleRequest(
    activityReq("?window=99d"),
    chainActivityEnv(),
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

test("GET /api/v1/chain/calls groups by call_module with honest share + 400 on junk param", async () => {
  const captured = [];
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            captured.push({ sql, params });
            const rows = /GROUP BY call_module/.test(sql)
              ? [
                  { call_module: "SubtensorModule", count: 60 },
                  { call_module: "Balances", count: 30 },
                ]
              : /COUNT\(\*\) AS total/.test(sql)
                ? [{ total: 120 }]
                : [];
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
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
  const grp = captured.find((q) => /GROUP BY call_module/.test(q.sql));
  assert.match(grp.sql, /ORDER BY count DESC/);
  assert.equal(grp.params.at(-1), 2); // limit bound

  const bad = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/calls?bogus=1"),
    env,
    {},
  );
  assert.equal(bad.status, 400);
});

test("GET /api/v1/chain/calls rejects inert group_by and non-canonical limits", async () => {
  const env = createLocalArtifactEnv();
  for (const [path, parameter] of [
    ["/api/v1/chain/calls?group_by=x1", "group_by"],
    ["/api/v1/chain/calls?limit=abc1", "limit"],
    ["/api/v1/chain/calls?limit=001", "limit"],
    ["/api/v1/chain/calls?limit=999999", "limit"],
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
    observed_at: null,
    signer_count: 0,
    signers: [],
  });
});

test("GET /api/v1/chain/signers ranks by tx_count via the signer GROUP BY", async () => {
  const captured = [];
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            captured.push({ sql, params });
            return {
              all: () =>
                Promise.resolve({
                  results: [
                    {
                      signer: "5Top",
                      tx_count: 900,
                      total_fee_tao: 3.2,
                      total_tip_tao: 0,
                      last_tx_block: 8490697,
                    },
                  ],
                }),
            };
          },
        };
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
  assert.equal(body.data.signers[0].signer, "5Top");
  assert.equal(body.data.signers[0].tx_count, 900);
  const sql = captured[0].sql;
  assert.match(sql, /GROUP BY signer/);
  assert.match(sql, /ORDER BY tx_count DESC/);
  assert.equal(captured[0].params.at(-1), 10);
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
  assert.equal(d25.avg_tip_tao, 0.005);
  const d26 = out.daily.find((d) => d.day === "2026-06-26");
  assert.equal(d26.avg_fee_tao, null); // zero extrinsics → null, never NaN
  assert.equal(out.top_fee_payers[0].signer, "5Pay");
});

test("GET /api/v1/chain/fees returns daily series + top payers, COALESCEs NULL fees", async () => {
  const captured = [];
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            captured.push({ sql, params });
            const rows = /GROUP BY day/.test(sql)
              ? [
                  {
                    day: "2026-06-25",
                    extrinsic_count: 50,
                    total_fee_tao: 0.5,
                    total_tip_tao: 0,
                  },
                ]
              : /GROUP BY signer/.test(sql)
                ? [
                    {
                      signer: "5Pay",
                      total_fee_tao: 0.5,
                      total_tip_tao: 0,
                      extrinsic_count: 50,
                    },
                  ]
                : [];
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
    },
  };
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/fees?window=7d"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.daily[0].avg_fee_tao, 0.01); // 0.5/50
  assert.equal(body.data.top_fee_payers[0].signer, "5Pay");
  const daily = captured.find((q) => /GROUP BY day/.test(q.sql));
  assert.match(daily.sql, /COALESCE\(fee_tao, 0\)/);
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
