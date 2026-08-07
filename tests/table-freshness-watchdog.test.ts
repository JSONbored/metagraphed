// The all-tables freshness sweep (src/table-freshness-watchdog.ts, #9786).
//
// The test that gives this file its value is the COVERAGE one: every table in
// migrations/d1 must be classified, so a new table cannot arrive unwatched.
// That is the whole failure this watchdog exists to end -- four tables were
// frozen for five days because no per-lane watchdog covered them, and none
// ever would have.
//
// `maxAgeMs: null` is a classification, not an exemption: it says "staleness
// is meaningless here" and has to be written down. Absent from the list means
// nobody thought about it, and that fails.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import {
  describeStaleTables,
  FRESHNESS_BATCH,
  freshnessSql,
  freshnessTables,
  parseFreshnessRows,
  runTableFreshnessWatchdog,
  staleTables,
  TABLE_FRESHNESS,
  TABLE_FRESHNESS_LANE,
  type FreshnessExpectation,
} from "../src/table-freshness-watchdog.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1_785_800_000_000;

function fakeDb(byTable: Record<string, unknown>, failOn: string[] = []) {
  const calls: string[] = [];
  const written: Record<string, unknown>[] = [];
  return {
    calls,
    written,
    db: {
      prepare(sql: string) {
        calls.push(sql);
        return {
          async all() {
            if (failOn.some((f) => sql.includes(f))) {
              throw new Error("D1_ERROR: overloaded");
            }
            const names = [...sql.matchAll(/SELECT '(\w+)' AS t/g)].map(
              (m) => m[1],
            );
            return {
              results: names.map((t) => ({ t, mx: byTable[t] ?? null })),
            };
          },
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT")) {
                  written.push({
                    lane: values[0],
                    verdict: values[1],
                    age: values[2],
                    detail: values[3],
                  });
                }
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

describe("TABLE_FRESHNESS coverage", () => {
  test("every table in migrations/d1 is classified", () => {
    // THE LOAD-BEARING TEST. A table absent from the map is one nobody has
    // decided the freshness meaning of, and it would be swept by nothing --
    // exactly how the registry cluster went five days unnoticed (#9779).
    const dir = path.join(process.cwd(), "migrations/d1");
    const declared = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(path.join(dir, file), "utf8");
      for (const m of sql.matchAll(
        /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/gi,
      )) {
        declared.add(m[1]);
      }
    }
    assert.ok(
      declared.size >= 40,
      `only ${declared.size} tables parsed out of migrations/d1 -- the parse ` +
        `broke, so this test is passing on nothing`,
    );
    const missing = [...declared].filter((t) => !TABLE_FRESHNESS[t]).sort();
    assert.deepEqual(
      missing,
      [],
      "these tables have no freshness classification. Add them to " +
        "TABLE_FRESHNESS -- `maxAgeMs: null` with a reason is a valid answer, " +
        `being absent is not:\n${missing.join("\n")}`,
    );
  });

  test("the map names no table that does not exist", () => {
    // A stale entry would be swept forever against a dropped table, which
    // fails every batch it lands in and hides the tables beside it.
    const dir = path.join(process.cwd(), "migrations/d1");
    const declared = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      for (const m of readFileSync(path.join(dir, file), "utf8").matchAll(
        /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/gi,
      )) {
        declared.add(m[1]);
      }
    }
    for (const table of Object.keys(TABLE_FRESHNESS)) {
      assert.ok(
        declared.has(table),
        `${table} is classified but never created`,
      );
    }
  });

  test("every entry gives a reason, and a threshold or an explicit null", () => {
    for (const [table, e] of Object.entries(TABLE_FRESHNESS)) {
      assert.ok(e.reason.length > 8, `${table} has no real reason`);
      assert.ok(
        e.maxAgeMs === null || e.maxAgeMs > 0,
        `${table}'s maxAgeMs must be a positive number or null`,
      );
      if (e.column === "") {
        assert.equal(
          e.maxAgeMs,
          null,
          `${table} has no timestamp column, so it cannot have a threshold`,
        );
      }
    }
  });

  test("the registry cluster is NOT exempted", () => {
    // #9779 is a live outage. Classifying these `null` to keep the lane green
    // is precisely what a watchdog must never do -- quiet only when healthy.
    for (const table of ["subnets", "surfaces", "providers"]) {
      const e = TABLE_FRESHNESS[table];
      assert.ok(e.maxAgeMs !== null, `${table} must stay alarmed`);
      assert.equal(e.knownIssue, "#9779", `${table} should point at its issue`);
    }
  });
});

describe("freshnessSql", () => {
  test("asks a batch in one statement", () => {
    assert.equal(
      freshnessSql(["neurons", "lane_health"]),
      "SELECT 'neurons' AS t, MAX(captured_at) AS mx FROM neurons UNION ALL " +
        "SELECT 'lane_health' AS t, MAX(checked_at) AS mx FROM lane_health",
    );
  });

  test("batches stay under D1's compound-SELECT term limit", () => {
    // D1 rejects a compound SELECT past roughly five terms.
    assert.ok(FRESHNESS_BATCH <= 4, "batch size must keep a margin under 5");
  });

  test("only tables with a column are swept", () => {
    const swept = freshnessTables();
    assert.ok(!swept.includes("api_key_blocks"), "no timestamp column");
    assert.ok(swept.includes("neurons"));
  });
});

describe("staleTables", () => {
  const spec: Record<string, FreshnessExpectation> = {
    fast: {
      column: "captured_at",
      kind: "ms",
      maxAgeMs: HOUR,
      reason: "hourly",
    },
    slow: {
      column: "captured_at",
      kind: "ms",
      maxAgeMs: 48 * HOUR,
      reason: "daily",
    },
    never: {
      column: "created_at",
      kind: "ms",
      maxAgeMs: null,
      reason: "signup",
    },
  };

  test("reports only tables past their OWN threshold, worst first", () => {
    const out = staleTables(
      new Map([
        ["fast", NOW - 5 * HOUR],
        ["slow", NOW - 5 * HOUR],
        ["never", NOW - 900 * HOUR],
      ]),
      NOW,
      spec,
    );
    assert.deepEqual(
      out.map((s) => s.table),
      ["fast"],
    );
    assert.equal(out[0].maxAgeMs, HOUR);
  });

  test("a null threshold is never stale, however old", () => {
    assert.deepEqual(staleTables(new Map([["never", 0]]), NOW, spec), []);
  });

  test("an EMPTY table is not stale", () => {
    // No arrival means nothing is late. Reporting it would make every
    // not-yet-populated table permanently loud.
    assert.deepEqual(staleTables(new Map(), NOW, spec), []);
  });

  test("exactly at the threshold is not stale", () => {
    assert.deepEqual(
      staleTables(new Map([["fast", NOW - HOUR]]), NOW, spec),
      [],
    );
  });
});

describe("parseFreshnessRows", () => {
  const spec: Record<string, FreshnessExpectation> = {
    ms: { column: "captured_at", kind: "ms", maxAgeMs: HOUR, reason: "x" },
    dated: { column: "day", kind: "date", maxAgeMs: HOUR, reason: "x" },
  };

  test("reads epoch-ms and date columns alike", () => {
    const out = parseFreshnessRows(
      [
        { t: "ms", mx: NOW },
        { t: "dated", mx: "2026-08-07" },
      ],
      spec,
    );
    assert.equal(out.get("ms"), NOW);
    assert.equal(out.get("dated"), Date.parse("2026-08-07T00:00:00Z"));
  });

  test("a NULL max is dropped, not read as 1970", () => {
    // `Number(null)` is 0 and passes Number.isFinite. Reading MAX() over an
    // empty table as epoch 0 would report it as decades stale.
    assert.equal(parseFreshnessRows([{ t: "ms", mx: null }], spec).size, 0);
    assert.equal(parseFreshnessRows([{ t: null, mx: NOW }], spec).size, 0);
    assert.equal(parseFreshnessRows([{ t: "ms", mx: "nope" }], spec).size, 0);
  });

  test("a table the spec does not know is ignored", () => {
    assert.equal(
      parseFreshnessRows([{ t: "surprise", mx: NOW }], spec).size,
      0,
    );
  });
});

describe("describeStaleTables", () => {
  test("names the age, the cap, and any known issue", () => {
    assert.equal(
      describeStaleTables([]),
      "every table is within its expected age",
    );
    assert.equal(
      describeStaleTables([
        {
          table: "surfaces",
          ageMs: 126 * HOUR,
          maxAgeMs: 48 * HOUR,
          reason: "x",
          knownIssue: "#9779",
        },
        { table: "neurons", ageMs: 3 * HOUR, maxAgeMs: 2 * HOUR, reason: "y" },
      ]),
      "surfaces 126.0h > 48h (known: #9779); neurons 3.0h > 2h",
    );
  });
});

describe("runTableFreshnessWatchdog", () => {
  const spec: Record<string, FreshnessExpectation> = {
    a: { column: "captured_at", kind: "ms", maxAgeMs: HOUR, reason: "hourly" },
    b: { column: "captured_at", kind: "ms", maxAgeMs: HOUR, reason: "hourly" },
    c: { column: "captured_at", kind: "ms", maxAgeMs: HOUR, reason: "hourly" },
    d: { column: "captured_at", kind: "ms", maxAgeMs: HOUR, reason: "hourly" },
    e: { column: "captured_at", kind: "ms", maxAgeMs: HOUR, reason: "hourly" },
    skip: { column: "", kind: "ms", maxAgeMs: null, reason: "no column" },
  };
  const fresh = { a: NOW, b: NOW, c: NOW, d: NOW, e: NOW };

  test("records OK when every table is within its age", async () => {
    const spy = fakeDb(fresh);
    const out = await runTableFreshnessWatchdog(null, {
      db: spy.db,
      laneHealthDb: spy.db,
      now: () => NOW,
      spec,
    });
    assert.deepEqual(out.stale, []);
    assert.equal(out.checked, 5);
    assert.equal(spy.written[0].lane, TABLE_FRESHNESS_LANE);
    assert.equal(spy.written[0].verdict, "ok");
  });

  test("batches rather than issuing one huge compound SELECT", async () => {
    const spy = fakeDb(fresh);
    await runTableFreshnessWatchdog(null, {
      db: spy.db,
      laneHealthDb: spy.db,
      now: () => NOW,
      spec,
    });
    const selects = spy.calls.filter((c) => c.startsWith("SELECT"));
    assert.equal(selects.length, 2, "5 tables at batch size 4 = 2 batches");
    for (const s of selects) {
      assert.ok(
        (s.match(/UNION ALL/g) ?? []).length < 4,
        `batch has too many terms: ${s}`,
      );
    }
    // The column-less table is never queried.
    assert.ok(!selects.some((s) => s.includes("'skip'")));
  });

  test("records STALE with the worst age", async () => {
    const spy = fakeDb({ ...fresh, a: NOW - 9 * HOUR, b: NOW - 3 * HOUR });
    const out = await runTableFreshnessWatchdog(null, {
      db: spy.db,
      laneHealthDb: spy.db,
      now: () => NOW,
      spec,
    });
    assert.deepEqual(
      out.stale?.map((s) => s.table),
      ["a", "b"],
    );
    assert.equal(spy.written[0].verdict, "stale");
    assert.equal(spy.written[0].age, 9 * HOUR);
  });

  test("ONE failed batch does not hide the healthy tables beside it", async () => {
    // The other batches still carry real information.
    const spy = fakeDb({ ...fresh, e: NOW - 9 * HOUR }, ["'a'"]);
    const out = await runTableFreshnessWatchdog(null, {
      db: spy.db,
      laneHealthDb: spy.db,
      now: () => NOW,
      spec,
    });
    assert.deepEqual(
      out.stale?.map((s) => s.table),
      ["e"],
    );
    assert.match(String(spy.written[0].detail), /1 of 2 batches unreadable/);
  });

  test("EVERY batch failing is unknown, never ok", async () => {
    // "nothing was measured" and "nothing is stale" must not look alike.
    const spy = fakeDb(fresh, ["SELECT"]);
    const out = await runTableFreshnessWatchdog(null, {
      db: spy.db,
      laneHealthDb: spy.db,
      now: () => NOW,
      spec,
    });
    assert.equal(out.reason, "all batches failed");
    assert.equal(spy.written[0].verdict, "unknown");
  });

  test("an unbound D1 is unknown too", async () => {
    const spy = fakeDb({});
    const out = await runTableFreshnessWatchdog(null, {
      db: null,
      laneHealthDb: spy.db,
      now: () => NOW,
      spec,
    });
    assert.equal(out.reason, "all batches failed");
    assert.equal(spy.written[0].verdict, "unknown");
  });

  test("a batch response with no `results` key contributes nothing, not a crash", async () => {
    // D1 can answer without the key at all; `?? []` must absorb it rather than
    // letting a TypeError take out the batch.
    const noKey = {
      prepare(sql: string) {
        return {
          async all() {
            return sql.startsWith("SELECT") ? {} : { results: [] };
          },
          bind() {
            return {
              async run() {},
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    };
    const out = await runTableFreshnessWatchdog(null, {
      db: noKey,
      laneHealthDb: noKey,
      now: () => NOW,
      spec,
    });
    assert.equal(out.checked, 0);
    assert.deepEqual(out.stale, []);
  });

  test("takes its D1 and clock off env with no deps", async () => {
    const spy = fakeDb({});
    const out = await runTableFreshnessWatchdog({
      METAGRAPH_HEALTH_DB: spy.db,
    });
    assert.equal(out.attempted, true);
  });
});

describe("the deployed wiring", () => {
  const wrangler = readFileSync("wrangler.data.jsonc", "utf8");

  test("the cron the handler dispatches on is declared", async () => {
    const { TABLE_FRESHNESS_CRON } = await import("../workers/config.ts");
    assert.ok(
      wrangler.includes(`"${TABLE_FRESHNESS_CRON}"`),
      `wrangler.data.jsonc declares no "${TABLE_FRESHNESS_CRON}" cron, so the sweep never runs`,
    );
  });

  test("the cadence is faster than the tightest threshold it enforces", async () => {
    // A sweep slower than what it checks would report a breach late enough to
    // be useless. Hourly against a two-hour floor leaves one tick of margin.
    const { TABLE_FRESHNESS_CRON } = await import("../workers/config.ts");
    assert.match(
      TABLE_FRESHNESS_CRON,
      /^\d+ \* \* \* \*$/,
      "expected an hourly cron",
    );
    const tightest = Math.min(
      ...Object.values(TABLE_FRESHNESS)
        .map((e) => e.maxAgeMs)
        .filter((v): v is number => v != null),
    );
    assert.ok(
      tightest >= 2 * HOUR,
      `tightest threshold is ${tightest / HOUR}h but the sweep runs hourly -- ` +
        `anything under 2h would alarm on its own sampling gap`,
    );
  });
});
