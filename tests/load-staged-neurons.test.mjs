import assert from "node:assert/strict";
import { test } from "vitest";
import { loadStagedNeurons } from "../workers/api.mjs";

function mockEnv({ sql, getCalls = [], deleted = [], batches = [] }) {
  return {
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key) {
          getCalls.push(key);
          return sql == null ? null : { text: async () => sql };
        },
        async delete(key) {
          deleted.push(key);
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare(s) {
          return { __sql: s };
        },
        async batch(stmts) {
          batches.push(stmts.length);
        },
      },
    },
    getCalls,
    deleted,
    batches,
  };
}

test("loadStagedNeurons loads R2-staged SQL into D1 in batches + deletes it (#1303)", async () => {
  const sql = Array.from(
    { length: 90 },
    (_, i) => `INSERT OR REPLACE INTO neurons (netuid,uid) VALUES (1,${i});`,
  ).join("\n");
  const m = mockEnv({ sql });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.statements, 90);
  assert.deepEqual(m.batches, [40, 40, 10]); // BATCH=40 → 3 chunks
  assert.deepEqual(m.deleted, ["metagraph/neurons-pending.sql"]);
});

test("loadStagedNeurons no-ops when nothing is staged", async () => {
  const m = mockEnv({ sql: null });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "none");
  assert.equal(m.batches.length, 0);
  assert.equal(m.deleted.length, 0);
});

test("loadStagedNeurons deletes an empty staged object without loading", async () => {
  const m = mockEnv({ sql: "-- no statements here\n" });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, ["metagraph/neurons-pending.sql"]);
});

test("loadStagedNeurons is a safe no-op without bindings", async () => {
  const r = await loadStagedNeurons({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
});
