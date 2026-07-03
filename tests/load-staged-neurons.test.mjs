import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, vi } from "vitest";
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

const SIGNING_KEY = "test-staged-neurons-secret";

function signedEnvelope(rows, key = SIGNING_KEY) {
  return {
    schema_version: 1,
    hmac_sha256: createHmac("sha256", key)
      .update(JSON.stringify(rows))
      .digest("hex"),
    rows,
  };
}

function signedCoverageEnvelope(
  rows,
  refreshed_netuids,
  captured_at,
  key = SIGNING_KEY,
) {
  const payload = JSON.stringify({ rows, refreshed_netuids, captured_at });
  return {
    schema_version: 1,
    hmac_sha256: createHmac("sha256", key).update(payload).digest("hex"),
    rows,
    refreshed_netuids,
    captured_at,
  };
}

function mockEnv({
  rows,
  bad = false,
  failBatch = false,
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
            bind: (...v) => ({
              sql,
              v,
              async all() {
                return { results: [] };
              },
              async run() {
                runs.push({ sql, v });
                return { meta: { changes: 1 } };
              },
            }),
            async all() {
              return { results: [] };
            },
          };
        },
        async batch(stmts) {
          batches.push(stmts.length);
          if (failBatch) throw new Error("simulated D1 batch failure");
          return stmts.map((stmt) => ({
            meta: {
              changes: stmt.sql?.includes("DELETE FROM neurons") ? 1 : 0,
            },
          }));
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

test("loadStagedNeurons loads JSON via parameterized batches + deletes it (#1303)", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => neuronRow(1, i));
  const m = mockEnv({ rows: signedEnvelope(rows) });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 12);
  assert.deepEqual(m.getCalls, ["metagraph/neurons-pending.json"]);
  // 12 rows / 5 per statement = 3 upsert statements + 1 prune in one atomic batch.
  assert.deepEqual(m.batches, [4]);
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
  const m = mockEnv({ rows: signedEnvelope([{ foo: 1 }]) }); // no netuid/uid → invalid
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.reason, "invalid");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, ["metagraph/neurons-pending.json"]);
});

test("loadStagedNeurons is a safe no-op without bindings", async () => {
  const r = await loadStagedNeurons({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
});

test("loadStagedNeurons rejects unsigned or tampered staged payloads", async () => {
  const m = mockEnv({ rows: [neuronRow(1, 0)] });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unauthenticated");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, ["metagraph/neurons-pending.json"]);

  const tampered = signedEnvelope([neuronRow(1, 0)]);
  tampered.rows[0].uid = 1;
  const m2 = mockEnv({ rows: tampered });
  const r2 = await loadStagedNeurons(m2.env);
  assert.equal(r2.reason, "unauthenticated");
  assert.equal(m2.batches.length, 0);
});

test("loadStagedNeurons accepts full-network snapshots above the old 2 MB cap", async () => {
  const rows = Array.from({ length: 2_000 }, (_, i) => ({
    ...neuronRow(1, i),
    hotkey: `h${"x".repeat(511)}`.slice(0, 512),
    coldkey: `c${"y".repeat(511)}`.slice(0, 512),
    axon: `a${"z".repeat(511)}`.slice(0, 512),
  }));
  const envelope = signedEnvelope(rows);
  const size = JSON.stringify(envelope).length;
  assert.ok(size > 2_000_000, "fixture must exceed the regressed 2 MB cap");

  const m = mockEnv({ rows: envelope, size });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, rows.length);
  assert.ok(m.batches.length > 0);
  assert.deepEqual(m.deleted, ["metagraph/neurons-pending.json"]);
});

test("loadStagedNeurons rejects oversized and out-of-range rows", async () => {
  const warn = vi.spyOn(console, "warn");
  const oversized = mockEnv({
    rows: signedEnvelope([neuronRow(1, 0)]),
    size: 32_000_001,
  });
  const oversizedResult = await loadStagedNeurons(oversized.env);
  assert.equal(oversizedResult.reason, "too_large");
  assert.equal(oversizedResult.size, 32_000_001);
  assert.equal(oversized.batches.length, 0);
  assert.equal(
    oversized.jsonCalls.length,
    0,
    "oversized payloads must return before object.json()",
  );
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0][0]), /32000001/);
  assert.deepEqual(
    oversized.deleted,
    [],
    "must NOT delete — that would drop staged rows",
  );
  warn.mockRestore();

  const missingSizeJsonCalls = [];
  const missingSizeDeleted = [];
  const missingSizeRows = signedEnvelope([neuronRow(1, 0)]);
  const missingSizeEnv = {
    METAGRAPH_STAGING_SIGNING_KEY: SIGNING_KEY,
    METAGRAPH_ARCHIVE: {
      async get(key) {
        assert.equal(key, "metagraph/neurons-pending.json");
        return {
          async json() {
            missingSizeJsonCalls.push(1);
            return missingSizeRows;
          },
        };
      },
      async delete(key) {
        missingSizeDeleted.push(key);
      },
    },
    METAGRAPH_HEALTH_DB: mockEnv({ rows: missingSizeRows }).env
      .METAGRAPH_HEALTH_DB,
  };
  const missingSizeResult = await loadStagedNeurons(missingSizeEnv);
  assert.equal(missingSizeResult.ok, true);
  assert.equal(missingSizeJsonCalls.length, 1);

  const m = mockEnv({ rows: signedEnvelope([neuronRow(999999, -7)]) });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid");
  assert.equal(m.batches.length, 0);

  const bigRows = Array.from({ length: 50_001 }, (_, i) => neuronRow(1, i));
  const m2 = mockEnv({ rows: signedEnvelope(bigRows), size: 1 });
  const r2 = await loadStagedNeurons(m2.env);
  assert.equal(r2.reason, "too_many_rows");
});

test("loadStagedNeurons rejects rows that fail per-field bounding (#1360)", async () => {
  // Each case is a correctly-signed, in-range (netuid/uid) row that still fails
  // one of the per-field guards in validStagedNeuronRow — exercising the column
  // allow-list, string-length cap, finiteness, and type checks that the
  // netuid/uid-only cases never reach.
  const cases = {
    unknown_column: { ...neuronRow(1, 0), evil_extra: 1 },
    oversized_string: { ...neuronRow(1, 0), hotkey: "x".repeat(513) },
    non_finite_number: { ...neuronRow(1, 0), rank: Infinity },
    wrong_typed_value: { ...neuronRow(1, 0), active: true },
    out_of_range_uid: neuronRow(1, 999_999), // valid netuid, uid past MAX_STAGED_UID
    non_object_row: null,
  };
  for (const [name, row] of Object.entries(cases)) {
    const m = mockEnv({ rows: signedEnvelope([row]) });
    const r = await loadStagedNeurons(m.env);
    assert.equal(r.ok, false, `${name} must be rejected`);
    assert.equal(r.reason, "invalid", `${name} must be rejected as invalid`);
    assert.equal(m.batches.length, 0, `${name} must never reach a D1 write`);
    assert.deepEqual(m.deleted, ["metagraph/neurons-pending.json"]);
  }
});

test("loadStagedNeurons coverage envelope prunes only refreshed netuids", async () => {
  // INVARIANT: coverage envelopes can be partial refreshes, so after a successful
  // load the prune deletes prior-snapshot rows only for refreshed netuids. This
  // preserves rows for subnets that were not represented in the staged payload.
  const captured_at = 2_000_000_000_000;
  const rows = [{ ...neuronRow(1, 0), captured_at }];
  const m = mockEnv({
    rows: signedCoverageEnvelope(rows, [1], captured_at),
  });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.purged, 1);
  const purges = [
    ...m.runs.filter((run) => run.sql.includes("DELETE FROM neurons")),
    ...m.prepared.filter((sql) => sql.includes("DELETE FROM neurons")),
  ];
  assert.ok(purges.length >= 1, "exactly one coverage-scoped prune");
  const purgeRun = m.runs.find((run) =>
    run.sql.includes("DELETE FROM neurons"),
  );
  if (purgeRun) {
    assert.deepEqual(purgeRun.v, [1, captured_at]);
    assert.match(purgeRun.sql, /WHERE netuid IN \(\?\) AND captured_at < \?/);
  }
  // The prune runs in the same D1 batch as the final upsert chunk (single-batch
  // loads) or via .run() after multi-batch upserts.
  assert.ok(m.batches.length > 0);
});

test("loadStagedNeurons rejects coverage metadata that disagrees with row captured_at", async () => {
  const captured_at = 2_000_000_000_000;
  const rows = [{ ...neuronRow(1, 0), captured_at: captured_at + 1 }];
  const m = mockEnv({
    rows: signedCoverageEnvelope(rows, [1], captured_at),
  });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.reason, "invalid");
  assert.equal(m.batches.length, 0);
});

// A *stateful* D1 mock: a real table (Map keyed on the (netuid,uid) PK) that
// honors the two SQL shapes loadStagedNeurons actually issues — INSERT OR REPLACE
// (upsert by PK) and the snapshot-prune DELETE ... WHERE captured_at < ?. This is
// what lets the regression test below prove a deregistered UID's row is actually
// gone, not merely that a DELETE statement was prepared.
function applyNeuronSnapshotPrune(table, sql, values) {
  if (sql.startsWith("DELETE FROM neurons WHERE captured_at <")) {
    const cutoff = values[0];
    let changes = 0;
    for (const [k, row] of table) {
      if (row.captured_at < cutoff) {
        table.delete(k);
        changes += 1;
      }
    }
    return changes;
  }
  if (
    sql.startsWith("DELETE FROM neurons WHERE netuid IN") &&
    sql.includes("captured_at <")
  ) {
    const cutoff = values.at(-1);
    const refreshed = new Set(values.slice(0, -1));
    let changes = 0;
    for (const [k, row] of table) {
      if (refreshed.has(row.netuid) && row.captured_at < cutoff) {
        table.delete(k);
        changes += 1;
      }
    }
    return changes;
  }
  return 0;
}

function applyNeuronDeleteByKey(table, sql, values) {
  if (sql.startsWith("DELETE FROM neurons WHERE netuid = ? AND uid = ?")) {
    return table.delete(`${values[0]}:${values[1]}`) ? 1 : 0;
  }
  return 0;
}

function applyNeuronSelect(table, sql, values) {
  let rows = [...table.values()];
  if (sql.includes("WHERE netuid IN")) {
    const netuids = new Set(values);
    rows = rows.filter((row) => netuids.has(row.netuid));
  }
  return rows;
}

function statefulEnv(
  table,
  {
    signingKey = SIGNING_KEY,
    failBatchOnPrune = false,
    failPruneUntil = 0,
    failUpsertOnBatch = 0,
    failRollbackBatch = false,
    omitPruneChangesMeta = false,
    bareSelectResponse = false,
  } = {},
) {
  const deleted = [];
  let pruneAttempts = 0;
  let upsertBatchesDone = 0;
  function applyInsert(sql, values) {
    // Columns from "INSERT OR REPLACE INTO neurons (a,b,...) VALUES ..."
    const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",");
    const perRow = cols.length;
    for (let i = 0; i < values.length; i += perRow) {
      const row = {};
      cols.forEach((c, j) => (row[c.trim()] = values[i + j]));
      table.set(`${row.netuid}:${row.uid}`, row); // REPLACE by PK
    }
  }
  function colsPerRow(sql) {
    return sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").length;
  }
  function isLoadUpsertBatch(stmts) {
    return stmts.some((stmt) => {
      if (!stmt.sql.startsWith("INSERT OR REPLACE INTO neurons")) return false;
      return stmt.v.length > colsPerRow(stmt.sql);
    });
  }
  function isRollbackBatch(stmts) {
    return (
      stmts.length > 0 &&
      stmts.every((stmt) => {
        if (
          stmt.sql.startsWith(
            "DELETE FROM neurons WHERE netuid = ? AND uid = ?",
          )
        )
          return true;
        if (!stmt.sql.startsWith("INSERT OR REPLACE INTO neurons"))
          return false;
        return stmt.v.length === colsPerRow(stmt.sql);
      })
    );
  }
  return {
    env: {
      METAGRAPH_STAGING_SIGNING_KEY: signingKey,
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
          // Mirror the real bound-statement shape: carries { sql, v } so batch()
          // (which receives already-bound statements) can apply them.
          return {
            bind: (...v) => ({
              sql,
              v,
              async all() {
                if (sql.startsWith("SELECT")) {
                  return bareSelectResponse
                    ? {}
                    : { results: applyNeuronSelect(table, sql, v) };
                }
                return { results: [] };
              },
              async run() {
                if (sql.startsWith("DELETE FROM neurons")) {
                  pruneAttempts += 1;
                  if (pruneAttempts <= failPruneUntil) {
                    throw new Error("simulated prune failure");
                  }
                  if (
                    sql.startsWith(
                      "DELETE FROM neurons WHERE netuid = ? AND uid = ?",
                    )
                  ) {
                    return {
                      meta: { changes: applyNeuronDeleteByKey(table, sql, v) },
                    };
                  }
                  return omitPruneChangesMeta
                    ? {}
                    : {
                        meta: {
                          changes: applyNeuronSnapshotPrune(table, sql, v),
                        },
                      };
                }
                return { meta: { changes: 0 } };
              },
            }),
            async all() {
              if (sql.startsWith("SELECT")) {
                return bareSelectResponse
                  ? {}
                  : { results: applyNeuronSelect(table, sql, []) };
              }
              return { results: [] };
            },
          };
        },
        async batch(stmts) {
          if (
            failBatchOnPrune &&
            stmts.some((stmt) => stmt.sql.startsWith("DELETE FROM neurons"))
          ) {
            throw new Error("simulated atomic upsert+prune batch failure");
          }
          if (failRollbackBatch && isRollbackBatch(stmts)) {
            throw new Error("simulated rollback failure");
          }
          const hasUpsert = stmts.some((stmt) =>
            stmt.sql.startsWith("INSERT OR REPLACE INTO neurons"),
          );
          const hasPrune = stmts.some((stmt) =>
            stmt.sql.startsWith("DELETE FROM neurons"),
          );
          if (hasUpsert && !hasPrune && isLoadUpsertBatch(stmts)) {
            upsertBatchesDone += 1;
            if (failUpsertOnBatch && upsertBatchesDone === failUpsertOnBatch) {
              throw new Error("simulated multi-batch upsert failure");
            }
          }
          const results = [];
          for (const stmt of stmts) {
            if (stmt.sql.startsWith("INSERT OR REPLACE INTO neurons")) {
              applyInsert(stmt.sql, stmt.v);
              results.push({ meta: { changes: 0 } });
              continue;
            }
            if (
              stmt.sql.startsWith(
                "DELETE FROM neurons WHERE netuid = ? AND uid = ?",
              )
            ) {
              results.push({
                meta: {
                  changes: applyNeuronDeleteByKey(table, stmt.sql, stmt.v),
                },
              });
              continue;
            }
            if (stmt.sql.startsWith("DELETE FROM neurons")) {
              pruneAttempts += 1;
              if (pruneAttempts <= failPruneUntil) {
                throw new Error("simulated prune failure");
              }
              results.push({
                meta: {
                  changes: applyNeuronSnapshotPrune(table, stmt.sql, stmt.v),
                },
              });
            }
          }
          return results;
        },
      },
    },
    deleted,
    table,
    get pruneAttempts() {
      return pruneAttempts;
    },
  };
}

test("loadStagedNeurons snapshot-replace removes a deregistered UID across snapshots (regression #1303)", async () => {
  // THE BUG: INSERT OR REPLACE never deletes a (netuid,uid) that vanished from the
  // next snapshot, so a deregistered neuron's row would persist forever → ghost
  // metagraph entries + inflated neuron_count. snapshot-replace must clear it.
  const table = new Map();
  const m = statefulEnv(table);

  // Snapshot 1 @T1: subnet 1 has UIDs 0 and 1.
  const T1 = 1_700_000_000_000;
  const snap1 = [
    { ...neuronRow(1, 0), captured_at: T1 },
    { ...neuronRow(1, 1), captured_at: T1 },
  ];
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(snap1, [1], T1);
  const r1 = await loadStagedNeurons(m.env);
  assert.equal(r1.ok, true);
  assert.deepEqual([...table.keys()].sort(), ["1:0", "1:1"]);

  // Snapshot 2 @T2>T1: UID 1 deregistered — only UID 0 remains in the snapshot.
  const T2 = T1 + 60_000;
  const snap2 = [{ ...neuronRow(1, 0), captured_at: T2 }];
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(snap2, [1], T2);
  const r2 = await loadStagedNeurons(m.env);
  assert.equal(r2.ok, true);
  assert.equal(r2.purged, 1, "exactly the one stale (1,1) row is pruned");

  // The phantom (1,1) is gone; only the current (1,0) survives, at the new stamp.
  assert.deepEqual(
    [...table.keys()],
    ["1:0"],
    "deregistered UID must not linger as a phantom row",
  );
  assert.equal(table.get("1:0").captured_at, T2);
  assert.equal(table.has("1:1"), false);
});

test("loadStagedNeurons keeps unrefreshed subnets during a partial coverage refresh", async () => {
  const table = new Map();
  const m = statefulEnv(table);

  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1 });
  table.set("1:1", { ...neuronRow(1, 1), captured_at: T1 });
  table.set("2:0", { ...neuronRow(2, 0), captured_at: T1 });

  const T2 = T1 + 60_000;
  const partial = [{ ...neuronRow(1, 0), captured_at: T2 }];
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(partial, [1], T2);

  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.purged, 1, "only stale rows in refreshed subnet 1 are pruned");
  assert.deepEqual([...table.keys()].sort(), ["1:0", "2:0"]);
  assert.equal(table.get("1:0").captured_at, T2);
  assert.equal(table.get("2:0").captured_at, T1);
});

test("loadStagedNeurons makes NO prune and keeps the staged object when a batch fails (safety)", async () => {
  // SAFETY: if any upsert batch throws mid-load, we must NOT commit the snapshot
  // prune (which would delete the prior good snapshot) and must NOT delete the
  // staged R2 object (so the prior snapshot stays as a fallback and the next cron
  // retries).
  const rows = Array.from({ length: 12 }, (_, i) => neuronRow(1, i));
  const m = mockEnv({ rows: signedEnvelope(rows), failBatch: true });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.equal(
    m.batches.length,
    1,
    "single atomic upsert+prune batch attempted",
  );
  assert.equal(m.runs.length, 0, "no DELETE .run() was issued");
  // The staged object is preserved as the fallback snapshot.
  assert.deepEqual(m.deleted, [], "the staged R2 object must not be deleted");
});

test("loadStagedNeurons atomic upsert+prune failure leaves the prior snapshot intact", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1 });
  table.set("1:1", { ...neuronRow(1, 1), captured_at: T1 });
  const m = statefulEnv(table, { failBatchOnPrune: true });

  const T2 = T1 + 60_000;
  const snap2 = [{ ...neuronRow(1, 0), captured_at: T2 }];
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(snap2, [1], T2);
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.deepEqual([...table.keys()].sort(), ["1:0", "1:1"]);
  assert.equal(table.get("1:0").captured_at, T1);
  assert.equal(table.get("1:1").captured_at, T1);
  assert.deepEqual(m.deleted, [], "staged R2 object kept for retry");
});

test("loadStagedNeurons retries a failed multi-batch prune before giving up", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1 });
  table.set("1:1", { ...neuronRow(1, 1), captured_at: T1 });
  const m = statefulEnv(table, { failPruneUntil: 2 });

  const T2 = T1 + 60_000;
  // 255 rows -> 51 upsert statements (> STMTS_PER_BATCH) -> multi-batch path.
  // UID 1 is intentionally absent so the stale (1,1)@T1 row must be pruned.
  const snap2 = Array.from({ length: 255 }, (_, i) => {
    const uid = i === 0 ? 0 : i + 1;
    return { ...neuronRow(1, uid), captured_at: T2 };
  });
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(snap2, [1], T2);
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(m.pruneAttempts, 3, "two failed prune attempts then success");
  assert.equal(table.has("1:1"), false, "deregistered ghost UID is pruned");
  assert.equal(table.get("1:0").captured_at, T2);
});

test("loadStagedNeurons rolls back partial multi-batch upserts on mid-load failure", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1, stake_tao: 99 });
  table.set("1:1", { ...neuronRow(1, 1), captured_at: T1 });
  const m = statefulEnv(table, { failUpsertOnBatch: 2 });

  const T2 = T1 + 60_000;
  const snap2 = Array.from({ length: 255 }, (_, i) => {
    const uid = i === 0 ? 0 : i + 1;
    return { ...neuronRow(1, uid), captured_at: T2, stake_tao: 200 };
  });
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(snap2, [1], T2);
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.equal(
    [...table.values()].some(
      (row) => row.netuid === 1 && row.captured_at === T2,
    ),
    false,
    "partial snapshot rows at T2 must be rolled back",
  );
  assert.equal(
    table.get("1:0").captured_at,
    T1,
    "replaced UID must be restored to the prior snapshot stamp",
  );
  assert.equal(
    table.get("1:0").stake_tao,
    99,
    "replaced UID must be restored to prior row values, not deleted",
  );
  assert.equal(
    table.get("1:1").captured_at,
    T1,
    "untouched UID stays at prior snapshot until retry",
  );
  assert.deepEqual(m.deleted, [], "staged R2 object kept for retry");
});

test("loadStagedNeurons returns purge_failed when upserts finish but prune never succeeds", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1 });
  const m = statefulEnv(table, { failPruneUntil: 999 });

  const T2 = T1 + 60_000;
  const snap2 = Array.from({ length: 255 }, (_, i) => {
    const uid = i === 0 ? 0 : i + 1;
    return { ...neuronRow(1, uid), captured_at: T2 };
  });
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(snap2, [1], T2);
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "purge_failed");
  assert.deepEqual(m.deleted, [], "staged object kept for re-prune retry");
});

test("loadStagedNeurons rolls back legacy bare-array snapshots on mid-load failure", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1, stake_tao: 77 });
  const m = statefulEnv(table, { failUpsertOnBatch: 2 });

  const T2 = T1 + 60_000;
  const snap2 = Array.from({ length: 255 }, (_, i) => {
    const uid = i === 0 ? 0 : i + 1;
    return { ...neuronRow(1, uid), captured_at: T2, stake_tao: 200 };
  });
  m.env.METAGRAPH_ARCHIVE._staged = signedEnvelope(snap2);
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.equal(
    [...table.values()].some((row) => row.captured_at === T2),
    false,
    "partial legacy snapshot rows must be rolled back",
  );
  assert.equal(table.get("1:0").captured_at, T1);
  assert.equal(table.get("1:0").stake_tao, 77);
});

test("loadStagedNeurons treats missing atomic prune meta.changes as zero purged", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => neuronRow(1, i));
  const m = mockEnv({ rows: signedEnvelope(rows) });
  const baseBatch = m.env.METAGRAPH_HEALTH_DB.batch.bind(
    m.env.METAGRAPH_HEALTH_DB,
  );
  m.env.METAGRAPH_HEALTH_DB.batch = async (stmts) => {
    const out = await baseBatch(stmts);
    out[out.length - 1] = {};
    return out;
  };
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.purged, 0);
});

test("loadStagedNeurons treats missing multi-batch prune meta.changes as zero purged", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1 });
  const m = statefulEnv(table, { omitPruneChangesMeta: true });

  const T2 = T1 + 60_000;
  const snap2 = Array.from({ length: 255 }, (_, i) => {
    const uid = i === 0 ? 0 : i + 1;
    return { ...neuronRow(1, uid), captured_at: T2 };
  });
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(snap2, [1], T2);
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.purged, 0);
});

test("loadStagedNeurons multi-batch backup tolerates D1 select without results field", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1, stake_tao: 55 });
  const m = statefulEnv(table, {
    bareSelectResponse: true,
    failUpsertOnBatch: 2,
  });

  const T2 = T1 + 60_000;
  const snap2 = Array.from({ length: 255 }, (_, i) => {
    const uid = i === 0 ? 0 : i + 1;
    return { ...neuronRow(1, uid), captured_at: T2, stake_tao: 200 };
  });
  m.env.METAGRAPH_ARCHIVE._staged = signedEnvelope(snap2);
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.equal(
    [...table.values()].some((row) => row.captured_at === T2),
    false,
    "partial snapshot rows must be rolled back even without prior backup rows",
  );
});

test("loadStagedNeurons returns load_failed when multi-batch backup read throws", async () => {
  const rows = Array.from({ length: 255 }, (_, i) => neuronRow(1, i));
  const m = mockEnv({ rows: signedEnvelope(rows) });
  const basePrepare = m.env.METAGRAPH_HEALTH_DB.prepare.bind(
    m.env.METAGRAPH_HEALTH_DB,
  );
  m.env.METAGRAPH_HEALTH_DB.prepare = (sql) => {
    const stmt = basePrepare(sql);
    if (!sql.startsWith("SELECT")) return stmt;
    return {
      bind: (...v) => ({
        sql,
        v,
        async all() {
          throw new Error("simulated backup read failure");
        },
      }),
      async all() {
        throw new Error("simulated backup read failure");
      },
    };
  };
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.deepEqual(m.deleted, [], "staged object kept for retry");
});

test("loadStagedNeurons keeps committed rows after purge_failed retry mid-load failure", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1 });
  table.set("1:1", { ...neuronRow(1, 1), captured_at: T1 });

  const T2 = T1 + 60_000;
  const snap2 = Array.from({ length: 255 }, (_, i) => {
    const uid = i === 0 ? 0 : i + 1;
    return { ...neuronRow(1, uid), captured_at: T2, stake_tao: 300 + uid };
  });
  const staged = signedCoverageEnvelope(snap2, [1], T2);

  const m1 = statefulEnv(table, { failPruneUntil: 999 });
  m1.env.METAGRAPH_ARCHIVE._staged = staged;
  const r1 = await loadStagedNeurons(m1.env);
  assert.equal(r1.reason, "purge_failed");
  assert.equal(table.get("1:0").captured_at, T2);
  assert.equal(table.get("1:200").captured_at, T2);

  const m2 = statefulEnv(table, { failUpsertOnBatch: 2 });
  m2.env.METAGRAPH_ARCHIVE._staged = staged;
  const r2 = await loadStagedNeurons(m2.env);
  assert.equal(r2.reason, "load_failed");
  assert.equal(
    table.get("1:200").captured_at,
    T2,
    "rows not upserted in the failed retry must stay from the committed snapshot",
  );
  assert.equal(
    table.get("1:200").stake_tao,
    500,
    "untouched committed row values must survive the retry rollback",
  );
  assert.deepEqual(m2.deleted, [], "staged object kept for retry");
});

test("loadStagedNeurons survives rollback failure after mid-load upsert failure", async () => {
  const table = new Map();
  const T1 = 1_700_000_000_000;
  table.set("1:0", { ...neuronRow(1, 0), captured_at: T1 });
  const m = statefulEnv(table, {
    failUpsertOnBatch: 2,
    failRollbackBatch: true,
  });

  const T2 = T1 + 60_000;
  const snap2 = Array.from({ length: 255 }, (_, i) => {
    const uid = i === 0 ? 0 : i + 1;
    return { ...neuronRow(1, uid), captured_at: T2 };
  });
  m.env.METAGRAPH_ARCHIVE._staged = signedCoverageEnvelope(snap2, [1], T2);
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.deepEqual(
    m.deleted,
    [],
    "staged object kept even when rollback throws",
  );
});
