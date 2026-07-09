import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  buildSubnetHyperparamsHistory,
  formatHyperparamsHistoryEntry,
  hyperparamsHash,
  loadSubnetHyperparamsHistory,
  recordSubnetHyperparamsChanges,
} from "../src/subnet-hyperparams-history.mjs";
import { encodeCursor } from "../src/cursor.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

function stagedRow(overrides = {}) {
  return {
    netuid: 86,
    kappa_ratio: 0.5,
    immunity_period: 7200,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 1,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 1,
    min_burn_tao: 0.001,
    max_burn_tao: 100,
    burn_half_life: 100_000,
    burn_increase_mult: 1,
    bonds_moving_avg_raw: 900_000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.1,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 3,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 1,
    min_childkey_take_ratio: 0,
    block_number: 100,
    captured_at: 1_700_000_000_000,
    ...overrides,
  };
}

// Derives from stagedRow() rather than re-typing the 33 hyperparameter fields
// a second time, so the two fixtures can't silently drift out of sync.
function historyRow(overrides = {}) {
  const {
    netuid: _netuid,
    block_number,
    captured_at,
    ...hyperparamFields
  } = stagedRow();
  return {
    id: 10,
    block_number,
    observed_at: captured_at,
    ...hyperparamFields,
    hyperparams_hash: "abc",
    ...overrides,
  };
}

describe("hyperparamsHash", () => {
  test("is stable for the same object", async () => {
    const payload = { tempo: 360, registration_allowed: true };
    const a = await hyperparamsHash(payload);
    const b = await hyperparamsHash(payload);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  test("differs when a field changes", async () => {
    const a = await hyperparamsHash({ tempo: 360 });
    const b = await hyperparamsHash({ tempo: 361 });
    assert.notEqual(a, b);
  });

  test("is order-independent (stable stringify)", async () => {
    const a = await hyperparamsHash({ tempo: 360, kappa_ratio: 0.5 });
    const b = await hyperparamsHash({ kappa_ratio: 0.5, tempo: 360 });
    assert.equal(a, b);
  });

  test("hashes nested arrays via stableStringify", async () => {
    const hash = await hyperparamsHash({ tempo: 360, tags: [1, 2] });
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  test("returns null for a null/undefined payload", async () => {
    assert.equal(await hyperparamsHash(null), null);
    assert.equal(await hyperparamsHash(undefined), null);
  });
});

describe("formatHyperparamsHistoryEntry", () => {
  test("formats a D1 row into an API entry, nesting hyperparameters", () => {
    const out = formatHyperparamsHistoryEntry(historyRow());
    assert.equal(out.block_number, 100);
    assert.equal(out.observed_at, "2023-11-14T22:13:20.000Z");
    assert.equal(out.hyperparams_hash, "abc");
    assert.equal(out.hyperparameters.tempo, 360);
    assert.equal(out.hyperparameters.registration_allowed, true);
    assert.equal(out.hyperparameters.commit_reveal_enabled, false);
  });

  test("returns null for invalid rows", () => {
    assert.equal(formatHyperparamsHistoryEntry(null), null);
    assert.equal(formatHyperparamsHistoryEntry(undefined), null);
    assert.equal(formatHyperparamsHistoryEntry("nope"), null);
  });

  test("defaults hyperparams_hash to null when absent", () => {
    const out = formatHyperparamsHistoryEntry({
      ...historyRow(),
      hyperparams_hash: undefined,
    });
    assert.equal(out.hyperparams_hash, null);
  });

  test("nulls invalid block numbers and observed_at values", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ block_number: "nope", observed_at: 0 }),
    );
    assert.equal(out.block_number, null);
    assert.equal(out.observed_at, null);
  });

  test("nulls blank/whitespace and negative block_number cells", () => {
    for (const block_number of ["", "   ", -1, "-5"]) {
      const out = formatHyperparamsHistoryEntry(historyRow({ block_number }));
      assert.equal(out.block_number, null);
    }
  });

  test("coerces string-typed observed_at cells to ISO timestamps", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ observed_at: "1700000000000" }),
    );
    assert.equal(out.observed_at, new Date(1_700_000_000_000).toISOString());
  });

  test("preserves null observed_at as null (not epoch 1970)", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ observed_at: null }),
    );
    assert.equal(out.observed_at, null);
  });

  test("nulls a directly-null block_number", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ block_number: null }),
    );
    assert.equal(out.block_number, null);
  });

  test("nulls an out-of-range observed_at that produces an invalid Date", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ observed_at: 8_640_000_000_000_001 }),
    );
    assert.equal(out.observed_at, null);
  });
});

describe("buildSubnetHyperparamsHistory", () => {
  test("wraps rows with pagination metadata", () => {
    const out = buildSubnetHyperparamsHistory([historyRow({ id: 2 })], 86, {
      limit: 100,
      offset: 0,
      nextCursor: "2.1",
    });
    assert.equal(out.netuid, 86);
    assert.equal(out.entry_count, 1);
    assert.equal(out.next_cursor, "2.1");
    assert.equal(out.entries[0].hyperparams_hash, "abc");
  });

  test("defaults limit/offset to null and drops invalid rows", () => {
    const out = buildSubnetHyperparamsHistory([null, historyRow()], 86);
    assert.equal(out.limit, null);
    assert.equal(out.offset, null);
    assert.equal(out.entry_count, 1);
  });

  test("treats null rows input as empty", () => {
    const out = buildSubnetHyperparamsHistory(null, 86);
    assert.equal(out.entry_count, 0);
  });
});

function fakeDb({ latest = [], onBind } = {}) {
  const statements = [];
  return {
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            if (onBind) onBind(sql, args);
            statements.push({ sql, args });
            return this;
          },
          all: async () => ({ results: latest }),
        };
      },
      batch: async (batch) => {
        statements.push({ batch: batch.length });
      },
    },
    statements,
  };
}

describe("recordSubnetHyperparamsChanges", () => {
  test("inserts only when the hash changes", async () => {
    const { db, statements } = fakeDb({
      latest: [{ netuid: 86, hyperparams_hash: "old" }],
    });
    const result = await recordSubnetHyperparamsChanges(
      {},
      { rows: [stagedRow()], now: 1_700_000_000_000, db },
    );
    assert.equal(result.recorded, true);
    assert.equal(result.rows, 1);
    const insert = statements.find((entry) => entry.sql?.includes("INSERT"));
    assert.ok(insert);
    // netuid, block_number, observed_at are the first three bound values.
    assert.equal(insert.args[0], 86);
    assert.equal(insert.args[1], 100);
    assert.equal(insert.args[2], 1_700_000_000_000);
  });

  test("flattens boolean hyperparameter fields to 0/1 in the bound values", async () => {
    const { db, statements } = fakeDb();
    await recordSubnetHyperparamsChanges({}, { rows: [stagedRow()], db });
    const insert = statements.find((entry) => entry.sql?.includes("INSERT"));
    // registration_allowed is bound after netuid/block_number/observed_at/kappa_ratio/...
    // — assert the row contains only numbers/strings/null, never a boolean.
    assert.ok(insert.args.every((v) => typeof v !== "boolean"));
  });

  test("skips unchanged hyperparameters", async () => {
    const row = stagedRow();
    const { formatSubnetHyperparams } =
      await import("../src/subnet-hyperparams.mjs");
    const hash = await hyperparamsHash(formatSubnetHyperparams(row));
    const { db, statements } = fakeDb({
      latest: [{ netuid: 86, hyperparams_hash: hash }],
    });
    const result = await recordSubnetHyperparamsChanges(
      {},
      { rows: [row], db },
    );
    assert.equal(result.rows, 0);
    assert.equal(
      statements.some((s) => s.sql?.includes("INSERT")),
      false,
    );
  });

  test("skips unchanged when D1 returns a string netuid; ignores blank cells", async () => {
    const row = stagedRow();
    const { formatSubnetHyperparams } =
      await import("../src/subnet-hyperparams.mjs");
    const hash = await hyperparamsHash(formatSubnetHyperparams(row));
    const { db } = fakeDb({
      latest: [
        { netuid: "", hyperparams_hash: "junk" },
        { netuid: "86", hyperparams_hash: hash },
      ],
    });
    const result = await recordSubnetHyperparamsChanges(
      {},
      { rows: [row], db },
    );
    assert.equal(result.rows, 0);
  });

  test("ignores a negative-number netuid cell when reading latest hashes", async () => {
    // rowNetuid must reject a raw negative NUMBER (not just a negative string) —
    // a bad latest-hash row should never suppress a real change for that netuid.
    const { db, statements } = fakeDb({
      latest: [{ netuid: -1, hyperparams_hash: "junk" }],
    });
    const result = await recordSubnetHyperparamsChanges(
      {},
      { rows: [stagedRow()], db },
    );
    assert.equal(result.rows, 1);
    assert.ok(statements.some((s) => s.sql?.includes("INSERT")));
  });

  test("falls back to null for a missing numeric hyperparameter field", async () => {
    const { db, statements } = fakeDb();
    await recordSubnetHyperparamsChanges(
      {},
      { rows: [stagedRow({ kappa_ratio: null })], db },
    );
    const insert = statements.find((entry) => entry.sql?.includes("INSERT"));
    // kappa_ratio is the first hyperparameter column after netuid/block_number/observed_at.
    assert.equal(insert.args[3], null);
  });

  test("returns unavailable when rows are missing or empty", async () => {
    assert.deepEqual(await recordSubnetHyperparamsChanges({}, { rows: [] }), {
      recorded: false,
      reason: "unavailable",
    });
    assert.deepEqual(await recordSubnetHyperparamsChanges({}, {}), {
      recorded: false,
      reason: "unavailable",
    });
  });

  test("uses env.METAGRAPH_HEALTH_DB when db is not passed explicitly", async () => {
    const { db } = fakeDb();
    const result = await recordSubnetHyperparamsChanges(
      { METAGRAPH_HEALTH_DB: db },
      { rows: [stagedRow()] },
    );
    assert.equal(result.recorded, true);
  });

  test("returns read_failed when the latest-hash query throws", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => {
            throw new Error("read failed");
          },
        };
      },
    };
    assert.deepEqual(
      await recordSubnetHyperparamsChanges({}, { rows: [stagedRow()], db }),
      {
        recorded: false,
        reason: "read_failed",
      },
    );
  });

  test("returns write_failed when the insert batch throws", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => ({ results: [] }),
        };
      },
      batch: async () => {
        throw new Error("write failed");
      },
    };
    assert.deepEqual(
      await recordSubnetHyperparamsChanges({}, { rows: [stagedRow()], db }),
      {
        recorded: false,
        reason: "write_failed",
      },
    );
  });

  test("returns write_failed when building a statement throws (never propagates to the caller)", async () => {
    // A throw from stmt.bind() itself (not the later db.batch() write) — the
    // "never fail the load" invariant (staging.mjs) depends on this loop
    // catching its own errors, same as the read/write calls around it.
    const db = {
      prepare() {
        return {
          bind() {
            throw new Error("bind failed");
          },
          all: async () => ({ results: [] }),
        };
      },
      batch: async () => {
        throw new Error("should not reach batch");
      },
    };
    assert.deepEqual(
      await recordSubnetHyperparamsChanges({}, { rows: [stagedRow()], db }),
      {
        recorded: false,
        reason: "write_failed",
      },
    );
  });

  test("skips rows without a resolvable netuid", async () => {
    const { db, statements } = fakeDb();
    const result = await recordSubnetHyperparamsChanges(
      {},
      {
        rows: [
          stagedRow({ netuid: "not-a-number" }),
          stagedRow({ netuid: null }),
        ],
        db,
      },
    );
    assert.equal(result.rows, 0);
    assert.equal(
      statements.some((s) => s.sql?.includes("INSERT")),
      false,
    );
  });

  test("reads latest hashes when D1 returns no results array", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => ({}),
        };
      },
      batch: async () => {},
    };
    const result = await recordSubnetHyperparamsChanges(
      {},
      { rows: [stagedRow()], db },
    );
    assert.equal(result.rows, 1);
  });

  test("batches large inserts in chunks of 100", async () => {
    let batches = 0;
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => ({ results: [] }),
        };
      },
      batch: async (chunk) => {
        batches += 1;
        assert.ok(chunk.length > 0 && chunk.length <= 100);
      },
    };
    const rows = Array.from({ length: 101 }, (_, index) =>
      stagedRow({ netuid: index + 1 }),
    );
    const result = await recordSubnetHyperparamsChanges({}, { rows, db });
    assert.equal(result.rows, 101);
    assert.equal(batches, 2);
  });
});

describe("loadSubnetHyperparamsHistory", () => {
  test("paginates with offset when no cursor is provided", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [historyRow()];
    };
    const out = await loadSubnetHyperparamsHistory(d1, 86, {
      limit: 10,
      offset: 5,
    });
    assert.equal(out.entry_count, 1);
    assert.ok(calls[0].sql.includes("OFFSET"));
    assert.equal(out.next_cursor, null);
  });

  test("uses cursor seek and emits next_cursor for a full page", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        historyRow({ id: 9, observed_at: 1_600_000_000_000 }),
        historyRow({ id: 8, observed_at: 1_500_000_000_000 }),
      ];
    };
    const out = await loadSubnetHyperparamsHistory(d1, 86, {
      limit: 2,
      cursor: encodeCursor([1_700_000_000_000, 10]),
    });
    assert.ok(calls[0].sql.includes("(observed_at, id) <"));
    assert.equal(out.next_cursor, encodeCursor([1_500_000_000_000, 8]));
  });

  test("omits next_cursor for a short page or invalid observed_at", async () => {
    const out = await loadSubnetHyperparamsHistory(
      async () => [historyRow({ observed_at: "bad" })],
      86,
      { limit: 10 },
    );
    assert.equal(out.next_cursor, null);
  });
});

const ctx = { waitUntil: (p) => p };

// Stub METAGRAPH_HEALTH_DB whose .all() returns the given rows and records the
// SQL — mirrors hyperparamsEnv in tests/subnet-hyperparams.test.mjs.
function historyEnv(rows, captured = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        captured.sql = sql;
        return {
          bind(...params) {
            captured.params = params;
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
    },
  };
}

describe("GET /api/v1/subnets/{netuid}/hyperparameters/history via the Worker", () => {
  test("returns the change timeline for a warm D1", async () => {
    const captured = {};
    const env = historyEnv([historyRow()], captured);
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/86/hyperparameters/history",
      ),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 86);
    assert.equal(body.data.entry_count, 1);
    assert.equal(body.data.entries[0].hyperparameters.tempo, 360);
    assert.match(captured.sql, /FROM subnet_hyperparams_history/);
  });

  test("is schema-stable when D1 is cold (never 404)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/86/hyperparameters/history",
      ),
      historyEnv([]),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 86);
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  test("an unsupported query param is a 400", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/86/hyperparameters/history?foo=bar",
      ),
      historyEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
