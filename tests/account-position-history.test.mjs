import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  rollupAccountPositionDaily,
  pruneAccountPositionDaily,
  ACCOUNT_POSITION_DAILY_RETENTION_DAYS,
  ACCOUNT_POSITION_DAILY_READ_COLUMNS,
  formatAccountPosition,
  buildAccountPositionHistory,
} from "../src/account-position-history.mjs";
import { handleRequest, handleScheduled } from "../workers/api.mjs";
import { NEURON_HISTORY_ROLLUP_CRON } from "../workers/config.mjs";
import { MAX_HISTORY_POINTS } from "../src/neuron-history.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const ctx = { waitUntil: (p) => p };
const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

describe("rollupAccountPositionDaily", () => {
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
    const res = await rollupAccountPositionDaily(env, {
      now: 1_780_000_000_001,
    });
    assert.deepEqual(res, { rolled: true, rows: 42 });
    // One consistent snapshot stamp (WHERE captured_at = MAX), dated in SQL.
    assert.match(captured.sql, /INSERT INTO account_position_daily/);
    assert.match(captured.sql, /hotkey AS account/);
    assert.match(captured.sql, /SELECT MAX\(captured_at\) FROM neurons/);
    assert.match(captured.sql, /date\(captured_at \/ 1000, 'unixepoch'\)/);
    // account is NOT NULL + part of the primary key, but neurons.hotkey is
    // nullable — an unfiltered SELECT would abort the whole INSERT on any one
    // null-hotkey row (see the function's own docstring).
    assert.match(captured.sql, /AND hotkey IS NOT NULL/);
    // Idempotent intra-day re-run.
    assert.match(
      captured.sql,
      /ON CONFLICT\(account, netuid, snapshot_date\) DO UPDATE/,
    );
    assert.deepEqual(captured.params, [1_780_000_000_001]);
  });

  test("no-ops cleanly without a DB binding (cron isolation)", async () => {
    assert.deepEqual(await rollupAccountPositionDaily({}), {
      rolled: false,
      reason: "no-db",
    });
  });

  test("reports rows:null when the run result omits meta.changes", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return { bind: () => ({ run: () => Promise.resolve({}) }) };
        },
      },
    };
    const res = await rollupAccountPositionDaily(env, { now: 1 });
    assert.equal(res.rolled, true);
    assert.equal(res.rows, null);
  });
});

describe("pruneAccountPositionDaily", () => {
  test("deletes below the retention cutoff", async () => {
    let boundCutoff;
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind: (cutoff) => {
              boundCutoff = cutoff;
              return { run: async () => ({ meta: { changes: 7 } }) };
            },
          };
        },
      },
    };
    const now = new Date("2026-07-09T00:00:00.000Z").getTime();
    const res = await pruneAccountPositionDaily(env, { now });
    assert.equal(res.pruned, true);
    assert.equal(res.changes, 7);
    const expectedCutoff = new Date(
      now - ACCOUNT_POSITION_DAILY_RETENTION_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    assert.equal(boundCutoff, expectedCutoff);
    assert.equal(res.cutoff, expectedCutoff);
  });

  test("no-ops cleanly without a DB binding", async () => {
    assert.deepEqual(await pruneAccountPositionDaily({}), {
      pruned: false,
      reason: "no-db",
    });
  });

  test("reports changes:null when the run result omits meta.changes", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return { bind: () => ({ run: () => Promise.resolve({}) }) };
        },
      },
    };
    const res = await pruneAccountPositionDaily(env, { now: 1 });
    assert.equal(res.pruned, true);
    assert.equal(res.changes, null);
  });

  test("returns pruned:false when D1 throws", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind: () => ({
              run: async () => {
                throw new Error("d1 down");
              },
            }),
          };
        },
      },
    };
    const res = await pruneAccountPositionDaily(env, { now: 1 });
    assert.equal(res.pruned, false);
  });
});

describe("handleScheduled rollup cron wiring (#4329/6.1)", () => {
  test("isolates a rollup failure from the rest of the NEURON_HISTORY_ROLLUP_CRON tick", async () => {
    // account_position_daily's INSERT throws; every other statement (neuron_daily's
    // rollup/archive-read/prune) resolves emptily, so the surrounding cron tick
    // completes and the failure stays isolated to accountPositionRolled.
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              run: () => {
                if (sql.includes("account_position_daily")) {
                  return Promise.reject(new Error("d1 down"));
                }
                return Promise.resolve({ meta: { changes: 0 } });
              },
              all: () => Promise.resolve({ results: [] }),
            }),
          };
        },
      },
    };
    const result = await handleScheduled(
      { cron: NEURON_HISTORY_ROLLUP_CRON },
      env,
      ctx,
    );
    assert.equal(result.accountPositionRolled.rolled, false);
  });

  test("rolls up and prunes account_position_daily on the same cron tick", async () => {
    const calls = [];
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          calls.push(sql);
          return {
            bind: () => ({
              run: () => Promise.resolve({ meta: { changes: 3 } }),
              all: () => Promise.resolve({ results: [] }),
            }),
          };
        },
      },
    };
    const result = await handleScheduled(
      { cron: NEURON_HISTORY_ROLLUP_CRON },
      env,
      ctx,
    );
    assert.equal(result.accountPositionRolled.rolled, true);
    assert.equal(result.accountPositionPruned.pruned, true);
    assert.ok(
      calls.some((sql) => sql.includes("INSERT INTO account_position_daily")),
    );
    assert.ok(
      calls.some((sql) => sql.includes("DELETE FROM account_position_daily")),
    );
  });
});

// An ACCOUNT_POSITION_DAILY_READ_COLUMNS-shaped row.
function positionRow(overrides = {}) {
  return {
    snapshot_date: "2026-06-20",
    captured_at: 1_780_000_000_000,
    uid: 3,
    coldkey: "5Cold",
    active: 1,
    validator_permit: 1,
    rank: 0.5,
    trust: 0.9,
    incentive: 0.6,
    dividends: 0.4,
    stake_tao: 456.7,
    emission_tao: 1.23,
    ...overrides,
  };
}

describe("formatAccountPosition", () => {
  test("formats a full row in the same shape as buildAccountPortfolio's positions[]", () => {
    const out = formatAccountPosition(positionRow());
    assert.deepEqual(out, {
      uid: 3,
      coldkey: "5Cold",
      role: "validator",
      active: true,
      stake_tao: 456.7,
      emission_tao: 1.23,
      rank: 0.5,
      trust: 0.9,
      incentive: 0.6,
      dividends: 0.4,
      // round9(emission_tao / stake_tao) = round9(1.23 / 456.7).
      yield: 0.002693234,
    });
  });

  test("returns null for a non-object row", () => {
    assert.equal(formatAccountPosition(null), null);
    assert.equal(formatAccountPosition(undefined), null);
    assert.equal(formatAccountPosition("x"), null);
  });

  test("role is miner when validator_permit does not coerce to 1", () => {
    for (const validator_permit of [0, null, undefined, 2]) {
      const out = formatAccountPosition(positionRow({ validator_permit }));
      assert.equal(out.role, "miner", JSON.stringify(validator_permit));
    }
  });

  test('a numeric-string "1" cell still counts as validator (D1 string coercion)', () => {
    const out = formatAccountPosition(positionRow({ validator_permit: "1" }));
    assert.equal(out.role, "validator");
  });

  test("active coerces D1's 0/1 flag to a boolean", () => {
    assert.equal(
      formatAccountPosition(positionRow({ active: 1 })).active,
      true,
    );
    assert.equal(
      formatAccountPosition(positionRow({ active: 0 })).active,
      false,
    );
    assert.equal(
      formatAccountPosition(positionRow({ active: null })).active,
      false,
    );
  });

  test("yield is null when stake is zero (undefined return, not divide-by-zero)", () => {
    const out = formatAccountPosition(
      positionRow({ stake_tao: 0, emission_tao: 5 }),
    );
    assert.equal(out.yield, null);
  });

  test("score fields are null on an absent/blank cell, not coerced to 0", () => {
    const out = formatAccountPosition(
      positionRow({ rank: null, trust: "", incentive: undefined }),
    );
    assert.equal(out.rank, null);
    assert.equal(out.trust, null);
    assert.equal(out.incentive, null);
  });

  test("score fields are null on a non-numeric, non-blank cell", () => {
    const out = formatAccountPosition(positionRow({ dividends: "garbage" }));
    assert.equal(out.dividends, null);
  });

  test("coldkey is null when absent", () => {
    assert.equal(
      formatAccountPosition(positionRow({ coldkey: null })).coldkey,
      null,
    );
  });

  test("uid is null when missing or negative, not coerced", () => {
    assert.equal(formatAccountPosition(positionRow({ uid: null })).uid, null);
    assert.equal(formatAccountPosition(positionRow({ uid: -1 })).uid, null);
  });

  test("uid tolerates a D1 numeric-string cell", () => {
    assert.equal(formatAccountPosition(positionRow({ uid: "3" })).uid, 3);
    assert.equal(formatAccountPosition(positionRow({ uid: "-1" })).uid, null);
  });

  test("malformed stake/emission cells degrade to 0, not NaN", () => {
    const out = formatAccountPosition(
      positionRow({ stake_tao: "garbage", emission_tao: undefined }),
    );
    assert.equal(out.stake_tao, 0);
    assert.equal(out.emission_tao, 0);
    assert.equal(out.yield, null);
  });
});

describe("buildAccountPositionHistory", () => {
  test("shapes rows into a schema_version-tagged points series", () => {
    const data = buildAccountPositionHistory([positionRow()], SS58, 7, {
      window: "30d",
    });
    assert.equal(data.schema_version, 1);
    assert.equal(data.ss58, SS58);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.point_count, 1);
    assert.equal(data.points[0].snapshot_date, "2026-06-20");
    assert.equal(
      data.points[0].captured_at,
      new Date(1_780_000_000_000).toISOString(),
    );
    assert.equal(data.points[0].uid, 3);
    assert.equal(data.points[0].role, "validator");
    // netuid is NOT repeated per-point — it's the fixed scope of the series.
    assert.equal("netuid" in data.points[0], false);
  });

  test("point_count always matches points.length", () => {
    const data = buildAccountPositionHistory(
      [positionRow(), positionRow({ snapshot_date: "2026-06-21" })],
      SS58,
      7,
      {},
    );
    assert.equal(data.point_count, 2);
    assert.equal(data.points.length, 2);
  });

  test("drops malformed rows instead of throwing", () => {
    const data = buildAccountPositionHistory(
      [positionRow(), null, "garbage", undefined],
      SS58,
      7,
      {},
    );
    assert.equal(data.point_count, 1);
  });

  test("is schema-stable (empty points, not a throw) on null/empty rows", () => {
    for (const rows of [null, undefined, []]) {
      const data = buildAccountPositionHistory(rows, SS58, 7, {});
      assert.deepEqual(data.points, []);
      assert.equal(data.point_count, 0);
    }
  });

  test("window defaults to null when omitted", () => {
    const data = buildAccountPositionHistory([], SS58, 7, {});
    assert.equal(data.window, null);
  });

  test("captured_at is null for a missing/non-finite/non-positive value", () => {
    for (const captured_at of [null, undefined, "garbage", NaN, 0, -5]) {
      const data = buildAccountPositionHistory(
        [positionRow({ captured_at })],
        SS58,
        7,
        {},
      );
      assert.equal(
        data.points[0].captured_at,
        null,
        JSON.stringify(captured_at),
      );
    }
  });

  test("captured_at is null for a finite ms value outside the Date-representable range", () => {
    const data = buildAccountPositionHistory(
      [positionRow({ captured_at: 8.7e15 })],
      SS58,
      7,
      {},
    );
    assert.equal(data.points[0].captured_at, null);
  });
});

// Stub METAGRAPH_HEALTH_DB whose .all() returns the given rows and records the SQL.
function positionHistoryEnv(rows, captured = {}) {
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

describe("GET /accounts/{ss58}/subnets/{netuid}/history via the Worker dispatch", () => {
  test("returns a 200 series + applies a date cutoff", async () => {
    const captured = {};
    const env = positionHistoryEnv([positionRow()], captured);
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history?window=7d`,
      ),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.points[0].snapshot_date, "2026-06-20");
    assert.match(
      captured.sql,
      /FROM account_position_daily WHERE account = \? AND netuid = \?/,
    );
    assert.match(captured.sql, /snapshot_date >= \?/);
    assert.deepEqual(captured.params.slice(0, 2), [SS58, 7]);
    assert.ok(captured.params.includes(MAX_HISTORY_POINTS));
    assert.match(res.headers.get("content-type"), /^application\/json/);
  });

  test("uses ACCOUNT_POSITION_DAILY_READ_COLUMNS in the SELECT list", async () => {
    const captured = {};
    await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history`,
      ),
      positionHistoryEnv([], captured),
      ctx,
    );
    assert.match(
      captured.sql,
      new RegExp(`SELECT ${ACCOUNT_POSITION_DAILY_READ_COLUMNS}`),
    );
  });

  test("an unsupported ?window is a 400, never a silent coerce", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history?window=400d`,
      ),
      positionHistoryEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "window");
  });

  test("?window=all omits the cutoff (full history, still bounded by the row cap)", async () => {
    const captured = {};
    await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history?window=all`,
      ),
      positionHistoryEnv([positionRow()], captured),
      ctx,
    );
    assert.doesNotMatch(captured.sql, /snapshot_date >= \?/);
    assert.ok(captured.params.includes(MAX_HISTORY_POINTS));
  });

  test("cold/absent store returns 200 with empty points, never 404", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history`,
      ),
      positionHistoryEnv([]),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.points, []);
    assert.equal(body.data.point_count, 0);
  });

  test("an unrecognized query param is rejected", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history?bogus=1`,
      ),
      positionHistoryEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("meta.generated_at reflects the newest point's captured_at", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history`,
      ),
      positionHistoryEnv([positionRow()]),
      ctx,
    );
    const body = await res.json();
    assert.equal(
      body.meta.generated_at,
      new Date(1_780_000_000_000).toISOString(),
    );
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("meta.generated_at is null when the store is cold", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history`,
      ),
      positionHistoryEnv([]),
      ctx,
    );
    const body = await res.json();
    assert.equal(body.meta.generated_at, null);
  });

  test("an invalid ss58 in the path 404s (no route match)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/not-a-valid-address/subnets/7/history",
      ),
      positionHistoryEnv([]),
      ctx,
    );
    assert.equal(res.status, 404);
  });
});
