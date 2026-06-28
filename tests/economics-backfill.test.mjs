import assert from "node:assert/strict";
import { test } from "vitest";
import { handleEconomicsBackfill, handleRequest } from "../workers/api.mjs";
import {
  economicsSnapshotUpsertStatements,
  validEconomicsBackfillRows,
} from "../src/economics-backfill.mjs";

const SECRET = "test-secret-token-1234567890";

function row(overrides = {}) {
  return {
    netuid: 8,
    snapshot_date: "2025-12-01",
    captured_at: 1700000000000,
    alpha_price_tao: 0.030678787,
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
    "https://api.metagraph.sh/api/v1/internal/backfill-economics",
    init,
  );
}

// Captures both the number of statements batched AND the bound values, so a test
// can assert the upsert is parameterized (no string interpolation of row data).
function dbCapture(captured) {
  return {
    prepare(sql) {
      return { bind: (...v) => ({ sql, v }) };
    },
    async batch(stmts) {
      captured.push(stmts);
    },
  };
}

test("economics backfill is disabled (503) without the secret configured", async () => {
  const res = await handleEconomicsBackfill(post([row()], { secret: "x" }), {});
  assert.equal(res.status, 503);
});

test("economics backfill rejects a wrong or missing token (401)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  assert.equal(
    (await handleEconomicsBackfill(post([row()], { secret: "wrong" }), env))
      .status,
    401,
  );
  assert.equal((await handleEconomicsBackfill(post([row()]), env)).status, 401);
});

test("economics backfill rejects non-POST (405)", async () => {
  const env = { METAGRAPH_EVENTS_INGEST_SECRET: SECRET };
  const res = await handleEconomicsBackfill(
    post([row()], { secret: SECRET, method: "GET" }),
    env,
  );
  assert.equal(res.status, 405);
});

test("economics backfill upserts valid rows + filters invalid (200, parameterized)", async () => {
  const captured = [];
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture(captured),
  };
  const rows = [
    row(),
    row({ netuid: 9, snapshot_date: "2025-12-02", alpha_price_tao: 0.5 }),
    { netuid: 7 }, // invalid (no date/price) → filtered
    row({ netuid: 10, snapshot_date: "12/01/2025" }), // bad date format → filtered
    row({ netuid: 11, alpha_price_tao: "0.1" }), // non-numeric price → filtered
    row({ netuid: -1 }), // negative netuid → filtered
    row({ netuid: 12, alpha_price_tao: Number.NaN }), // NaN price → filtered
    row({ netuid: 13, alpha_price_tao: -0.5 }), // negative price → filtered
  ];
  const res = await handleEconomicsBackfill(
    post(rows, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.received, 8);
  assert.equal(body.inserted, 2);
  assert.equal(captured.length, 1); // one batch
  assert.equal(captured[0].length, 2); // of the 2 valid rows
  // Parameterized: row data is bound, never interpolated into the SQL string.
  const [first] = captured[0];
  assert.match(first.sql, /INSERT INTO subnet_snapshots/);
  assert.match(
    first.sql,
    /alpha_price_tao = COALESCE\(subnet_snapshots\.alpha_price_tao, excluded\.alpha_price_tao\)/,
  );
  assert.deepEqual(first.v, [8, "2025-12-01", 0.030678787, 1700000000000]);
});

test("economics backfill accepts the {rows:[...]} envelope + no-ops on empty", async () => {
  const captured = [];
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture(captured),
  };
  const res = await handleEconomicsBackfill(
    post({ rows: [] }, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).inserted, 0);
  assert.equal(captured.length, 0); // no batch issued for an empty set
});

test("economics backfill rejects malformed JSON (400) + non-array (400)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  assert.equal(
    (await handleEconomicsBackfill(post("{nope", { secret: SECRET }), env))
      .status,
    400,
  );
  assert.equal(
    (await handleEconomicsBackfill(post({ foo: 1 }, { secret: SECRET }), env))
      .status,
    400,
  );
});

test("economics backfill rejects too many rows (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const many = Array.from({ length: 2001 }, (_, i) => row({ netuid: i }));
  const res = await handleEconomicsBackfill(
    post(many, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 413);
});

test("economics backfill sizes the body by UTF-8 bytes, not UTF-16 code units (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  // 400k three-byte chars: 400_000 UTF-16 code units (under the 1 MiB byte cap)
  // but ~1.2 MB of UTF-8 (over it). A code-unit check would wrongly admit it.
  const res = await handleEconomicsBackfill(
    post("あ".repeat(400000), { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 413);
});

test("economics backfill returns 503 when the history store is unavailable", async () => {
  const env = { METAGRAPH_EVENTS_INGEST_SECRET: SECRET }; // authed but no DB
  const res = await handleEconomicsBackfill(
    post([row()], { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 503);
});

test("handleRequest routes POST /api/v1/internal/backfill-economics", async () => {
  // No secret configured → 503 proves dispatch reached handleEconomicsBackfill.
  const res = await handleRequest(post([row()], { secret: "x" }), {}, {});
  assert.equal(res.status, 503);
});

// ---- Writer failure-path coverage (D1 batch) -------------------------------
// The backfill writer is economicsSnapshotUpsertStatements + db.batch. The
// handler runs the batch WITHOUT a try/catch, so a D1 failure during the upsert
// must surface (reject) — never be swallowed into a false 200. These harden that
// path plus the all-invalid no-batch short-circuit.

test("economics backfill surfaces a D1 batch failure instead of a false 200", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return { bind: (...v) => ({ sql, v }) };
      },
      async batch() {
        throw new Error("D1_ERROR: database is locked");
      },
    },
  };
  // One valid row → the writer reaches db.batch, which rejects; the handler
  // does not catch it, so the rejection propagates to the caller (the runtime
  // turns it into a 500), proving no swallow-to-200.
  await assert.rejects(
    handleEconomicsBackfill(post([row()], { secret: SECRET }), env),
    /database is locked/,
  );
});

test("economics backfill issues no batch when every row is invalid (no D1 call)", async () => {
  let batched = 0;
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return { bind: (...v) => ({ sql, v }) };
      },
      async batch() {
        batched += 1;
      },
    },
  };
  // All rows fail validEconomicsBackfillRows → rows.length === 0 → no db.batch.
  const res = await handleEconomicsBackfill(
    post([{ netuid: -1 }, { snapshot_date: "bad" }], { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.received, 2);
  assert.equal(body.inserted, 0);
  assert.equal(batched, 0); // short-circuited before touching D1
});

test("economicsSnapshotUpsertStatements emits one bound statement per valid row", () => {
  // Writer-shape contract: N valid rows → N parameterized statements, each with
  // exactly 4 bound values (no interpolation), so a batch is sized to the input.
  const db = { prepare: (sql) => ({ bind: (...v) => ({ sql, v }) }) };
  const valid = validEconomicsBackfillRows([
    row(),
    row({ netuid: 9, snapshot_date: "2025-12-02", alpha_price_tao: 0.5 }),
  ]);
  const stmts = economicsSnapshotUpsertStatements(db, valid);
  assert.equal(stmts.length, 2);
  for (const s of stmts) assert.equal(s.v.length, 4);
});

test("economicsSnapshotUpsertStatements no-ops on an empty row set", () => {
  const db = { prepare: (sql) => ({ bind: (...v) => ({ sql, v }) }) };
  assert.deepEqual(economicsSnapshotUpsertStatements(db, []), []);
});

test("economicsSnapshotUpsertStatements treats a NaN captured_at as missing", () => {
  // A non-finite captured_at must fall back to the snapshot day's UTC midnight,
  // not bind NaN into the row (which would poison the time column).
  const db = { prepare: (sql) => ({ bind: (...v) => ({ sql, v }) }) };
  const stmts = economicsSnapshotUpsertStatements(db, [
    {
      netuid: 8,
      snapshot_date: "2025-12-01",
      alpha_price_tao: 0.1,
      captured_at: Number.NaN,
    },
  ]);
  assert.equal(stmts[0].v[3], Date.parse("2025-12-01T00:00:00Z"));
});

test("validEconomicsBackfillRows + upsert: captured_at falls back to the snapshot day", () => {
  const valid = validEconomicsBackfillRows([
    { netuid: 8, snapshot_date: "2025-12-01", alpha_price_tao: 0.1 }, // no captured_at
    { netuid: 0, snapshot_date: "2025-12-01", alpha_price_tao: 0 }, // netuid 0 + price 0 are valid
  ]);
  assert.equal(valid.length, 2);
  const db = { prepare: (sql) => ({ bind: (...v) => ({ sql, v }) }) };
  const stmts = economicsSnapshotUpsertStatements(db, valid);
  // Missing captured_at → derived from the snapshot day's UTC midnight.
  assert.equal(stmts[0].v[3], Date.parse("2025-12-01T00:00:00Z"));
  // netuid 0 and alpha_price_tao 0 are preserved (not treated as falsy-invalid).
  assert.equal(stmts[1].v[0], 0);
  assert.equal(stmts[1].v[2], 0);
  assert.equal(
    validEconomicsBackfillRows([
      { netuid: 8, snapshot_date: "2025-12-01", alpha_price_tao: -0.5 },
    ]).length,
    0,
  );
});
