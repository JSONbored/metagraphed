// The alarm for a hole in the MIDDLE of a daily series (#9781).
//
// THE BUG THIS EXISTS FOR. 2026-08-06 is missing entirely from `neuron_daily`
// and `account_position_daily`, and nothing noticed for two days. Every other
// watchdog in this repo asks how old the newest row is, and that question is
// structurally blind to a missing day: the rollup ran normally on 08-07, so the
// newest row was minutes old and the width was full.
//
// The assertions below are about the four things that decide whether a gap
// check is useful or just noisy: it must find a hole between two healthy days,
// it must NOT fire on the newest day (in progress) or the oldest (being pruned),
// it must distinguish missing from thin, and it must name the dates.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { pgMockEnv } from "./helpers/pg-mock.ts";
import {
  DAILY_SERIES,
  DAILY_THIN_RATIO,
  coverageDetail,
  evaluateDailyCoverage,
  runDailySeriesCoverageWatchdog,
} from "../src/daily-series-coverage-watchdog.ts";

/** A run of consecutive days at a uniform width. */
function series(start: string, count: number, rows = 30_000) {
  const out: { date: string; rows: number }[] = [];
  let ms = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    out.push({ date: new Date(ms).toISOString().slice(0, 10), rows });
    ms += 86_400_000;
  }
  return out;
}

describe("evaluateDailyCoverage", () => {
  test("finds the real 2026-08-06 hole", () => {
    // The production shape, transcribed: 07-29..08-08 at full width with 08-06
    // absent. Both tables had exactly this.
    const days = series("2026-07-29", 11, 30_100).filter(
      (d) => d.date !== "2026-08-06",
    );
    const v = evaluateDailyCoverage("neuron_daily", days);
    assert.deepEqual(v.missing, ["2026-08-06"]);
    assert.deepEqual(v.thin, []);
  });

  test("a clean series reports nothing", () => {
    const v = evaluateDailyCoverage("neuron_daily", series("2026-07-29", 11));
    assert.deepEqual(v.missing, []);
    assert.deepEqual(v.thin, []);
    assert.equal(v.examined, 9, "the two boundary days are excluded");
  });

  test("the NEWEST day is never a fault, however thin", () => {
    // A rollup writing right now is thin by definition. Alarming on it would
    // fire every day, and an alarm that fires on a working lane stops being
    // read (#9301).
    const days = [...series("2026-07-29", 10), { date: "2026-08-07", rows: 3 }];
    const v = evaluateDailyCoverage("neuron_daily", days);
    assert.deepEqual(v.thin, [], "today is in progress, not thin");
    assert.deepEqual(v.missing, []);
  });

  test("the OLDEST day is never a fault, because retention prunes from that end", () => {
    const days = [
      { date: "2026-07-28", rows: 12 },
      ...series("2026-07-29", 10),
    ];
    const v = evaluateDailyCoverage("neuron_daily", days);
    assert.deepEqual(v.thin, []);
    assert.deepEqual(v.missing, []);
  });

  test("a present-but-truncated day is THIN, not missing", () => {
    // A pass that started and died. Counting dates alone reads this as a
    // normal day, which is the second way a series loses data.
    const days = series("2026-07-29", 11).map((d) =>
      d.date === "2026-08-03" ? { ...d, rows: 900 } : d,
    );
    const v = evaluateDailyCoverage("neuron_daily", days);
    assert.deepEqual(v.thin, ["2026-08-03"]);
    assert.deepEqual(v.missing, [], "it has rows -- a different fault");
  });

  test("ordinary day-to-day variation is not thin", () => {
    const days = series("2026-07-29", 11).map((d, i) => ({
      ...d,
      rows: 30_000 + i * 400,
    }));
    const v = evaluateDailyCoverage("neuron_daily", days);
    assert.deepEqual(v.thin, []);
  });

  test("a run of missing days cannot drag the width floor to zero", () => {
    // The median is taken over PRESENT interior days. Were zeros included, a
    // long outage would pull the threshold down and hide every thin day with it.
    const days = series("2026-07-29", 14)
      .filter(
        (d) => !["2026-08-02", "2026-08-03", "2026-08-04"].includes(d.date),
      )
      .map((d) => (d.date === "2026-08-06" ? { ...d, rows: 500 } : d));
    const v = evaluateDailyCoverage("neuron_daily", days);
    assert.deepEqual(v.missing, ["2026-08-02", "2026-08-03", "2026-08-04"]);
    assert.deepEqual(v.thin, ["2026-08-06"], "still caught alongside the run");
    assert.ok(v.median_rows > 0);
  });

  test("a table too short to have a hole reports nothing rather than a green light", () => {
    for (const days of [[], series("2026-08-01", 1), series("2026-08-01", 2)]) {
      const v = evaluateDailyCoverage("neuron_daily", days);
      assert.deepEqual(v.missing, []);
      assert.equal(v.examined, 0);
    }
  });

  test("the thin ratio is applied against the median, not the mean", () => {
    // One enormous day would drag a mean upward and make ordinary days read as
    // thin -- the false-alarm direction.
    const days = series("2026-07-29", 11).map((d) =>
      d.date === "2026-08-02" ? { ...d, rows: 3_000_000 } : d,
    );
    const v = evaluateDailyCoverage("neuron_daily", days, DAILY_THIN_RATIO);
    assert.deepEqual(v.thin, []);
  });

  test("one row stranded in 1970 cannot widen the walk to 56 years", () => {
    // FOUND BY RUNNING THIS AGAINST PRODUCTION. account_position_daily holds a
    // row whose captured_at was written in SECONDS (#9782), dating it to
    // 1970-01-21. Walking oldest-to-newest made the interior 20,000 days wide
    // and produced a 221 KB verdict naming every one of them.
    const days = [
      { date: "1970-01-21", rows: 1 },
      ...series("2026-07-29", 11).filter((d) => d.date !== "2026-08-06"),
    ];
    const v = evaluateDailyCoverage("account_position_daily", days);
    assert.deepEqual(
      v.missing,
      ["2026-08-06"],
      "the real hole, and nothing from 1970",
    );
    assert.ok(v.examined < 90, `walked ${v.examined} days, not 20,000`);
  });

  test("the lookback bounds the walk even with a long clean history", () => {
    const v = evaluateDailyCoverage(
      "neuron_daily",
      series("2026-01-01", 200),
      DAILY_THIN_RATIO,
      30,
    );
    assert.ok(v.examined <= 30, `examined ${v.examined}`);
  });

  test("dates roll over a month boundary correctly", () => {
    const days = series("2026-07-28", 8).filter((d) => d.date !== "2026-08-01");
    const v = evaluateDailyCoverage("neuron_daily", days);
    assert.deepEqual(v.missing, ["2026-08-01"]);
  });
});

describe("coverageDetail", () => {
  test("names the dates, because a count sends nobody anywhere", () => {
    const detail = coverageDetail([
      {
        table: "neuron_daily",
        missing: ["2026-08-06"],
        thin: [],
        examined: 9,
        median_rows: 30100,
      },
      {
        table: "account_position_daily",
        missing: ["2026-08-06"],
        thin: ["2026-08-02"],
        examined: 9,
        median_rows: 31000,
      },
    ]);
    assert.match(detail, /neuron_daily: missing 2026-08-06/);
    assert.match(
      detail,
      /account_position_daily: missing 2026-08-06; thin 2026-08-02/,
    );
  });

  test("a long gap list is capped but its COUNT stays exact", () => {
    // A silently shortened list is worse than a long one: it reads as though
    // the gap were small.
    const missing = Array.from({ length: 40 }, (_, i) =>
      new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    );
    const detail = coverageDetail([
      {
        table: "neuron_daily",
        missing,
        thin: [],
        examined: 60,
        median_rows: 30000,
      },
    ]);
    assert.match(detail, /and 28 more \(40 total\)/);
    assert.ok(detail.length < 500, `detail is ${detail.length} chars`);
  });

  test("a clean check says what it examined, not just 'ok'", () => {
    const detail = coverageDetail([
      {
        table: "neuron_daily",
        missing: [],
        thin: [],
        examined: 9,
        median_rows: 1,
      },
    ]);
    assert.match(detail, /9 interior day\(s\), no gaps/);
  });
});

describe("the watchdog tick", () => {
  beforeEach(() => {
    pg.control.queries.length = 0;
    pg.control.answers.length = 0;
    pg.control.rows = null;
    pg.control.failNext = null;
  });

  /** Answer each series' GROUP BY with the days given. */
  function answerWith(
    byTable: Record<string, { date: string; rows: number }[]>,
  ) {
    for (const [table, days] of Object.entries(byTable)) {
      pg.control.answers.push({
        match: new RegExp(`FROM ${table}\\b`),
        rows: days.map((d) => ({ date: d.date, rows: d.rows })),
      });
    }
    // Everything else (the lane_health insert and its prune) answers empty.
    pg.control.answers.push({ match: /.*/, rows: [] });
  }

  /** The verdict the tick durably recorded, read off the recorded statements. */
  function recordedVerdict() {
    const insert = pg.control.queries.find((q) =>
      q.text.includes("INSERT INTO lane_health"),
    );
    assert.ok(insert, "the tick recorded a verdict");
    return {
      lane: insert.values[0],
      verdict: insert.values[1],
      detail: insert.values[3],
    };
  }

  test("records `stale` NAMING the missing date when a series has a hole", async () => {
    answerWith({
      neuron_daily: series("2026-07-29", 11, 30_100).filter(
        (d) => d.date !== "2026-08-06",
      ),
      account_position_daily: series("2026-07-29", 11, 31_000),
    });
    const result = (await runDailySeriesCoverageWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async () => true) as never,
    })) as { ok: boolean; alerted: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
    const v = recordedVerdict();
    assert.equal(v.lane, "daily-series-coverage");
    assert.equal(v.verdict, "stale");
    assert.match(String(v.detail), /neuron_daily: missing 2026-08-06/);
  });

  test("records `ok` with what it examined when every series is whole", async () => {
    answerWith({
      neuron_daily: series("2026-07-29", 11),
      account_position_daily: series("2026-07-29", 11, 31_000),
    });
    const result = (await runDailySeriesCoverageWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async () => true) as never,
    })) as { ok: boolean; alerted: boolean };
    assert.equal(result.alerted, false);
    const v = recordedVerdict();
    assert.equal(v.verdict, "ok");
    assert.match(String(v.detail), /no gaps/);
    assert.match(
      String(v.detail),
      /interior day\(s\)/,
      "says what it examined",
    );
  });

  test("it reads EVERY series, not just the first", async () => {
    // A loop that stopped at the first table would have found 08-06 and
    // reported it, looking entirely correct while never checking the second.
    answerWith({
      neuron_daily: series("2026-07-29", 11),
      account_position_daily: series("2026-07-29", 11, 31_000).filter(
        (d) => d.date !== "2026-08-04",
      ),
    });
    const result = (await runDailySeriesCoverageWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async () => true) as never,
    })) as { alerted: boolean };
    assert.equal(result.alerted, true);
    assert.match(
      String(recordedVerdict().detail),
      /account_position_daily: missing 2026-08-04/,
    );
    for (const { table } of DAILY_SERIES) {
      assert.ok(
        pg.control.queries.some((q) => q.text.includes(`FROM ${table}`)),
        `${table} was queried`,
      );
    }
  });

  test("a failing read is reported, not rendered as a clean series", async () => {
    // The direction that matters: a query error must never read as "no gaps".
    pg.control.failNext = new Error("connection reset");
    const result = (await runDailySeriesCoverageWatchdog(pgMockEnv(), {
      now: () => 1000,
      recordException: (async () => true) as never,
    })) as { ok: boolean; reason?: string };
    assert.equal(result.ok, false);
    assert.equal(result.reason, "query_failed");
  });

  test("declines rather than reporting a clean series with no store", async () => {
    const result = (await runDailySeriesCoverageWatchdog({}, {})) as {
      ok: boolean;
      reason?: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.reason!, /no store/i);
  });
});

describe("the lane is actually scheduled", () => {
  test("wrangler.jsonc declares the trigger", async () => {
    // Without this the code merges, the dispatcher branch exists, every test
    // above passes -- and the check never runs, which is the same shape as the
    // gap it exists to find.
    const { DAILY_SERIES_COVERAGE_CRON } = await import("../workers/config.ts");
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    assert.ok(
      raw.includes(`"${DAILY_SERIES_COVERAGE_CRON}"`),
      `wrangler.jsonc has no trigger for ${DAILY_SERIES_COVERAGE_CRON}`,
    );
  });

  test("it runs after both daily rollup windows, not during one", async () => {
    // Reading a series mid-rollup would report the day being written as thin.
    const { DAILY_SERIES_COVERAGE_CRON } = await import("../workers/config.ts");
    const [minute, hours] = DAILY_SERIES_COVERAGE_CRON.split(" ");
    assert.equal(minute, "35");
    assert.deepEqual(hours!.split(",").sort(), ["19", "7"]);
  });
});
