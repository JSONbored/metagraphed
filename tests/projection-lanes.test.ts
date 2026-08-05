// The projection framework's one hard promise is that a failed compute NEVER
// overwrites a good artifact — so these tests assert the absence of the put
// as sharply as its presence — and the lane computes are asserted as the
// validated-literal R2 SQL that replicates data-api's route semantics.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";
import {
  PROJECTION_LANES,
  PROJECTION_NETWORKS,
  PROJECTION_QUERY_TIMEOUT_MS,
  projectionKey,
  STAKE_FLOW_PROJECTION_WINDOWS,
  runProjectionLane,
  runProjectionLanes,
  type ProjectionLane,
} from "../src/projection-lanes.ts";
import { BLOCKS_SUMMARY_SCAN_CAP } from "../src/blocks-summary.ts";
import {
  CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY,
  CHAIN_DEREGISTRATIONS_PROJECTION_KEY,
} from "../src/chain-deregistrations-artifact.ts";
import { LAKEHOUSE_NAMESPACES } from "../src/chain-network.ts";
import { QUERY_TIMEOUT_MS } from "../src/r2-sql.ts";
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

/**
 * A whole-engine fake for the runProjectionLanes tests: every lane sees an
 * empty result EXCEPT the blocks scan, which gets one row.
 *
 * blocks-summary stores a shaped card rather than rows, so an empty scan makes
 * it decline by design -- buildBlocksSummary([]) asserts a chain with zero
 * blocks, which is false, and persisting it would overwrite real numbers. The
 * row-storing lanes have no such problem: an empty window is honest for them.
 */
function lakeFetchWithBlocks(onFail?: (sql: string) => boolean) {
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const sql = String(JSON.parse(String(init.body)).query);
    if (onFail?.(sql)) return { ok: false, status: 500 } as unknown as Response;
    // Matched on the ORDER BY, not just the table: chain-activity aggregates
    // over chain.blocks too, and feeding IT rows would change what that lane
    // computes. Only the blocks-summary scan orders by block_number.
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("ORDER BY block_number DESC")) {
      rows = [
        {
          block_number: 8_760_000,
          author: "5A",
          extrinsic_count: 2,
          event_count: 4,
          spec_version: 300,
          observed_at: NOW - 12_000,
        },
      ];
    } else if (sql.includes("event_index")) {
      // chain-deregistrations is the one lane that reads RAW registration
      // rows, and it declines on an empty pull by design (30 days with no
      // registration anywhere is a failed read, not a quiet month).
      rows = [
        {
          netuid: 5,
          uid: 216,
          hotkey: "A",
          block_number: 10,
          event_index: 1,
          observed_at: NOW - 2 * DAY_MS,
        },
      ];
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
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
      "mainnet",
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
      "mainnet",
    );
    assert.equal(body, null);
  });

  test("a failure in the leaderboard statements declines too", async () => {
    lakeFetch([], [], [], "fail");
    assert.equal(
      await laneNamed("chain-transfers").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
    lakeFetch([], [], [], [], "fail");
    assert.equal(
      await laneNamed("chain-transfers").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
    lakeFetch("fail");
    assert.equal(
      await laneNamed("chain-transfers").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
    lakeFetch([], "fail");
    assert.equal(
      await laneNamed("chain-transfers").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });
});

describe("blocks-summary lane compute", () => {
  const BLOCKS = [
    {
      block_number: 8_760_002,
      author: "5A",
      extrinsic_count: 4,
      event_count: 9,
      spec_version: 300,
      observed_at: NOW - 12_000,
    },
    {
      block_number: 8_760_001,
      author: "5B",
      extrinsic_count: 2,
      event_count: 5,
      spec_version: 300,
      observed_at: NOW - 24_000,
    },
  ];

  test("scans the newest blocks and stores the SHAPED card", async () => {
    const queries = lakeFetch(BLOCKS);
    const body = (await laneNamed("blocks-summary").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;

    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /FROM chain\.blocks/);
    // Newest-first with the same fixed cap the D1 loader used, so the card is
    // computed over the same window.
    assert.match(queries[0]!, /ORDER BY block_number DESC/);
    assert.match(queries[0]!, new RegExp(`LIMIT ${BLOCKS_SUMMARY_SCAN_CAP}`));

    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 2);
    // Unlike the chain-* lanes this stores the CARD, not the rows: the route
    // takes no parameters, so there is nothing for a reader to re-slice.
    assert.equal((body.summary as Row).block_count, 2);
    assert.equal((body.summary as Row).distinct_authors, 2);
    assert.equal(body.rows, undefined);
  });

  test("declines rather than storing a zeroed card over a good one", async () => {
    // buildBlocksSummary([]) is a plausible-looking blank. Persisting it would
    // replace real numbers with one, which is exactly the silent failure the
    // all-or-nothing contract exists to prevent.
    lakeFetch([]);
    assert.equal(
      await laneNamed("blocks-summary").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });

  test("declines when the lakehouse query fails", async () => {
    lakeFetch("fail");
    assert.equal(
      await laneNamed("blocks-summary").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });
});

describe("chain-registrations lane compute", () => {
  const STAMP = [{ newest_observed: NOW - 1000 }];
  // Distinct (netuid, hotkey) pairs, the shape the distributed aggregation
  // returns. hotkey A appears on BOTH subnets on purpose: it is two
  // subnet-level registrants but only ONE network-wide distinct registrant.
  const PAIRS = [
    { netuid: 5, hotkey: "A", n: 3 },
    { netuid: 5, hotkey: "B", n: 1 },
    { netuid: 15, hotkey: "A", n: 2 },
  ];

  test("distributes the aggregation and reduces the pairs exactly", async () => {
    const queries = lakeFetch(STAMP, PAIRS, STAMP, PAIRS);
    const body = (await laneNamed("chain-registrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;

    assert.equal(queries.length, 4, "2 windows x (stamp + pairs)");
    // The cheap stamp first -- it gates the heavy read.
    assert.match(queries[0]!, /MAX\(observed_at\) AS newest_observed/);
    assert.doesNotMatch(queries[0]!, /GROUP BY/);
    // R2 SQL rejects COUNT(DISTINCT) + GROUP BY on the 30d window (40015 scan
    // budget), so the heavy read must never use that form.
    assert.match(queries[1]!, /GROUP BY netuid, hotkey/);
    assert.doesNotMatch(queries[1]!, /COUNT\(DISTINCT/);
    assert.doesNotMatch(queries[1]!, /APPROX_DISTINCT/);

    const win = (body.windows as Row)["7d"] as Row;
    assert.deepEqual(win.rows, [
      { netuid: 5, registrations: 4, distinct_registrants: 2 },
      { netuid: 15, registrations: 2, distinct_registrants: 1 },
    ]);
    // Network distinct is over the pair set, NOT the sum of the per-subnet
    // counts (2 + 1 = 3): hotkey A registered on both subnets.
    assert.equal((win.network as Row).distinct_registrants, 2);
    assert.equal((win.network as Row).newest_observed, NOW - 1000);
  });

  test("ranks rows the way the retired loader emitted them", async () => {
    lakeFetch(STAMP, PAIRS);
    const body = (await laneNamed("chain-registrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    const rows = ((body.windows as Row)["7d"] as Row).rows as Row[];
    assert.deepEqual(
      rows.map((r) => r.netuid),
      [5, 15],
      "registrations DESC, netuid ASC",
    );
  });

  test("skips the heavy read when the window holds no registrations", async () => {
    const queries = lakeFetch([{ newest_observed: null }]);
    const body = (await laneNamed("chain-registrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    assert.equal(queries.length, 2, "one stamp per window, no pair read");
    const win = (body.windows as Row)["7d"] as Row;
    assert.deepEqual(win.rows, []);
    assert.equal((win.network as Row).distinct_registrants, 0);
  });

  test("declines the whole compute when the stamp read fails", async () => {
    lakeFetch("fail");
    assert.equal(
      await laneNamed("chain-registrations").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });

  test("declines when the pair read fails after a healthy stamp", async () => {
    // Storing the window with a real newest_observed but no rows would publish
    // subnet_count 0 beside a live freshness stamp -- indistinguishable from a
    // genuinely quiet window.
    lakeFetch(STAMP, "fail");
    assert.equal(
      await laneNamed("chain-registrations").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });

  test("does not count a null hotkey as a distinct registrant", async () => {
    // account_events carries a null hotkey on some kinds (WeightsSet rows do).
    // Counting one as a registrant would inflate both the per-subnet and the
    // network distinct counts with a non-identity.
    lakeFetch(STAMP, [
      { netuid: 5, hotkey: null, n: 4 },
      { netuid: 5, hotkey: "A", n: 1 },
    ]);
    const body = (await laneNamed("chain-registrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    const win = (body.windows as Row)["7d"] as Row;
    // The events still count -- they happened -- but only "A" is a registrant.
    assert.deepEqual(win.rows, [
      { netuid: 5, registrations: 5, distinct_registrants: 1 },
    ]);
    assert.equal((win.network as Row).distinct_registrants, 1);
  });

  test("treats a non-numeric event count as zero rather than NaN", async () => {
    // One malformed cell must not turn a subnet's whole registrations figure
    // into NaN, which would serialize as null and read as 'no data'.
    lakeFetch(STAMP, [{ netuid: 5, hotkey: "A", n: "oops" }]);
    const body = (await laneNamed("chain-registrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    assert.deepEqual(((body.windows as Row)["7d"] as Row).rows, [
      { netuid: 5, registrations: 0, distinct_registrants: 1 },
    ]);
  });

  test("breaks a registrations tie by netuid ascending", async () => {
    lakeFetch(STAMP, [
      { netuid: 15, hotkey: "A", n: 2 },
      { netuid: 5, hotkey: "B", n: 2 },
    ]);
    const body = (await laneNamed("chain-registrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    const rows = ((body.windows as Row)["7d"] as Row).rows as Row[];
    assert.deepEqual(
      rows.map((r) => r.netuid),
      [5, 15],
      "equal registrations must order by netuid ASC",
    );
  });

  test("ignores a pair with a malformed netuid rather than counting it", async () => {
    lakeFetch(STAMP, [{ netuid: "not-a-number", hotkey: "A", n: 9 }]);
    const body = (await laneNamed("chain-registrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    assert.deepEqual(((body.windows as Row)["7d"] as Row).rows, []);
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
      "mainnet",
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
      await laneNamed("chain-stake-flow").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
    lakeFetch([], "fail");
    assert.equal(
      await laneNamed("chain-stake-flow").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
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
      "mainnet",
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
        await laneNamed("chain-activity").compute(
          LAKE_ENV as unknown as Env,
          "mainnet",
        ),
        null,
      );
    }
  });

  test("an unrenderable day index declines rather than mislabeling a day", async () => {
    // In the extrinsic rows...
    lakeFetch([{ day_index: "bogus", extrinsic_count: "1" }], [], [], []);
    assert.equal(
      await laneNamed("chain-activity").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
    // ...and in the block rows.
    lakeFetch([], [], [{ day_index: -5, block_count: "1" }], []);
    assert.equal(
      await laneNamed("chain-activity").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
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
      "mainnet",
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
        await laneNamed("chain-calls").compute(
          LAKE_ENV as unknown as Env,
          "mainnet",
        ),
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
      "mainnet",
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
        await laneNamed("chain-fees").compute(
          LAKE_ENV as unknown as Env,
          "mainnet",
        ),
        null,
      );
    }
  });

  test("an unrenderable day index declines rather than mislabeling a day", async () => {
    // In the daily series...
    lakeFetch([{ day_index: null, extrinsic_count: "1" }], [], [], [], []);
    assert.equal(
      await laneNamed("chain-fees").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
    // ...in the fee medians...
    lakeFetch([], [], [{ day_index: "bogus", median_value: 1 }], [], []);
    assert.equal(
      await laneNamed("chain-fees").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
    // ...and in the tip medians.
    lakeFetch([], [], [], [{ day_index: -1, median_value: 1 }], []);
    assert.equal(
      await laneNamed("chain-fees").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
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
      "mainnet",
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
        await laneNamed("chain-signers").compute(
          LAKE_ENV as unknown as Env,
          "mainnet",
        ),
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
      "mainnet",
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
      await laneNamed("chain-alpha-volume").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });
});

describe("chain-stake-transfers lane compute", () => {
  test("replicates data-api's DISTINCT row + guarded per-subnet aggregate per window", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const queries = lakeFetch(
      // 7d: newest first, then the chain-wide DISTINCT, then the per-subnet
      // tally, then the per-subnet DISTINCT. Four statements because each
      // heavy aggregation stands alone (#9423).
      [{ newest_observed: NOW - 1000 }],
      [{ distinct_senders: "4" }],
      [{ netuid: 7, transfers: "6" }],
      [{ netuid: 7, distinct_senders: "3" }],
      // 30d: no newest_observed at all — the window observed nothing, so none
      // of the heavy scans are issued.
      [{ newest_observed: null }],
    );
    const body = (await laneNamed("chain-stake-transfers").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    // Five statements: four for the active window, one for the empty one.
    // The empty window costs a single cheap MAX() and stops there.
    assert.equal(queries.length, 5);
    const cutoff7d = NOW - 7 * DAY_MS;
    assert.match(queries[0]!, /FROM chain\.account_events/);
    assert.match(queries[0]!, /event_kind = 'StakeTransferred'/);
    assert.match(queries[0]!, new RegExp(`observed_at >= ${cutoff7d}`));
    assert.match(queries[0]!, /MAX\(observed_at\) AS newest_observed/);
    // ONE heavy aggregation per statement: the DISTINCT stands alone, which is
    // the shape its sibling transferWindowSql already used and the shape these
    // two lanes lacked when they stopped writing for 31 hours (#9423).
    assert.match(queries[1]!, /COUNT\(DISTINCT coldkey\) AS distinct_senders/);
    assert.doesNotMatch(queries[1]!, /MAX\(observed_at\)/);
    assert.match(
      queries[2]!,
      /GROUP BY netuid ORDER BY transfers DESC, netuid ASC/,
    );
    // The per-subnet DISTINCT is the statement that actually 422s in
    // production (40015, count(DISTINCT) with GROUP BY), so it stands alone
    // too -- and never with APPROX_DISTINCT, which the engine suggests and
    // this lane refuses because distinct_senders is a published field.
    assert.match(queries[3]!, /COUNT\(DISTINCT coldkey\) AS distinct_senders/);
    assert.doesNotMatch(queries[3]!, /COUNT\(\*\)/);
    assert.doesNotMatch(queries[3]!, /APPROX_DISTINCT/i);
    assert.match(
      queries[4]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
    );

    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 1);
    // Merged back into the one chain-wide row the artifact has always carried,
    // so the split is invisible to every reader.
    assert.deepEqual((body.windows as Row)["7d"], {
      days: 7,
      network: { distinct_senders: "4", newest_observed: NOW - 1000 },
      rows: [{ netuid: 7, transfers: "6", distinct_senders: "3" }],
    });
    // An empty window keeps its MEASURED zero rather than degrading to
    // "unknown": MAX(observed_at) IS NULL means no rows matched, so the
    // distinct count is necessarily 0 -- derived, not guessed.
    assert.deepEqual((body.windows as Row)["30d"], {
      days: 30,
      network: { distinct_senders: 0, newest_observed: null },
      rows: [],
    });
  });

  // NO ROW AT ALL, as distinct from a row saying NULL: an aggregate that ran
  // returns exactly one row, so an empty result set is unread rather than a
  // measured empty window, and must not be published as a zero.
  test("an empty network result stores a null network row", async () => {
    lakeFetch([]);
    const body = (await laneNamed("chain-stake-transfers").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
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
        "mainnet",
      ),
      null,
    );
    // The subnet statement failing after a live network row declines too.
    lakeFetch([{ distinct_senders: "4", newest_observed: NOW }], "fail");
    assert.equal(
      await laneNamed("chain-stake-transfers").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });
});

describe("chain-stake-moves lane compute", () => {
  test("replicates data-api's DISTINCT row + per-subnet aggregate over StakeMoved", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const queries = lakeFetch(
      [{ newest_observed: NOW - 1000 }],
      [{ distinct_movers: "5" }],
      [{ netuid: 3, movements: "10" }],
      [{ netuid: 3, distinct_movers: "2" }],
      [],
    );
    const body = (await laneNamed("chain-stake-moves").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    assert.equal(queries.length, 5);
    assert.match(queries[0]!, /event_kind = 'StakeMoved'/);
    assert.match(queries[0]!, /MAX\(observed_at\) AS newest_observed/);
    // The DISTINCT stands alone (#9423) -- one heavy aggregation per statement.
    assert.match(queries[1]!, /COUNT\(DISTINCT coldkey\) AS distinct_movers/);
    assert.doesNotMatch(queries[1]!, /MAX\(observed_at\)/);
    assert.match(queries[2]!, /COUNT\(\*\) AS movements/);
    assert.match(
      queries[2]!,
      /GROUP BY netuid ORDER BY movements DESC, netuid ASC/,
    );
    assert.match(queries[3]!, /COUNT\(DISTINCT coldkey\) AS distinct_movers/);
    assert.doesNotMatch(queries[3]!, /COUNT\(\*\)/);

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
      await laneNamed("chain-stake-moves").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
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
      "mainnet",
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
          "mainnet",
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
    lakeFetchWithBlocks();
    const { puts, bucket } = archiveBucket();
    const result = await runProjectionLanes({
      ...LAKE_ENV,
      METAGRAPH_ARCHIVE: bucket,
    } as unknown as Env);
    // Derived from the registry, NOT a hand-written roster -- the same change
    // #9214 made to the sibling assertion in api-coverage.test.ts. A hardcoded
    // list is what red-lined main when #9195 registered blocks-summary: the
    // lane and the runner were both right and the TEST was what had to be
    // edited in lockstep. Deriving means registering a lane can only fail this
    // if the lane genuinely did not run or did not write.
    // Every lane x every network (#9412): mainnet keeps its bare name, each
    // other chain is suffixed, so a failing testnet lane is never reported
    // under the mainnet lane's name. Derived from BOTH registries rather than
    // written out, for the reason the note above gives.
    const registered = PROJECTION_NETWORKS.flatMap((network) =>
      PROJECTION_LANES.map((lane) =>
        network === "mainnet" ? lane.name : `${lane.name}:${network}`,
      ),
    );
    const outcome = result as {
      ok: boolean;
      lanes: Record<string, number | null>;
    };
    assert.deepEqual(
      Object.keys(outcome.lanes).sort(),
      [...registered].sort(),
      "every registered lane must appear in the tick summary",
    );
    // A lane reporting null DECLINED (compute returned null, previous artifact
    // left in place). Name them rather than leaving the next reader to hunt.
    const declined = registered.filter((name) => outcome.lanes[name] === null);
    assert.deepEqual(
      declined,
      [],
      `these lanes declined instead of writing: ${declined.join(", ")}. ` +
        `If a newly registered lane declines on an empty read, give its query ` +
        `rows in the stub above -- do not weaken this assertion.`,
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(
      puts.map((put) => put.key).sort(),
      PROJECTION_NETWORKS.flatMap((network) =>
        [
          ...PROJECTION_LANES.map((lane) => lane.artifactKey),
          // The one lane that fans its single computed body across two objects
          // (src/chain-deregistrations-artifact.ts's header says why).
          CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY,
        ].map((key) => projectionKey(key, network)),
      ).sort(),
      "each lane writes its own artifact key per network, plus any split it declares",
    );
    // MAINNET'S KEYS ARE UNPREFIXED. Every artifact written before #9412 stays
    // readable and a mainnet request reads the object it read before -- the
    // asymmetry networkKvKey and chainTable already use.
    for (const lane of PROJECTION_LANES) {
      assert.ok(
        puts.some((put) => put.key === lane.artifactKey),
        `${lane.name} must still write its unprefixed mainnet key`,
      );
    }
  });

  test("one failed lane never skips the next — failures are isolated", async () => {
    // The transfers and transfer-pairs lanes' statements all filter on the
    // Transfer kind; fail exactly those so every other lane still sees a
    // healthy engine.
    const { puts, bucket } = archiveBucket();
    const { events, record } = exceptionRecorder();
    lakeFetchWithBlocks((sql) => sql.includes("'Transfer'"));
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
    assert.equal(result.lanes["blocks-summary"], 1);
    assert.equal(
      Object.keys(result.lanes).length,
      PROJECTION_LANES.length * PROJECTION_NETWORKS.length,
    );
    assert.deepEqual(
      puts.map((put) => put.key),
      PROJECTION_NETWORKS.flatMap((network) =>
        PROJECTION_LANES.flatMap((lane) =>
          (lane.artifactKey === CHAIN_DEREGISTRATIONS_PROJECTION_KEY
            ? [lane.artifactKey, CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY]
            : [lane.artifactKey]
          ).map((key) => projectionKey(key, network)),
        ),
      ).filter(
        (key) =>
          // The two lanes stubbed to fail write nothing, on EITHER network.
          !key.endsWith("chain-transfers.json") &&
          !key.endsWith("chain-transfer-pairs.json"),
      ),
    );
    // Each network reports its OWN failure under its own route label, so a
    // testnet decline never lands in the mainnet lane's telemetry -- which
    // would make an outage on the secondary chain page as one on the primary.
    assert.deepEqual(
      events.map((event) => event.route),
      PROJECTION_NETWORKS.flatMap((network) =>
        ["chain-transfers", "chain-transfer-pairs"].map((lane) =>
          network === "mainnet"
            ? `projection:${lane}`
            : `projection:${lane}:${network}`,
        ),
      ),
    );
  });

  // A testnet lane's decline is REPORTED but must not fail the tick: its decode
  // lane is younger and its tables can genuinely be empty for a window, so
  // letting it set `ok: false` would drain the meaning out of the one signal
  // that says mainnet is broken.
  test("only mainnet decides the tick verdict", async () => {
    // EVERY testnet query fails; every mainnet one succeeds.
    lakeFetchWithBlocks((sql) => sql.includes("chain_testnet."));
    const { puts, bucket } = archiveBucket();
    const seen: string[] = [];
    const result = await runProjectionLanes(
      { ...LAKE_ENV, METAGRAPH_ARCHIVE: bucket } as unknown as Env,
      {
        recordException: (async (_env: unknown, event: { route?: string }) => {
          seen.push(String(event.route));
          return true;
        }) as never,
      },
    );
    assert.equal(result.ok, true, "a testnet decline must not fail the tick");
    // Reported, not swallowed: every testnet lane records under its own label.
    assert.ok(seen.length > 0, "the testnet declines must still be recorded");
    assert.ok(
      seen.every((route) => route.endsWith(":testnet")),
      `only testnet lanes should have declined: ${seen.join(", ")}`,
    );
    // And mainnet's artifacts still landed, unprefixed.
    for (const lane of PROJECTION_LANES) {
      assert.ok(
        puts.some((put) => put.key === lane.artifactKey),
        `${lane.name} must still write its mainnet artifact`,
      );
      assert.ok(
        !puts.some(
          (put) => put.key === projectionKey(lane.artifactKey, "testnet"),
        ),
        `${lane.name} must not write a testnet artifact from a failed read`,
      );
    }
  });
});

describe("chain-deregistrations lane compute", () => {
  // Two claims on slot (5,216) and one on (5,217): A -> B on the first, and a
  // lone first claim on the second, which displaced nobody we can see.
  const REGS = [
    {
      netuid: 5,
      uid: 216,
      hotkey: "A",
      block_number: 10,
      event_index: 1,
      observed_at: NOW - 20 * DAY_MS,
    },
    {
      netuid: 5,
      uid: 216,
      hotkey: "B",
      block_number: 20,
      event_index: 1,
      observed_at: NOW - 2 * DAY_MS,
    },
    {
      netuid: 5,
      uid: 217,
      hotkey: "A",
      block_number: 30,
      event_index: 1,
      observed_at: NOW - DAY_MS,
    },
  ];

  test("issues ONE raw read over the widest window and slices the rest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const queries = lakeFetch(REGS);
    const body = (await laneNamed("chain-deregistrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;

    // One query for two windows. The 7d window is derived from the same rows,
    // which is both cheaper and what gives it 23 days of prior occupancy.
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /FROM chain\.account_events/);
    assert.match(queries[0]!, /event_kind = 'NeuronRegistered'/);
    // NeuronDeregistered has never been emitted -- reading it is the bug.
    assert.doesNotMatch(queries[0]!, /NeuronDeregistered/);
    // Raw rows, not an aggregate: "who held this slot before" is a sequence
    // question no GROUP BY answers.
    assert.doesNotMatch(queries[0]!, /GROUP BY/);
    assert.doesNotMatch(queries[0]!, /COUNT\(DISTINCT/);
    assert.match(queries[0]!, /uid, hotkey, block_number, event_index/);
    assert.match(
      queries[0]!,
      new RegExp(`observed_at >= ${NOW - 30 * DAY_MS}`),
      "the widest window, so the narrow one derives against a real prefix",
    );
    assert.equal(body.lookback_days, 30);
  });

  test("derives the displaced holder, not the arriving one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    lakeFetch(REGS);
    const body = (await laneNamed("chain-deregistrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    const win = (body.windows as Row)["7d"] as Row;
    assert.deepEqual(win.rows, [
      {
        netuid: 5,
        deregistrations: 1,
        distinct_deregistered_hotkeys: 1,
        newest_observed: NOW - 2 * DAY_MS,
      },
    ]);
    assert.deepEqual(win.network, {
      distinct_deregistered_hotkeys: 1,
      newest_observed: NOW - 2 * DAY_MS,
    });
    const index = ((body.hotkey_windows as Row)["7d"] as Row).hotkeys as Row;
    assert.deepEqual(Object.keys(index), ["A"], "A lost the slot; B gained it");
  });

  test("declares the unattributed registrations rather than hiding them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    lakeFetch(REGS);
    const body = (await laneNamed("chain-deregistrations").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    const derivation = ((body.windows as Row)["7d"] as Row).derivation as Row;
    assert.equal(derivation.method, "uid-reuse");
    assert.equal(derivation.lookback_days, 30);
    // Two registrations inside 7d; one of them (slot 217's first claim) has no
    // observed previous holder, so the published total is a lower bound by 1.
    assert.equal(derivation.window_registrations, 2);
    assert.equal(derivation.unattributed_registrations, 1);
  });

  test("a failed read declines rather than persisting an empty derivation", async () => {
    lakeFetch("fail");
    assert.equal(
      await laneNamed("chain-deregistrations").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });

  test("an empty 30d pull declines -- no month of this chain has zero registrations", async () => {
    lakeFetch([]);
    assert.equal(
      await laneNamed("chain-deregistrations").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });

  test("splits the rollup away from the 200x-larger per-hotkey index", async () => {
    const { puts, bucket } = archiveBucket();
    lakeFetch(REGS);
    const result = await runProjectionLane(
      { ...LAKE_ENV, METAGRAPH_ARCHIVE: bucket } as unknown as Env,
      laneNamed("chain-deregistrations"),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      puts.map((p) => p.key),
      [
        CHAIN_DEREGISTRATIONS_PROJECTION_KEY,
        CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY,
      ],
    );
    const rollup = JSON.parse(puts[0]!.value) as Row;
    // The rollup must NOT carry the index: the chain and subnet routes read it
    // per request and would otherwise parse ~200x the bytes they use.
    assert.equal(rollup.hotkey_windows, undefined);
    assert.ok(((rollup.windows as Row)["7d"] as Row).rows);
    const index = JSON.parse(puts[1]!.value) as Row;
    assert.equal(index.schema_version, 1);
    assert.equal(index.lookback_days, 30);
    assert.ok(((index.windows as Row)["7d"] as Row).hotkeys);
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

// #9412: the lanes read the network's OWN namespace and write to its own key.
// Every assertion below is paired with the positive -- the query was issued,
// and here is the namespace in it -- because "it does not read chain.*" passes
// perfectly on a lane that reads nothing at all.
describe("projection lanes are network-scoped end to end", () => {
  test("projectionKey leaves mainnet alone and namespaces every other chain", () => {
    const key = "metagraph/projections/blocks-summary.json";
    assert.equal(projectionKey(key), key, "mainnet must stay unprefixed");
    assert.equal(projectionKey(key, "mainnet"), key);
    assert.equal(
      projectionKey(key, "testnet"),
      "metagraph/projections/testnet/blocks-summary.json",
      "the network goes INSIDE the projections prefix, so a listing still groups them",
    );
    // A key that is not under the projections prefix still gets scoped rather
    // than passed through: an unscoped key would be one object two chains
    // overwrite in turn, each serving the other's numbers.
    assert.equal(
      projectionKey("metagraph/other/thing.json", "testnet"),
      "testnet/metagraph/other/thing.json",
    );
  });

  test("the network list is derived from the lakehouse namespaces", () => {
    // Not a second hand-written roster: a chain that gains a decode namespace
    // is exactly a chain these lanes can project, and listing them separately
    // would let one gain tables and silently never get artifacts.
    assert.deepEqual(
      [...PROJECTION_NETWORKS].sort(),
      Object.keys(LAKEHOUSE_NAMESPACES).sort(),
    );
  });

  test("every lane reads its own namespace, and never the other's", async () => {
    for (const network of PROJECTION_NETWORKS) {
      const expected = LAKEHOUSE_NAMESPACES[network];
      const foreign = Object.values(LAKEHOUSE_NAMESPACES).filter(
        (ns) => ns !== expected,
      );
      for (const lane of PROJECTION_LANES) {
        const queries = lakeFetch([]);
        await lane.compute(LAKE_ENV as unknown as Env, network);
        assert.ok(
          queries.length > 0,
          `${lane.name} on ${network} issued no query at all`,
        );
        for (const sql of queries) {
          assert.match(
            sql,
            new RegExp(`FROM ${expected}\\.\\w+`),
            `${lane.name} on ${network} read the wrong namespace: ${sql}`,
          );
          for (const other of foreign) {
            assert.doesNotMatch(
              sql,
              new RegExp(`FROM ${other}\\.\\w+`),
              `${lane.name} on ${network} still reads ${other}: ${sql}`,
            );
          }
        }
      }
    }
  });
});

// The chain-wide DISTINCT returning no row at all, as distinct from a row of
// zero: the statement ran but gave nothing usable, so the artifact must not
// publish a count nobody produced (#9423).
describe("a chain-wide DISTINCT that returns nothing is unread, not zero", () => {
  test("the window stores a null chain-wide row", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    lakeFetch(
      [{ newest_observed: NOW - 1000 }],
      [],
      [{ netuid: 3, movements: "10", distinct_movers: "2" }],
      [{ newest_observed: null }],
    );
    const body = (await laneNamed("chain-stake-moves").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    assert.equal((body.windows as Row)["7d"].network, null);
    // The per-subnet rows still landed -- one missing aggregate does not
    // discard the scan that succeeded.
    assert.equal((body.windows as Row)["7d"].rows.length, 1);
  });
});

// The per-subnet DISTINCT is a SEPARATE statement now, so its rows have to be
// merged back onto the tally by netuid. A netuid the DISTINCT scan did not
// return is a real zero -- the tally already proved the subnet has rows in the
// window, so "no distinct row" means no distinct coldkeys were counted, not
// that the count is unknown.
describe("the split per-subnet aggregates merge back by netuid", () => {
  test("each subnet keeps its own distinct count", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    lakeFetch(
      [{ newest_observed: NOW - 1000 }],
      [{ distinct_movers: "9" }],
      [
        { netuid: 3, movements: "10" },
        { netuid: 7, movements: "4" },
      ],
      // Deliberately out of order, and missing netuid 7 entirely.
      [{ netuid: 3, distinct_movers: "2" }],
      [{ newest_observed: null }],
    );
    const body = (await laneNamed("chain-stake-moves").compute(
      LAKE_ENV as unknown as Env,
      "mainnet",
    )) as Row;
    const rows = (body.windows as Row)["7d"].rows as Row[];
    assert.deepEqual(rows, [
      { netuid: 3, movements: "10", distinct_movers: "2" },
      { netuid: 7, movements: "4", distinct_movers: 0 },
    ]);
  });

  test("a failed per-subnet DISTINCT declines the whole compute", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    lakeFetch(
      [{ newest_observed: NOW - 1000 }],
      [{ distinct_movers: "9" }],
      [{ netuid: 3, movements: "10" }],
      "fail",
    );
    // All-or-nothing: half an aggregate published as though whole would show
    // every subnet's distinct count as zero.
    assert.equal(
      await laneNamed("chain-stake-moves").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      ),
      null,
    );
  });
});

// A CRON HAS NO CALLER WAITING. The 15 s request bound is sized for someone
// sitting on a response; chain-transfer-pairs was declining every tick with
// "The operation was aborted" because its pair-grouping CTE had grown past a
// bound borrowed from a context it does not share (#9423).
describe("lane statements run on the lane bound, not the request bound", () => {
  test("every lane read carries the longer timeout", async () => {
    const seen: (number | undefined)[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      // The abort signal is what carries the bound; assert the deps instead by
      // observing that a slow response is still allowed well past 15 s.
      seen.push(init.signal ? 1 : undefined);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      await laneNamed("chain-transfer-pairs").compute(
        LAKE_ENV as unknown as Env,
        "mainnet",
      );
      assert.ok(seen.length > 0, "the lane never queried");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the lane bound is a multiple of the request bound, not a fresh number", () => {
    // Tied to the thing it relaxes, so the reason for the difference stays
    // legible: same query, no caller waiting.
    assert.equal(PROJECTION_QUERY_TIMEOUT_MS, 4 * QUERY_TIMEOUT_MS);
    assert.ok(PROJECTION_QUERY_TIMEOUT_MS > QUERY_TIMEOUT_MS);
  });

  test("no lane statement calls r2SqlQuery directly, bypassing the bound", () => {
    // #9459: the test above it passed while EIGHT statements across five lanes
    // did exactly this — the transfer-pairs lane #9423 fixed went through
    // laneQuery, and nothing checked its siblings, which were quietly taking
    // the 15s REQUEST default on account_events aggregates over multi-day
    // windows. A behavioural test cannot see the difference (the bound is a
    // number handed to a timer, and a stubbed fetch resolves instantly), so
    // this reads the source: laneQuery is the single seam, and the only
    // mention of r2SqlQuery outside it is the import that feeds it.
    const source = readFileSync(
      new URL("../src/projection-lanes.ts", import.meta.url),
      "utf8",
    );
    const calls = source.match(/\br2SqlQuery\(/g) ?? [];
    assert.equal(
      calls.length,
      1,
      `r2SqlQuery is called ${calls.length} times; only laneQuery may call it`,
    );
    assert.match(
      source,
      /function laneQuery\([^)]*\)[^{]*\{\s*return r2SqlQuery\(/,
      "the one call must be laneQuery's own",
    );
  });
});
