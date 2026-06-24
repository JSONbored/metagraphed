import assert from "node:assert/strict";
import { test } from "vitest";
import { handleNeuronBackfill, handleRequest } from "../workers/api.mjs";

const SECRET = "test-secret-token-1234567890";

function row(overrides = {}) {
  return {
    netuid: 7,
    uid: 1,
    hotkey: "5Hk",
    coldkey: "5Co",
    active: 1,
    validator_permit: 0,
    rank: null,
    trust: 0.0,
    validator_trust: 0.5,
    consensus: 0.1,
    incentive: 0.2,
    dividends: 0.0,
    emission_tao: 1.5,
    stake_tao: 100.0,
    registered_at_block: 1000,
    is_immunity_period: 0,
    axon: "1.2.3.4:8091",
    block_number: 8000000,
    captured_at: 1700000000000,
    snapshot_date: "2025-12-01",
    ...overrides,
  };
}

function post(body, { secret, method = "POST" } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["x-metagraph-events-token"] = secret;
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(
    "https://api.metagraph.sh/api/v1/internal/backfill-neurons",
    init,
  );
}

function dbCapture(captured) {
  return {
    prepare(sql) {
      return { bind: (...v) => ({ sql, v }) };
    },
    async batch(stmts) {
      captured.push(stmts.length);
    },
  };
}

test("backfill is disabled (503) without the secret configured", async () => {
  const res = await handleNeuronBackfill(post([row()], { secret: "x" }), {});
  assert.equal(res.status, 503);
});

test("backfill rejects a wrong or missing token (401)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  assert.equal(
    (await handleNeuronBackfill(post([row()], { secret: "wrong" }), env))
      .status,
    401,
  );
  assert.equal((await handleNeuronBackfill(post([row()]), env)).status, 401);
});

test("backfill rejects non-POST (405)", async () => {
  const env = { METAGRAPH_EVENTS_INGEST_SECRET: SECRET };
  const res = await handleNeuronBackfill(
    post([row()], { secret: SECRET, method: "GET" }),
    env,
  );
  assert.equal(res.status, 405);
});

test("backfill upserts valid rows + filters invalid (200, parameterized)", async () => {
  const captured = [];
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture(captured),
  };
  const rows = [
    row(),
    row({ uid: 2, snapshot_date: "2025-12-02" }),
    { netuid: 7, uid: 3 }, // invalid (no snapshot_date/hotkey) → filtered
    row({ hotkey: "", uid: 4 }), // invalid (empty hotkey) → filtered
    row({ snapshot_date: "12/01/2025", uid: 5 }), // invalid date format → filtered
  ];
  const res = await handleNeuronBackfill(post(rows, { secret: SECRET }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.received, 5);
  assert.equal(body.inserted, 2);
  assert.deepEqual(captured, [2]); // one batch of the 2 valid rows
});

test("backfill accepts the {rows:[...]} envelope + no-ops on empty", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const res = await handleNeuronBackfill(
    post({ rows: [] }, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).inserted, 0);
});

test("backfill rejects malformed JSON (400) + non-array (400)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  assert.equal(
    (await handleNeuronBackfill(post("{nope", { secret: SECRET }), env)).status,
    400,
  );
  assert.equal(
    (await handleNeuronBackfill(post({ foo: 1 }, { secret: SECRET }), env))
      .status,
    400,
  );
});

test("backfill rejects too many rows (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const many = Array.from({ length: 2001 }, (_, i) => row({ uid: i }));
  const res = await handleNeuronBackfill(post(many, { secret: SECRET }), env);
  assert.equal(res.status, 413);
});

test("backfill sizes the body by UTF-8 bytes, not UTF-16 code units (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  // 400k three-byte chars: 400_000 UTF-16 code units (under the 1 MiB byte cap)
  // but ~1.2 MB of UTF-8 (over it). A code-unit check would wrongly admit it.
  const res = await handleNeuronBackfill(
    post("あ".repeat(400000), { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 413);
});

test("backfill returns 503 when the history store is unavailable", async () => {
  const env = { METAGRAPH_EVENTS_INGEST_SECRET: SECRET }; // authed but no DB
  const res = await handleNeuronBackfill(
    post([row()], { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 503);
});

test("handleRequest routes POST /api/v1/internal/backfill-neurons", async () => {
  // No secret configured → 503 proves dispatch reached handleNeuronBackfill.
  const res = await handleRequest(post([row()], { secret: "x" }), {}, {});
  assert.equal(res.status, 503);
});
