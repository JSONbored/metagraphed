// #9622: /api/v1/health/failure-reasons -- why surfaces fail, and whether the
// mix is changing.
//
// The rollup writer is asserted against a REAL SQLite engine because its whole
// correctness rests on one thing a mock cannot show: the ON CONFLICT target is
// an EXPRESSION (`ifnull(netuid, -1)`) matching 0025's unique index, and a
// registry-level surface -- the one with a NULL netuid -- is exactly the row a
// plain column key would silently duplicate on every hourly tick.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildFailureReasons,
  declineFailureReasons,
  FAILURE_CLASSIFICATIONS,
  FAILURE_REASONS_TABLE,
  loadFailureReasons,
} from "../src/failure-reasons.ts";
import { rollupFailureReasonsToD1 } from "../src/observations-d1.ts";

/** 0025's table, so the expression index is the one under test. */
function rollupDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE ${FAILURE_REASONS_TABLE} (
       day TEXT NOT NULL, netuid INTEGER, kind TEXT NOT NULL,
       classification TEXT NOT NULL, checks INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  );
  sqlite.exec(
    `CREATE UNIQUE INDEX ux ON ${FAILURE_REASONS_TABLE}
       (day, ifnull(netuid, -1), kind, classification)`,
  );
  sqlite.exec(
    `CREATE TABLE surface_checks (
       netuid INTEGER, kind TEXT, classification TEXT, checked_at INTEGER NOT NULL
     )`,
  );
  return sqlite;
}

/** The ObservationsDb shape the rollup writer binds against. */
function asDb(sqlite: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...values: unknown[]) {
          return { __stmt: stmt, __values: values };
        },
      };
    },
    async batch(stmts: Array<{ __stmt: unknown; __values: unknown[] }>) {
      for (const s of stmts) {
        (s.__stmt as { run(...v: unknown[]): void }).run(...s.__values);
      }
      return [];
    },
  } as never;
}

/** A read surface over the rollup table, for loadFailureReasons. */
function readDb(sqlite: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...values: unknown[]) {
          return {
            all: async () => ({
              results: stmt.all(...(values as Array<string | number | null>)),
            }),
          };
        },
      };
    },
  };
}

const DAY_MS = 86_400_000;
const T = Date.UTC(2026, 7, 5, 12); // 2026-08-05T12:00:00Z

describe("rollupFailureReasonsToD1", () => {
  const days = [
    {
      date: "2026-08-05",
      start: Date.UTC(2026, 7, 5),
      end: Date.UTC(2026, 7, 6),
    },
  ];

  it("aggregates a day's raw checks by netuid, kind and classification", async () => {
    const sqlite = rollupDb();
    const ins = sqlite.prepare(
      "INSERT INTO surface_checks (netuid, kind, classification, checked_at) VALUES (?,?,?,?)",
    );
    ins.run(7, "api", "live", T);
    ins.run(7, "api", "live", T + 1000);
    ins.run(7, "api", "timeout", T);
    ins.run(11, "api", "dead", T);

    const out = await rollupFailureReasonsToD1(asDb(sqlite), days, T);
    expect(out.rolled).toBe(true);
    const rows = sqlite
      .prepare(
        `SELECT netuid, classification, checks FROM ${FAILURE_REASONS_TABLE} ORDER BY netuid, classification`,
      )
      .all();
    expect(rows).toEqual([
      { netuid: 7, classification: "live", checks: 2 },
      { netuid: 7, classification: "timeout", checks: 1 },
      { netuid: 11, classification: "dead", checks: 1 },
    ]);
  });

  it("UPDATES a registry-level (null netuid) row instead of duplicating it", async () => {
    // The case the expression index exists for. SQLite treats NULLs as distinct
    // in a unique constraint, so a plain column key would append a second row
    // here on every hourly tick and double the counts.
    const sqlite = rollupDb();
    const ins = sqlite.prepare(
      "INSERT INTO surface_checks (netuid, kind, classification, checked_at) VALUES (?,?,?,?)",
    );
    ins.run(null, "docs", "live", T);

    await rollupFailureReasonsToD1(asDb(sqlite), days, T);
    ins.run(null, "docs", "live", T + 1000);
    await rollupFailureReasonsToD1(asDb(sqlite), days, T + 3_600_000);

    const rows = sqlite
      .prepare(`SELECT netuid, checks FROM ${FAILURE_REASONS_TABLE}`)
      .all();
    expect(rows).toEqual([{ netuid: null, checks: 2 }]);
  });

  it("is idempotent across ticks for a subnet-scoped row too", async () => {
    const sqlite = rollupDb();
    sqlite
      .prepare(
        "INSERT INTO surface_checks (netuid, kind, classification, checked_at) VALUES (?,?,?,?)",
      )
      .run(3, "api", "rate-limited", T);
    await rollupFailureReasonsToD1(asDb(sqlite), days, T);
    await rollupFailureReasonsToD1(asDb(sqlite), days, T + 3_600_000);
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${FAILURE_REASONS_TABLE}`)
        .get(),
    ).toEqual({ n: 1 });
  });

  it("skips a check that cannot say which kind or reason it describes", async () => {
    // Not bucketed under a placeholder: a row with no classification cannot
    // honestly be counted in any classification's mix.
    const sqlite = rollupDb();
    const ins = sqlite.prepare(
      "INSERT INTO surface_checks (netuid, kind, classification, checked_at) VALUES (?,?,?,?)",
    );
    ins.run(7, null, "live", T);
    ins.run(7, "api", null, T);
    ins.run(7, "api", "live", T);
    await rollupFailureReasonsToD1(asDb(sqlite), days, T);
    expect(
      sqlite.prepare(`SELECT checks FROM ${FAILURE_REASONS_TABLE}`).all(),
    ).toEqual([{ checks: 1 }]);
  });

  it("counts only the day it was asked for", async () => {
    const sqlite = rollupDb();
    const ins = sqlite.prepare(
      "INSERT INTO surface_checks (netuid, kind, classification, checked_at) VALUES (?,?,?,?)",
    );
    ins.run(7, "api", "live", T);
    ins.run(7, "api", "live", T - DAY_MS);
    await rollupFailureReasonsToD1(asDb(sqlite), days, T);
    expect(
      sqlite.prepare(`SELECT checks FROM ${FAILURE_REASONS_TABLE}`).all(),
    ).toEqual([{ checks: 1 }]);
  });

  it("reports rolled:false without a database rather than throwing", async () => {
    expect(await rollupFailureReasonsToD1(undefined, days, T)).toEqual({
      rolled: false,
    });
  });

  it("reports rolled:false and the message when the write throws", async () => {
    // Not swallowed: a silent failure here freezes the reason series while the
    // uptime series keeps advancing, which reads as "no failures had a reason".
    const broken = {
      prepare() {
        throw new Error("no such table: surface_failure_daily");
      },
    } as never;
    const out = await rollupFailureReasonsToD1(broken, days, T);
    expect(out.rolled).toBe(false);
    expect(out.error).toContain("surface_failure_daily");
  });

  it("reports a thrown non-Error rather than the string 'undefined'", () => {
    // D1 can reject with a bare string; `.message` is undefined there, and
    // recording "undefined" as the reason would make the failure undiagnosable.
    const broken = {
      prepare() {
        throw "D1 unavailable";
      },
    } as never;
    return rollupFailureReasonsToD1(broken, days, T).then((out) => {
      expect(out).toMatchObject({ rolled: false, error: "D1 unavailable" });
    });
  });
});

describe("loadFailureReasons", () => {
  function seeded() {
    const sqlite = rollupDb();
    const ins = sqlite.prepare(
      `INSERT INTO ${FAILURE_REASONS_TABLE} (day, netuid, kind, classification, checks, updated_at) VALUES (?,?,?,?,?,?)`,
    );
    ins.run("2026-08-05", 7, "api", "live", 90, T);
    ins.run("2026-08-05", 7, "api", "timeout", 10, T);
    ins.run("2026-08-05", 11, "docs", "dead", 5, T);
    ins.run("2026-07-01", 7, "api", "live", 999, T);
    return sqlite;
  }

  it("returns only the days inside the window", async () => {
    const rows = await loadFailureReasons(readDb(seeded()), {
      window: "7d",
      nowMs: T,
    });
    expect(rows?.every((r) => r.day === "2026-08-05")).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("reaches back past the raw table's retention on a wide window", async () => {
    // The reason the rollup exists: 2026-07-01 is outside the 30-day raw
    // window and still answerable here.
    const rows = await loadFailureReasons(readDb(seeded()), {
      window: "90d",
      nowMs: T,
    });
    expect(rows?.some((r) => r.day === "2026-07-01")).toBe(true);
  });

  it("filters by netuid and by kind in SQL", async () => {
    const db = readDb(seeded());
    expect(
      await loadFailureReasons(db, { window: "7d", netuid: 11, nowMs: T }),
    ).toHaveLength(1);
    expect(
      await loadFailureReasons(db, { window: "7d", kind: "api", nowMs: T }),
    ).toHaveLength(2);
    expect(
      await loadFailureReasons(db, {
        window: "7d",
        netuid: 7,
        kind: "docs",
        nowMs: T,
      }),
    ).toHaveLength(0);
  });

  it("accepts netuid 0, which is a real subnet", async () => {
    const sqlite = rollupDb();
    sqlite
      .prepare(
        `INSERT INTO ${FAILURE_REASONS_TABLE} (day, netuid, kind, classification, checks, updated_at) VALUES (?,?,?,?,?,?)`,
      )
      .run("2026-08-05", 0, "api", "live", 4, T);
    expect(
      await loadFailureReasons(readDb(sqlite), {
        window: "7d",
        netuid: 0,
        nowMs: T,
      }),
    ).toHaveLength(1);
  });

  it("ignores an empty kind rather than filtering on it", async () => {
    expect(
      await loadFailureReasons(readDb(seeded()), {
        window: "7d",
        kind: "",
        nowMs: T,
      }),
    ).toHaveLength(3);
  });

  it("returns null for a window the vocabulary does not define", async () => {
    expect(
      await loadFailureReasons(readDb(seeded()), { window: "1h", nowMs: T }),
    ).toBeNull();
  });

  it("defaults to the 30d window", async () => {
    const rows = await loadFailureReasons(readDb(seeded()), { nowMs: T });
    expect(rows).toHaveLength(3);
  });

  it("returns null without a database and when the read throws", async () => {
    expect(await loadFailureReasons(null)).toBeNull();
    expect(await loadFailureReasons(undefined)).toBeNull();
    expect(await loadFailureReasons({} as never)).toBeNull();
    const throwing = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1_ERROR");
          },
        }),
      }),
    };
    expect(await loadFailureReasons(throwing)).toBeNull();
  });

  it("returns an empty list when all() is absent or answers nothing", async () => {
    const noAll = { prepare: () => ({ bind: () => ({}) }) };
    expect(await loadFailureReasons(noAll as never)).toEqual([]);
    const empty = {
      prepare: () => ({ bind: () => ({ all: async () => null }) }),
    };
    expect(await loadFailureReasons(empty)).toEqual([]);
  });
});

describe("buildFailureReasons", () => {
  const rows = [
    { day: "2026-08-04", classification: "live", checks: 80 },
    { day: "2026-08-04", classification: "timeout", checks: 20 },
    { day: "2026-08-05", classification: "live", checks: 90 },
    { day: "2026-08-05", classification: "redirected", checks: 5 },
    { day: "2026-08-05", classification: "dead", checks: 5 },
  ];

  it("shapes the mix with both denominators", () => {
    const card = buildFailureReasons(rows, { window: "7d" });
    expect(card.total_checks).toBe(200);
    // 20 timeouts + 5 dead. `redirected` is NOT counted: a surface answering
    // from a new location is serving.
    expect(card.failing_checks).toBe(25);
    expect(card.failure_rate).toBeCloseTo(0.125, 10);
    type Reason = {
      classification: string;
      is_failure: boolean;
      checks: number;
      share: number | null;
      failure_share: number | null;
    };
    const byName: Record<string, Reason> = Object.fromEntries(
      (card.reasons as Reason[]).map((r) => [r.classification, r]),
    );
    expect(byName.live).toMatchObject({
      is_failure: false,
      checks: 170,
      // NULL, not zero: "what share of failures were successes" is not a
      // question with an answer.
      failure_share: null,
    });
    expect(byName.redirected.is_failure).toBe(false);
    expect(byName.timeout).toMatchObject({ is_failure: true, checks: 20 });
    expect(byName.timeout.share).toBeCloseTo(0.1, 10);
    expect(byName.timeout.failure_share).toBeCloseTo(0.8, 10);
  });

  it("ranks the reasons by volume", () => {
    const card = buildFailureReasons(rows, {});
    const order = (card.reasons as Array<{ checks: number }>).map(
      (r) => r.checks,
    );
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });

  it("counts days from the ROWS, not the requested window", () => {
    // A day the prober did not run is ABSENT. Reporting the window's length
    // would present a gap in coverage as days of perfect health.
    const card = buildFailureReasons(rows, { window: "30d" });
    expect(card.days_covered).toBe(2);
    expect(card.oldest_day).toBe("2026-08-04");
    expect(card.newest_day).toBe("2026-08-05");
  });

  it("emits the series oldest first with per-day rates", () => {
    const series = buildFailureReasons(rows, {}).series as Array<{
      day: string;
      total_checks: number;
      failing_checks: number;
      failure_rate: number;
      by_classification: Record<string, number>;
    }>;
    expect(series.map((d) => d.day)).toEqual(["2026-08-04", "2026-08-05"]);
    expect(series[0]).toMatchObject({
      total_checks: 100,
      failing_checks: 20,
      failure_rate: 0.2,
    });
    expect(series[1].by_classification).toEqual({
      live: 90,
      redirected: 5,
      dead: 5,
    });
  });

  it("treats an empty window as a MEASUREMENT, not a decline", () => {
    // "The prober recorded nothing in that range" is a real answer, and the
    // common one for a narrow window over a quiet period.
    const card = buildFailureReasons([], { window: "7d" });
    expect(card.degraded).toBeUndefined();
    expect(card.days_covered).toBe(0);
    expect(card.total_checks).toBe(0);
    // NULL rather than 0: a rate over zero probes has no value, and 0 would
    // read as "nothing failed".
    expect(card.failure_rate).toBeNull();
    expect(card.reasons).toEqual([]);
    expect(card.series).toEqual([]);
  });

  it("nulls a share and a rate over zero probes rather than emitting NaN", () => {
    // The rollup writer records COUNT(*), so it never produces a zero -- but a
    // division here would produce NaN, which is not a JSON number, and the
    // reader must be robust to any row the table can hold.
    const card = buildFailureReasons(
      [{ day: "2026-08-05", classification: "live", checks: 0 }],
      {},
    );
    expect(card.total_checks).toBe(0);
    expect(card.failure_rate).toBeNull();
    expect(
      (card.reasons as Array<{ share: number | null }>)[0].share,
    ).toBeNull();
    expect(
      (card.series as Array<{ failure_rate: number | null }>)[0].failure_rate,
    ).toBeNull();
  });

  it("accepts a null or absent row list without inventing an error", () => {
    expect(buildFailureReasons(null).total_checks).toBe(0);
    expect(buildFailureReasons(undefined).total_checks).toBe(0);
    expect(buildFailureReasons("nope" as never).total_checks).toBe(0);
  });

  it("drops a row that cannot say which day or reason it describes", () => {
    const card = buildFailureReasons(
      [
        { day: "2026-08-05", classification: "live", checks: 10 },
        { day: null, classification: "live", checks: 99 },
        { day: "2026-08-05", classification: "made-up", checks: 99 },
        { day: "2026-08-05", classification: "live", checks: -1 },
        { day: "2026-08-05", classification: "live", checks: 1.5 },
        { day: "2026-08-05", classification: "live", checks: null },
      ],
      {},
    );
    expect(card.total_checks).toBe(10);
  });

  it("keeps the vocabulary closed", () => {
    // A classification this API does not define would either break a typed
    // client or teach a consumer a vocabulary that does not exist.
    for (const c of FAILURE_CLASSIFICATIONS) {
      const card = buildFailureReasons(
        [{ day: "2026-08-05", classification: c, checks: 1 }],
        {},
      );
      expect(card.total_checks).toBe(1);
    }
  });

  it("echoes the filters it was asked for", () => {
    const card = buildFailureReasons(rows, {
      window: "90d",
      netuid: 7,
      kind: "api",
    });
    expect(card).toMatchObject({ window: "90d", netuid: 7, kind: "api" });
    const bare = buildFailureReasons(rows);
    expect(bare).toMatchObject({ window: null, netuid: null, kind: null });
  });
});

describe("declineFailureReasons", () => {
  it("nulls every count rather than reporting a quiet network", () => {
    const card = declineFailureReasons("unavailable", {
      window: "7d",
      netuid: 7,
      kind: "api",
    });
    expect((card.degraded as { reason: string }).reason).toBe("unavailable");
    expect(card.total_checks).toBeNull();
    expect(card.failing_checks).toBeNull();
    expect(card.failure_rate).toBeNull();
    expect(card.days_covered).toBeNull();
    expect(card.oldest_day).toBeNull();
    expect(card.newest_day).toBeNull();
    expect(card.reasons).toEqual([]);
    expect(card.series).toEqual([]);
    expect(card).toMatchObject({ window: "7d", netuid: 7, kind: "api" });
  });

  it("echoes nulls when it was given no filters", () => {
    const card = declineFailureReasons("unavailable");
    expect(card).toMatchObject({ window: null, netuid: null, kind: null });
  });
});
