import assert from "node:assert/strict";
import { test } from "vitest";
import { handleEventIngest, handleRequest } from "../workers/api.mjs";

const SECRET = "test-secret-token-1234567890";

function post(body, { secret, method = "POST" } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["x-metagraph-events-token"] = secret;
  const init = { method, headers };
  // GET/HEAD Requests cannot carry a body (undici throws); only attach for POST.
  if (method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://api.metagraph.sh/api/v1/internal/events", init);
}

function dbCapture(captured) {
  return {
    prepare(sql) {
      return {
        bind(...v) {
          return { sql, v };
        },
      };
    },
    async batch(stmts) {
      captured.push(stmts.length);
      // Mirror D1: each statement result carries meta.changes (rows written).
      // All-inserted here (one multi-row statement per <=10 rows).
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

test("ingest is disabled (503) without the secret configured (#1360)", async () => {
  const res = await handleEventIngest(post([], { secret: "x" }), {});
  assert.equal(res.status, 503);
});

test("ingest rejects a wrong or missing token (401)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  assert.equal(
    (await handleEventIngest(post([], { secret: "wrong" }), env)).status,
    401,
  );
  assert.equal((await handleEventIngest(post([]), env)).status, 401);
});

test("ingest rejects non-POST (405)", async () => {
  const env = { METAGRAPH_EVENTS_INGEST_SECRET: SECRET };
  const res = await handleEventIngest(
    post([], { secret: SECRET, method: "GET" }),
    env,
  );
  assert.equal(res.status, 405);
});

test("ingest writes valid rows with a good token (200, parameterized)", async () => {
  const captured = [];
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture(captured),
  };
  const rows = [
    {
      block_number: 1,
      event_index: 0,
      event_kind: "StakeAdded",
      hotkey: "5Hk",
      coldkey: "5Co",
      netuid: 7,
      uid: 1,
      amount_tao: 1.5,
      observed_at: 1,
    },
    { foo: "bar" }, // invalid (no block_number/event_index) → filtered out
  ];
  const res = await handleEventIngest(post(rows, { secret: SECRET }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.inserted, 1);
  assert.deepEqual(captured, [1]); // one batch issued
});

test("ingest rejects malformed JSON (400)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const res = await handleEventIngest(
    post("{not json", { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 400);
});

test("ingest accepts the {events:[...]} envelope + no-ops on empty", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const res = await handleEventIngest(
    post({ events: [] }, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).inserted, 0);
});

test("handleRequest routes POST /api/v1/internal/events to the ingest handler", async () => {
  // No secret configured → 503 (proves the dispatch reached handleEventIngest).
  const res = await handleRequest(post([], { secret: "x" }), {}, {});
  assert.equal(res.status, 503);
});

test("handleRequest ingest writes rows end-to-end with a valid token", async () => {
  const captured = [];
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture(captured),
  };
  const res = await handleRequest(
    post(
      [
        {
          block_number: 5,
          event_index: 0,
          event_kind: "WeightsSet",
          observed_at: 1,
        },
      ],
      {
        secret: SECRET,
      },
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).inserted, 1);
});

test("ingest reports actually-inserted rows, not validated rows (INSERT OR IGNORE)", async () => {
  // A row that validates but is a duplicate is dropped by INSERT OR IGNORE
  // (meta.changes = 0). `inserted` must reflect the real write count, not the
  // validated count.
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: {
      prepare: (sql) => ({ bind: (...v) => ({ sql, v }) }),
      async batch(stmts) {
        return stmts.map(() => ({ meta: { changes: 0 } })); // all duplicates
      },
    },
  };
  const rows = [
    {
      block_number: 9,
      event_index: 0,
      event_kind: "WeightsSet",
      observed_at: 1,
    },
  ];
  const res = await handleEventIngest(post(rows, { secret: SECRET }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).inserted, 0); // validated 1, inserted 0
});

test("ingest tolerates a batch result missing meta.changes (counts 0)", async () => {
  // Defensive: a driver/result without `meta.changes` must fold to 0, not NaN —
  // exercises the `result?.meta?.changes ?? 0` fallback branch.
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: {
      prepare: (sql) => ({ bind: (...v) => ({ sql, v }) }),
      async batch(stmts) {
        return stmts.map(() => ({})); // no meta on the result
      },
    },
  };
  const rows = [
    {
      block_number: 11,
      event_index: 0,
      event_kind: "WeightsSet",
      observed_at: 1,
    },
  ];
  const res = await handleEventIngest(post(rows, { secret: SECRET }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).inserted, 0);
});

test("ingest returns 503 when the event store is unavailable", async () => {
  const env = { METAGRAPH_EVENTS_INGEST_SECRET: SECRET }; // authed but no DB
  const res = await handleEventIngest(post([], { secret: SECRET }), env);
  assert.equal(res.status, 503);
});

test("ingest rejects an oversized body (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const res = await handleEventIngest(
    post("x".repeat(300000), { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 413);
});

test("ingest sizes the body by UTF-8 bytes, not UTF-16 code units (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  // 100k three-byte chars: 100_000 UTF-16 code units (under the byte cap) but
  // ~300_000 UTF-8 bytes (over it). A code-unit check would wrongly let it past
  // the guard; a byte check rejects it.
  const res = await handleEventIngest(
    post("あ".repeat(100000), { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 413);
});

test("ingest rejects a non-array body (400)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const res = await handleEventIngest(
    post({ foo: 1 }, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 400);
});

test("ingest rejects too many rows (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const many = Array.from({ length: 501 }, (_, i) => ({
    block_number: 1,
    event_index: i,
  }));
  const res = await handleEventIngest(post(many, { secret: SECRET }), env);
  assert.equal(res.status, 413);
});
