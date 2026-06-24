import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vitest";
import { handleScheduled, loadStagedEvents } from "../workers/api.mjs";
import {
  EVENTS_LOAD_CRON,
  MAX_STAGED_EVENTS_BYTES,
  MAX_STAGED_EVENT_ROWS,
} from "../workers/config.mjs";

const SIGNING_KEY = "test-staged-events-secret";

function eventRow(block_number, event_index) {
  return {
    block_number,
    event_index,
    event_kind: "StakeAdded",
    hotkey: `5Hk${event_index}`,
    coldkey: `5Co${event_index}`,
    netuid: 1,
    uid: null,
    amount_tao: 12.5,
    observed_at: 1750000000000,
  };
}

function signedEventEnvelope(rows, key = SIGNING_KEY) {
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
  getCalls = [],
  deleted = [],
  prepared = [],
  batches = [],
  signingKey = SIGNING_KEY,
}) {
  return {
    env: {
      METAGRAPH_STAGING_SIGNING_KEY: signingKey,
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

function archiveEnv({ get, put, delete: del, signingKey = SIGNING_KEY }) {
  return {
    METAGRAPH_STAGING_SIGNING_KEY: signingKey,
    METAGRAPH_ARCHIVE: { get, put, delete: del },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return { bind: () => ({}) };
      },
      async batch() {},
    },
  };
}

test("loadStagedEvents loads signed JSON via parameterized batches + deletes it (#1346)", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => eventRow(1000 + i, i));
  const m = mockEnv({ rows: signedEventEnvelope(rows) });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 12);
  assert.deepEqual(m.getCalls, ["events/account-events-pending.json"]);
  assert.deepEqual(m.batches, [2]);
  assert.ok(m.prepared[0].startsWith("INSERT OR IGNORE INTO account_events ("));
  assert.ok(m.prepared[0].includes("VALUES (?"));
  assert.ok(
    !m.prepared.some((s) => s.includes("5Hk")),
    "row values must never appear in the SQL text",
  );
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents no-ops when nothing is staged", async () => {
  const m = mockEnv({ rows: null });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "none");
  assert.equal(m.batches.length, 0);
  assert.equal(m.deleted.length, 0);
});

test("loadStagedEvents deletes + bails on unparseable JSON", async () => {
  const m = mockEnv({ rows: signedEventEnvelope([]), bad: true });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.reason, "parse_failed");
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents rejects an unsigned envelope", async () => {
  const m = mockEnv({ rows: [eventRow(1000, 0)] });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.reason, "unauthenticated");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents rejects a bad HMAC", async () => {
  const rows = [eventRow(1000, 0)];
  const envelope = signedEventEnvelope(rows);
  envelope.hmac_sha256 = "0".repeat(64);
  const m = mockEnv({ rows: envelope });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.reason, "unauthenticated");
  assert.equal(m.batches.length, 0);
});

test("loadStagedEvents drops rows lacking the (block, index) key", async () => {
  const m = mockEnv({
    rows: signedEventEnvelope([{ event_kind: "StakeAdded" }]),
  });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.reason, "empty");
  assert.equal(m.batches.length, 0);
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents drops rows missing required insert fields", async () => {
  const valid = eventRow(1000, 0);
  const m = mockEnv({
    rows: signedEventEnvelope([
      { ...valid, observed_at: null },
      { ...valid, event_index: 1, event_kind: null },
      { ...valid, event_index: 2 },
    ]),
  });
  const r = await loadStagedEvents(m.env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 1);
  assert.deepEqual(m.batches, [1]);
  assert.deepEqual(m.deleted, ["events/account-events-pending.json"]);
});

test("loadStagedEvents is a safe no-op without bindings", async () => {
  const r = await loadStagedEvents({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
});

test("handleScheduled fast-load cron drains staged batches + skips the probe (#1346 Option A)", async () => {
  const drained = [];
  const env = {
    METAGRAPH_STAGING_SIGNING_KEY: SIGNING_KEY,
    METAGRAPH_ARCHIVE: {
      async get(key) {
        return key === "events/account-events-pending.json"
          ? {
              async json() {
                return signedEventEnvelope([
                  {
                    block_number: 1,
                    event_index: 0,
                    event_kind: "StakeAdded",
                    observed_at: 1,
                  },
                ]);
              },
            }
          : null;
      },
      async delete(key) {
        drained.push(key);
      },
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return { bind: () => ({}) };
      },
      async batch() {},
    },
  };
  const r = await handleScheduled({ cron: EVENTS_LOAD_CRON }, env, {});
  assert.deepEqual(r, { ok: true, fast_load: true });
  assert.ok(
    drained.includes("events/account-events-pending.json"),
    "the staged event batch was loaded + deleted",
  );
});

// ---- input caps on the staged drain (parity with the HTTP ingest caps) -------

test("loadStagedEvents caps rows/tick + leaves the remainder in R2 (not deleted)", async () => {
  const N = MAX_STAGED_EVENT_ROWS + 5;
  const rows = Array.from({ length: N }, (_, i) => eventRow(1000 + i, i));
  const puts = [];
  const deleted = [];
  const env = archiveEnv({
    async get() {
      return {
        size: 1024,
        async json() {
          return signedEventEnvelope(rows);
        },
      };
    },
    async put(key, body) {
      puts.push({ key, body });
    },
    async delete(key) {
      deleted.push(key);
    },
  });
  const r = await loadStagedEvents(env);
  assert.equal(r.ok, true);
  assert.equal(r.rows, MAX_STAGED_EVENT_ROWS);
  assert.equal(r.remaining, 5);
  assert.deepEqual(deleted, [], "must NOT delete while rows are un-persisted");
  assert.equal(puts.length, 1, "remainder rewritten for the next tick");
  const remainder = JSON.parse(puts[0].body);
  assert.equal(remainder.rows.length, 5, "exactly the un-loaded rows are kept");
  assert.match(remainder.hmac_sha256, /^[a-f0-9]{64}$/);
});

test("loadStagedEvents drains a >cap file across ticks without dropping rows", async () => {
  const N = MAX_STAGED_EVENT_ROWS + 5;
  const all = Array.from({ length: N }, (_, i) => eventRow(1000 + i, i));
  let stored = JSON.stringify(signedEventEnvelope(all));
  const env = archiveEnv({
    async get() {
      return stored == null
        ? null
        : {
            size: stored.length,
            async json() {
              return JSON.parse(stored);
            },
          };
    },
    async put(_key, body) {
      stored = body;
    },
    async delete() {
      stored = null;
    },
  });
  const t1 = await loadStagedEvents(env);
  assert.equal(t1.rows, MAX_STAGED_EVENT_ROWS);
  assert.equal(t1.remaining, 5);
  assert.notEqual(stored, null, "remainder stays in R2 after tick 1");
  const t2 = await loadStagedEvents(env);
  assert.equal(t2.rows, 5);
  assert.equal(t2.remaining, undefined);
  assert.equal(stored, null, "object deleted only after the last row drained");
  assert.equal(
    t1.rows + t2.rows,
    N,
    "every row loaded across ticks — none dropped",
  );
});

test("loadStagedEvents skips an over-byte-cap file without parsing or deleting it", async () => {
  let jsonCalled = false;
  const deleted = [];
  const env = archiveEnv({
    async get() {
      return {
        size: MAX_STAGED_EVENTS_BYTES + 1,
        async json() {
          jsonCalled = true;
          return [];
        },
      };
    },
    async put() {},
    async delete(key) {
      deleted.push(key);
    },
  });
  const r = await loadStagedEvents(env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too_large");
  assert.equal(jsonCalled, false, "never materialized the oversized body");
  assert.deepEqual(
    deleted,
    [],
    "must NOT delete — that would drop staged rows",
  );
});

test("loadStagedEvents leaves the file intact if a D1 batch throws (no drop on crash)", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => eventRow(1000 + i, i));
  const puts = [];
  const deleted = [];
  const env = {
    METAGRAPH_STAGING_SIGNING_KEY: SIGNING_KEY,
    METAGRAPH_ARCHIVE: {
      async get() {
        return {
          size: 256,
          async json() {
            return signedEventEnvelope(rows);
          },
        };
      },
      async put(key, body) {
        puts.push({ key, body });
      },
      async delete(key) {
        deleted.push(key);
      },
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return { bind: () => ({}) };
      },
      async batch() {
        throw new Error("d1 down");
      },
    },
  };
  await assert.rejects(loadStagedEvents(env));
  assert.deepEqual(puts, [], "no remainder written on failure");
  assert.deepEqual(
    deleted,
    [],
    "object NOT deleted — full file re-drains next tick",
  );
});
