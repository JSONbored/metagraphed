import assert from "node:assert/strict";
import { test } from "vitest";
import { handleBlockIngest, handleRequest } from "../workers/api.mjs";

// Realtime block-explorer ingest (#1345 Option B): POST /api/v1/internal/blocks
// takes {blocks:[...], extrinsics:[...]} and INSERT OR IGNOREs both into D1 — the
// streamer's per-head emit that closes the blocks/extrinsics realtime gap (#1749).
const SECRET = "test-secret-token-1234567890";

function post(body, { secret, method = "POST" } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["x-metagraph-events-token"] = secret;
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://api.metagraph.sh/api/v1/internal/blocks", init);
}

function dbCapture(captured, changes = 1) {
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
      return stmts.map(() => ({ meta: { changes } }));
    },
  };
}

const BLOCK = {
  block_number: 1,
  block_hash: "0xabc",
  parent_hash: "0xpar",
  author: "5Author",
  extrinsic_count: 2,
  event_count: 3,
  observed_at: 1,
};
const EXTRINSIC = {
  block_number: 1,
  extrinsic_index: 0,
  extrinsic_hash: "0xe0",
  signer: "5Signer",
  call_module: "SubtensorModule",
  call_function: "set_weights",
  success: 1,
  observed_at: 1,
};

test("block ingest is disabled (503) without the secret configured", async () => {
  const res = await handleBlockIngest(
    post({ blocks: [] }, { secret: "x" }),
    {},
  );
  assert.equal(res.status, 503);
});

test("block ingest rejects a wrong or missing token (401)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  assert.equal(
    (await handleBlockIngest(post({ blocks: [] }, { secret: "wrong" }), env))
      .status,
    401,
  );
  assert.equal(
    (await handleBlockIngest(post({ blocks: [] }), env)).status,
    401,
  );
});

test("block ingest rejects non-POST (405)", async () => {
  const env = { METAGRAPH_EVENTS_INGEST_SECRET: SECRET };
  const res = await handleBlockIngest(
    post({ blocks: [] }, { secret: SECRET, method: "GET" }),
    env,
  );
  assert.equal(res.status, 405);
});

test("block ingest writes valid blocks + extrinsics (200, counts split)", async () => {
  const captured = [];
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture(captured),
  };
  const res = await handleBlockIngest(
    post(
      {
        blocks: [BLOCK],
        extrinsics: [EXTRINSIC, { foo: "bar" }], // second is invalid → filtered
      },
      { secret: SECRET },
    ),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.blocks_inserted, 1);
  assert.equal(body.extrinsics_inserted, 1); // junk row filtered out
  assert.deepEqual(captured, [2]); // 1 block stmt + 1 extrinsic stmt, one batch
});

test("block ingest no-ops on an empty payload (200, no batch)", async () => {
  const captured = [];
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture(captured),
  };
  const res = await handleBlockIngest(
    post({ blocks: [], extrinsics: [] }, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.blocks_inserted, 0);
  assert.equal(body.extrinsics_inserted, 0);
  assert.deepEqual(captured, []); // nothing valid → no db.batch issued
});

test("block ingest reports actually-inserted rows (INSERT OR IGNORE dup = 0)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([], 0), // all duplicates → meta.changes 0
  };
  const res = await handleBlockIngest(
    post({ blocks: [BLOCK], extrinsics: [EXTRINSIC] }, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.blocks_inserted, 0);
  assert.equal(body.extrinsics_inserted, 0);
});

test("block ingest rejects malformed JSON (400)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const res = await handleBlockIngest(
    post("{not json", { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 400);
});

test("block ingest rejects a non-object body (400)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  // A bare array is not the {blocks, extrinsics} envelope.
  const res = await handleBlockIngest(post([BLOCK], { secret: SECRET }), env);
  assert.equal(res.status, 400);
});

test("block ingest rejects too many rows (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const many = Array.from({ length: 501 }, (_, i) => ({
    block_number: 1,
    extrinsic_index: i,
    observed_at: 1,
  }));
  const res = await handleBlockIngest(
    post({ blocks: [], extrinsics: many }, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 413);
});

test("block ingest rejects an oversized body (413)", async () => {
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture([]),
  };
  const res = await handleBlockIngest(
    post("x".repeat(300000), { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 413);
});

test("block ingest returns 503 when the store is unavailable", async () => {
  const env = { METAGRAPH_EVENTS_INGEST_SECRET: SECRET }; // authed, no DB
  const res = await handleBlockIngest(
    post({ blocks: [] }, { secret: SECRET }),
    env,
  );
  assert.equal(res.status, 503);
});

test("handleRequest routes POST /api/v1/internal/blocks to the ingest handler", async () => {
  // No secret configured → 503 proves the dispatch reached handleBlockIngest.
  const res = await handleRequest(
    post({ blocks: [] }, { secret: "x" }),
    {},
    {},
  );
  assert.equal(res.status, 503);
});

test("handleRequest writes blocks end-to-end with a valid token", async () => {
  const captured = [];
  const env = {
    METAGRAPH_EVENTS_INGEST_SECRET: SECRET,
    METAGRAPH_HEALTH_DB: dbCapture(captured),
  };
  const res = await handleRequest(
    post({ blocks: [BLOCK], extrinsics: [EXTRINSIC] }, { secret: SECRET }),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.blocks_inserted, 1);
  assert.equal(body.extrinsics_inserted, 1);
});
