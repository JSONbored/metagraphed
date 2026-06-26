import assert from "node:assert/strict";
import { test } from "vitest";
import { buildChainActivity } from "../src/chain-analytics.mjs";
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
