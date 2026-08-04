// The registration-cost series (src/subnet-burn-history.ts, #9402).
//
// Two properties carry the weight. A captured price of 0 is REAL -- netuid 76 reads a
// true zero and is the cheapest registration on the network -- so "no reading" must be
// an absent row rather than a zero one, or the series grows false bargains. And the
// capture must never be able to take down the cron it runs on, because a lane that
// fails loudly at the wrong moment costs more than a gap in a chart.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BURN_HISTORY_MAX_POINTS,
  BURN_HISTORY_RETENTION_MS,
  BURN_HISTORY_WINDOWS,
  DEFAULT_BURN_HISTORY_WINDOW,
  SUBNET_BURN_HISTORY_TABLE,
  buildSubnetBurnHistory,
  captureSubnetBurnHistory,
  loadSubnetBurnHistory,
} from "../src/subnet-burn-history.ts";
import { SubnetBurnHistoryArtifactSchema } from "../schemas-src/routes/subnet-registration-cost.ts";

type Row = Record<string, unknown>;

const NOW = 1_785_800_000_000;

/** A D1 double recording every statement and its bound values. */
function fakeDb({ failBatch = false, failSweep = false } = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const call = { sql, values };
          return {
            run: async () => {
              calls.push(call);
              if (failSweep && sql.startsWith("DELETE")) {
                throw new Error("D1_ERROR: busy");
              }
              return { success: true };
            },
            all: async () => {
              calls.push(call);
              return { results: [] };
            },
            __call: call,
          };
        },
      };
    },
    async batch(statements: unknown[]) {
      if (failBatch) throw new Error("D1_ERROR: no such table");
      for (const s of statements) {
        calls.push(
          (s as { __call: { sql: string; values: unknown[] } }).__call,
        );
      }
      return [];
    },
  };
  return { db, calls };
}

function card(subnets: Array<{ netuid: number; burn_tao: number }>) {
  return async () => ({ schema_version: 1, subnets }) as Row;
}

describe("captureSubnetBurnHistory", () => {
  test("writes one row per subnet, all sharing the tick's stamp", async () => {
    // One observed_at for the whole batch: every price came from the same block, so
    // sharing the stamp is what makes a cross-subnet comparison at a point in time
    // meaningful rather than smeared across the write.
    const { db, calls } = fakeDb();
    const result = await captureSubnetBurnHistory({} as never, {
      db,
      now: () => NOW,
      load: card([
        { netuid: 0, burn_tao: 0.0005 },
        { netuid: 76, burn_tao: 0 },
      ]) as never,
    });
    assert.deepEqual(result, { ok: true, captured: 2, pruned: true });
    const inserts = calls.filter((c) => c.sql.startsWith("INSERT"));
    assert.equal(inserts.length, 2);
    assert.deepEqual(inserts[0].values, [0, NOW, 0.0005]);
    assert.deepEqual(inserts[1].values, [76, NOW, 0]);
    assert.equal(new Set(inserts.map((c) => c.values[1])).size, 1);
  });

  test("a genuine zero price is recorded, not skipped", async () => {
    // netuid 76 is the cheapest registration on the network. Dropping it as falsy
    // would erase the best answer from the series it exists to provide.
    const { db, calls } = fakeDb();
    await captureSubnetBurnHistory({} as never, {
      db,
      now: () => NOW,
      load: card([{ netuid: 76, burn_tao: 0 }]) as never,
    });
    assert.deepEqual(
      calls.filter((c) => c.sql.startsWith("INSERT"))[0].values,
      [76, NOW, 0],
    );
  });

  test("an unreadable price is an ABSENT row, never a zero one", async () => {
    // The inverse of the rule above, and the reason it matters: writing 0 for
    // "unknown" would put a false bargain in the series that reads as measured.
    const { db, calls } = fakeDb();
    const result = await captureSubnetBurnHistory({} as never, {
      db,
      now: () => NOW,
      load: (async () => ({
        subnets: [
          { netuid: 1, burn_tao: null },
          { netuid: 2, burn_tao: "nope" },
          { netuid: -1, burn_tao: 5 },
          { netuid: 1.5, burn_tao: 5 },
          { netuid: 3, burn_tao: -1 },
          { netuid: 4, burn_tao: 0.25 },
        ],
      })) as never,
    });
    assert.equal(result.captured, 1);
    assert.deepEqual(
      calls.filter((c) => c.sql.startsWith("INSERT"))[0].values,
      [4, NOW, 0.25],
    );
  });

  test("the write is idempotent, so a retried tick is not a key error", async () => {
    const { db, calls } = fakeDb();
    await captureSubnetBurnHistory({} as never, {
      db,
      now: () => NOW,
      load: card([{ netuid: 1, burn_tao: 1 }]) as never,
    });
    assert.match(calls[0].sql, /^INSERT OR REPLACE INTO /);
  });

  test("expired rows are swept, bounded by the retention horizon", async () => {
    const { db, calls } = fakeDb();
    await captureSubnetBurnHistory({} as never, {
      db,
      now: () => NOW,
      load: card([{ netuid: 1, burn_tao: 1 }]) as never,
    });
    const sweep = calls.find((c) => c.sql.startsWith("DELETE"))!;
    assert.match(sweep.sql, new RegExp(`FROM ${SUBNET_BURN_HISTORY_TABLE}`));
    assert.deepEqual(sweep.values, [NOW - BURN_HISTORY_RETENTION_MS]);
  });

  test("a failed sweep does not report the capture as failed", async () => {
    // The prices are already committed by then. Reporting failure would send an
    // operator looking for a data gap that does not exist.
    const { db } = fakeDb({ failSweep: true });
    const result = await captureSubnetBurnHistory({} as never, {
      db,
      now: () => NOW,
      load: card([{ netuid: 1, burn_tao: 1 }]) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.captured, 1);
    assert.equal(result.pruned, false, "and it says the sweep did not run");
  });

  test("a non-Error throw still produces a readable reason", async () => {
    // Nothing guarantees a rejected promise carries an Error. A bare String() on the
    // value keeps the reason readable instead of rendering "undefined".
    for (const [load, batch, expect] of [
      [
        async () => {
          throw "chain exploded";
        },
        false,
        /chain_read_failed: chain exploded/,
      ],
      [null, true, /write_failed: kaboom/],
    ] as const) {
      const db = batch
        ? {
            prepare: (sql: string) => ({
              bind: (...values: unknown[]) => ({
                run: async () => ({}),
                __call: { sql, values },
              }),
            }),
            batch: async () => {
              throw "kaboom";
            },
          }
        : fakeDb().db;
      const result = await captureSubnetBurnHistory({} as never, {
        db: db as never,
        now: () => NOW,
        load: (load ?? card([{ netuid: 1, burn_tao: 1 }])) as never,
      });
      assert.equal(result.ok, false);
      assert.match(String(result.reason), expect);
    }
  });

  test("a card with no subnets array is an empty read, not a crash", async () => {
    const { db } = fakeDb();
    const result = await captureSubnetBurnHistory({} as never, {
      db,
      now: () => NOW,
      load: (async () => ({ schema_version: 1 })) as never,
    });
    assert.equal(result.reason, "empty_read");
  });

  test("every failure is reported, never thrown", async () => {
    // A capture lane that could take down the cron it runs on would be worse than a
    // gap in the series.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ db: null }, "no_d1_binding"],
      [
        {
          db: fakeDb().db,
          load: async () => {
            throw new Error("chain down");
          },
        },
        "chain_read_failed",
      ],
      [{ db: fakeDb().db, load: card([]) }, "empty_read"],
      [
        {
          db: fakeDb({ failBatch: true }).db,
          load: card([{ netuid: 1, burn_tao: 1 }]),
        },
        "write_failed",
      ],
    ];
    for (const [opts, reason] of cases) {
      const result = await captureSubnetBurnHistory(
        {} as never,
        {
          now: () => NOW,
          ...(opts as object),
        } as never,
      );
      assert.equal(result.ok, false, reason);
      assert.equal(result.captured, 0);
      assert.match(String(result.reason), new RegExp(`^${reason}`));
    }
  });
});

describe("buildSubnetBurnHistory", () => {
  const POINTS = [
    { observed_at: NOW, burn_tao: 0.5 },
    { observed_at: NOW - 3_600_000, burn_tao: 0.25 },
    { observed_at: NOW - 7_200_000, burn_tao: 0.1 },
  ];

  test("reports the newest price and the movement across the window", () => {
    const c = buildSubnetBurnHistory(POINTS, 7, { window: "7d" });
    assert.equal(c.point_count, 3);
    assert.equal(c.current_burn_tao, 0.5);
    // 0.5 - 0.1, across the RETURNED window.
    assert.equal(c.change_tao, 0.4);
    assert.equal(c.change_pct, 4);
  });

  test("a single point has no change to report", () => {
    const c = buildSubnetBurnHistory([POINTS[0]], 7, { window: "24h" });
    assert.equal(c.current_burn_tao, 0.5);
    assert.equal(c.change_tao, null);
    assert.equal(c.change_pct, null);
  });

  test("a rise from zero has no percentage, and does not become Infinity", () => {
    // Infinity serializes to null with nothing to say why. An explicit null is the
    // same answer with the reason preserved in the schema's own description.
    const c = buildSubnetBurnHistory(
      [
        { observed_at: NOW, burn_tao: 0.5 },
        { observed_at: NOW - 1000, burn_tao: 0 },
      ],
      7,
    );
    assert.equal(c.change_tao, 0.5);
    assert.equal(c.change_pct, null);
  });

  test("a fall is reported as a negative change, not an absolute one", () => {
    const c = buildSubnetBurnHistory(
      [
        { observed_at: NOW, burn_tao: 0.1 },
        { observed_at: NOW - 1000, burn_tao: 0.5 },
      ],
      7,
    );
    assert.equal(c.change_tao, -0.4);
    assert.equal(c.change_pct, -0.8);
  });

  test("an empty series is a real answer, with nulls rather than zeroes", () => {
    // A subnet nobody has recorded yet has an unknown price, not a free one.
    for (const empty of [null, undefined, [], "nonsense"]) {
      const c = buildSubnetBurnHistory(empty as never, 7, { window: "7d" });
      assert.deepEqual(c.points, []);
      assert.equal(c.point_count, 0);
      assert.equal(c.current_burn_tao, null);
      assert.equal(c.change_tao, null);
      assert.equal(c.change_pct, null);
    }
  });

  test("unusable rows are dropped rather than shaped into nulls", () => {
    const c = buildSubnetBurnHistory(
      [
        { observed_at: NOW, burn_tao: 0.5 },
        { observed_at: null, burn_tao: 1 },
        { observed_at: 0, burn_tao: 1 },
        { observed_at: NOW, burn_tao: "nope" },
      ],
      7,
    );
    assert.equal(c.point_count, 1);
  });

  test("timestamps are serialized, not passed through as epoch integers", () => {
    const c = buildSubnetBurnHistory(POINTS, 7);
    assert.equal(
      (c.points as Row[])[0].observed_at,
      new Date(NOW).toISOString(),
    );
  });

  test("the card satisfies its published schema", () => {
    for (const rows of [POINTS, []]) {
      const parsed = SubnetBurnHistoryArtifactSchema.safeParse(
        buildSubnetBurnHistory(rows, 7, { window: "7d" }),
      );
      assert.equal(
        parsed.success,
        true,
        parsed.success ? "" : JSON.stringify(parsed.error.issues),
      );
    }
  });
});

describe("loadSubnetBurnHistory", () => {
  test("reads newest-first, windowed, and bounded", async () => {
    const { db, calls } = fakeDb();
    await loadSubnetBurnHistory(db, 7, { windowDays: 7, now: () => NOW });
    const read = calls[0];
    assert.match(read.sql, /ORDER BY observed_at DESC/);
    assert.match(read.sql, new RegExp(`LIMIT ${BURN_HISTORY_MAX_POINTS}`));
    assert.deepEqual(read.values, [7, NOW - 7 * 24 * 60 * 60 * 1000]);
  });

  test("a missing binding or failed read is null, not an empty series", async () => {
    // Null lets the caller keep "we could not read" distinct from "nothing recorded",
    // which are different answers to "is this subnet getting more expensive".
    assert.equal(
      await loadSubnetBurnHistory(null, 7, { windowDays: 7, now: () => NOW }),
      null,
    );
    const broken = {
      prepare() {
        throw new Error("D1_ERROR: no such table");
      },
    };
    assert.equal(
      await loadSubnetBurnHistory(broken as never, 7, {
        windowDays: 7,
        now: () => NOW,
      }),
      null,
    );
  });

  test("a read that returns no result set is an empty series, not null", async () => {
    // D1 can answer with no `results` key. That is zero rows, which is a real
    // answer -- distinct from the read failing, which is what null means here.
    const db = {
      prepare: () => ({ bind: () => ({ all: async () => null }) }),
    };
    assert.deepEqual(
      await loadSubnetBurnHistory(db as never, 7, {
        windowDays: 7,
        now: () => NOW,
      }),
      [],
    );
  });

  test("an out-of-range timestamp is dropped rather than throwing", () => {
    // A finite but absurd epoch would make `new Date()` produce an Invalid Date,
    // and `.toISOString()` on that throws -- taking down a whole series for one row.
    const c = buildSubnetBurnHistory(
      [
        { observed_at: 8.64e15 + 1, burn_tao: 1 },
        { observed_at: NOW, burn_tao: 2 },
      ],
      7,
    );
    assert.equal(c.point_count, 1);
    assert.equal(c.current_burn_tao, 2);
  });

  test("every published window maps to a real day count", () => {
    // The route rejects anything outside this map, so a window here with no days
    // would 400 a documented value.
    for (const [label, days] of Object.entries(BURN_HISTORY_WINDOWS)) {
      assert.ok(Number.isFinite(days) && days > 0, label);
    }
    assert.ok(BURN_HISTORY_WINDOWS[DEFAULT_BURN_HISTORY_WINDOW]);
  });
});
