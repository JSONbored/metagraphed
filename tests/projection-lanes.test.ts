// The projection framework's one hard promise is that a failed compute NEVER
// overwrites a good artifact — so these tests assert the absence of the put
// as sharply as its presence — and the lane computes are asserted as the
// validated-literal R2 SQL that replicates data-api's route semantics.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  PROJECTION_LANES,
  runProjectionLane,
  runProjectionLanes,
  type ProjectionLane,
} from "../src/projection-lanes.ts";
import { CHAIN_TRANSFERS_PROJECTION_KEY } from "../src/chain-transfers-artifact.ts";
import { CHAIN_STAKE_FLOW_PROJECTION_KEY } from "../src/chain-stake-flow-artifact.ts";
import { type Row } from "./row-type.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);

function archiveBucket(opts: { failPut?: boolean } = {}) {
  const puts: { key: string; value: string }[] = [];
  return {
    puts,
    bucket: {
      async put(key: string, value: string) {
        if (opts.failPut) throw new Error("r2 down");
        puts.push({ key, value });
      },
    },
  };
}

function exceptionRecorder() {
  const events: Row[] = [];
  return {
    events,
    record: async (_env: unknown, event: Row) => {
      events.push(event);
      return true;
    },
  };
}

/** R2 SQL transport stub, same shape as the cold-tier suites: one rows-array
 * per successive query (or an HTTP failure when the entry is "fail"). */
function lakeFetch(...responses: (unknown[] | "fail")[]) {
  const queries: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    const entry = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (entry === "fail") {
      return { ok: false, status: 500 } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows: entry ?? [] } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

const LAKE_ENV = { R2_SQL_TOKEN: "cfut_test" };

function laneNamed(name: string): ProjectionLane {
  const lane = PROJECTION_LANES.find((entry) => entry.name === name);
  assert.ok(lane, `lane ${name} must be registered`);
  return lane!;
}

describe("runProjectionLane", () => {
  test("a null compute writes NOTHING and records one routed exception", async () => {
    const { puts, bucket } = archiveBucket();
    const { events, record } = exceptionRecorder();
    const result = await runProjectionLane(
      { METAGRAPH_ARCHIVE: bucket } as unknown as Env,
      {
        name: "test-lane",
        artifactKey: "metagraph/projections/test-lane.json",
        compute: async () => null,
      },
      { recordException: record },
    );
    assert.deepEqual(result, {
      name: "test-lane",
      ok: false,
      rows: null,
      reason: "compute_declined",
    });
    // The hard promise: the previous artifact survives a failed compute.
    assert.equal(puts.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.route, "projection:test-lane");
  });

  test("a non-null compute writes the body to the lane's key", async () => {
    const { puts, bucket } = archiveBucket();
    const body = { schema_version: 1, row_count: 3, windows: {} };
    const result = await runProjectionLane(
      { METAGRAPH_ARCHIVE: bucket } as unknown as Env,
      {
        name: "test-lane",
        artifactKey: "metagraph/projections/test-lane.json",
        compute: async () => body,
      },
    );
    assert.deepEqual(result, { name: "test-lane", ok: true, rows: 3 });
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.key, "metagraph/projections/test-lane.json");
    assert.deepEqual(JSON.parse(puts[0]!.value), body);
  });

  test("a body without a numeric row_count still writes, reporting null rows", async () => {
    const { puts, bucket } = archiveBucket();
    const result = await runProjectionLane(
      { METAGRAPH_ARCHIVE: bucket } as unknown as Env,
      {
        name: "test-lane",
        artifactKey: "metagraph/projections/test-lane.json",
        compute: async () => ({ schema_version: 1 }),
      },
    );
    assert.deepEqual(result, { name: "test-lane", ok: true, rows: null });
    assert.equal(puts.length, 1);
  });

  test("an unbound bucket refuses BEFORE spending compute", async () => {
    let computed = 0;
    for (const env of [{}, null]) {
      const result = await runProjectionLane(env as unknown as Env, {
        name: "test-lane",
        artifactKey: "metagraph/projections/test-lane.json",
        compute: async () => {
          computed += 1;
          return { schema_version: 1 };
        },
      });
      assert.deepEqual(result, {
        name: "test-lane",
        ok: false,
        rows: null,
        reason: "r2_binding_missing",
      });
    }
    assert.equal(computed, 0);
  });

  test("a throwing store records the exception and reports the lane failed", async () => {
    const { puts, bucket } = archiveBucket({ failPut: true });
    const { events, record } = exceptionRecorder();
    const result = await runProjectionLane(
      { METAGRAPH_ARCHIVE: bucket } as unknown as Env,
      {
        name: "test-lane",
        artifactKey: "metagraph/projections/test-lane.json",
        compute: async () => ({ schema_version: 1, row_count: 1 }),
      },
      { recordException: record },
    );
    assert.deepEqual(result, {
      name: "test-lane",
      ok: false,
      rows: null,
      reason: "lane_failed",
    });
    assert.equal(puts.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.route, "projection:test-lane");
  });

  test("a throwing compute takes the same isolated failure path", async () => {
    // Both throw shapes: a real Error and a bare string (the log line's
    // message fallback), since compute is lane-author code, not a contract.
    for (const thrown of [new Error("boom"), "boom-string"]) {
      const { puts, bucket } = archiveBucket();
      const { events, record } = exceptionRecorder();
      const result = await runProjectionLane(
        { METAGRAPH_ARCHIVE: bucket } as unknown as Env,
        {
          name: "test-lane",
          artifactKey: "metagraph/projections/test-lane.json",
          compute: async () => {
            throw thrown;
          },
        },
        { recordException: record },
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason, "lane_failed");
      assert.equal(puts.length, 0);
      assert.equal(events[0]!.route, "projection:test-lane");
    }
  });
});

describe("chain-transfers lane compute", () => {
  test("replicates data-api's five statements per window, windowed from generated_at", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const queries = lakeFetch(
      // 7d: totals, distinct senders, distinct receivers, senders, receivers.
      [
        {
          transfer_count: "12",
          total_volume_tao: "2000",
          newest_observed: NOW - 1000,
        },
      ],
      [{ unique_senders: "5" }],
      [{ unique_receivers: "6" }],
      [{ address: "5A", volume_tao: "600", transfer_count: "7" }],
      [{ address: "5B", volume_tao: "2000", transfer_count: "12" }],
      // 30d: an empty window is a legitimate answer, not a decline.
      [],
      [],
      [],
      [],
      [],
    );
    const body = (await laneNamed("chain-transfers").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 10);
    const cutoff7d = NOW - 7 * DAY_MS;
    const cutoff30d = NOW - 30 * DAY_MS;
    // The totals aggregate, filtered exactly as data-api filters it.
    assert.match(queries[0]!, /FROM chain\.account_events/);
    assert.match(queries[0]!, /event_kind = 'Transfer'/);
    assert.match(queries[0]!, new RegExp(`observed_at >= ${cutoff7d}`));
    assert.match(queries[0]!, /COALESCE\(SUM\(amount_tao\), 0\)/);
    assert.match(queries[0]!, /MAX\(observed_at\) AS newest_observed/);
    // The two DISTINCT counts stay split into their own statements.
    assert.match(queries[1]!, /COUNT\(DISTINCT hotkey\) AS unique_senders/);
    assert.match(queries[2]!, /COUNT\(DISTINCT coldkey\) AS unique_receivers/);
    // Leaderboards: NULL parties excluded, data-api's exact total order,
    // precomputed at the route's maximum limit.
    assert.match(queries[3]!, /hotkey IS NOT NULL/);
    assert.match(queries[3]!, /GROUP BY hotkey/);
    assert.match(queries[3]!, /ORDER BY volume_tao DESC, hotkey ASC/);
    assert.match(queries[3]!, /LIMIT 100/);
    assert.match(queries[4]!, /coldkey IS NOT NULL/);
    assert.match(queries[4]!, /GROUP BY coldkey/);
    assert.match(queries[4]!, /ORDER BY volume_tao DESC, coldkey ASC/);
    // The second window re-anchors to the same generated_at.
    assert.match(queries[5]!, new RegExp(`observed_at >= ${cutoff30d}`));

    assert.equal(body.schema_version, 1);
    assert.equal(body.generated_at, new Date(NOW).toISOString());
    assert.equal(body.row_count, 2);
    const w7 = (body.windows as Row)["7d"] as Row;
    assert.equal(w7.days, 7);
    // The exact totals object data-api hands buildChainTransfers: the
    // single-row aggregate merged with the two DISTINCT counts.
    assert.deepEqual(w7.totals, {
      transfer_count: "12",
      total_volume_tao: "2000",
      newest_observed: NOW - 1000,
      unique_senders: "5",
      unique_receivers: "6",
    });
    assert.deepEqual(w7.senders, [
      { address: "5A", volume_tao: "600", transfer_count: "7" },
    ]);
    const w30 = (body.windows as Row)["30d"] as Row;
    assert.equal(w30.days, 30);
    assert.deepEqual(w30.totals, {
      unique_senders: 0,
      unique_receivers: 0,
    });
  });

  test("one failed statement declines the WHOLE compute — no partial artifact", async () => {
    lakeFetch([], [], "fail");
    const body = await laneNamed("chain-transfers").compute(
      LAKE_ENV as unknown as Env,
    );
    assert.equal(body, null);
  });

  test("a failure in the leaderboard statements declines too", async () => {
    lakeFetch([], [], [], "fail");
    assert.equal(
      await laneNamed("chain-transfers").compute(LAKE_ENV as unknown as Env),
      null,
    );
    lakeFetch([], [], [], [], "fail");
    assert.equal(
      await laneNamed("chain-transfers").compute(LAKE_ENV as unknown as Env),
      null,
    );
    lakeFetch("fail");
    assert.equal(
      await laneNamed("chain-transfers").compute(LAKE_ENV as unknown as Env),
      null,
    );
    lakeFetch([], "fail");
    assert.equal(
      await laneNamed("chain-transfers").compute(LAKE_ENV as unknown as Env),
      null,
    );
  });
});

describe("chain-stake-flow lane compute", () => {
  test("replicates data-api's single GROUP BY aggregate per window", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const ROWS = [
      {
        netuid: 7,
        event_kind: "StakeAdded",
        total_tao: "100",
        event_count: "3",
        last_observed: NOW - 1000,
      },
      {
        netuid: 7,
        event_kind: "StakeRemoved",
        total_tao: "40",
        event_count: "2",
        last_observed: NOW - 2000,
      },
    ];
    const queries = lakeFetch(ROWS, []);
    const body = (await laneNamed("chain-stake-flow").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 2);
    assert.match(queries[0]!, /FROM chain\.account_events/);
    assert.match(queries[0]!, /event_kind IN \('StakeAdded', 'StakeRemoved'\)/);
    assert.match(queries[0]!, new RegExp(`observed_at >= ${NOW - 7 * DAY_MS}`));
    assert.match(queries[0]!, /GROUP BY netuid, event_kind/);
    assert.match(queries[0]!, /COALESCE\(SUM\(amount_tao\), 0\) AS total_tao/);
    assert.match(queries[0]!, /COUNT\(\*\) AS event_count/);
    assert.match(queries[0]!, /MAX\(observed_at\) AS last_observed/);
    assert.match(
      queries[1]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.generated_at, new Date(NOW).toISOString());
    assert.equal(body.row_count, 2);
    // Rows are stored VERBATIM: shaping is the reader-side builder's job.
    assert.deepEqual((body.windows as Row)["7d"], { days: 7, rows: ROWS });
    assert.deepEqual((body.windows as Row)["30d"], { days: 30, rows: [] });
  });

  test("a failed window declines the whole compute", async () => {
    lakeFetch("fail");
    assert.equal(
      await laneNamed("chain-stake-flow").compute(LAKE_ENV as unknown as Env),
      null,
    );
    lakeFetch([], "fail");
    assert.equal(
      await laneNamed("chain-stake-flow").compute(LAKE_ENV as unknown as Env),
      null,
    );
  });
});

describe("runProjectionLanes", () => {
  test("skips quietly when R2 SQL is unconfigured — a deliberate state, not a fault", async () => {
    const { events, record } = exceptionRecorder();
    const result = await runProjectionLanes({} as unknown as Env, {
      recordException: record,
    });
    assert.deepEqual(result, {
      ok: false,
      skipped: true,
      reason: "r2 sql not configured",
      lanes: {},
    });
    assert.equal(events.length, 0);
  });

  test("runs every registered lane and writes both artifacts", async () => {
    lakeFetch([]);
    const { puts, bucket } = archiveBucket();
    const result = await runProjectionLanes({
      ...LAKE_ENV,
      METAGRAPH_ARCHIVE: bucket,
    } as unknown as Env);
    assert.deepEqual(result, {
      ok: true,
      lanes: { "chain-transfers": 0, "chain-stake-flow": 0 },
    });
    assert.deepEqual(
      puts.map((put) => put.key),
      [CHAIN_TRANSFERS_PROJECTION_KEY, CHAIN_STAKE_FLOW_PROJECTION_KEY],
    );
  });

  test("one failed lane never skips the next — failures are isolated", async () => {
    // The transfers lane's statements all filter on the Transfer kind; fail
    // exactly those so the stake-flow lane still sees a healthy engine.
    const { puts, bucket } = archiveBucket();
    const { events, record } = exceptionRecorder();
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const sql = String(JSON.parse(String(init.body)).query);
      if (sql.includes("'Transfer'")) {
        return { ok: false, status: 500 } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await runProjectionLanes(
      { ...LAKE_ENV, METAGRAPH_ARCHIVE: bucket } as unknown as Env,
      { recordException: record },
    );
    assert.deepEqual(result, {
      ok: false,
      lanes: { "chain-transfers": null, "chain-stake-flow": 0 },
    });
    assert.deepEqual(
      puts.map((put) => put.key),
      [CHAIN_STAKE_FLOW_PROJECTION_KEY],
    );
    assert.equal(events[0]!.route, "projection:chain-transfers");
  });
});

describe("lane registry", () => {
  test("every lane's artifact key lives under metagraph/projections/", () => {
    assert.ok(PROJECTION_LANES.length >= 2);
    for (const lane of PROJECTION_LANES) {
      assert.equal(lane.artifactKey, `metagraph/projections/${lane.name}.json`);
    }
  });

  test("the cron constant matches a wrangler schedule", async () => {
    // A constant with no matching wrangler entry never fires at all, and a
    // wrangler entry with no matching constant falls through to the health
    // prober. Both are silent (the lakehouse-seam watchdog's own guard).
    const { readFileSync } = await import("node:fs");
    const { PROJECTION_LANES_CRON } = await import("../workers/config.ts");
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    assert.ok(
      wrangler.includes(`"${PROJECTION_LANES_CRON}"`),
      `wrangler.jsonc declares no "${PROJECTION_LANES_CRON}" cron, so no projection ever recomputes`,
    );
  });
});
