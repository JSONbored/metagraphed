// The D1 -> Neon reconciler (src/neon-backfill.ts, infra#336).
//
// This lane copies rows between two stores on a cron with nobody watching, so
// the tests are about the ways that goes wrong quietly:
//
//   * a store that will not answer must NOT read as "the other store has
//     everything and this one has nothing", which is the shape of a
//     catastrophic mistaken copy
//   * D1's 0/1 must arrive as Neon's BOOLEAN -- the one shape difference
//     between the stores, and one that has already broken this lane once
//   * the write must carry the out-of-order guard, because today's rows are
//     being rewritten by the producer WHILE this pages through them
//   * a tick that copies 4 of 26 missing dates must not report `ok`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  D1_PAGE_ROWS,
  IDLE_RECHECK_MS,
  MAX_DATES_PER_TICK,
  NEON_BACKFILL_PLANS,
  TICK_BUDGET_MS,
  WHOLE_TABLE_UNIT,
  backfillGuard,
  copyDateToNeon,
  copyWholeTableToNeon,
  d1DateCounts,
  d1TableSignature,
  dateDeficits,
  describeOutcome,
  keysetPredicate,
  neonDateCounts,
  neonTableSignature,
  readDatePage,
  readWholePage,
  reconcileTableToNeon,
  runNeonBackfill,
  shapeRowForNeon,
  signaturesAgree,
} from "../src/neon-backfill.ts";
import { neonBackfillLanes } from "../src/neon-write.ts";

const NOW = 1_785_800_000_000;
const PLAN = NEON_BACKFILL_PLANS.neuron_daily;

/** A D1 stand-in that answers each query from a scripted queue and records
 * every statement it was asked to run. */
function fakeDb(pages: unknown[][] = [], throwOn: string | null = null) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const written: Record<string, unknown>[] = [];
  const queue = [...pages];
  const answer = (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (throwOn && sql.includes(throwOn))
      throw new Error("D1_ERROR: overloaded");
    // A scripted `null` page stands for a D1 response with no `results` key at
    // all, which is a different thing from an empty result set.
    const next = queue.length > 0 ? queue.shift() : [];
    return next === null ? {} : { results: next as unknown[] };
  };
  return {
    calls,
    written,
    db: {
      prepare(sql: string) {
        return {
          async all() {
            return answer(sql, []);
          },
          bind(...values: unknown[]) {
            return {
              async all() {
                return answer(sql, values);
              },
              async run() {
                calls.push({ sql, values });
                if (sql.startsWith("INSERT")) {
                  written.push({
                    lane: values[0],
                    verdict: values[1],
                    detail: values[3],
                  });
                }
              },
            };
          },
        };
      },
    },
  };
}

function fakeSql(rows: unknown[] = [], fail: string | null = null) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    sql: {
      async unsafe(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        if (fail && text.includes(fail)) throw new Error("relation missing");
        return text.startsWith("SELECT") ? rows : [];
      },
    },
  };
}

function laneSpy() {
  const written: Record<string, unknown>[] = [];
  return {
    written,
    db: {
      prepare(sql: string) {
        return {
          async all() {
            return { results: laneSpy.rows };
          },
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT")) {
                  written.push({
                    lane: values[0],
                    verdict: values[1],
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
// Rows loadLatestLaneHealth sees; set per-test, read by the fake above.
laneSpy.rows = [] as Record<string, unknown>[];

const ctx = { waitUntil() {} };

describe("NEON_BACKFILL_PLANS", () => {
  test("every plan's conflict, keyset and boolean columns are its own columns", () => {
    for (const [name, plan] of Object.entries(NEON_BACKFILL_PLANS)) {
      for (const column of [...plan.conflict, ...plan.booleans]) {
        assert.ok(
          plan.columns.includes(column),
          `${name}: ${column} is not in its own column list`,
        );
      }
      // The keyset is what a page resumes from. If it ever drifted from the
      // primary key, a page would resume from the wrong place and skip rows
      // silently -- the deficit would shrink and never reach zero.
      //
      // The two partitions relate it to the key differently, which is the
      // point of declaring the partition: a dated plan already has the date
      // pinned by its WHERE clause, so its keyset is the key MINUS
      // snapshot_date; a whole-table plan has nothing pinned, so its keyset is
      // the entire key.
      assert.deepEqual(
        plan.partition === "date"
          ? [...plan.keyset, "snapshot_date"].sort()
          : [...plan.keyset].sort(),
        [...plan.conflict].sort(),
        `${name}: keyset must be the primary key (minus snapshot_date when dated)`,
      );
    }
  });

  test("a dated plan has snapshot_date and a whole-table plan does not", () => {
    // The partition is not a label -- it selects the SQL. A dated plan whose
    // table has no snapshot_date would query a column that does not exist, and
    // a whole-table plan that has one would copy the entire table every tick
    // instead of the dates that changed.
    for (const [name, plan] of Object.entries(NEON_BACKFILL_PLANS)) {
      assert.equal(
        plan.columns.includes("snapshot_date"),
        plan.partition === "date",
        `${name} is partitioned "${plan.partition}" but ${
          plan.columns.includes("snapshot_date") ? "has" : "lacks"
        } a snapshot_date column`,
      );
    }
  });

  test("every plan can compare signatures, which needs captured_at", () => {
    // Both the whole-table sync check and backfillGuard read captured_at, so a
    // plan without it would compare on row count alone and never notice an
    // updated-in-place row.
    for (const [name, plan] of Object.entries(NEON_BACKFILL_PLANS)) {
      assert.ok(
        plan.columns.includes("captured_at"),
        `${name} has no captured_at`,
      );
    }
  });

  test("conflict keys match the primary keys D1 declares", () => {
    // Read off sqlite_master 2026-08-07, and identical in Neon.
    assert.deepEqual(NEON_BACKFILL_PLANS.neuron_daily.conflict, [
      "netuid",
      "uid",
      "snapshot_date",
    ]);
    assert.deepEqual(NEON_BACKFILL_PLANS.account_position_daily.conflict, [
      "account",
      "netuid",
      "snapshot_date",
    ]);
  });

  test("guards every write against a concurrent producer pass", () => {
    assert.equal(
      backfillGuard("neuron_daily"),
      "neuron_daily.captured_at < EXCLUDED.captured_at",
    );
  });
});

describe("the deployed wiring", () => {
  const wrangler = readFileSync("wrangler.data.jsonc", "utf8");

  test("the cron the handler dispatches on is actually declared", async () => {
    // A constant the trigger list does not carry is a lane that never fires,
    // and nothing else in CI compares the two.
    const { NEON_BACKFILL_CRON } = await import("../workers/config.ts");
    assert.ok(
      wrangler.includes(`"${NEON_BACKFILL_CRON}"`),
      `wrangler.data.jsonc declares no "${NEON_BACKFILL_CRON}" cron, so the reconciler never runs`,
    );
  });

  test("runs on the Worker that holds BOTH bindings", () => {
    // D1 in and Hyperdrive out. Anywhere else this would be a copy over HTTP.
    assert.ok(wrangler.includes('"binding": "METAGRAPH_HEALTH_DB"'));
    assert.ok(wrangler.includes('"binding": "HYPERDRIVE"'));
  });

  test("names only the two accumulating tables", () => {
    // Naming a latest-only table would copy ~800,000 rows to prove they
    // already agree: one producer cycle rewrites those whole.
    const named = /"NEON_BACKFILL_LANES":\s*"([^"]*)"/.exec(wrangler)?.[1];
    assert.deepEqual(named?.split(",").sort(), [
      "account_position_daily",
      "neuron_daily",
    ]);
    for (const table of named?.split(",") ?? []) {
      assert.ok(NEON_BACKFILL_PLANS[table], `${table} has no plan`);
    }
  });
});

describe("neonBackfillLanes", () => {
  test("is its own flag, defaulting to empty", () => {
    assert.deepEqual([...neonBackfillLanes(undefined)], []);
    assert.deepEqual([...neonBackfillLanes({})], []);
    assert.deepEqual([...neonBackfillLanes({ NEON_BACKFILL_LANES: "  " })], []);
    assert.deepEqual([...neonBackfillLanes({ NEON_BACKFILL_LANES: 7 })], []);
    assert.deepEqual(
      [...neonBackfillLanes({ NEON_BACKFILL_LANES: "a, b ,,c" })],
      ["a", "b", "c"],
    );
    // Naming a lane for the mirror must not enrol it in an 800,000-row copy.
    assert.deepEqual(
      [...neonBackfillLanes({ NEON_DUAL_WRITE_LANES: "neurons" })],
      [],
    );
  });
});

describe("keysetPredicate", () => {
  test("expands to one OR term per key column, with positional values", () => {
    assert.deepEqual(keysetPredicate(["netuid", "uid"], [12, 500]), {
      sql: "((netuid > ?) OR (netuid = ? AND uid > ?))",
      values: [12, 12, 500],
    });
  });

  test("a single-column keyset is a plain comparison", () => {
    assert.deepEqual(keysetPredicate(["account"], ["5A"]), {
      sql: "((account > ?))",
      values: ["5A"],
    });
  });
});

describe("dateDeficits", () => {
  const d1 = new Map([
    ["2026-08-05", 100],
    ["2026-08-06", 100],
    ["2026-08-07", 100],
    ["2026-08-04", 100],
  ]);

  test("reports only where Neon has fewer rows, newest date first", () => {
    const neon = new Map([
      ["2026-08-05", 100],
      ["2026-08-06", 40],
      ["2026-08-07", 0],
    ]);
    assert.deepEqual(dateDeficits(d1, neon), [
      { date: "2026-08-07", d1: 100, neon: 0 },
      { date: "2026-08-06", d1: 100, neon: 40 },
      { date: "2026-08-04", d1: 100, neon: 0 },
    ]);
  });

  test("a date where Neon holds MORE is not reported", () => {
    // This path only ever adds rows. A surplus is a question about deletes,
    // and copying cannot answer it -- reporting it would put the lane
    // permanently stale over something it can never fix.
    assert.deepEqual(
      dateDeficits(
        new Map([["2026-08-07", 10]]),
        new Map([["2026-08-07", 99]]),
      ),
      [],
    );
  });

  test("equal counts are not a deficit", () => {
    assert.deepEqual(
      dateDeficits(
        new Map([["2026-08-07", 10]]),
        new Map([["2026-08-07", 10]]),
      ),
      [],
    );
  });
});

describe("shapeRowForNeon", () => {
  test("D1's 0/1 become real booleans, and nothing else changes", () => {
    // The one shape difference between the stores. Rows the live mirror sends
    // carry JS booleans, so Neon's columns are BOOLEAN; rows read back out of
    // D1 are integers, so only this path has to convert.
    assert.deepEqual(
      shapeRowForNeon(
        { active: 1, validator_permit: 0, rank: 0.5, hotkey: "5H" },
        ["active", "validator_permit"],
      ),
      { active: true, validator_permit: false, rank: 0.5, hotkey: "5H" },
    );
  });

  test("null stays null rather than becoming false", () => {
    // `active IS NULL` and `active = false` are different facts about a neuron,
    // and Boolean(null) would quietly merge them.
    assert.deepEqual(shapeRowForNeon({ active: null }, ["active"]), {
      active: null,
    });
  });

  test("a column the row does not carry is left absent", () => {
    assert.deepEqual(shapeRowForNeon({ uid: 3 }, ["active"]), { uid: 3 });
  });

  test("does not mutate its input", () => {
    const row = { active: 1 };
    shapeRowForNeon(row, ["active"]);
    assert.equal(row.active, 1);
  });
});

describe("d1DateCounts / neonDateCounts", () => {
  test("group by snapshot_date on each side", async () => {
    const d1 = fakeDb([[{ d: "2026-08-07", n: 30109 }]]);
    assert.deepEqual(
      [...((await d1DateCounts(d1.db, "neuron_daily")) ?? [])],
      [["2026-08-07", 30109]],
    );
    assert.match(d1.calls[0].sql, /GROUP BY snapshot_date/);

    const neon = fakeSql([{ d: "2026-08-07", n: "30109" }]);
    assert.deepEqual(
      [...((await neonDateCounts(neon.sql, "neuron_daily")) ?? [])],
      // Postgres returns COUNT(*) as a string; the map holds numbers either way.
      [["2026-08-07", 30109]],
    );
    assert.match(neon.calls[0].text, /snapshot_date::text/);
  });

  test("a store that will not answer returns NULL, never an empty map", async () => {
    // The distinction this lane's safety rests on. An empty map would read as
    // "this store holds nothing", and against a healthy other side that is a
    // deficit of every row in the table.
    assert.equal(await d1DateCounts(null, "neuron_daily"), null);
    assert.equal(
      await d1DateCounts(fakeDb([], "GROUP BY").db, "neuron_daily"),
      null,
    );
    assert.equal(await neonDateCounts(null, "neuron_daily"), null);
    // A runner object with no `unsafe` on it -- what createPgSql returns when
    // the binding is present but the connection never opened.
    assert.equal(await neonDateCounts({} as never, "neuron_daily"), null);
    assert.equal(
      await neonDateCounts(fakeSql([], "GROUP BY").sql, "neuron_daily"),
      null,
    );
  });

  test("rows with no date, a bad count, or a non-array response are tolerated", async () => {
    const d1 = fakeDb([
      [
        { d: null, n: 5 },
        { d: "2026-08-07", n: "x" },
      ],
    ]);
    assert.deepEqual(
      [...((await d1DateCounts(d1.db, "neuron_daily")) ?? [])],
      [["2026-08-07", 0]],
    );
    const notRows = {
      async unsafe() {
        return null;
      },
    };
    assert.deepEqual([...((await neonDateCounts(notRows, "t")) ?? [])], []);
  });

  test("a D1 response carrying no `results` key is an empty count, not a crash", async () => {
    const d1 = fakeDb([null as unknown as unknown[]]);
    assert.deepEqual(
      [...((await d1DateCounts(d1.db, "neuron_daily")) ?? [])],
      [],
    );
  });
});

describe("readDatePage", () => {
  test("the first page has no keyset predicate", async () => {
    const d1 = fakeDb([[{ netuid: 1 }]]);
    await readDatePage(d1.db, PLAN, "2026-08-07", null, 500);
    assert.match(
      d1.calls[0].sql,
      /WHERE snapshot_date = \? ORDER BY netuid, uid LIMIT \?/,
    );
    assert.deepEqual(d1.calls[0].values, ["2026-08-07", 500]);
  });

  test("a resumed page seeks past the cursor, in keyset order", async () => {
    const d1 = fakeDb([[]]);
    await readDatePage(d1.db, PLAN, "2026-08-07", [12, 500], 500);
    assert.match(
      d1.calls[0].sql,
      /WHERE snapshot_date = \? AND \(\(netuid > \?\) OR \(netuid = \? AND uid > \?\)\)/,
    );
    assert.deepEqual(d1.calls[0].values, ["2026-08-07", 12, 12, 500, 500]);
  });

  test("selects exactly the plan's columns, so the write can bind positionally", async () => {
    const d1 = fakeDb([[]]);
    await readDatePage(d1.db, PLAN, "2026-08-07", null, 1);
    assert.ok(
      d1.calls[0].sql.startsWith(
        `SELECT ${PLAN.columns.join(", ")} FROM neuron_daily `,
      ),
    );
  });

  test("a response carrying no `results` key reads as the end of the date", async () => {
    const d1 = fakeDb([null as unknown as unknown[]]);
    assert.deepEqual(
      await readDatePage(d1.db, PLAN, "2026-08-07", null, 1),
      [],
    );
  });
});

describe("the whole-table partition", () => {
  const WHOLE = NEON_BACKFILL_PLANS.account_identity;
  const sig = (n: number, max: number | null) => [{ n, max_captured: max }];

  test("reads a signature from each store", async () => {
    const d1 = fakeDb([sig(497, 1786098804131)]);
    assert.deepEqual(await d1TableSignature(d1.db, "account_identity"), {
      rows: 497,
      maxCapturedAt: 1786098804131,
    });
    const pg = fakeSql(sig(497, 1786098804131));
    assert.deepEqual(await neonTableSignature(pg.sql, "account_identity"), {
      rows: 497,
      maxCapturedAt: 1786098804131,
    });
  });

  test("a store that will not answer reads as null, never as zero rows", async () => {
    // Same rule as d1DateCounts: an empty signature would make the other
    // store's entire contents look like a deficit.
    assert.equal(await d1TableSignature(null, "account_identity"), null);
    assert.equal(
      await d1TableSignature(fakeDb([], "SELECT COUNT").db, "account_identity"),
      null,
    );
    assert.equal(await neonTableSignature(null, "account_identity"), null);
    assert.equal(
      await neonTableSignature(fakeSql([], "SELECT").sql, "account_identity"),
      null,
    );
  });

  test("an empty table is a real signature, not a failure", async () => {
    assert.deepEqual(
      await d1TableSignature(fakeDb([sig(0, null)]).db, "account_identity"),
      { rows: 0, maxCapturedAt: null },
    );
  });

  test("signatures agree only when BOTH count and newest write match", () => {
    const a = { rows: 497, maxCapturedAt: 100 };
    assert.equal(signaturesAgree(a, { rows: 497, maxCapturedAt: 100 }), true);
    assert.equal(signaturesAgree(a, { rows: 496, maxCapturedAt: 100 }), false);
    // THE CASE A COUNT ALONE MISSES: same row count, one side rewritten. This
    // is the normal shape of drift for a dimension table -- an identity
    // changes, the row is UPDATED, and the count never moves.
    assert.equal(signaturesAgree(a, { rows: 497, maxCapturedAt: 99 }), false);
  });

  test("a whole-table page has no date predicate", async () => {
    const d1 = fakeDb([[]]);
    await readWholePage(d1.db, WHOLE, null, 500);
    assert.doesNotMatch(d1.calls[0].sql, /snapshot_date/);
    assert.match(
      d1.calls[0].sql,
      /FROM account_identity ORDER BY account LIMIT \?/,
    );
    assert.deepEqual(d1.calls[0].values, [500]);
  });

  test("a resumed whole-table page seeks past the cursor", async () => {
    const d1 = fakeDb([[]]);
    await readWholePage(d1.db, WHOLE, ["5Abc"], 500);
    assert.match(
      d1.calls[0].sql,
      /WHERE \(\(account > \?\)\) ORDER BY account/,
    );
    assert.deepEqual(d1.calls[0].values, ["5Abc", 500]);
  });

  test("in sync copies nothing", async () => {
    const d1 = fakeDb([sig(2, 100)]);
    const pg = fakeSql(sig(2, 100));
    const out = await reconcileTableToNeon(d1.db, pg.sql, WHOLE);
    assert.equal(out.ok, true);
    assert.equal(out.deficits, 0);
    assert.deepEqual(out.copied, []);
    assert.equal(
      d1.calls.some((c) => c.sql.startsWith("SELECT account,")),
      false,
      "read rows despite the signatures agreeing",
    );
  });

  test("drift with an EQUAL row count still copies", async () => {
    // The whole reason the signature is a pair.
    const d1 = fakeDb([sig(2, 200), [{ account: "a" }, { account: "b" }], []]);
    const pg = fakeSql(sig(2, 100));
    const out = await reconcileTableToNeon(d1.db, pg.sql, WHOLE);
    assert.equal(out.ok, true);
    assert.equal(out.deficits, 1);
    assert.equal(out.missing, 0, "no rows are MISSING; they are stale");
    assert.equal(out.remaining, 0);
    assert.equal(out.copied[0]?.date, WHOLE_TABLE_UNIT);
    assert.equal(out.copied[0]?.rows, 2);
  });

  test("a failed signature read refuses to copy", async () => {
    const d1 = fakeDb([sig(2, 200)]);
    const pg = fakeSql([], "SELECT");
    const out = await reconcileTableToNeon(d1.db, pg.sql, WHOLE);
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /signature failed: neon/);
    assert.deepEqual(out.copied, []);
  });

  test("a failed write reports the backlog as still owed", async () => {
    const d1 = fakeDb([sig(3, 200), [{ account: "a" }]]);
    const pg = fakeSql(sig(1, 100), "INSERT");
    const out = await reconcileTableToNeon(d1.db, pg.sql, WHOLE);
    assert.equal(out.ok, false);
    assert.equal(out.missing, 2);
    assert.equal(out.remaining, 2, "a failed copy must not clear the backlog");
  });

  test("a failed READ is reported, not counted as an empty table", async () => {
    const d1 = fakeDb([sig(3, 200)], "SELECT account,");
    const pg = fakeSql(sig(1, 100));
    const out = await reconcileTableToNeon(d1.db, pg.sql, WHOLE);
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /D1_ERROR/);
  });

  test("a signature query answering NO ROW reads as null, not as empty", () => {
    // COUNT(*) always returns exactly one row, even over an empty table. So a
    // response with no row is not "no data" -- it is a response that is not
    // the shape a count produces, and reading it as {rows: 0} would report the
    // other store's entire contents as a deficit.
    return Promise.all([
      d1TableSignature(fakeDb([[]]).db, "account_identity").then((v) =>
        assert.equal(v, null),
      ),
      neonTableSignature(fakeSql([]).sql, "account_identity").then((v) =>
        assert.equal(v, null),
      ),
    ]);
  });

  test("an unreadable count reads as zero rows, not as NaN", async () => {
    // A signature carrying NaN would compare unequal to itself forever, so the
    // lane would copy the whole table every tick and never converge.
    const sig = await d1TableSignature(
      fakeDb([[{ n: "not-a-number", max_captured: 5 }]]).db,
      "account_identity",
    );
    assert.deepEqual(sig, { rows: 0, maxCapturedAt: 5 });
  });

  test("a D1 response with no `results` key reads as null, not as empty", async () => {
    assert.equal(
      await d1TableSignature(fakeDb([null as unknown as unknown[]]).db, "t"),
      null,
    );
  });

  test("a non-array answer from Neon reads as null", async () => {
    const sql = {
      async unsafe() {
        return { rows: 1 } as unknown as unknown[];
      },
    };
    assert.equal(await neonTableSignature(sql, "account_identity"), null);
  });

  test("a whole-table page with no `results` key reads as the end", async () => {
    const d1 = fakeDb([null as unknown as unknown[]]);
    assert.deepEqual(await readWholePage(d1.db, WHOLE, null, 1), []);
  });

  test("an already-empty table copies nothing and still succeeds", async () => {
    const d1 = fakeDb([[]]);
    const out = await copyWholeTableToNeon(d1.db, fakeSql([]).sql, WHOLE, 2);
    assert.deepEqual(out, {
      ok: true,
      rows: 0,
      statements: 0,
      pages: 0,
      date: WHOLE_TABLE_UNIT,
    });
  });

  test("names D1 as the failing side when D1 is the one that failed", async () => {
    // The reason string is the only thing a human reads off the lane verdict,
    // so it has to name the store that actually failed.
    const d1 = fakeDb([], "SELECT COUNT");
    const out = await reconcileTableToNeon(
      d1.db,
      fakeSql(sig(1, 1)).sql,
      WHOLE,
    );
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /signature failed: d1/);
  });

  test("pages until D1 returns a short page", async () => {
    const rows = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ account: `a${from + i}` }));
    const d1 = fakeDb([rows(2, 0), rows(1, 2)]);
    const pg = fakeSql(sig(0, null));
    const out = await copyWholeTableToNeon(d1.db, pg.sql, WHOLE, 2);
    assert.equal(out.ok, true);
    assert.equal(out.pages, 2);
    assert.equal(out.rows, 3);
  });
});

describe("copyDateToNeon", () => {
  const row = (netuid: number, uid: number) => ({
    netuid,
    uid,
    active: 1,
    validator_permit: 0,
    is_immunity_period: 1,
    captured_at: 9,
    snapshot_date: "2026-08-07",
  });

  test("pages until D1 returns a short page, resuming from the last key", async () => {
    const d1 = fakeDb([[row(1, 1), row(1, 2)], [row(2, 9)]]);
    const neon = fakeSql();
    const out = await copyDateToNeon(d1.db, neon.sql, PLAN, "2026-08-07", 2);
    assert.deepEqual(
      { ok: out.ok, rows: out.rows, pages: out.pages, date: out.date },
      { ok: true, rows: 3, pages: 2, date: "2026-08-07" },
    );
    // The second read resumes from (1, 2) -- the last row of the first page.
    assert.deepEqual(d1.calls[1].values, ["2026-08-07", 1, 1, 2, 2]);
  });

  test("an empty first page finishes without writing", async () => {
    const d1 = fakeDb([[]]);
    const neon = fakeSql();
    const out = await copyDateToNeon(d1.db, neon.sql, PLAN, "2026-08-07", 2);
    assert.deepEqual(
      { ok: out.ok, rows: out.rows, pages: out.pages },
      {
        ok: true,
        rows: 0,
        pages: 0,
      },
    );
    assert.equal(neon.calls.length, 0);
  });

  test("carries the out-of-order guard and converts the boolean columns", async () => {
    // Both properties in one assertion because they protect the same write:
    // the guard stops this path regressing a row the producer just refreshed,
    // and the conversion is what lets the row be inserted at all.
    const d1 = fakeDb([[row(1, 1)]]);
    const neon = fakeSql();
    await copyDateToNeon(d1.db, neon.sql, PLAN, "2026-08-07", 5);
    assert.match(
      neon.calls[0].text,
      /WHERE neuron_daily\.captured_at < EXCLUDED\.captured_at/,
    );
    assert.match(
      neon.calls[0].text,
      /ON CONFLICT \(netuid, uid, snapshot_date\)/,
    );
    const active = PLAN.columns.indexOf("active");
    const permit = PLAN.columns.indexOf("validator_permit");
    assert.equal(neon.calls[0].values[active], true);
    assert.equal(neon.calls[0].values[permit], false);
  });

  test("stops at the first failed write rather than paging on", async () => {
    const d1 = fakeDb([[row(1, 1)], [row(2, 1)]]);
    const neon = fakeSql([], "INSERT");
    const out = await copyDateToNeon(d1.db, neon.sql, PLAN, "2026-08-07", 1);
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /relation missing/);
    assert.equal(out.pages, 1);
    assert.equal(d1.calls.length, 1, "no second page may be read");
  });

  test("a failed D1 read is reported, not thrown", async () => {
    const out = await copyDateToNeon(
      fakeDb([], "SELECT").db,
      fakeSql().sql,
      PLAN,
      "2026-08-07",
      5,
    );
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /overloaded/);
  });

  test("a rejection that is not an Error still reads", async () => {
    const thrower = {
      prepare() {
        return {
          bind() {
            return {
              async all(): Promise<never> {
                throw "connection terminated";
              },
            };
          },
          async all() {
            return { results: [] };
          },
        };
      },
    };
    const out = await copyDateToNeon(
      thrower,
      fakeSql().sql,
      PLAN,
      "2026-08-07",
      5,
    );
    assert.equal(out.reason, "connection terminated");
  });

  test("defaults to the module's page size", async () => {
    const d1 = fakeDb([[]]);
    await copyDateToNeon(d1.db, fakeSql().sql, PLAN, "2026-08-07");
    assert.equal(d1.calls[0].values.at(-1), D1_PAGE_ROWS);
  });
});

describe("reconcileTableToNeon", () => {
  const counts = (n: number) => [{ d: "2026-08-07", n }];

  test("an unbound store is reported, and nothing is read", async () => {
    assert.deepEqual(await reconcileTableToNeon(null, fakeSql().sql, PLAN), {
      table: "neuron_daily",
      deficits: 0,
      missing: 0,
      remaining: 0,
      copied: [],
      ok: false,
      reason: "unbound",
    });
    assert.equal(
      (await reconcileTableToNeon(fakeDb().db, null, PLAN)).reason,
      "unbound",
    );
  });

  test("a half-read comparison copies NOTHING", async () => {
    // The property that keeps a transient Neon fault from being read as "Neon
    // is empty" and triggering an 846,912-row copy.
    const d1 = fakeDb([counts(100)]);
    const out = await reconcileTableToNeon(
      d1.db,
      fakeSql([], "GROUP BY").sql,
      PLAN,
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, "count failed: neon");
    assert.equal(d1.calls.length, 1, "only the count may be read");

    const failedD1 = await reconcileTableToNeon(
      fakeDb([], "GROUP BY").db,
      fakeSql(counts(100)).sql,
      PLAN,
    );
    assert.equal(failedD1.reason, "count failed: d1");
  });

  test("stores that agree are a no-op", async () => {
    const d1 = fakeDb([counts(100)]);
    const out = await reconcileTableToNeon(
      d1.db,
      fakeSql(counts(100)).sql,
      PLAN,
    );
    assert.deepEqual(out, {
      table: "neuron_daily",
      deficits: 0,
      missing: 0,
      remaining: 0,
      copied: [],
      ok: true,
    });
    assert.equal(d1.calls.length, 1);
  });

  test("copies the deficient dates and reports how much was missing", async () => {
    const d1 = fakeDb([
      [
        { d: "2026-08-06", n: 2 },
        { d: "2026-08-07", n: 1 },
      ],
      [{ netuid: 1, uid: 1, captured_at: 9 }],
      [{ netuid: 1, uid: 2, captured_at: 9 }],
    ]);
    const out = await reconcileTableToNeon(
      d1.db,
      fakeSql([{ d: "2026-08-06", n: 0 }]).sql,
      PLAN,
    );
    assert.equal(out.ok, true);
    assert.equal(out.deficits, 2);
    assert.equal(out.missing, 3);
    // Newest first: 08-07 before 08-06.
    assert.deepEqual(
      out.copied.map((c) => c.date),
      ["2026-08-07", "2026-08-06"],
    );
  });

  test("caps the dates per tick even when the clock says there is room", async () => {
    const dates = ["01", "02", "03", "04", "05", "06"].map((d) => ({
      d: `2026-08-${d}`,
      n: 1,
    }));
    const d1 = fakeDb([dates, ...dates.map(() => [] as unknown[])]);
    const out = await reconcileTableToNeon(d1.db, fakeSql([]).sql, PLAN, {
      elapsed: () => 0,
    });
    assert.equal(out.deficits, 6);
    assert.equal(out.copied.length, MAX_DATES_PER_TICK);
  });

  test("stops on the budget BETWEEN dates, never inside one", async () => {
    // A date copied halfway would leave a deficit the next tick recomputes
    // correctly but restarts, so the unit of work is a whole date.
    const dates = [1, 2, 3].map((i) => ({ d: `2026-08-0${i}`, n: 1 }));
    const d1 = fakeDb([dates, [], [], []]);
    const out = await reconcileTableToNeon(d1.db, fakeSql([]).sql, PLAN, {
      elapsed: () => TICK_BUDGET_MS,
    });
    assert.equal(
      out.copied.length,
      1,
      "the first date always runs to completion",
    );
  });

  test("a failed copy stops the tick and reports the reason", async () => {
    const d1 = fakeDb([
      [
        { d: "2026-08-07", n: 1 },
        { d: "2026-08-06", n: 1 },
      ],
      [{ netuid: 1, uid: 1, captured_at: 9 }],
    ]);
    const out = await reconcileTableToNeon(
      d1.db,
      fakeSql([], "INSERT").sql,
      PLAN,
    );
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /relation missing/);
    assert.equal(out.copied.length, 1);
  });

  test("defaults its budget clock rather than requiring one", async () => {
    const d1 = fakeDb([[{ d: "2026-08-07", n: 1 }], []]);
    const out = await reconcileTableToNeon(d1.db, fakeSql([]).sql, PLAN);
    assert.equal(out.ok, true);
  });
});

describe("describeOutcome", () => {
  test("NEVER reports a negative backlog", () => {
    // Caught in production on the first tick: `account_position_daily` was 231
    // rows short, the unit of work is a whole DATE, so closing it wrote all
    // 30,278 of that date's rows and `missing - written` read
    // "~-30047 row(s) still behind".
    //
    // Rows written and rows owed are different quantities. `remaining` counts
    // the deficit of the dates NOT reached, so it is bounded by `missing` and
    // cannot go below zero however many rows a date turns out to hold.
    const text = describeOutcome({
      table: "account_position_daily",
      deficits: 2,
      missing: 231,
      remaining: 0,
      copied: [
        {
          ok: true,
          rows: 30_278,
          statements: 11,
          pages: 16,
          date: "2026-08-07",
        },
      ],
      ok: true,
    });
    assert.doesNotMatch(text, /-\d/, `negative figure in: ${text}`);
    assert.equal(
      text,
      "30278 row(s) over 1 date(s); 1 date(s) / 0 row(s) still behind",
    );
  });

  const base = {
    table: "neuron_daily",
    deficits: 0,
    missing: 0,
    remaining: 0,
    copied: [],
    ok: true,
  };

  test("names the state a reader of lane_health needs", () => {
    assert.equal(
      describeOutcome({ ...base, skipped: true }),
      "no deficit at last check",
    );
    assert.equal(describeOutcome(base), "in sync");
    assert.equal(
      describeOutcome({
        ...base,
        deficits: 26,
        missing: 816_803,
        remaining: 786_694,
        copied: [
          {
            ok: true,
            rows: 30_109,
            statements: 13,
            pages: 16,
            date: "2026-08-07",
          },
        ],
      }),
      "30109 row(s) over 1 date(s); 25 date(s) / 786694 row(s) still behind",
    );
    assert.equal(
      describeOutcome({
        ...base,
        ok: false,
        deficits: 2,
        copied: [
          { ok: false, rows: 40, statements: 1, pages: 1, date: "2026-08-07" },
        ],
      }),
      "40 row(s) copied before failure: unknown",
    );
    assert.match(
      describeOutcome({ ...base, ok: false, reason: "deadlock" }),
      /0 row\(s\) copied before failure: deadlock/,
    );
  });
});

describe("runNeonBackfill", () => {
  const on = { NEON_BACKFILL_LANES: "neuron_daily" };

  test("does nothing until a table is named", async () => {
    const d1 = fakeDb();
    for (const env of [undefined, null, {}, { NEON_BACKFILL_LANES: "" }]) {
      assert.deepEqual(await runNeonBackfill(env, ctx, { db: d1.db }), {
        attempted: false,
        tables: [],
      });
    }
    assert.equal(d1.calls.length, 0);
  });

  test("an UNKNOWN table is a no-op, not a throw", async () => {
    // The flag is a free-text list, and a typo must not take down the tick for
    // the tables spelled right.
    laneSpy.rows = [];
    const spy = laneSpy();
    const out = await runNeonBackfill(
      { NEON_BACKFILL_LANES: "neuron_dialy" },
      ctx,
      {
        db: fakeDb().db,
        sql: fakeSql().sql,
        laneHealthDb: spy.db,
        now: () => NOW,
      },
    );
    assert.deepEqual(out, { attempted: true, tables: [] });
    assert.equal(spy.written.length, 0);
  });

  test("reports STALE while any deficit remains, even on a successful copy", async () => {
    // A tick that copied 4 of 26 missing dates has not finished, and a verdict
    // of `ok` there would report progress as completion -- which is precisely
    // what #9698's alarm reads to decide whether this lane is converging.
    laneSpy.rows = [];
    const spy = laneSpy();
    const d1 = fakeDb([[{ d: "2026-08-07", n: 1 }], []]);
    await runNeonBackfill(on, ctx, {
      db: d1.db,
      sql: fakeSql([]).sql,
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.equal(spy.written[0].lane, "neon:backfill:neuron_daily");
    assert.equal(spy.written[0].verdict, "stale");
  });

  test("reports OK only when the comparison itself finds nothing missing", async () => {
    laneSpy.rows = [];
    const spy = laneSpy();
    const d1 = fakeDb([[{ d: "2026-08-07", n: 5 }]]);
    await runNeonBackfill(on, ctx, {
      db: d1.db,
      sql: fakeSql([{ d: "2026-08-07", n: 5 }]).sql,
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.equal(spy.written[0].verdict, "ok");
    assert.equal(spy.written[0].detail, "in sync");
  });

  test("skips the comparison for an hour after a clean verdict", async () => {
    // Two grouped counts over ~840,000 rows each is worth paying every three
    // minutes while copying and worth paying hourly once it is a watchdog.
    laneSpy.rows = [
      {
        lane: "neon:backfill:neuron_daily",
        verdict: "ok",
        age_ms: null,
        detail: "in sync",
        checked_at: NOW - 60_000,
      },
    ];
    const spy = laneSpy();
    const d1 = fakeDb();
    const out = await runNeonBackfill(on, ctx, {
      db: d1.db,
      sql: fakeSql().sql,
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.equal(out.tables[0].skipped, true);
    assert.equal(d1.calls.length, 0, "no count may be run while suppressed");
    assert.equal(spy.written.length, 0, "and no verdict is rewritten");
  });

  test("a STALE verdict is never suppressed, however recent", async () => {
    // Suppressing on a known-bad state is how a lane goes quiet while broken.
    laneSpy.rows = [
      {
        lane: "neon:backfill:neuron_daily",
        verdict: "stale",
        age_ms: null,
        detail: "behind",
        checked_at: NOW - 1_000,
      },
    ];
    const spy = laneSpy();
    const d1 = fakeDb([[{ d: "2026-08-07", n: 1 }]]);
    const out = await runNeonBackfill(on, ctx, {
      db: d1.db,
      sql: fakeSql([{ d: "2026-08-07", n: 1 }]).sql,
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.equal(out.tables[0].skipped, undefined);
    assert.ok(d1.calls.length > 0);
  });

  test("an EXPIRED clean verdict re-compares", async () => {
    laneSpy.rows = [
      {
        lane: "neon:backfill:neuron_daily",
        verdict: "ok",
        age_ms: null,
        detail: "in sync",
        checked_at: NOW - IDLE_RECHECK_MS - 1,
      },
    ];
    const spy = laneSpy();
    const d1 = fakeDb([[{ d: "2026-08-07", n: 1 }]]);
    await runNeonBackfill(on, ctx, {
      db: d1.db,
      sql: fakeSql([{ d: "2026-08-07", n: 1 }]).sql,
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.equal(spy.written[0].verdict, "ok");
  });

  test("one table's fault costs a verdict, never the other table's turn", async () => {
    // Everything inside reconcileTableToNeon guards its own store access, so
    // the outer catch exists for what those guards do not cover -- here, an
    // injected clock. What it protects is the LOOP: two tables share this
    // tick, and the first one faulting must not leave the second unmeasured.
    laneSpy.rows = [];
    const spy = laneSpy();
    let ticks = 0;
    const out = await runNeonBackfill(
      { NEON_BACKFILL_LANES: "neuron_daily,account_position_daily" },
      ctx,
      {
        db: fakeDb([
          [
            { d: "2026-08-07", n: 1 },
            { d: "2026-08-06", n: 1 },
          ],
          [],
          [{ d: "2026-08-07", n: 1 }],
        ]).db,
        sql: fakeSql([]).sql,
        laneHealthDb: spy.db,
        now: () => NOW,
        elapsed: () => {
          ticks += 1;
          if (ticks === 1) throw new Error("clock unavailable");
          return 0;
        },
      },
    );
    assert.equal(out.attempted, true);
    assert.equal(out.tables[0].ok, false);
    assert.deepEqual(
      spy.written.map((r) => [r.lane, r.verdict]),
      [
        ["neon:backfill:neuron_daily", "stale"],
        ["neon:backfill:account_position_daily", "stale"],
      ],
    );
    assert.match(String(spy.written[0].detail), /clock unavailable/);
  });

  test("enabled with no Hyperdrive records the misconfiguration", async () => {
    laneSpy.rows = [];
    const spy = laneSpy();
    const out = await runNeonBackfill(on, null, {
      db: fakeDb().db,
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.equal(out.tables[0].reason, "unbound");
    assert.equal(spy.written[0].verdict, "stale");
  });

  test("times its own budget from the start of the tick when none is injected", async () => {
    // The default budget clock is a closure over the tick's start, so a tick
    // that copies several dates measures itself against when IT began rather
    // than against each date.
    laneSpy.rows = [];
    const spy = laneSpy();
    const out = await runNeonBackfill(on, ctx, {
      db: fakeDb([
        [
          { d: "2026-08-07", n: 1 },
          { d: "2026-08-06", n: 1 },
        ],
        [],
        [],
      ]).db,
      sql: fakeSql([]).sql,
      laneHealthDb: spy.db,
    });
    assert.equal(out.tables[0].ok, true);
    assert.equal(out.tables[0].copied.length, 2);
  });

  test("takes its D1, its lane record and its clock off env, with no deps at all", async () => {
    // The Worker calls this with `(env, ctx)` and nothing else, so every `??`
    // in the wiring has to resolve from the environment -- including the fact
    // that METAGRAPH_HEALTH_DB is BOTH the store being reconciled and the
    // store the verdict is written to, because in production they are one
    // binding over one database.
    //
    // Hyperdrive points at a closed port, so this also covers the real
    // createPgSql path and a dead origin reading as a failed comparison rather
    // than an empty Neon.
    const combined = fakeDb([
      [], // loadLatestLaneHealth: no prior verdict
      [{ d: "2026-08-07", n: 30_109 }], // d1DateCounts
    ]);
    const out = await runNeonBackfill(
      {
        ...on,
        HYPERDRIVE: { connectionString: "postgresql://u:p@127.0.0.1:1/none" },
        METAGRAPH_HEALTH_DB: combined.db,
      },
      ctx,
    );
    assert.equal(out.attempted, true);
    assert.equal(out.tables[0].ok, false);
    assert.match(String(out.tables[0].reason), /count failed: neon/);
    assert.deepEqual(combined.written, [
      {
        lane: "neon:backfill:neuron_daily",
        verdict: "stale",
        detail: "0 row(s) copied before failure: count failed: neon",
      },
    ]);
  });
});
