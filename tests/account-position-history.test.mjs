import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  rollupAccountPositionDaily,
  pruneAccountPositionDaily,
  ACCOUNT_POSITION_DAILY_RETENTION_DAYS,
} from "../src/account-position-history.mjs";
import { handleScheduled } from "../workers/api.mjs";
import { NEURON_HISTORY_ROLLUP_CRON } from "../workers/config.mjs";

const ctx = { waitUntil: (p) => p };

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
