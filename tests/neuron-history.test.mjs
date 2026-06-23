import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  parseHistoryWindow,
  rollupNeuronDaily,
  archiveNeuronDaily,
  archivePrunableNeuronDaily,
  pruneNeuronDaily,
  coldArchiveKey,
  NEURON_DAILY_RETENTION_DAYS,
  neuronDailyUpsertStatements,
  validNeuronDailyRows,
  buildNeuronHistory,
  buildSubnetHistory,
  HISTORY_WINDOWS,
  MAX_HISTORY_POINTS,
} from "../src/neuron-history.mjs";
import { handleRequest, handleScheduled } from "../workers/api.mjs";
import { NEURON_HISTORY_ROLLUP_CRON } from "../workers/config.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// A neuron_daily read row (NEURON_DAILY_READ_COLUMNS shape: snapshot_date + the
// live neuron columns) — formatNeuron consumes the same fields.
function dailyRow(overrides = {}) {
  return {
    snapshot_date: "2026-06-20",
    uid: 3,
    hotkey: "5Hot",
    coldkey: "5Cold",
    active: 1,
    validator_permit: 1,
    rank: 0.5,
    trust: 0.9,
    validator_trust: 0.8,
    consensus: 0.7,
    incentive: 0.6,
    dividends: 0.4,
    emission_tao: 1.23,
    stake_tao: 456.7,
    registered_at_block: 100,
    is_immunity_period: 0,
    axon: "1.2.3.4:9000",
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

// Stub METAGRAPH_HEALTH_DB whose .all() returns the given rows and records the SQL.
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

const ctx = { waitUntil: (p) => p };

describe("parseHistoryWindow", () => {
  test("accepts the documented windows + defaults", () => {
    assert.deepEqual(parseHistoryWindow("7d"), { label: "7d", days: 7 });
    assert.deepEqual(parseHistoryWindow("1y"), { label: "1y", days: 365 });
    assert.deepEqual(parseHistoryWindow("all"), { label: "all", days: null });
    // Missing → the default window, not an error.
    assert.equal(parseHistoryWindow(undefined).label, "30d");
  });
  test("rejects an unsupported window (NOT silently coerced like analyticsWindow)", () => {
    assert.deepEqual(parseHistoryWindow("400d").error, {
      parameter: "window",
      message: "window must be one of: 7d, 30d, 90d, 1y, all",
    });
    assert.equal(parseHistoryWindow("bogus").error.parameter, "window");
  });
  test("every window is bounded under MAX_HISTORY_POINTS", () => {
    for (const days of Object.values(HISTORY_WINDOWS)) {
      if (days != null) assert.ok(days <= MAX_HISTORY_POINTS);
    }
  });
});

describe("rollupNeuronDaily", () => {
  test("issues a single INSERT...SELECT with a consistent captured_at snapshot + idempotent upsert", async () => {
    const captured = {};
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          captured.sql = sql;
          return {
            bind(...params) {
              captured.params = params;
              return { run: () => Promise.resolve({ meta: { changes: 42 } }) };
            },
          };
        },
      },
    };
    const res = await rollupNeuronDaily(env, { now: 1_780_000_000_001 });
    assert.deepEqual(res, { rolled: true, rows: 42 });
    // One consistent snapshot stamp (WHERE captured_at = MAX), dated in SQL.
    assert.match(captured.sql, /INSERT INTO neuron_daily/);
    assert.match(captured.sql, /SELECT MAX\(captured_at\) FROM neurons/);
    assert.match(captured.sql, /date\(captured_at \/ 1000, 'unixepoch'\)/);
    // Idempotent intra-day re-run.
    assert.match(
      captured.sql,
      /ON CONFLICT\(netuid, uid, snapshot_date\) DO UPDATE/,
    );
    assert.deepEqual(captured.params, [1_780_000_000_001]);
  });
  test("no-ops cleanly without a DB binding (cron isolation)", async () => {
    assert.deepEqual(await rollupNeuronDaily({}), {
      rolled: false,
      reason: "no-db",
    });
  });
});

describe("history builders", () => {
  test("buildNeuronHistory shapes a per-UID series (live-shaped points + date)", () => {
    const out = buildNeuronHistory([dailyRow()], 7, 3, { window: "30d" });
    assert.equal(out.netuid, 7);
    assert.equal(out.uid, 3);
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 1);
    assert.equal(out.points[0].snapshot_date, "2026-06-20");
    assert.equal(out.points[0].stake_tao, 456.7);
    assert.equal(out.points[0].validator_permit, true); // formatNeuron coerces 0/1
  });
  test("buildSubnetHistory shapes per-day aggregates", () => {
    const out = buildSubnetHistory(
      [
        {
          snapshot_date: "2026-06-20",
          neuron_count: 256,
          validator_count: 64,
          total_stake_tao: 1000,
          total_emission_tao: 12.3,
        },
      ],
      7,
      { window: "90d" },
    );
    assert.equal(out.point_count, 1);
    assert.equal(out.points[0].neuron_count, 256);
    assert.equal(out.points[0].validator_count, 64);
  });
});

describe("history endpoints (via the Worker dispatch)", () => {
  test("GET /subnets/{n}/neurons/{u}/history returns a 200 series + applies a date cutoff", async () => {
    const captured = {};
    const env = historyEnv([dailyRow()], captured);
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/neurons/3/history?window=7d",
      ),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.uid, 3);
    assert.equal(body.data.points[0].snapshot_date, "2026-06-20");
    // A bounded window binds a snapshot_date cutoff + the row cap.
    assert.match(
      captured.sql,
      /FROM neuron_daily WHERE netuid = \? AND uid = \?/,
    );
    assert.match(captured.sql, /snapshot_date >= \?/);
    assert.ok(captured.params.includes(MAX_HISTORY_POINTS));
  });
  test("an unsupported ?window is a 400, never a silent coerce", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/neurons/3/history?window=400d",
      ),
      historyEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(
      body.error.message,
      "window must be one of: 7d, 30d, 90d, 1y, all",
    );
    assert.equal(body.meta.parameter, "window");
  });
  test("GET /subnets/{n}/history returns per-day aggregates", async () => {
    const env = historyEnv([
      {
        snapshot_date: "2026-06-20",
        neuron_count: 256,
        validator_count: 64,
        total_stake_tao: 1000,
        total_emission_tao: 12.3,
      },
    ]);
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/history?window=90d",
      ),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.points[0].neuron_count, 256);
  });
  test("?window=all omits the cutoff (full history, still bounded by the row cap)", async () => {
    const captured = {};
    const env = historyEnv([dailyRow()], captured);
    await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/neurons/3/history?window=all",
      ),
      env,
      ctx,
    );
    assert.doesNotMatch(captured.sql, /snapshot_date >= \?/);
    assert.ok(captured.params.includes(MAX_HISTORY_POINTS));
  });
});

describe("R2 cold archive + prune (PR-A2)", () => {
  test("archiveNeuronDaily writes one immutable gzip object per subnet under the cold key", async () => {
    const day = "2026-06-20";
    const rows = [
      { netuid: 7, uid: 0, snapshot_date: day, stake_tao: 1 },
      { netuid: 7, uid: 1, snapshot_date: day, stake_tao: 2 },
      { netuid: 12, uid: 0, snapshot_date: day, stake_tao: 3 },
    ];
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              all: () =>
                Promise.resolve({
                  results: sql.includes("MAX(snapshot_date)")
                    ? [{ day }]
                    : rows,
                }),
            };
          },
        };
      },
    };
    const puts = [];
    const bucket = {
      put: (key, body, opts) => {
        puts.push({ key, opts, size: body.byteLength });
        return Promise.resolve();
      },
    };
    const res = await archiveNeuronDaily({}, { db, bucket });
    assert.equal(res.archived, true);
    assert.equal(res.day, day);
    assert.equal(res.subnets, 2); // netuid 7 + 12 → one object each
    assert.equal(res.rows, 3);
    assert.deepEqual(
      puts.map((p) => p.key).sort(),
      [coldArchiveKey(7, day), coldArchiveKey(12, day)].sort(),
    );
    assert.equal(puts[0].opts.httpMetadata.contentEncoding, "gzip");
    assert.match(puts[0].opts.httpMetadata.cacheControl, /immutable/);
    assert.ok(puts[0].size > 0, "gzip body is non-empty");
  });

  test("archiveNeuronDaily no-ops without bindings", async () => {
    assert.equal((await archiveNeuronDaily({})).archived, false);
  });

  test("archivePrunableNeuronDaily archives every day older than the retention cutoff before prune", async () => {
    const oldDay = "2026-03-20";
    const newerOldDay = "2026-03-21";
    const latestDay = "2026-06-21";
    const rowsByDay = new Map([
      [oldDay, [{ netuid: 7, uid: 0, snapshot_date: oldDay, stake_tao: 1 }]],
      [
        newerOldDay,
        [{ netuid: 8, uid: 0, snapshot_date: newerOldDay, stake_tao: 2 }],
      ],
      [
        latestDay,
        [{ netuid: 9, uid: 0, snapshot_date: latestDay, stake_tao: 3 }],
      ],
    ]);
    const db = {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              all: () => {
                if (sql.includes("DISTINCT snapshot_date")) {
                  return Promise.resolve({
                    results: [{ day: oldDay }, { day: newerOldDay }],
                  });
                }
                return Promise.resolve({
                  results: rowsByDay.get(params[0]) ?? [],
                });
              },
            };
          },
        };
      },
    };
    const puts = [];
    const bucket = {
      put: (key) => {
        puts.push(key);
        return Promise.resolve();
      },
    };
    const now = Date.parse("2026-06-22T00:00:00Z");

    const res = await archivePrunableNeuronDaily({}, { db, bucket, now });

    assert.equal(res.archived, true);
    assert.deepEqual(res.days, [oldDay, newerOldDay]);
    assert.equal(res.rows, 2);
    assert.deepEqual(
      puts.sort(),
      [coldArchiveKey(7, oldDay), coldArchiveKey(8, newerOldDay)].sort(),
    );
    assert.equal(puts.includes(coldArchiveKey(9, latestDay)), false);
  });

  test("archivePrunableNeuronDaily no-ops without bindings", async () => {
    assert.deepEqual(await archivePrunableNeuronDaily({}), {
      archived: false,
      reason: "no-binding",
    });
  });

  test("archivePrunableNeuronDaily tolerates a DISTINCT query with no results", async () => {
    const db = {
      prepare() {
        return { bind: () => ({ all: () => Promise.resolve({}) }) };
      },
    };
    const bucket = { put: () => Promise.resolve() };
    const res = await archivePrunableNeuronDaily({}, { db, bucket });
    assert.equal(res.archived, true);
    assert.deepEqual(res.days, []);
    assert.equal(res.rows, 0);
    assert.equal(res.subnets, 0);
  });

  test("archivePrunableNeuronDaily stops and reports the first day that fails to archive", async () => {
    const emptyDay = "2026-03-19";
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              all: () => {
                if (sql.includes("DISTINCT snapshot_date")) {
                  return Promise.resolve({ results: [{ day: emptyDay }] });
                }
                // The per-day archive read finds no rows → archiveNeuronDaily
                // returns {archived:false} and the loop bails out.
                return Promise.resolve({ results: [] });
              },
            };
          },
        };
      },
    };
    const bucket = { put: () => Promise.resolve() };
    const now = Date.parse("2026-06-22T00:00:00Z");
    const res = await archivePrunableNeuronDaily({}, { db, bucket, now });
    assert.equal(res.archived, false);
    assert.equal(res.reason, "archive-failed");
    assert.equal(res.day, emptyDay);
    assert.deepEqual(res.days, []);
    assert.equal(res.failed.archived, false);
  });

  test("pruneNeuronDaily deletes below the 90-day retention cutoff", async () => {
    const cap = {};
    const db = {
      prepare(sql) {
        cap.sql = sql;
        return {
          bind(...p) {
            cap.params = p;
            return { run: () => Promise.resolve({ meta: { changes: 5 } }) };
          },
        };
      },
    };
    const now = Date.parse("2026-06-22T00:00:00Z");
    const res = await pruneNeuronDaily({ METAGRAPH_HEALTH_DB: db }, { now });
    assert.equal(res.pruned, true);
    assert.equal(res.rows, 5);
    assert.match(cap.sql, /DELETE FROM neuron_daily WHERE snapshot_date < \?/);
    const expectedCutoff = new Date(
      now - NEURON_DAILY_RETENTION_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    assert.deepEqual(cap.params, [expectedCutoff]);
  });

  test("retention window covers a rolling 1-year history (>= 365 days)", () => {
    assert.ok(
      NEURON_DAILY_RETENTION_DAYS >= 365,
      "1y window must stay D1-served",
    );
  });
});

describe("handleScheduled rollup cron (#1345)", () => {
  test("gates the prune on archive-not-confirmed when bindings are missing", async () => {
    // Empty env → rollup/archive/archivePrunable all fail-soft, so the prune is
    // skipped with the archive-not-confirmed gate.
    const result = await handleScheduled(
      { cron: NEURON_HISTORY_ROLLUP_CRON },
      {},
      ctx,
    );
    assert.equal(result.archived.archived, false);
    assert.equal(result.archivedPrunable.archived, false);
    assert.deepEqual(result.pruned, {
      pruned: false,
      reason: "archive-not-confirmed",
    });
  });

  test("prunes once the latest-day and backlog archives both confirm", async () => {
    const latestDay = "2026-06-21";
    let deleted = false;
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              run: () => {
                if (sql.startsWith("DELETE")) deleted = true;
                return Promise.resolve({ meta: { changes: 1 } });
              },
              all: () => {
                if (sql.includes("MAX(snapshot_date)")) {
                  return Promise.resolve({ results: [{ day: latestDay }] });
                }
                if (sql.includes("DISTINCT snapshot_date")) {
                  // No prunable backlog → archivePrunable confirms trivially.
                  return Promise.resolve({ results: [] });
                }
                // The latest-day archive read.
                return Promise.resolve({
                  results: [
                    {
                      netuid: 7,
                      uid: 0,
                      snapshot_date: latestDay,
                      stake_tao: 1,
                    },
                  ],
                });
              },
            };
          },
        };
      },
    };
    const env = {
      METAGRAPH_HEALTH_DB: db,
      METAGRAPH_ARCHIVE: { put: () => Promise.resolve() },
    };
    const result = await handleScheduled(
      { cron: NEURON_HISTORY_ROLLUP_CRON },
      env,
      ctx,
    );
    assert.equal(result.archived.archived, true);
    assert.equal(result.archivedPrunable.archived, true);
    assert.equal(result.pruned.pruned, true);
    assert.equal(deleted, true);
  });

  test("isolates a rejected backlog archive and skips the gated prune", async () => {
    const latestDay = "2026-06-21";
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              run: () => Promise.resolve({ meta: { changes: 1 } }),
              all: () => {
                if (sql.includes("MAX(snapshot_date)")) {
                  return Promise.resolve({ results: [{ day: latestDay }] });
                }
                // archivePrunableNeuronDaily's DISTINCT-days query throws → the
                // whole call rejects and its .catch fallback fires.
                if (sql.includes("DISTINCT snapshot_date")) {
                  return Promise.reject(new Error("backlog query down"));
                }
                return Promise.resolve({
                  results: [
                    {
                      netuid: 7,
                      uid: 0,
                      snapshot_date: latestDay,
                      stake_tao: 1,
                    },
                  ],
                });
              },
            };
          },
        };
      },
    };
    const env = {
      METAGRAPH_HEALTH_DB: db,
      METAGRAPH_ARCHIVE: { put: () => Promise.resolve() },
    };
    const result = await handleScheduled(
      { cron: NEURON_HISTORY_ROLLUP_CRON },
      env,
      ctx,
    );
    assert.equal(result.archived.archived, true);
    assert.equal(result.archivedPrunable.archived, false);
    assert.deepEqual(result.pruned, {
      pruned: false,
      reason: "archive-not-confirmed",
    });
  });

  test("isolates a rejected prune after both archives confirm", async () => {
    const latestDay = "2026-06-21";
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              run: () => {
                // The gated DELETE prune throws → its .catch fallback fires.
                if (sql.startsWith("DELETE")) {
                  return Promise.reject(new Error("prune down"));
                }
                return Promise.resolve({ meta: { changes: 1 } });
              },
              all: () => {
                if (sql.includes("MAX(snapshot_date)")) {
                  return Promise.resolve({ results: [{ day: latestDay }] });
                }
                if (sql.includes("DISTINCT snapshot_date")) {
                  return Promise.resolve({ results: [] });
                }
                return Promise.resolve({
                  results: [
                    {
                      netuid: 7,
                      uid: 0,
                      snapshot_date: latestDay,
                      stake_tao: 1,
                    },
                  ],
                });
              },
            };
          },
        };
      },
    };
    const env = {
      METAGRAPH_HEALTH_DB: db,
      METAGRAPH_ARCHIVE: { put: () => Promise.resolve() },
    };
    const result = await handleScheduled(
      { cron: NEURON_HISTORY_ROLLUP_CRON },
      env,
      ctx,
    );
    assert.equal(result.archived.archived, true);
    assert.equal(result.archivedPrunable.archived, true);
    assert.deepEqual(result.pruned, { pruned: false });
  });
});

describe("backfill ingest helpers (#1345 Phase 1)", () => {
  test("validNeuronDailyRows keeps well-formed rows, drops the rest", () => {
    const good = {
      netuid: 7,
      uid: 1,
      snapshot_date: "2025-12-01",
      hotkey: "5Hk",
    };
    const rows = validNeuronDailyRows([
      good,
      { netuid: 7, uid: 2, snapshot_date: "2025-12-01" }, // no hotkey
      { netuid: 7, uid: 3, snapshot_date: "bad", hotkey: "5Hk" }, // bad date
      { netuid: 7, uid: "x", snapshot_date: "2025-12-01", hotkey: "5Hk" }, // uid not int
      { uid: 4, snapshot_date: "2025-12-01", hotkey: "5Hk" }, // no netuid
      { netuid: 7, uid: 5, snapshot_date: "2025-12-01", hotkey: "" }, // empty hotkey
    ]);
    assert.deepEqual(rows, [good]);
    assert.deepEqual(validNeuronDailyRows("nope"), []);
  });

  test("neuronDailyUpsertStatements upserts with the rollup column set + ON CONFLICT", () => {
    const cap = [];
    const db = {
      prepare(sql) {
        return {
          bind(...v) {
            cap.push({ sql, v });
            return { sql, v };
          },
        };
      },
    };
    const now = 1700000000000;
    const stmts = neuronDailyUpsertStatements(
      db,
      [{ netuid: 7, uid: 1, snapshot_date: "2025-12-01", hotkey: "5Hk" }],
      { now },
    );
    assert.equal(stmts.length, 1);
    const { sql, v } = cap[0];
    assert.match(sql, /INSERT INTO neuron_daily/);
    assert.match(sql, /snapshot_date/);
    assert.match(
      sql,
      /ON CONFLICT\(netuid, uid, snapshot_date\) DO UPDATE SET/,
    );
    assert.doesNotMatch(sql, /netuid = excluded/); // PK columns never in SET
    assert.doesNotMatch(sql, /uid = excluded/);
    assert.match(sql, /updated_at = excluded\.updated_at/);
    // updated_at (now) is the last bound param; missing fields bind as null.
    assert.equal(v[v.length - 1], now);
    assert.ok(v.includes("5Hk") && v.includes("2025-12-01"));
    assert.ok(v.includes(null)); // unspecified columns → null, not undefined
  });
});
