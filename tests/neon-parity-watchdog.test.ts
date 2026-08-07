// The D1<->Neon parity watchdog (src/neon-parity-watchdog.ts, #9846).
//
// The thing this has to get right is the DIFFERENCE between churn and a
// structural gap. Both look like "the counts disagree" in a single sample, and
// alarming on the first is how a check stops being read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  D1_MAX_COMPOUND_TERMS,
  NEON_PARITY_CRON,
  NEON_PARITY_LANE,
  PARITY_MIN_ROWS,
  PARITY_TABLES,
  describeParity,
  parityCountBatches,
  parityCountSql,
  parityGaps,
  persistentGaps,
  runNeonParityWatchdog,
  EXPECTED_DIVERGENCE,
} from "../src/neon-parity-watchdog.ts";

const ctx = { waitUntil() {} };
const NOW = 1_786_000_000_000;

function fakeDb(rows: unknown[] | null, throwIt = false) {
  const written: Record<string, unknown>[] = [];
  return {
    written,
    db: {
      prepare(sql: string) {
        return {
          async all() {
            // loadLatestLaneHealth reads lane_health through the same
            // prepare().all() shape, so the fake has to answer by STATEMENT
            // rather than by call order.
            if (/lane_health/i.test(sql)) return { results: fakeDb.laneRows };
            if (throwIt && sql.startsWith("SELECT '"))
              throw new Error("D1_ERROR");
            // THE FAKE ENFORCES D1'S REAL CEILING. Without this the double
            // accepts any width, the suite agrees with whatever the code
            // happens to build, and #9850 ships a lane that reports
            // `unknown: counts unreadable` every hour for its whole life --
            // which is exactly what happened. A test that only asserts the
            // code's own assumption cannot see the store disagreeing with it.
            if (sql.startsWith("SELECT '")) {
              const terms = sql.split(/\bUNION ALL\b/).length;
              if (terms > D1_MAX_COMPOUND_TERMS)
                throw new Error(
                  "D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR",
                );
            }
            return rows === null ? null : { results: rows };
          },
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT"))
                  written.push({
                    lane: values[0],
                    verdict: values[1],
                    detail: values[3],
                  });
              },
              async all() {
                return { results: fakeDb.laneRows };
              },
            };
          },
        };
      },
    },
  };
}
fakeDb.laneRows = [] as Record<string, unknown>[];

const pg = (rows: unknown, fail = false) => ({
  async unsafe() {
    if (fail) throw new Error("relation missing");
    return rows as never;
  },
});

const counts = (m: Record<string, number>) =>
  Object.entries(m).map(([t, n]) => ({ t, n }));

describe("parityCountSql", () => {
  test("one counted SELECT per table, unioned", () => {
    const sql = parityCountSql(["a", "b"]);
    assert.equal(
      sql,
      "SELECT 'a' AS t, COUNT(*) AS n FROM a UNION ALL SELECT 'b' AS t, COUNT(*) AS n FROM b",
    );
  });

  test("the same statement runs on both stores", () => {
    // The point of `'x' AS t` over a per-table round trip: identical text on
    // both sides means a difference cannot come from asking different things.
    assert.ok(!/\?|\$\d/.test(parityCountSql([...PARITY_TABLES])));
  });
});

describe("parityCountBatches", () => {
  test("no batch is wider than D1 will parse", () => {
    // The ceiling is 5, measured against production. Anything above it does
    // not degrade -- it throws, and the sweep reads NOTHING.
    for (const sql of parityCountBatches([...PARITY_TABLES])) {
      assert.ok(
        sql.split(/\bUNION ALL\b/).length <= D1_MAX_COMPOUND_TERMS,
        `batch too wide: ${sql}`,
      );
    }
  });

  test("every table is counted exactly once", () => {
    const named = parityCountBatches([...PARITY_TABLES])
      .flatMap((sql) => [...sql.matchAll(/SELECT '(\w+)' AS t/g)])
      .map((m) => m[1]);
    assert.deepEqual(named.sort(), [...PARITY_TABLES].sort());
  });

  test("the live table list ACTUALLY needs splitting", () => {
    // A negative assertion passes on nothing. If PARITY_TABLES ever shrank to
    // five, the two tests above would hold on a single batch and stop proving
    // that batching works at all -- so pin that the real config exercises it.
    assert.ok(
      PARITY_TABLES.length > D1_MAX_COMPOUND_TERMS,
      "PARITY_TABLES no longer exceeds one batch; this suite stopped testing the split",
    );
    assert.ok(parityCountBatches([...PARITY_TABLES]).length > 1);
  });

  test("a table list that fits stays one statement", () => {
    assert.equal(parityCountBatches(["a", "b"]).length, 1);
  });

  test("the width is overridable, and the remainder is not dropped", () => {
    // 5 tables at 2 per batch is 3 batches, the last holding ONE -- the case
    // an off-by-one in the loop bound loses silently.
    const batches = parityCountBatches(["a", "b", "c", "d", "e"], 2);
    assert.equal(batches.length, 3);
    assert.equal(batches[2], parityCountSql(["e"]));
  });
});

describe("parityGaps", () => {
  test("reports differences in BOTH directions", () => {
    // hotkey_alpha's real shape: Neon holds MORE. A check written as
    // "is Neon behind D1" would call that table healthy (#9832).
    const gaps = parityGaps(
      new Map([["hotkey_alpha", 17867]]),
      new Map([["hotkey_alpha", 47320]]),
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.delta, -29453);
  });

  test("ignores a difference below the floor", () => {
    assert.deepEqual(
      parityGaps(
        new Map([["t", 100]]),
        new Map([["t", 100 - PARITY_MIN_ROWS + 1]]),
      ),
      [],
    );
  });

  test("catches a difference AT the floor, so 14 is not waved through", () => {
    const gaps = parityGaps(new Map([["t", 100]]), new Map([["t", 95]]));
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.delta, 5);
  });

  test("a table absent from one store is not a gap", () => {
    // Before migrations/neon/0001 the three side tables existed only in D1.
    // Reporting those as a gap of their entire contents would bury the real
    // ones under noise nobody can act on.
    assert.deepEqual(parityGaps(new Map([["t", 500]]), new Map()), []);
  });

  test("orders by magnitude, so the worst reads first", () => {
    const gaps = parityGaps(
      new Map([
        ["small", 100],
        ["big", 50000],
      ]),
      new Map([
        ["small", 86],
        ["big", 20000],
      ]),
    );
    assert.deepEqual(
      gaps.map((g) => g.table),
      ["big", "small"],
    );
  });
});

describe("persistentGaps", () => {
  const gap = (table: string, delta: number) => ({
    table,
    d1: 0,
    neon: -delta,
    delta,
  });

  test("a gap of the SAME size in the previous tick is structural", () => {
    assert.deepEqual(
      persistentGaps([gap("vnc", 14)], "vnc +14").map((g) => g.table),
      ["vnc"],
    );
  });

  test("a gap that MOVED is churn, not a finding", () => {
    // The distinction the whole lane rests on: a producer pass landing between
    // the two counts shows a different number every tick.
    assert.deepEqual(
      persistentGaps([gap("balances", 125)], "balances +91"),
      [],
    );
  });

  test("a SHRINKING gap does not alarm while a backfill works", () => {
    assert.deepEqual(persistentGaps([gap("snap", 40000)], "snap +50375"), []);
  });

  test("negative deltas round-trip through the detail line", () => {
    // `-29453` has to parse back with its sign, or the table with the most
    // rows in Neon would look new every hour and never be called persistent.
    // Deliberately NOT hotkey_alpha: that one is an expected divergence and
    // would return [] for a different reason, hiding what this asserts.
    assert.deepEqual(
      persistentGaps([gap("some_table", -29453)], "some_table -29453").map(
        (g) => g.delta,
      ),
      [-29453],
    );
  });

  test("an EXPECTED divergence never becomes persistent, however stable", () => {
    // hotkey_alpha diverges by design: D1 filters to referenced pools (#9558),
    // the mirror does not (#9832). A stable ~29,000-row gap is the correct
    // state today, and alarming on it hourly would teach everyone to ignore
    // this lane before it had caught anything real.
    assert.deepEqual(
      persistentGaps([gap("hotkey_alpha", -29453)], "hotkey_alpha -29453"),
      [],
    );
    // ...but an ordinary table with the same stable gap still alarms.
    assert.equal(
      persistentGaps(
        [gap("nominator_positions", 13402)],
        "nominator_positions +13402",
      ).length,
      1,
    );
  });

  test("every expected divergence names a table and a reason", () => {
    // An exemption without a reason is indistinguishable from a bug someone
    // muted, so the reason is the entry's whole justification for existing.
    for (const [table, why] of Object.entries(EXPECTED_DIVERGENCE)) {
      assert.ok(
        PARITY_TABLES.includes(table as (typeof PARITY_TABLES)[number]),
        `${table} is exempted but not watched`,
      );
      assert.match(why, /#\d+/, `${table}'s exemption cites no issue`);
    }
  });

  test("an expected divergence is still REPORTED, not silenced", () => {
    // Naming it keeps the day it changes size visible. Dropping it from the
    // detail would hide a NEW reason behind a known one.
    const detail = describeParity([gap("hotkey_alpha", -29453)], 10);
    assert.match(detail, /hotkey_alpha -29453/);
  });

  test("no previous verdict means nothing is persistent yet", () => {
    assert.deepEqual(persistentGaps([gap("t", 9)], null), []);
    assert.deepEqual(persistentGaps([gap("t", 9)], ""), []);
  });
});

describe("describeParity", () => {
  test("names the count when everything agrees", () => {
    assert.equal(describeParity([], 10), "10 table(s) in parity");
  });

  test("emits signed deltas that persistentGaps can read back", () => {
    const detail = describeParity(
      [
        { table: "a", d1: 1, neon: 2, delta: -1 },
        { table: "b", d1: 5, neon: 1, delta: 4 },
      ],
      10,
    );
    assert.equal(detail, "a -1, b +4");
    assert.equal(
      persistentGaps([{ table: "b", d1: 5, neon: 1, delta: 4 }], detail).length,
      1,
    );
  });
});

describe("runNeonParityWatchdog", () => {
  test("does nothing without both stores bound", async () => {
    assert.deepEqual(await runNeonParityWatchdog({}, ctx), {
      attempted: false,
    });
    assert.deepEqual(
      await runNeonParityWatchdog({}, ctx, { db: fakeDb([]).db }),
      { attempted: false },
    );
  });

  test("reports ok when the stores agree", async () => {
    fakeDb.laneRows = [];
    const d1 = fakeDb(counts({ neurons: 30110 }));
    const out = await runNeonParityWatchdog({}, ctx, {
      db: d1.db,
      sql: pg(counts({ neurons: 30110 })),
      laneHealthDb: d1.db,
      now: () => NOW,
    });
    assert.equal(out.attempted, true);
    assert.deepEqual(out.gaps, []);
    assert.equal(d1.written[0]!.verdict, "ok");
    assert.match(String(d1.written[0]!.detail), /1 table\(s\) in parity/);
  });

  test("a FIRST sighting is ok, and is recorded so the next tick can judge", async () => {
    fakeDb.laneRows = [];
    const d1 = fakeDb(counts({ vnc: 112250 }));
    const out = await runNeonParityWatchdog({}, ctx, {
      db: d1.db,
      sql: pg(counts({ vnc: 112236 })),
      laneHealthDb: d1.db,
      now: () => NOW,
    });
    assert.equal(out.gaps?.length, 1);
    assert.deepEqual(out.persistent, []);
    assert.equal(d1.written[0]!.verdict, "ok", "one sample cannot prove a gap");
    assert.match(String(d1.written[0]!.detail), /vnc \+14/);
  });

  test("the SAME gap next tick is stale", async () => {
    fakeDb.laneRows = [
      {
        lane: NEON_PARITY_LANE,
        verdict: "ok",
        detail: "vnc +14",
        checked_at: NOW - 3600_000,
        age_ms: null,
      },
    ];
    const d1 = fakeDb(counts({ vnc: 112250 }));
    const out = await runNeonParityWatchdog({}, ctx, {
      db: d1.db,
      sql: pg(counts({ vnc: 112236 })),
      laneHealthDb: d1.db,
      now: () => NOW,
    });
    assert.equal(out.persistent?.length, 1);
    assert.equal(d1.written[0]!.verdict, "stale");
  });

  test("a store that will not answer is unknown, never stale", async () => {
    // Calling an unreadable store a gap would list every table as broken,
    // which is both wrong and unactionable.
    fakeDb.laneRows = [];
    const d1 = fakeDb(counts({ t: 1 }));
    const out = await runNeonParityWatchdog({}, ctx, {
      db: d1.db,
      sql: pg(null, true),
      laneHealthDb: d1.db,
      now: () => NOW,
    });
    assert.equal(out.reason, "counts unreadable");
    assert.equal(d1.written[0]!.verdict, "unknown");
  });

  test("a D1 response with no result at all is unknown too", async () => {
    fakeDb.laneRows = [];
    const d1 = fakeDb(null);
    const out = await runNeonParityWatchdog({}, ctx, {
      db: d1.db,
      sql: pg(counts({ t: 1 })),
      laneHealthDb: d1.db,
      now: () => NOW,
    });
    assert.equal(out.reason, "counts unreadable");
    assert.equal(d1.written[0]!.verdict, "unknown");
  });

  test("a non-array answer from Neon yields no counts rather than throwing", async () => {
    fakeDb.laneRows = [];
    const d1 = fakeDb(counts({ t: 1 }));
    const out = await runNeonParityWatchdog({}, ctx, {
      db: d1.db,
      sql: pg({ rows: 1 }),
      laneHealthDb: d1.db,
      now: () => NOW,
    });
    // No Neon count for `t`, so it is "absent from one store", not a gap.
    assert.deepEqual(out.gaps, []);
  });

  test("rows missing t or n are skipped, not counted as zero", async () => {
    fakeDb.laneRows = [];
    const d1 = fakeDb([
      { t: null, n: 5 },
      { t: "x", n: null },
      { t: "y", n: 100 },
    ]);
    const out = await runNeonParityWatchdog({}, ctx, {
      db: d1.db,
      sql: pg([{ t: "y", n: 100 }]),
      laneHealthDb: d1.db,
      now: () => NOW,
    });
    assert.deepEqual(out.gaps, []);
    assert.match(String(d1.written[0]!.detail), /1 table\(s\)/);
  });
});

test("a non-numeric count is skipped rather than read as zero", async () => {
  // Zero would be the worst possible reading: it makes the OTHER store's
  // whole contents look like a gap, which is the shape of a mistaken copy.
  fakeDb.laneRows = [];
  const d1 = fakeDb([{ t: "y", n: "not-a-number" }]);
  const out = await runNeonParityWatchdog({}, ctx, {
    db: d1.db,
    sql: pg([{ t: "y", n: 100 }]),
    laneHealthDb: d1.db,
    now: () => NOW,
  });
  assert.deepEqual(out.gaps, []);
});

test("HYPERDRIVE alone is enough to build the Neon side", async () => {
  // The runner builds its own createPgSql when `deps.sql` is absent, which
  // is how it runs in production -- the injected form only exists for tests.
  fakeDb.laneRows = [];
  const d1 = fakeDb(counts({ t: 1 }));
  const out = await runNeonParityWatchdog(
    {
      METAGRAPH_HEALTH_DB: d1.db,
      HYPERDRIVE: { connectionString: "postgres://x" },
    },
    ctx,
    { now: () => NOW },
  );
  // It attempted, then failed to reach the fake connection string -- which
  // is the `unknown` path, not a silent no-op.
  assert.equal(out.attempted, true);
  assert.equal(out.reason, "counts unreadable");
});

test("a D1 response with no `results` key counts nothing", async () => {
  // `{}` is not `null`: the request succeeded and carried no rows, which is
  // still "no counts" rather than an error.
  fakeDb.laneRows = [];
  const lane = fakeDb([]);
  const db = {
    prepare(sql: string) {
      return {
        async all() {
          return /lane_health/i.test(sql) ? { results: [] } : {};
        },
        bind: () => ({
          async run() {},
          async all() {
            return { results: [] };
          },
        }),
      };
    },
  };
  const out = await runNeonParityWatchdog({}, ctx, {
    db: db as never,
    sql: pg([{ t: "y", n: 1 }]),
    laneHealthDb: lane.db,
    now: () => NOW,
  });
  assert.deepEqual(out.gaps, []);
});

test("a non-Error thrown value still reaches the detail line", async () => {
  fakeDb.laneRows = [];
  const d1 = fakeDb(counts({ t: 1 }));
  const out = await runNeonParityWatchdog({}, ctx, {
    db: d1.db,
    sql: {
      async unsafe() {
        throw "plain string";
      },
    },
    laneHealthDb: d1.db,
    now: () => NOW,
  });
  assert.equal(out.reason, "counts unreadable");
  assert.match(String(d1.written[0]!.detail), /plain string/);
});

describe("the deployed wiring", () => {
  const wrangler = readFileSync("wrangler.data.jsonc", "utf8");

  test("the cron slot is scheduled", () => {
    assert.ok(
      wrangler.includes(`"${NEON_PARITY_CRON}"`),
      `${NEON_PARITY_CRON} is not in the deployed crons, so this lane never runs`,
    );
  });

  test("every mirrored or backfilled table is watched", () => {
    // The gap this lane exists to close: a table written to both stores with
    // nothing comparing them. Anything named in either flag must be here.
    const named = (re: RegExp) =>
      (re.exec(wrangler)?.[1] ?? "")
        .split(",")
        .map((s) => s.trim().replace(/-/g, "_"))
        .filter(Boolean);
    const watched = new Set<string>(PARITY_TABLES);
    for (const t of [
      ...named(/"NEON_DUAL_WRITE_LANES":\s*"([^"]*)"/),
      ...named(/"NEON_BACKFILL_LANES":\s*"([^"]*)"/),
    ]) {
      assert.ok(
        watched.has(t),
        `${t} is written to Neon but not in PARITY_TABLES`,
      );
    }
  });
});
