import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  parseHistoryWindow,
  rollupNeuronDaily,
  archiveNeuronDaily,
  archivePrunableNeuronDaily,
  pruneNeuronDaily,
  coldArchiveKey,
  isValidSnapshotDate,
  NEURON_DAILY_RETENTION_DAYS,
  neuronDailyUpsertStatements,
  validNeuronDailyRows,
  buildNeuronHistory,
  buildSubnetHistory,
  HISTORY_WINDOWS,
  MAX_HISTORY_POINTS,
} from "../src/neuron-history.mjs";
import { buildConcentrationHistory } from "../src/concentration.mjs";
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

describe("isValidSnapshotDate", () => {
  test("accepts a YYYY-MM-DD string, rejects everything else", () => {
    assert.equal(isValidSnapshotDate("2026-06-20"), true);
    // Shape-only (real-date/range checks are SQLite's job per the source note),
    // but the format gate must reject obvious junk so it never reaches a query.
    assert.equal(isValidSnapshotDate("2026-6-2"), false); // not zero-padded
    assert.equal(isValidSnapshotDate("06/20/2026"), false); // wrong separators
    assert.equal(isValidSnapshotDate("2026-06-20T00:00:00Z"), false); // datetime
    assert.equal(isValidSnapshotDate(""), false);
    assert.equal(isValidSnapshotDate(20260620), false); // not a string
    assert.equal(isValidSnapshotDate(null), false);
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

  test("reports rows:null when the run result omits meta.changes", async () => {
    // A run() that returns no `.meta.changes` must surface rows:null, exercising
    // the `?? null` fallback rather than leaking undefined.
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return { bind: () => ({ run: () => Promise.resolve({}) }) };
        },
      },
    };
    const res = await rollupNeuronDaily(env, { now: 1 });
    assert.equal(res.rolled, true);
    assert.equal(res.rows, null);
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

  test("buildNeuronHistory defaults window + per-point captured_at/block_number to null", () => {
    // A point row with no captured_at/block_number (sparse / pre-block-tag rows)
    // must still produce a schema-stable point — null, never undefined — and an
    // omitted window option must surface as window:null.
    const out = buildNeuronHistory(
      [dailyRow({ captured_at: undefined })],
      7,
      3,
    );
    assert.equal(out.window, null);
    assert.equal(out.points[0].captured_at, null);
    const sparse = buildNeuronHistory(
      [{ snapshot_date: "2026-06-20", hotkey: "5Hk" }],
      7,
      3,
    );
    assert.equal(sparse.points[0].block_number, null);
  });

  test("buildSubnetHistory defaults window + every aggregate to null on sparse rows", () => {
    const out = buildSubnetHistory([{ snapshot_date: "2026-06-20" }], 7);
    assert.equal(out.window, null);
    assert.equal(out.points[0].neuron_count, null);
    assert.equal(out.points[0].validator_count, null);
    assert.equal(out.points[0].total_stake_tao, null);
    assert.equal(out.points[0].total_emission_tao, null);
  });
});

describe("rollupNeuronDaily idempotency invariant (#1345)", () => {
  test("two consecutive rolls emit byte-identical SQL + an idempotent ON CONFLICT upsert", async () => {
    // The daily rollup must be safe to re-run within a UTC day: identical SQL,
    // a COALESCE-style ON CONFLICT upsert keyed on (netuid,uid,snapshot_date),
    // and the PK columns must never appear in the SET clause (they'd be no-ops
    // at best, a drift risk at worst).
    const seen = [];
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          seen.push(sql);
          return {
            bind: () => ({
              run: () => Promise.resolve({ meta: { changes: 5 } }),
            }),
          };
        },
      },
    };
    await rollupNeuronDaily(env, { now: 1 });
    await rollupNeuronDaily(env, { now: 2 });
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1], "rollup SQL is stable across re-runs");
    assert.match(
      seen[0],
      /ON CONFLICT\(netuid, uid, snapshot_date\) DO UPDATE/,
    );
    assert.doesNotMatch(seen[0], /\bnetuid = excluded/);
    assert.doesNotMatch(seen[0], /\buid = excluded/);
    assert.match(seen[0], /updated_at = excluded\.updated_at/);
  });
});

describe("rollupNeuronDaily stake-column invariant (P7)", () => {
  // The forward rollup copies `neurons` -> `neuron_daily` verbatim, so stake_tao
  // MUST be one of the rolled + upserted columns. The historical backfill
  // (scripts/backfill-neuron-history.py) intentionally deferred per-UID stake to
  // null, which is the documented historical gap — but the FORWARD path must never
  // silently drop stake the way the backfill omits it, or the daily
  // total_stake_tao / stake_gini / stake_nakamoto aggregates go null again. This
  // locks stake_tao into both the INSERT...SELECT projection and the ON CONFLICT
  // SET clause so a future column refactor can't regress it.
  test("rolls stake_tao in the INSERT...SELECT and re-applies it on conflict", async () => {
    let sql = "";
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(s) {
          sql = s;
          return {
            bind: () => ({
              run: () => Promise.resolve({ meta: { changes: 1 } }),
            }),
          };
        },
      },
    };
    await rollupNeuronDaily(env, { now: 1 });
    // Projected from neurons in the INSERT column list...
    assert.match(sql, /INSERT INTO neuron_daily \([^)]*\bstake_tao\b/);
    // ...and carried forward on an intra-day re-run.
    assert.match(sql, /stake_tao = excluded\.stake_tao/);
  });
});

describe("stake aggregates surface when the rolled rows carry stake (P7)", () => {
  // Locks the documented historical behaviour: a day whose neuron_daily rows have
  // a real per-UID stake distribution yields populated total_stake_tao / stake_gini
  // / stake_nakamoto, while a day backfilled with stake_tao = null yields nulls —
  // the exact split observed in production (stake populated from 2026-06-22, the
  // day the forward rollup began carrying it; null before, from the backfill).
  test("buildSubnetHistory: SUM(stake) day -> number, null-stake day -> null", () => {
    const out = buildSubnetHistory(
      [
        // A populated forward-rollup day (SQL SUM(stake_tao) is a number).
        {
          snapshot_date: "2026-06-22",
          neuron_count: 2,
          validator_count: 1,
          total_stake_tao: 150,
          total_emission_tao: 3,
        },
        // A backfilled day: SUM over all-null stake_tao -> SQLite returns NULL.
        {
          snapshot_date: "2026-06-21",
          neuron_count: 2,
          validator_count: 1,
          total_stake_tao: null,
          total_emission_tao: 3,
        },
      ],
      64,
      { window: "30d" },
    );
    assert.equal(out.points[0].total_stake_tao, 150);
    assert.equal(out.points[0].total_emission_tao, 3);
    // The backfilled day keeps emission but nulls stake (the production gap).
    assert.equal(out.points[1].total_stake_tao, null);
    assert.equal(out.points[1].total_emission_tao, 3);
  });

  test("buildConcentrationHistory: stake metrics null on a null-stake day, populated otherwise", () => {
    const out = buildConcentrationHistory(
      [
        // Forward-rollup day: real per-UID stake distribution.
        { snapshot_date: "2026-06-22", stake_tao: 100, emission_tao: 10 },
        { snapshot_date: "2026-06-22", stake_tao: 1, emission_tao: 1 },
        // Backfilled day: stake_tao null, emission present.
        { snapshot_date: "2026-06-21", stake_tao: null, emission_tao: 10 },
        { snapshot_date: "2026-06-21", stake_tao: null, emission_tao: 1 },
      ],
      64,
      { window: "30d" },
    );
    assert.equal(out.points[0].snapshot_date, "2026-06-22");
    assert.equal(typeof out.points[0].stake_gini, "number");
    assert.equal(out.points[0].stake_nakamoto_coefficient, 1);
    assert.equal(typeof out.points[0].stake_top_10pct_share, "number");
    // The backfilled day has no stake distribution -> stake metrics null, but
    // emission metrics still populate (proves it's a stake-data gap, not a builder
    // bug).
    assert.equal(out.points[1].snapshot_date, "2026-06-21");
    assert.equal(out.points[1].stake_gini, null);
    assert.equal(out.points[1].stake_nakamoto_coefficient, null);
    assert.equal(out.points[1].stake_top_10pct_share, null);
    assert.equal(typeof out.points[1].emission_gini, "number");
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

  test("archiveNeuronDaily reports no-data when no day has been rolled yet", async () => {
    // MAX(snapshot_date) returns no row (cold neuron_daily) → no targetDay → the
    // archive must report {archived:false, reason:"no-data"} and never put().
    let putCalled = false;
    const db = {
      prepare() {
        return {
          bind: () => ({ all: () => Promise.resolve({ results: [{}] }) }),
        };
      },
    };
    const bucket = {
      put: () => {
        putCalled = true;
        return Promise.resolve();
      },
    };
    const res = await archiveNeuronDaily({}, { db, bucket });
    assert.equal(res.archived, false);
    assert.equal(res.reason, "no-data");
    assert.equal(putCalled, false);
  });

  test("archiveNeuronDaily tolerates a day-read that returns no results object", async () => {
    // An explicit day + a row read that omits `results` entirely → treated as
    // zero rows → {archived:false, reason:"no-rows"} (the rows ?? [] fallback).
    const db = {
      prepare() {
        return { bind: () => ({ all: () => Promise.resolve({}) }) };
      },
    };
    const res = await archiveNeuronDaily(
      {},
      { day: "2026-06-20", db, bucket: { put: () => Promise.resolve() } },
    );
    assert.equal(res.archived, false);
    assert.equal(res.reason, "no-rows");
    assert.equal(res.day, "2026-06-20");
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

  test("pruneNeuronDaily no-ops without a DB binding (returns no-db, never throws)", async () => {
    assert.deepEqual(await pruneNeuronDaily({}), {
      pruned: false,
      reason: "no-db",
    });
  });

  test("pruneNeuronDaily reports rows:null when the delete omits meta.changes", async () => {
    const db = {
      prepare() {
        return { bind: () => ({ run: () => Promise.resolve({}) }) };
      },
    };
    const res = await pruneNeuronDaily(
      { METAGRAPH_HEALTH_DB: db },
      { now: Date.parse("2026-06-22T00:00:00Z") },
    );
    assert.equal(res.pruned, true);
    assert.equal(res.rows, null);
  });

  test("archivePrunableNeuronDaily defaults rows/subnets to 0 when an archive omits them", async () => {
    // A per-day archive that succeeds but reports neither rows nor subnets must
    // accumulate as 0 (the `?? 0` fallback), keeping the summary numeric.
    const oldDay = "2026-03-20";
    let firstRead = true;
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              all: () => {
                if (sql.includes("DISTINCT snapshot_date")) {
                  return Promise.resolve({ results: [{ day: oldDay }] });
                }
                if (sql.includes("MAX(snapshot_date)")) {
                  return Promise.resolve({ results: [{ day: oldDay }] });
                }
                // The day row-read returns a row (so archive succeeds) but the
                // archive's own counters are exercised via a single subnet row.
                firstRead = false;
                return Promise.resolve({
                  results: [{ netuid: 7, uid: 0, snapshot_date: oldDay }],
                });
              },
            };
          },
        };
      },
    };
    void firstRead;
    const res = await archivePrunableNeuronDaily(
      {},
      {
        db,
        bucket: { put: () => Promise.resolve() },
        now: Date.parse("2026-06-22T00:00:00Z"),
      },
    );
    assert.equal(res.archived, true);
    assert.equal(typeof res.rows, "number");
    assert.equal(typeof res.subnets, "number");
    assert.ok(res.rows >= 1);
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

  test("archive and prune share one now() so a day-boundary tick can't drop an un-archived day", async () => {
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
    // Date.now advances a full day on every call: if the archive and prune each
    // sampled it independently they'd derive retention cutoffs a day apart. The
    // single now pinned in handleScheduled must keep the two cutoffs identical.
    const realNow = Date.now;
    let call = 0;
    Date.now = () =>
      Date.parse("2026-06-21T23:59:59.000Z") + call++ * 86_400_000;
    try {
      const result = await handleScheduled(
        { cron: NEURON_HISTORY_ROLLUP_CRON },
        env,
        ctx,
      );
      assert.equal(result.archivedPrunable.archived, true);
      assert.equal(result.pruned.pruned, true);
      assert.equal(result.pruned.cutoff, result.archivedPrunable.cutoff);
    } finally {
      Date.now = realNow;
    }
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
      { netuid: -1, uid: 1, snapshot_date: "2025-12-01", hotkey: "5Hk" }, // negative netuid
      { netuid: 7, uid: -1, snapshot_date: "2025-12-01", hotkey: "5Hk" }, // negative uid
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
