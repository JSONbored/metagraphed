// Block-explorer staged-batch loaders (#1345): loadStagedBlocks +
// loadStagedExtrinsics drain the R2-staged sidecar into D1. They mirror
// loadStagedEvents EXACTLY (HMAC-authenticated envelope, byte/row caps,
// write-D1-first / shrink-R2-after progressive drain, delete-on-success), so
// these tests mirror tests/load-staged-events.test.mjs.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vitest";
import { loadStagedBlocks, loadStagedExtrinsics } from "../workers/api.mjs";
import {
  MAX_STAGED_BLOCKS_BYTES,
  MAX_STAGED_BLOCK_ROWS,
  MAX_STAGED_EXTRINSICS_BYTES,
  MAX_STAGED_EXTRINSIC_ROWS,
} from "../workers/config.mjs";

const SIGNING_KEY = "test-staged-secret";
const BLOCKS_KEY = "events/blocks-pending.json";
const EXTRINSICS_KEY = "events/extrinsics-pending.json";

function signed(rows, key = SIGNING_KEY) {
  return {
    schema_version: 1,
    hmac_sha256: createHmac("sha256", key)
      .update(JSON.stringify(rows))
      .digest("hex"),
    rows,
  };
}

function blockRow(n) {
  return { block_number: n, block_hash: `0x${n.toString(16)}`, observed_at: 1 };
}

function extrinsicRow(n) {
  return { block_number: n, extrinsic_index: 0, observed_at: 1 };
}

// Mirrors mockEnv/archiveEnv in load-staged-events.test.mjs.
function makeEnv({
  object,
  get,
  put,
  delete: del,
  signingKey = SIGNING_KEY,
  batchThrows = false,
  prepared = [],
  batches = [],
} = {}) {
  return {
    METAGRAPH_STAGING_SIGNING_KEY: signingKey,
    METAGRAPH_ARCHIVE: {
      get: get || (async () => object ?? null),
      put: put || (async () => {}),
      delete: del || (async () => {}),
    },
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        prepared.push(sql);
        return { bind: (...v) => ({ sql, v }) };
      },
      async batch(stmts) {
        if (batchThrows) throw new Error("d1 down");
        batches.push(stmts.length);
      },
    },
  };
}

// Each loader gets the same matrix of cases, parameterized by its key + sigil.
const cases = [
  {
    name: "blocks",
    load: loadStagedBlocks,
    key: BLOCKS_KEY,
    row: blockRow,
    maxBytes: MAX_STAGED_BLOCKS_BYTES,
    maxRows: MAX_STAGED_BLOCK_ROWS,
    insertTable: "INSERT OR IGNORE INTO blocks (",
  },
  {
    name: "extrinsics",
    load: loadStagedExtrinsics,
    key: EXTRINSICS_KEY,
    row: extrinsicRow,
    maxBytes: MAX_STAGED_EXTRINSICS_BYTES,
    maxRows: MAX_STAGED_EXTRINSIC_ROWS,
    insertTable: "INSERT OR IGNORE INTO extrinsics (",
  },
];

for (const c of cases) {
  test(`loadStaged${c.name} no-ops without bindings`, async () => {
    const r = await c.load({});
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unavailable");
  });

  test(`loadStaged${c.name} no-ops when nothing is staged`, async () => {
    const deleted = [];
    const env = makeEnv({ object: null, delete: async (k) => deleted.push(k) });
    const r = await c.load(env);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "none");
    assert.deepEqual(deleted, []);
  });

  test(`loadStaged${c.name} skips an over-byte-cap file without parsing or deleting it`, async () => {
    let jsonCalled = false;
    const deleted = [];
    const env = makeEnv({
      object: {
        size: c.maxBytes + 1,
        async json() {
          jsonCalled = true;
          return [];
        },
      },
      delete: async (k) => deleted.push(k),
    });
    const r = await c.load(env);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "too_large");
    assert.equal(r.size, c.maxBytes + 1);
    assert.equal(jsonCalled, false, "never materialized the oversized body");
    assert.deepEqual(deleted, [], "must NOT delete — that would drop rows");
  });

  test(`loadStaged${c.name} deletes + bails on unparseable JSON`, async () => {
    const deleted = [];
    const env = makeEnv({
      object: {
        size: 16,
        async json() {
          throw new Error("bad json");
        },
      },
      delete: async (k) => deleted.push(k),
    });
    const r = await c.load(env);
    assert.equal(r.reason, "parse_failed");
    assert.deepEqual(deleted, [c.key]);
  });

  test(`loadStaged${c.name} rejects an unsigned envelope`, async () => {
    const deleted = [];
    const batches = [];
    const env = makeEnv({
      object: {
        size: 16,
        async json() {
          return c.row(1); // raw rows, not an envelope
        },
      },
      delete: async (k) => deleted.push(k),
      batches,
    });
    const r = await c.load(env);
    assert.equal(r.reason, "unauthenticated");
    assert.equal(batches.length, 0);
    assert.deepEqual(deleted, [c.key]);
  });

  test(`loadStaged${c.name} rejects a bad HMAC`, async () => {
    const deleted = [];
    const batches = [];
    const envelope = signed([c.row(1)]);
    envelope.hmac_sha256 = "0".repeat(64);
    const env = makeEnv({
      object: {
        size: 16,
        async json() {
          return envelope;
        },
      },
      delete: async (k) => deleted.push(k),
      batches,
    });
    const r = await c.load(env);
    assert.equal(r.reason, "unauthenticated");
    assert.equal(batches.length, 0);
    assert.deepEqual(deleted, [c.key]);
  });

  test(`loadStaged${c.name} deletes + bails when no rows survive validation`, async () => {
    const deleted = [];
    const batches = [];
    // A valid HMAC over garbage rows -> validRows is empty -> "empty".
    const env = makeEnv({
      object: {
        size: 16,
        async json() {
          return signed([{ nope: true }]);
        },
      },
      delete: async (k) => deleted.push(k),
      batches,
    });
    const r = await c.load(env);
    assert.equal(r.reason, "empty");
    assert.equal(batches.length, 0);
    assert.deepEqual(deleted, [c.key]);
  });

  test(`loadStaged${c.name} loads signed rows via parameterized batches + deletes the file`, async () => {
    const deleted = [];
    const prepared = [];
    const batches = [];
    const rows = Array.from({ length: 5 }, (_, i) => c.row(1000 + i));
    const env = makeEnv({
      object: {
        size: 256,
        async json() {
          return signed(rows);
        },
      },
      delete: async (k) => deleted.push(k),
      prepared,
      batches,
    });
    const r = await c.load(env);
    assert.equal(r.ok, true);
    assert.equal(r.rows, 5);
    assert.equal(r.remaining, undefined);
    assert.ok(prepared[0].startsWith(c.insertTable));
    assert.ok(prepared[0].includes("VALUES (?"));
    assert.equal(batches.length, 1);
    assert.deepEqual(deleted, [c.key], "file deleted only after a full drain");
  });

  test(`loadStaged${c.name} caps rows/tick + leaves the remainder in R2 (not deleted)`, async () => {
    const N = c.maxRows + 3;
    const rows = Array.from({ length: N }, (_, i) => c.row(1000 + i));
    const puts = [];
    const deleted = [];
    const env = makeEnv({
      object: {
        size: 1024,
        async json() {
          return signed(rows);
        },
      },
      put: async (key, body) => puts.push({ key, body }),
      delete: async (k) => deleted.push(k),
    });
    const r = await c.load(env);
    assert.equal(r.ok, true);
    assert.equal(r.rows, c.maxRows);
    assert.equal(r.remaining, 3);
    assert.deepEqual(
      deleted,
      [],
      "must NOT delete while rows are un-persisted",
    );
    assert.equal(puts.length, 1, "remainder rewritten for the next tick");
    assert.equal(puts[0].key, c.key);
    const remainder = JSON.parse(puts[0].body);
    assert.equal(remainder.rows.length, 3, "exactly the un-loaded rows kept");
    assert.match(remainder.hmac_sha256, /^[a-f0-9]{64}$/);
  });

  test(`loadStaged${c.name} drains a >cap file across ticks without dropping rows`, async () => {
    const N = c.maxRows + 3;
    const all = Array.from({ length: N }, (_, i) => c.row(1000 + i));
    let stored = JSON.stringify(signed(all));
    const env = makeEnv({
      get: async () =>
        stored == null
          ? null
          : {
              size: stored.length,
              async json() {
                return JSON.parse(stored);
              },
            },
      put: async (_key, body) => {
        stored = body;
      },
      delete: async () => {
        stored = null;
      },
    });
    const t1 = await c.load(env);
    assert.equal(t1.rows, c.maxRows);
    assert.equal(t1.remaining, 3);
    assert.notEqual(stored, null, "remainder stays in R2 after tick 1");
    const t2 = await c.load(env);
    assert.equal(t2.rows, 3);
    assert.equal(t2.remaining, undefined);
    assert.equal(
      stored,
      null,
      "object deleted only after the last row drained",
    );
    assert.equal(t1.rows + t2.rows, N, "every row loaded across ticks");
  });

  test(`loadStaged${c.name} leaves the file intact if a D1 batch throws (no drop on crash)`, async () => {
    const puts = [];
    const deleted = [];
    const rows = Array.from({ length: 5 }, (_, i) => c.row(1000 + i));
    const env = makeEnv({
      object: {
        size: 256,
        async json() {
          return signed(rows);
        },
      },
      put: async (key, body) => puts.push({ key, body }),
      delete: async (k) => deleted.push(k),
      batchThrows: true,
    });
    await assert.rejects(c.load(env));
    assert.deepEqual(puts, [], "no remainder written on failure");
    assert.deepEqual(deleted, [], "object NOT deleted — re-drains next tick");
  });
}
