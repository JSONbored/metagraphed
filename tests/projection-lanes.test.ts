// The projection framework's one hard promise is that a failed compute NEVER
// overwrites a good artifact — so these tests assert the absence of the put
// as sharply as its presence — and the lane computes are asserted as the
// validated-literal R2 SQL that replicates data-api's route semantics.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  PROJECTION_LANES,
  STAKE_FLOW_PROJECTION_WINDOWS,
  runProjectionLane,
  runProjectionLanes,
  type ProjectionLane,
} from "../src/projection-lanes.ts";
import { CHAIN_TRANSFERS_PROJECTION_KEY } from "../src/chain-transfers-artifact.ts";
import { CHAIN_TRANSFER_PAIRS_PROJECTION_KEY } from "../src/chain-transfer-pairs-artifact.ts";
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
    // One query per PROJECTED window -- the union of the chain route's set and
    // the per-subnet route's, since both are served from this one artifact.
    // Asserted against the constant, not a literal, so widening either route's
    // windows cannot silently leave a window uncomputed.
    assert.equal(
      queries.length,
      Object.keys(STAKE_FLOW_PROJECTION_WINDOWS).length,
    );
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
    // 90d exists for the per-subnet route even though the chain reader gates
    // it out of its own window set.
    assert.deepEqual((body.windows as Row)["90d"], { days: 90, rows: [] });
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

// The UTC epoch-day of the fake NOW, the integer the day lanes GROUP BY.
const NOW_DAY = Math.floor(NOW / DAY_MS);

describe("chain-activity lane compute", () => {
  test("replicates data-api's four statements per window over the epoch-day grouping", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const queries = lakeFetch(
      // 7d: extrinsic base, per-day distinct signers, blocks, freshness.
      [
        {
          day_index: NOW_DAY,
          extrinsic_count: "100",
          successful_extrinsics: "97",
        },
        {
          day_index: NOW_DAY - 1,
          extrinsic_count: "50",
          successful_extrinsics: "50",
        },
      ],
      // The older day is missing here on purpose: data-api's merge defaults
      // an unmatched day's unique_signers to 0, and so must this one.
      [{ day_index: NOW_DAY, unique_signers: "9" }],
      [{ day_index: NOW_DAY, block_count: "7200", event_count: "40000" }],
      [{ newest_observed: NOW - 1000 }],
      // 30d: an empty window is a legitimate answer, not a decline.
      [],
      [],
      [],
      [],
    );
    const body = (await laneNamed("chain-activity").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 8);
    const cutoff7d = NOW - 7 * DAY_MS;
    // The base aggregate: UTC epoch-day buckets over the extrinsics table,
    // with data-api's success CASE in the cold tier's proven boolean form.
    assert.match(queries[0]!, /FROM chain\.extrinsics/);
    assert.match(queries[0]!, new RegExp(`observed_at >= ${cutoff7d}`));
    assert.match(queries[0]!, /observed_at \/ 86400000 AS day_index/);
    assert.match(
      queries[0]!,
      /SUM\(CASE WHEN success = TRUE THEN 1 ELSE 0 END\) AS successful_extrinsics/,
    );
    assert.match(queries[0]!, /GROUP BY day_index/);
    // The per-day DISTINCT signer count stays split into its own statement.
    assert.match(queries[1]!, /COUNT\(DISTINCT signer\) AS unique_signers/);
    // The blocks aggregate and the blocks freshness read.
    assert.match(queries[2]!, /FROM chain\.blocks/);
    assert.match(queries[2]!, /SUM\(event_count\) AS event_count/);
    assert.match(queries[3]!, /MAX\(observed_at\) AS newest_observed/);
    assert.match(queries[3]!, /FROM chain\.blocks/);
    // The second window re-anchors to the same generated_at.
    assert.match(
      queries[4]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.generated_at, new Date(NOW).toISOString());
    assert.equal(body.row_count, 3);
    const w7 = (body.windows as Row)["7d"] as Row;
    assert.equal(w7.days, 7);
    // Day indexes rendered as data-api's 'YYYY-MM-DD' labels, DISTINCT
    // signer counts merged in with the unmatched day defaulting to 0.
    assert.deepEqual(w7.extrinsic_rows, [
      {
        day: "2026-08-02",
        extrinsic_count: "100",
        successful_extrinsics: "97",
        unique_signers: "9",
      },
      {
        day: "2026-08-01",
        extrinsic_count: "50",
        successful_extrinsics: "50",
        unique_signers: 0,
      },
    ]);
    assert.deepEqual(w7.block_rows, [
      { day: "2026-08-02", block_count: "7200", event_count: "40000" },
    ]);
    assert.equal(w7.newest_observed, NOW - 1000);
    const w30 = (body.windows as Row)["30d"] as Row;
    assert.deepEqual(w30, {
      days: 30,
      extrinsic_rows: [],
      block_rows: [],
      newest_observed: null,
    });
  });

  test("one failed statement declines the WHOLE compute — no partial artifact", async () => {
    for (const responses of [
      ["fail"],
      [[], "fail"],
      [[], [], "fail"],
      [[], [], [], "fail"],
    ] as ("fail" | unknown[])[][]) {
      lakeFetch(...responses);
      assert.equal(
        await laneNamed("chain-activity").compute(LAKE_ENV as unknown as Env),
        null,
      );
    }
  });

  test("an unrenderable day index declines rather than mislabeling a day", async () => {
    // In the extrinsic rows...
    lakeFetch([{ day_index: "bogus", extrinsic_count: "1" }], [], [], []);
    assert.equal(
      await laneNamed("chain-activity").compute(LAKE_ENV as unknown as Env),
      null,
    );
    // ...and in the block rows.
    lakeFetch([], [], [{ day_index: -5, block_count: "1" }], []);
    assert.equal(
      await laneNamed("chain-activity").compute(LAKE_ENV as unknown as Env),
      null,
    );
  });
});

describe("chain-calls lane compute", () => {
  test("replicates data-api's statements per window, both group_by variants at the max limit", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const queries = lakeFetch(
      // 7d: freshness, module rows, module_function rows, total.
      [{ newest_observed: NOW - 500 }],
      [{ call_module: "Balances", count: "120" }],
      [
        {
          call_module: "Balances",
          call_function: "transfer_keep_alive",
          count: "90",
        },
      ],
      [{ total: "200" }],
      // 30d.
      [],
      [],
      [],
      [],
    );
    const body = (await laneNamed("chain-calls").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 8);
    const cutoff7d = NOW - 7 * DAY_MS;
    assert.match(queries[0]!, /MAX\(observed_at\) AS newest_observed/);
    assert.match(queries[0]!, new RegExp(`observed_at >= ${cutoff7d}`));
    // Both groupings: NULL modules excluded, data-api's exact total order,
    // precomputed at the route's maximum limit.
    assert.match(queries[1]!, /FROM chain\.extrinsics/);
    assert.match(queries[1]!, /call_module IS NOT NULL/);
    assert.match(
      queries[1]!,
      /GROUP BY call_module ORDER BY count DESC, call_module ASC/,
    );
    assert.match(queries[1]!, /LIMIT 100/);
    assert.match(queries[2]!, /GROUP BY call_module, call_function/);
    assert.match(
      queries[2]!,
      /ORDER BY count DESC, call_module ASC, call_function ASC/,
    );
    // The share denominator: full-window, no module filter, pre-LIMIT.
    assert.match(
      queries[3]!,
      /SELECT COUNT\(\*\) AS total FROM chain\.extrinsics/,
    );
    assert.doesNotMatch(queries[3]!, /call_module/);
    assert.match(
      queries[4]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 2);
    const w7 = (body.windows as Row)["7d"] as Row;
    assert.equal(w7.days, 7);
    assert.equal(w7.newest_observed, NOW - 500);
    assert.equal(w7.total, "200");
    assert.deepEqual((w7.groups as Row).module, [
      { call_module: "Balances", count: "120" },
    ]);
    assert.deepEqual((w7.groups as Row).module_function, [
      {
        call_module: "Balances",
        call_function: "transfer_keep_alive",
        count: "90",
      },
    ]);
    const w30 = (body.windows as Row)["30d"] as Row;
    assert.equal(w30.total, 0);
    assert.equal(w30.newest_observed, null);
  });

  test("one failed statement declines the WHOLE compute — no partial artifact", async () => {
    for (const responses of [
      ["fail"],
      [[], "fail"],
      [[], [], "fail"],
      [[], [], [], "fail"],
    ] as ("fail" | unknown[])[][]) {
      lakeFetch(...responses);
      assert.equal(
        await laneNamed("chain-calls").compute(LAKE_ENV as unknown as Env),
        null,
      );
    }
  });
});

describe("chain-fees lane compute", () => {
  test("replicates data-api's fee series, payers at the max limit, and EXACT medians", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const queries = lakeFetch(
      // 7d: daily, payers, fee medians, tip medians, freshness.
      [
        {
          day_index: NOW_DAY,
          extrinsic_count: "100",
          signed_extrinsic_count: "80",
          total_fee_tao: "1.6",
          total_tip_tao: "0.4",
        },
      ],
      [
        {
          signer: "5F",
          total_fee_tao: "0.6",
          total_tip_tao: "0.2",
          extrinsic_count: "10",
        },
      ],
      [
        { day_index: NOW_DAY, median_value: 0.005 },
        { day_index: NOW_DAY - 1, median_value: 0.004 },
      ],
      [
        { day_index: NOW_DAY, median_value: 0.001 },
        // A tip-only day: its fee median never existed (all fees NULL).
        { day_index: NOW_DAY - 2, median_value: 0.002 },
      ],
      [{ newest_observed: NOW - 2000 }],
      // 30d.
      [],
      [],
      [],
      [],
      [],
    );
    const body = (await laneNamed("chain-fees").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 10);
    const cutoff7d = NOW - 7 * DAY_MS;
    // The daily series: data-api's FILTER clause expanded to its equivalent
    // CASE form, everything else verbatim.
    assert.match(queries[0]!, new RegExp(`observed_at >= ${cutoff7d}`));
    assert.match(
      queries[0]!,
      /SUM\(CASE WHEN signer IS NOT NULL THEN 1 ELSE 0 END\) AS signed_extrinsic_count/,
    );
    assert.match(queries[0]!, /SUM\(COALESCE\(fee_tao, 0\)\) AS total_fee_tao/);
    // The payer leaderboard: unsigned inherents excluded, data-api's exact
    // total order, precomputed at the route's maximum limit.
    assert.match(queries[1]!, /signer IS NOT NULL/);
    assert.match(queries[1]!, /ORDER BY total_fee_tao DESC, signer ASC/);
    assert.match(queries[1]!, /LIMIT 100/);
    // The medians: PERCENTILE_CONT(0.5)'s exact middle-value interpolation
    // from ranked windows, NULLs excluded per column like WITHIN GROUP does.
    assert.match(queries[2]!, /WITH ranked AS/);
    assert.match(
      queries[2]!,
      /ROW_NUMBER\(\) OVER \(PARTITION BY observed_at \/ 86400000 ORDER BY fee_tao\) AS rn/,
    );
    assert.match(
      queries[2]!,
      /COUNT\(\*\) OVER \(PARTITION BY observed_at \/ 86400000\) AS cnt/,
    );
    assert.match(queries[2]!, /signer IS NOT NULL AND fee_tao IS NOT NULL/);
    assert.match(
      queries[2]!,
      /WHERE rn \* 2 = cnt OR rn \* 2 = cnt \+ 1 OR rn \* 2 = cnt \+ 2/,
    );
    assert.match(queries[2]!, /AVG\(fee_tao\) AS median_value/);
    assert.match(queries[3]!, /ORDER BY tip_tao/);
    assert.match(queries[3]!, /tip_tao IS NOT NULL/);
    assert.match(queries[4]!, /MAX\(observed_at\) AS newest_observed/);
    assert.match(
      queries[5]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 2);
    const w7 = (body.windows as Row)["7d"] as Row;
    assert.equal(w7.days, 7);
    assert.equal(w7.newest_observed, NOW - 2000);
    assert.deepEqual(w7.daily_rows, [
      {
        day: "2026-08-02",
        extrinsic_count: "100",
        signed_extrinsic_count: "80",
        total_fee_tao: "1.6",
        total_tip_tao: "0.4",
      },
    ]);
    // The two per-column median passes merged into data-api's medianRows
    // shape: both columns, fee-only, and tip-only days all represented.
    assert.deepEqual(w7.median_rows, [
      { day: "2026-08-02", median_fee_tao: 0.005, median_tip_tao: 0.001 },
      { day: "2026-08-01", median_fee_tao: 0.004 },
      { day: "2026-07-31", median_tip_tao: 0.002 },
    ]);
    assert.deepEqual(w7.payer_rows, [
      {
        signer: "5F",
        total_fee_tao: "0.6",
        total_tip_tao: "0.2",
        extrinsic_count: "10",
      },
    ]);
    const w30 = (body.windows as Row)["30d"] as Row;
    assert.deepEqual(w30.median_rows, []);
  });

  test("one failed statement declines the WHOLE compute — no partial artifact", async () => {
    for (const responses of [
      ["fail"],
      [[], "fail"],
      [[], [], "fail"],
      [[], [], [], "fail"],
      [[], [], [], [], "fail"],
    ] as ("fail" | unknown[])[][]) {
      lakeFetch(...responses);
      assert.equal(
        await laneNamed("chain-fees").compute(LAKE_ENV as unknown as Env),
        null,
      );
    }
  });

  test("an unrenderable day index declines rather than mislabeling a day", async () => {
    // In the daily series...
    lakeFetch([{ day_index: null, extrinsic_count: "1" }], [], [], [], []);
    assert.equal(
      await laneNamed("chain-fees").compute(LAKE_ENV as unknown as Env),
      null,
    );
    // ...in the fee medians...
    lakeFetch([], [], [{ day_index: "bogus", median_value: 1 }], [], []);
    assert.equal(
      await laneNamed("chain-fees").compute(LAKE_ENV as unknown as Env),
      null,
    );
    // ...and in the tip medians.
    lakeFetch([], [], [], [{ day_index: -1, median_value: 1 }], []);
    assert.equal(
      await laneNamed("chain-fees").compute(LAKE_ENV as unknown as Env),
      null,
    );
  });
});

describe("chain-signers lane compute", () => {
  test("replicates data-api's statements per window, both sorts at the max limit", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const TX_ROW = {
      signer: "5A",
      tx_count: "40",
      total_fee_tao: "0.1",
      total_tip_tao: "0",
      last_tx_block: "123456",
    };
    const FEE_ROW = { ...TX_ROW, signer: "5B" };
    const queries = lakeFetch(
      // 7d: freshness, tx_count order, total_fee_tao order.
      [{ newest_observed: NOW - 100 }],
      [TX_ROW],
      [FEE_ROW],
      // 30d.
      [],
      [],
      [],
    );
    const body = (await laneNamed("chain-signers").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 6);
    const cutoff7d = NOW - 7 * DAY_MS;
    // The separate freshness read data-api needs (grouped rows carry
    // last_tx_block, not a network observed_at).
    assert.match(queries[0]!, /MAX\(observed_at\) AS newest_observed/);
    assert.match(queries[0]!, new RegExp(`observed_at >= ${cutoff7d}`));
    // Both sorts: NULL signers excluded, data-api's exact total orders,
    // precomputed at the route's maximum limit.
    assert.match(queries[1]!, /FROM chain\.extrinsics/);
    assert.match(queries[1]!, /signer IS NOT NULL/);
    assert.match(queries[1]!, /SUM\(COALESCE\(fee_tao, 0\)\) AS total_fee_tao/);
    assert.match(queries[1]!, /MAX\(block_number\) AS last_tx_block/);
    assert.match(queries[1]!, /ORDER BY tx_count DESC, signer ASC/);
    assert.match(queries[1]!, /LIMIT 100/);
    assert.match(queries[2]!, /ORDER BY total_fee_tao DESC, signer ASC/);
    assert.match(
      queries[3]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 2);
    const w7 = (body.windows as Row)["7d"] as Row;
    assert.equal(w7.days, 7);
    assert.equal(w7.newest_observed, NOW - 100);
    assert.deepEqual((w7.sorts as Row).tx_count, [TX_ROW]);
    assert.deepEqual((w7.sorts as Row).total_fee_tao, [FEE_ROW]);
    const w30 = (body.windows as Row)["30d"] as Row;
    assert.deepEqual(w30.sorts, { tx_count: [], total_fee_tao: [] });
  });

  test("one failed statement declines the WHOLE compute — no partial artifact", async () => {
    for (const responses of [["fail"], [[], "fail"], [[], [], "fail"]] as (
      "fail" | unknown[]
    )[][]) {
      lakeFetch(...responses);
      assert.equal(
        await laneNamed("chain-signers").compute(LAKE_ENV as unknown as Env),
        null,
      );
    }
  });
});

describe("chain-alpha-volume lane compute", () => {
  test("replicates data-api's single GROUP BY aggregate over the fixed 24h window", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const ROWS = [
      {
        netuid: 7,
        event_kind: "StakeAdded",
        alpha_volume: "120",
        tao_volume: "60",
        event_count: "4",
        last_observed: NOW - 1000,
      },
    ];
    const queries = lakeFetch(ROWS);
    const body = (await laneNamed("chain-alpha-volume").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /FROM chain\.account_events/);
    assert.match(queries[0]!, /event_kind IN \('StakeAdded', 'StakeRemoved'\)/);
    // The route's fixed rolling 24h cutoff, anchored to generated_at.
    assert.match(queries[0]!, new RegExp(`observed_at >= ${NOW - DAY_MS}`));
    assert.match(
      queries[0]!,
      /COALESCE\(SUM\(alpha_amount\), 0\) AS alpha_volume/,
    );
    assert.match(queries[0]!, /COALESCE\(SUM\(amount_tao\), 0\) AS tao_volume/);
    assert.match(queries[0]!, /GROUP BY netuid, event_kind/);

    assert.equal(body.schema_version, 1);
    assert.equal(body.generated_at, new Date(NOW).toISOString());
    assert.equal(body.row_count, 1);
    // Rows are stored VERBATIM under the route's one fixed window.
    assert.deepEqual(body.windows, { "24h": { days: 1, rows: ROWS } });
  });

  test("a failed query declines the compute", async () => {
    lakeFetch("fail");
    assert.equal(
      await laneNamed("chain-alpha-volume").compute(LAKE_ENV as unknown as Env),
      null,
    );
  });
});

describe("chain-stake-transfers lane compute", () => {
  test("replicates data-api's DISTINCT row + guarded per-subnet aggregate per window", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const queries = lakeFetch(
      // 7d: the network row observed activity, so the subnet query runs.
      [{ distinct_senders: "4", newest_observed: NOW - 1000 }],
      [{ netuid: 7, transfers: "6", distinct_senders: "3" }],
      // 30d: a network row with NO newest_observed — data-api's guard skips
      // the subnet query entirely.
      [{ distinct_senders: "0", newest_observed: null }],
    );
    const body = (await laneNamed("chain-stake-transfers").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    // Three statements, not four: the guarded window issued only its
    // network read.
    assert.equal(queries.length, 3);
    const cutoff7d = NOW - 7 * DAY_MS;
    assert.match(queries[0]!, /FROM chain\.account_events/);
    assert.match(queries[0]!, /event_kind = 'StakeTransferred'/);
    assert.match(queries[0]!, new RegExp(`observed_at >= ${cutoff7d}`));
    assert.match(queries[0]!, /COUNT\(DISTINCT coldkey\) AS distinct_senders/);
    assert.match(
      queries[1]!,
      /GROUP BY netuid ORDER BY transfers DESC, netuid ASC/,
    );
    assert.match(
      queries[2]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 1);
    assert.deepEqual((body.windows as Row)["7d"], {
      days: 7,
      network: { distinct_senders: "4", newest_observed: NOW - 1000 },
      rows: [{ netuid: 7, transfers: "6", distinct_senders: "3" }],
    });
    assert.deepEqual((body.windows as Row)["30d"], {
      days: 30,
      network: { distinct_senders: "0", newest_observed: null },
      rows: [],
    });
  });

  test("an empty network result stores a null network row", async () => {
    lakeFetch([]);
    const body = (await laneNamed("chain-stake-transfers").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.deepEqual((body.windows as Row)["7d"], {
      days: 7,
      network: null,
      rows: [],
    });
  });

  test("a failed statement declines the whole compute", async () => {
    lakeFetch("fail");
    assert.equal(
      await laneNamed("chain-stake-transfers").compute(
        LAKE_ENV as unknown as Env,
      ),
      null,
    );
    // The subnet statement failing after a live network row declines too.
    lakeFetch([{ distinct_senders: "4", newest_observed: NOW }], "fail");
    assert.equal(
      await laneNamed("chain-stake-transfers").compute(
        LAKE_ENV as unknown as Env,
      ),
      null,
    );
  });
});

describe("chain-stake-moves lane compute", () => {
  test("replicates data-api's DISTINCT row + per-subnet aggregate over StakeMoved", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const queries = lakeFetch(
      [{ distinct_movers: "5", newest_observed: NOW - 1000 }],
      [{ netuid: 3, movements: "10", distinct_movers: "2" }],
      [],
    );
    const body = (await laneNamed("chain-stake-moves").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 3);
    assert.match(queries[0]!, /event_kind = 'StakeMoved'/);
    assert.match(queries[0]!, /COUNT\(DISTINCT coldkey\) AS distinct_movers/);
    assert.match(queries[1]!, /COUNT\(\*\) AS movements/);
    assert.match(
      queries[1]!,
      /GROUP BY netuid ORDER BY movements DESC, netuid ASC/,
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 1);
    assert.deepEqual((body.windows as Row)["7d"], {
      days: 7,
      network: { distinct_movers: "5", newest_observed: NOW - 1000 },
      rows: [{ netuid: 3, movements: "10", distinct_movers: "2" }],
    });
    assert.deepEqual((body.windows as Row)["30d"], {
      days: 30,
      network: null,
      rows: [],
    });
  });

  test("a failed statement declines the whole compute", async () => {
    lakeFetch("fail");
    assert.equal(
      await laneNamed("chain-stake-moves").compute(LAKE_ENV as unknown as Env),
      null,
    );
  });
});

describe("chain-transfer-pairs lane compute", () => {
  test("replicates data-api's CTE totals + both sort orders at the max limit", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const TOTALS = {
      transfer_count: "10",
      total_volume_tao: "500",
      unique_pairs: "3",
      top_pair_volume_tao: "300",
      newest_observed: NOW - 1000,
    };
    const PAIR = {
      from_address: "5A",
      to_address: "5B",
      volume_tao: "300",
      transfer_count: "4",
      last_block: "123456",
      last_observed_at: NOW - 1000,
    };
    const queries = lakeFetch(
      // 7d: totals CTE, volume order, count order.
      [TOTALS],
      [PAIR],
      [PAIR],
      // 30d: no corridors at all — the totals row is absent, stored null.
      [],
      [],
      [],
    );
    const body = (await laneNamed("chain-transfer-pairs").compute(
      LAKE_ENV as unknown as Env,
    )) as Row;
    assert.equal(queries.length, 6);
    const cutoff7d = NOW - 7 * DAY_MS;
    // The totals rollup over data-api's inlined PAIR_FILTER predicate.
    assert.match(queries[0]!, /WITH pair_totals AS/);
    assert.match(queries[0]!, /event_kind = 'Transfer'/);
    assert.match(queries[0]!, new RegExp(`observed_at >= ${cutoff7d}`));
    assert.match(
      queries[0]!,
      /hotkey <> '' AND coldkey <> '' AND hotkey <> coldkey/,
    );
    assert.match(queries[0]!, /amount_tao IS NOT NULL AND amount_tao >= 0/);
    assert.match(
      queries[0]!,
      /COALESCE\(MAX\(volume_tao\), 0\) AS top_pair_volume_tao/,
    );
    // Both sort orders, precomputed at the route's maximum limit.
    assert.match(queries[1]!, /GROUP BY hotkey, coldkey/);
    assert.match(
      queries[1]!,
      /ORDER BY volume_tao DESC, transfer_count DESC, hotkey ASC, coldkey ASC/,
    );
    assert.match(queries[1]!, /LIMIT 100/);
    assert.match(
      queries[2]!,
      /ORDER BY transfer_count DESC, volume_tao DESC, hotkey ASC, coldkey ASC/,
    );
    assert.match(
      queries[3]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 2);
    assert.deepEqual((body.windows as Row)["7d"], {
      days: 7,
      totals: TOTALS,
      sorts: { volume: [PAIR], count: [PAIR] },
    });
    assert.deepEqual((body.windows as Row)["30d"], {
      days: 30,
      totals: null,
      sorts: { volume: [], count: [] },
    });
  });

  test("one failed statement declines the WHOLE compute — no partial artifact", async () => {
    for (const responses of [["fail"], [[], "fail"], [[], [], "fail"]] as (
      "fail" | unknown[]
    )[][]) {
      lakeFetch(...responses);
      assert.equal(
        await laneNamed("chain-transfer-pairs").compute(
          LAKE_ENV as unknown as Env,
        ),
        null,
      );
    }
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

  test("runs every registered lane and writes every artifact", async () => {
    lakeFetch([]);
    const { puts, bucket } = archiveBucket();
    const result = await runProjectionLanes({
      ...LAKE_ENV,
      METAGRAPH_ARCHIVE: bucket,
    } as unknown as Env);
    assert.deepEqual(result, {
      ok: true,
      lanes: {
        "chain-transfers": 0,
        "chain-stake-flow": 0,
        "chain-activity": 0,
        "chain-calls": 0,
        "chain-fees": 0,
        "chain-signers": 0,
        "chain-alpha-volume": 0,
        "chain-stake-transfers": 0,
        "chain-transfer-pairs": 0,
        "chain-stake-moves": 0,
      },
    });
    assert.deepEqual(
      puts.map((put) => put.key),
      PROJECTION_LANES.map((lane) => lane.artifactKey),
    );
  });

  test("one failed lane never skips the next — failures are isolated", async () => {
    // The transfers and transfer-pairs lanes' statements all filter on the
    // Transfer kind; fail exactly those so every other lane still sees a
    // healthy engine.
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
    assert.equal(result.ok, false);
    assert.equal(result.lanes["chain-transfers"], null);
    assert.equal(result.lanes["chain-transfer-pairs"], null);
    // Every OTHER lane still ran and wrote.
    assert.equal(result.lanes["chain-stake-flow"], 0);
    assert.equal(result.lanes["chain-stake-moves"], 0);
    assert.equal(Object.keys(result.lanes).length, PROJECTION_LANES.length);
    assert.deepEqual(
      puts.map((put) => put.key),
      PROJECTION_LANES.map((lane) => lane.artifactKey).filter(
        (key) =>
          key !== CHAIN_TRANSFERS_PROJECTION_KEY &&
          key !== CHAIN_TRANSFER_PAIRS_PROJECTION_KEY,
      ),
    );
    assert.deepEqual(
      events.map((event) => event.route),
      ["projection:chain-transfers", "projection:chain-transfer-pairs"],
    );
  });
});

describe("lane registry", () => {
  test("every lane's artifact key lives under metagraph/projections/", () => {
    assert.ok(PROJECTION_LANES.length >= 10);
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
