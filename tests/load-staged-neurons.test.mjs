import assert from "node:assert/strict";
import { test } from "vitest";
import { loadStagedNeurons } from "../workers/api.mjs";

function neuronRow(netuid, uid) {
  return {
    netuid,
    uid,
    hotkey: `5Hk${uid}`,
    coldkey: `5Co${uid}`,
    active: 1,
    validator_permit: uid % 2,
    rank: 0.5,
    trust: 0.4,
    validator_trust: 0.9,
    consensus: 0.3,
    incentive: 0.1,
    dividends: 0.2,
    emission_tao: 1.5,
    stake_tao: 100,
    registered_at_block: 100,
    is_immunity_period: 0,
    axon: null,
    block_number: 200,
    captured_at: 1750000000000,
  };
}

function mockEnv({
  rows,
  bad = false,
  getCalls = [],
  deleted = [],
  prepared = [],
  batches = [],
}) {
  return {
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key) {
          getCalls.push(key);
          if (rows == null) return null;
          return {
            async json() {
              if (bad) throw new Error("bad json");
              return rows;
            },
          };
        },
        async delete(key) {
          deleted.push(key);
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          prepared.push(sql);
          return { bind: (...v) => ({ sql, v }) };
        },
        async batch(stmts) {
          batches.push(stmts.length);
        },
      },
    },
    getCalls,
    deleted,
    prepared,
    batches,
  };
}

test("loadStagedNeurons loads JSON via parameterized batches + deletes it (#1303)", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => neuronRow(1, i));
  const m = mockEnv({ rows });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 12);
  assert.deepEqual(m.getCalls, ["metagraph/neurons-pending.json"]);
  // 12 rows / 5 per statement = 3 statements, in one batch (<=50).
  assert.deepEqual(m.batches, [3]);
  // SQL is parameterized — the structure is fixed and values are bound, never
  // interpolated, so a tampered staged file cannot inject SQL.
  assert.ok(m.prepared[0].startsWith("INSERT OR REPLACE INTO neurons ("));
  assert.ok(m.prepared[0].includes("VALUES (?"));
  assert.ok(
    !m.prepared.some((s) => s.includes("5Hk")),
    "row values must never appear in the SQL text",
  );
  assert.deepEqual(m.deleted, ["metagraph/neurons-pending.json"]);
});

test("loadStagedNeurons no-ops when nothing is staged", async () => {
  const m = mockEnv({ rows: null });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "none");
  assert.equal(m.batches.length, 0);
  assert.equal(m.deleted.length, 0);
});

test("loadStagedNeurons deletes + bails on unparseable JSON", async () => {
  const m = mockEnv({ rows: [], bad: true });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.reason, "parse_failed");
  assert.deepEqual(m.deleted, ["metagraph/neurons-pending.json"]);
});

test("loadStagedNeurons deletes a no-valid-rows payload without loading", async () => {
  const m = mockEnv({ rows: [{ foo: 1 }] }); // no netuid/uid → filtered out
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.reason, "empty");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, ["metagraph/neurons-pending.json"]);
});

test("loadStagedNeurons is a safe no-op without bindings", async () => {
  const r = await loadStagedNeurons({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
});
