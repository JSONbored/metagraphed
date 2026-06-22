import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
  getCalls = [],
  deleted = [],
  prepared = [],
  batches = [],
  runs = [],
  size,
}) {
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
              async run() {
                runs.push({ sql, v });
                return { meta: { changes: 1 } };
              },
            }),
          };
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
    runs,
  };
}

test("loadStagedNeurons loads JSON via parameterized batches + deletes it (#1303)", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => neuronRow(1, i));
  const m = mockEnv({ rows: signedEnvelope(rows) });
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
  const oversized = mockEnv({
    rows: signedEnvelope([neuronRow(1, 0)]),
    size: 32_000_001,
  });
  const oversizedResult = await loadStagedNeurons(oversized.env);
  assert.equal(oversizedResult.reason, "too_large");
  assert.equal(oversized.batches.length, 0);

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

test("loadStagedNeurons purges prior-capture rows within refreshed subnets", async () => {
  const captured_at = 2_000_000_000_000;
  const rows = [{ ...neuronRow(1, 0), captured_at }];
  const m = mockEnv({
    rows: signedCoverageEnvelope(rows, [1], captured_at),
  });
  const r = await loadStagedNeurons(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.purged, 1);
  const purge = m.runs.find((run) => run.sql.includes("DELETE FROM neurons"));
  assert.ok(purge);
  assert.deepEqual(purge.v, [1, captured_at]);
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
