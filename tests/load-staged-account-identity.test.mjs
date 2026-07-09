import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, vi } from "vitest";
import { loadStagedAccountIdentity } from "../workers/api.mjs";

const STAGED_KEY = "metagraph/account-identity-pending.json";
const SIGNING_KEY = "test-staged-account-identity-secret";

function identityRow(account) {
  return {
    account,
    name: "Example Team",
    url: "https://example.com",
    github: "example",
    image: "https://example.com/logo.png",
    discord: "example#0001",
    description: "An example subnet operator.",
    additional: null,
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
  getCalls = [],
  deleted = [],
  prepared = [],
  batches = [],
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
            // recordAccountIdentityChanges' latestIdentityHashes reads via
            // prepare(sql).all() directly (no bind) — an empty history table
            // on every run, so every staged row's hash always looks "changed".
            async all() {
              return { results: [] };
            },
            bind: (...v) => ({
              sql,
              v,
              async run() {
                if (failBatch) throw new Error("simulated D1 batch failure");
                return { meta: { changes: 0 } };
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
    jsonCalls,
  };
}

test("loadStagedAccountIdentity loads JSON via parameterized batches + deletes it (#4324/5.1)", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => identityRow(`5Acc${i}`));
  const m = mockEnv({ rows: signedEnvelope(rows) });
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 3);
  assert.deepEqual(m.getCalls, [STAGED_KEY]);
  // 3 rows / 10 per statement = 1 upsert statement in one db.batch() call,
  // then a second db.batch() call of 3 history-diff INSERTs (#4326/5.2) — the
  // mock's empty latest-hash table means every row looks "changed".
  assert.deepEqual(m.batches, [1, 3]);
  // SQL is parameterized — the structure is fixed and values are bound, never
  // interpolated, so a tampered staged file cannot inject SQL.
  assert.ok(
    m.prepared[0].startsWith("INSERT OR REPLACE INTO account_identity ("),
  );
  assert.ok(m.prepared[0].includes("VALUES (?"));
  assert.ok(
    m.prepared.some((s) =>
      s.startsWith("INSERT INTO account_identity_history ("),
    ),
    "the diff-on-change history writer (#4326/5.2) must run alongside the latest-only upsert",
  );
  // Deliberately no purge/prune statement — see loadStagedAccountIdentity's
  // own header comment for why (identity persists past a scan-pass absence).
  assert.equal(
    m.prepared.some((s) => s.startsWith("DELETE")),
    false,
  );
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedAccountIdentity no-ops when nothing is staged", async () => {
  const m = mockEnv({ rows: null });
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "none");
  assert.equal(m.batches.length, 0);
  assert.equal(m.deleted.length, 0);
});

test("loadStagedAccountIdentity deletes + bails on unparseable JSON", async () => {
  const m = mockEnv({ rows: [], bad: true });
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.reason, "parse_failed");
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedAccountIdentity is a safe no-op without bindings", async () => {
  const r = await loadStagedAccountIdentity({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
});

test("loadStagedAccountIdentity rejects unsigned or tampered staged payloads", async () => {
  const m = mockEnv({ rows: [identityRow("5Acc0")] }); // bare array, no envelope shape
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unauthenticated");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, [STAGED_KEY]);

  const tampered = signedEnvelope([identityRow("5Acc0")]);
  tampered.rows[0].name = "Tampered";
  const m2 = mockEnv({ rows: tampered });
  const r2 = await loadStagedAccountIdentity(m2.env);
  assert.equal(r2.reason, "unauthenticated");
  assert.equal(m2.batches.length, 0);
});

test("loadStagedAccountIdentity rejects an oversized staged file without reading it", async () => {
  const warn = vi.spyOn(console, "warn");
  const m = mockEnv({
    rows: signedEnvelope([identityRow("5Acc0")]),
    size: 5_000_001,
  });
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.reason, "too_large");
  assert.equal(r.size, 5_000_001);
  assert.equal(m.batches.length, 0);
  assert.equal(
    m.jsonCalls.length,
    0,
    "oversized payloads must return before object.json()",
  );
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0][0]), /5000001/);
  assert.deepEqual(
    m.deleted,
    [],
    "must NOT delete — that would drop staged rows, next cron retries",
  );
  warn.mockRestore();
});

test("loadStagedAccountIdentity rejects a payload with more rows than the cap", async () => {
  const bigRows = Array.from({ length: 5_001 }, (_, i) =>
    identityRow(`5Acc${i}`),
  );
  const m = mockEnv({ rows: signedEnvelope(bigRows), size: 1 });
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too_many_rows");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedAccountIdentity deletes an empty-rows payload without loading", async () => {
  const m = mockEnv({ rows: signedEnvelope([]) });
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.reason, "invalid");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedAccountIdentity rejects rows that fail per-field bounding", async () => {
  const cases = {
    unknown_column: { ...identityRow("5Acc0"), evil_extra: 1 },
    non_finite_captured_at: { ...identityRow("5Acc0"), captured_at: Infinity },
    boolean_value: { ...identityRow("5Acc0"), name: true },
    // Regression case for the bug the adversarial review caught: the removed
    // `typeof value === "number" && !Number.isFinite(value)` check only ever
    // rejected NON-finite numbers, never a plain finite one like 12345 — a
    // number could flow straight into a TEXT column undetected.
    number_value: { ...identityRow("5Acc0"), name: 12345 },
    oversized_string: {
      ...identityRow("5Acc0"),
      description: "x".repeat(1025),
    },
    missing_account: { ...identityRow("5Acc0"), account: "" },
    non_string_account: { ...identityRow("5Acc0"), account: 5 },
    missing_captured_at: { ...identityRow("5Acc0"), captured_at: undefined },
    non_object_row: null,
    array_row: [],
  };
  for (const [name, row] of Object.entries(cases)) {
    const m = mockEnv({ rows: signedEnvelope([row]) });
    const r = await loadStagedAccountIdentity(m.env);
    assert.equal(r.ok, false, `${name} must be rejected`);
    assert.equal(r.reason, "invalid", `${name} must be rejected as invalid`);
    assert.equal(m.batches.length, 0, `${name} must never reach a D1 write`);
    assert.deepEqual(m.deleted, [STAGED_KEY]);
  }
});

test("loadStagedAccountIdentity keeps the staged object when the upsert batch fails (safety)", async () => {
  const rows = [identityRow("5Acc0"), identityRow("5Acc1")];
  const m = mockEnv({ rows: signedEnvelope(rows), failBatch: true });
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load_failed");
  assert.deepEqual(
    m.deleted,
    [],
    "staged object must be preserved for the next cron retry",
  );
});

test("loadStagedAccountIdentity treats a missing object.size as zero bytes", async () => {
  const envelope = signedEnvelope([identityRow("5Acc0")]);
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
  const r = await loadStagedAccountIdentity(env);
  assert.equal(
    r.ok,
    true,
    "a missing size must fall back to 0, not throw or reject",
  );
  assert.deepEqual(getCalls, [STAGED_KEY]);
});

test("loadStagedAccountIdentity rejects a schema_version:1 payload with no hmac field at all", async () => {
  const rows = [identityRow("5Acc0")];
  const m = mockEnv({ rows: { schema_version: 1, rows } });
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unauthenticated");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, [STAGED_KEY]);
});

test("loadStagedAccountIdentity substitutes null for a row's omitted optional columns", async () => {
  const captured = [];
  const m = mockEnv({
    rows: signedEnvelope([{ account: "5Acc0", captured_at: 1 }]),
  });
  const basePrepare = m.env.METAGRAPH_HEALTH_DB.prepare;
  m.env.METAGRAPH_HEALTH_DB.prepare = (sql) => {
    const stmt = basePrepare(sql);
    return {
      bind: (...v) => {
        captured.push(v);
        return stmt.bind(...v);
      },
    };
  };
  const r = await loadStagedAccountIdentity(m.env);
  assert.equal(r.ok, true);
  // account, name, url, github, image, discord, description, additional, captured_at
  assert.deepEqual(captured[0], [
    "5Acc0",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    1,
  ]);
});
