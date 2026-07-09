import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, vi } from "vitest";
import { loadStagedSubnetHyperparams } from "../workers/api.mjs";

const STAGED_KEY = "metagraph/subnet-hyperparams-pending.json";
const SIGNING_KEY = "test-staged-subnet-hyperparams-secret";

function hyperparamsRow(netuid) {
  return {
    netuid,
    kappa_ratio: 0.5,
    immunity_period: 4096,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 0,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 2,
    min_burn_tao: 0.000001,
    max_burn_tao: 100,
    burn_half_life: 43200,
    burn_increase_mult: 1.5,
    bonds_moving_avg_raw: 900000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.7,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 2,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 0,
    min_childkey_take_ratio: 0,
    block_number: 5_000_000,
    captured_at: 1_750_000_000_000,
  };
}

function signedEnvelope(rows, key = SIGNING_KEY) {
  return {
    schema_version: 1,
    hmac_sha256: createHmac("sha256", key)
      .update(JSON.stringify(rows))
      .digest("hex"),
    rows,
  };
}

function mockEnv({
  rows,
  bad = false,
  failBatch = false,
  failPrune = false,
  getCalls = [],
  deleted = [],
  prepared = [],
  batches = [],
  runs = [],
  size,
}) {
  const jsonCalls = [];
  return {
    env: {
      METAGRAPH_STAGING_SIGNING_KEY: SIGNING_KEY,
      METAGRAPH_ARCHIVE: {
        async get(key) {
          getCalls.push(key);
          if (rows == null) return null;
          return {
            size: size ?? JSON.stringify(rows).length,
            async json() {
              jsonCalls.push(1);
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
          return {
            // recordSubnetHyperparamsChanges' latestHyperparamsHashes reads via
            // prepare(sql).all() directly (no bind) — an empty history table on
            // every run, so every staged row's hash always looks "changed".
            async all() {
              return { results: [] };
            },
            bind: (...v) => ({
              sql,
              v,
              async run() {
                runs.push({ sql, v });
                if (
                  failPrune &&
                  sql.startsWith("DELETE FROM subnet_hyperparams")
                ) {
                  throw new Error("simulated prune failure");
                }
                return {
                  meta: {
                    changes: sql.startsWith("DELETE FROM subnet_hyperparams")
                      ? 1
                      : 0,
                  },
                };
              },
            }),
          };
        },
        async batch(stmts) {
          batches.push(stmts.length);
          if (failBatch) throw new Error("simulated D1 batch failure");
          return stmts.map(() => ({ meta: { changes: 0 } }));
        },
      },
    },
    getCalls,
    deleted,
    prepared,
    batches,
    runs,
    jsonCalls,
  };
}

test("loadStagedSubnetHyperparams loads JSON via parameterized batches + deletes it (#4306)", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => hyperparamsRow(i + 1));
  const m = mockEnv({ rows: signedEnvelope(rows) });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 5);
  assert.deepEqual(m.getCalls, [STAGED_KEY]);
  // 5 rows / 2 per statement = 3 upsert statements in one db.batch() call,
  // then a second db.batch() call of 5 history-diff INSERTs (#4309/1.6) — the
  // mock's empty latest-hash table means every row looks "changed".
  assert.deepEqual(m.batches, [3, 5]);
  // SQL is parameterized — the structure is fixed and values are bound, never
  // interpolated, so a tampered staged file cannot inject SQL.
  assert.ok(
    m.prepared[0].startsWith("INSERT OR REPLACE INTO subnet_hyperparams ("),
  );
  assert.ok(m.prepared[0].includes("VALUES (?"));
  assert.ok(
    m.prepared.some((s) =>
      s.startsWith("INSERT INTO subnet_hyperparams_history ("),
    ),
    "the diff-on-change history writer (#4309/1.6) must run alongside the latest-only upsert",
  );
  assert.ok(
    m.prepared.some((s) =>
      s.startsWith("DELETE FROM subnet_hyperparams WHERE netuid NOT IN"),
    ),
  );
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedSubnetHyperparams no-ops when nothing is staged", async () => {
  const m = mockEnv({ rows: null });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "none");
  assert.equal(m.batches.length, 0);
  assert.equal(m.deleted.length, 0);
});

test("loadStagedSubnetHyperparams deletes + bails on unparseable JSON", async () => {
  const m = mockEnv({ rows: [], bad: true });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.reason, "parse_failed");
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedSubnetHyperparams is a safe no-op without bindings", async () => {
  const r = await loadStagedSubnetHyperparams({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
});

test("loadStagedSubnetHyperparams rejects unsigned or tampered staged payloads", async () => {
  const m = mockEnv({ rows: [hyperparamsRow(1)] }); // bare array, no envelope shape
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unauthenticated");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, [STAGED_KEY]);

  const tampered = signedEnvelope([hyperparamsRow(1)]);
  tampered.rows[0].tempo = 999;
  const m2 = mockEnv({ rows: tampered });
  const r2 = await loadStagedSubnetHyperparams(m2.env);
  assert.equal(r2.reason, "unauthenticated");
  assert.equal(m2.batches.length, 0);
});

test("loadStagedSubnetHyperparams rejects an oversized staged file without reading it", async () => {
  const warn = vi.spyOn(console, "warn");
  const m = mockEnv({
    rows: signedEnvelope([hyperparamsRow(1)]),
    size: 2_000_001,
  });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.reason, "too_large");
  assert.equal(r.size, 2_000_001);
  assert.equal(m.batches.length, 0);
  assert.equal(
    m.jsonCalls.length,
    0,
    "oversized payloads must return before object.json()",
  );
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0][0]), /2000001/);
  assert.deepEqual(
    m.deleted,
    [],
    "must NOT delete — that would drop staged rows, next cron retries",
  );
  warn.mockRestore();
});

test("loadStagedSubnetHyperparams rejects a payload with more rows than the cap", async () => {
  const bigRows = Array.from({ length: 1_001 }, (_, i) => hyperparamsRow(i));
  const m = mockEnv({ rows: signedEnvelope(bigRows), size: 1 });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too_many_rows");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedSubnetHyperparams deletes an empty-rows payload without loading", async () => {
  const m = mockEnv({ rows: signedEnvelope([]) });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.reason, "invalid");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedSubnetHyperparams rejects rows that fail per-field bounding", async () => {
  // Each case is a correctly-signed row that still fails one of the guards in
  // validStagedSubnetHyperparamsRow — the column allow-list, finiteness, the
  // number-or-null type rule, and the netuid range/integer check.
  const cases = {
    unknown_column: { ...hyperparamsRow(1), evil_extra: 1 },
    non_finite_number: { ...hyperparamsRow(1), kappa_ratio: Infinity },
    boolean_value: { ...hyperparamsRow(1), registration_allowed: true },
    string_value: { ...hyperparamsRow(1), tempo: "360" },
    out_of_range_netuid: { ...hyperparamsRow(1), netuid: 999_999 },
    non_integer_netuid: { ...hyperparamsRow(1), netuid: 1.5 },
    negative_netuid: { ...hyperparamsRow(1), netuid: -1 },
    non_object_row: null,
    array_row: [],
  };
  for (const [name, row] of Object.entries(cases)) {
    const m = mockEnv({ rows: signedEnvelope([row]) });
    const r = await loadStagedSubnetHyperparams(m.env);
    assert.equal(r.ok, false, `${name} must be rejected`);
    assert.equal(r.reason, "invalid", `${name} must be rejected as invalid`);
    assert.equal(m.batches.length, 0, `${name} must never reach a D1 write`);
    assert.deepEqual(m.deleted, [STAGED_KEY]);
  }
});

test("loadStagedSubnetHyperparams keeps the staged object when the upsert batch fails (safety)", async () => {
  const rows = [hyperparamsRow(1), hyperparamsRow(2)];
  const m = mockEnv({ rows: signedEnvelope(rows), failBatch: true });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.equal(
    m.runs.length,
    0,
    "prune must never run after a failed upsert batch",
  );
  assert.deepEqual(
    m.deleted,
    [],
    "staged object must be preserved for the next cron retry",
  );
});

test("loadStagedSubnetHyperparams returns purge_failed when upserts commit but the prune fails", async () => {
  const rows = [hyperparamsRow(1)];
  const m = mockEnv({ rows: signedEnvelope(rows), failPrune: true });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "purge_failed");
  assert.ok(
    m.batches.length > 0,
    "upserts already committed before the prune ran",
  );
  assert.deepEqual(
    m.deleted,
    [],
    "staged object kept so the next cron re-prunes",
  );
});

// A stateful D1 mock (a real Map keyed on netuid) honoring the two SQL shapes
// loadStagedSubnetHyperparams issues — INSERT OR REPLACE (upsert by PK) and
// DELETE ... WHERE netuid NOT IN (full-sync prune, no partial-coverage concept
// since every fetch covers all active subnets). Proves a deregistered
// subnet's row is actually gone, not merely that a DELETE was prepared.
function statefulEnv(table, { failBatch = false, failPrune = false } = {}) {
  const deleted = [];
  function applyUpsert(sql, values) {
    const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",");
    const perRow = cols.length;
    for (let i = 0; i < values.length; i += perRow) {
      const row = {};
      cols.forEach((c, j) => (row[c.trim()] = values[i + j]));
      table.set(row.netuid, row);
    }
  }
  function applyPrune(keepNetuids) {
    const keep = new Set(keepNetuids);
    let changes = 0;
    for (const netuid of [...table.keys()]) {
      if (!keep.has(netuid)) {
        table.delete(netuid);
        changes += 1;
      }
    }
    return changes;
  }
  return {
    env: {
      METAGRAPH_STAGING_SIGNING_KEY: SIGNING_KEY,
      METAGRAPH_ARCHIVE: {
        _staged: null,
        async get() {
          return this._staged == null
            ? null
            : {
                size: JSON.stringify(this._staged).length,
                json: async () => this._staged,
              };
        },
        async delete(key) {
          deleted.push(key);
          this._staged = null;
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            // recordSubnetHyperparamsChanges' latestHyperparamsHashes read (#4309/1.6).
            async all() {
              return { results: [] };
            },
            bind: (...v) => ({
              sql,
              v,
              async run() {
                if (sql.startsWith("DELETE FROM subnet_hyperparams")) {
                  if (failPrune) throw new Error("simulated prune failure");
                  return { meta: { changes: applyPrune(v) } };
                }
                return { meta: { changes: 0 } };
              },
            }),
          };
        },
        async batch(stmts) {
          if (failBatch) throw new Error("simulated batch failure");
          for (const stmt of stmts) {
            if (
              stmt.sql.startsWith("INSERT OR REPLACE INTO subnet_hyperparams")
            ) {
              applyUpsert(stmt.sql, stmt.v);
            }
          }
          return stmts.map(() => ({ meta: { changes: 0 } }));
        },
      },
    },
    deleted,
    table,
  };
}

test("loadStagedSubnetHyperparams prunes a deregistered subnet's row on the next full snapshot", async () => {
  const table = new Map();
  table.set(1, { ...hyperparamsRow(1) });
  table.set(2, { ...hyperparamsRow(2) }); // subnet 2 will deregister
  const m = statefulEnv(table);

  // Every fetch covers ALL active subnets (no partial-coverage concept) — subnet
  // 2 is simply absent from this snapshot because it deregistered.
  const snapshot = [{ ...hyperparamsRow(1), tempo: 720 }];
  m.env.METAGRAPH_ARCHIVE._staged = signedEnvelope(snapshot);
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.purged, 1, "exactly the deregistered subnet 2 row is pruned");
  assert.deepEqual([...table.keys()], [1]);
  assert.equal(table.get(1).tempo, 720);
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedSubnetHyperparams keeps every current subnet when none deregistered", async () => {
  const table = new Map();
  table.set(1, { ...hyperparamsRow(1) });
  table.set(2, { ...hyperparamsRow(2) });
  const m = statefulEnv(table);

  const snapshot = [
    { ...hyperparamsRow(1), tempo: 720 },
    { ...hyperparamsRow(2), tempo: 100 },
  ];
  m.env.METAGRAPH_ARCHIVE._staged = signedEnvelope(snapshot);
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.purged, 0);
  assert.deepEqual([...table.keys()].sort(), [1, 2]);
});

test("loadStagedSubnetHyperparams treats a missing object.size as zero bytes", async () => {
  const envelope = signedEnvelope([hyperparamsRow(1)]);
  const getCalls = [];
  const env = {
    METAGRAPH_STAGING_SIGNING_KEY: SIGNING_KEY,
    METAGRAPH_ARCHIVE: {
      async get(key) {
        getCalls.push(key);
        return {
          async json() {
            return envelope;
          },
        }; // no .size field at all
      },
      async delete() {},
    },
    METAGRAPH_HEALTH_DB: mockEnv({ rows: envelope }).env.METAGRAPH_HEALTH_DB,
  };
  const r = await loadStagedSubnetHyperparams(env);
  assert.equal(
    r.ok,
    true,
    "a missing size must fall back to 0, not throw or reject",
  );
  assert.deepEqual(getCalls, [STAGED_KEY]);
});

test("loadStagedSubnetHyperparams rejects a schema_version:1 payload with no hmac field at all", async () => {
  // Distinct from the tampered-payload case: here hmac_sha256 is entirely
  // absent (not just wrong), which only the `envelope?.hmac_sha256 || ""`
  // fallback inside the format check can catch.
  const rows = [hyperparamsRow(1)];
  const m = mockEnv({ rows: { schema_version: 1, rows } });
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unauthenticated");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedSubnetHyperparams substitutes null for a row's omitted optional columns", async () => {
  const table = new Map();
  const m = statefulEnv(table);
  const partial = { netuid: 5, tempo: 360 }; // every other optional column omitted
  m.env.METAGRAPH_ARCHIVE._staged = signedEnvelope([partial]);
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, true);
  assert.equal(table.get(5).tempo, 360);
  assert.equal(
    table.get(5).kappa_ratio,
    null,
    "an omitted column must bind as NULL, not undefined",
  );
});

test("loadStagedSubnetHyperparams treats a prune result with no meta.changes as zero purged", async () => {
  const rows = [hyperparamsRow(1)];
  const m = mockEnv({ rows: signedEnvelope(rows) });
  const basePrepare = m.env.METAGRAPH_HEALTH_DB.prepare;
  m.env.METAGRAPH_HEALTH_DB.prepare = (sql) => {
    if (!sql.startsWith("DELETE FROM subnet_hyperparams")) {
      return basePrepare(sql);
    }
    return {
      bind: () => ({
        async run() {
          return {};
        },
      }),
    };
  };
  const r = await loadStagedSubnetHyperparams(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.purged, 0);
});
