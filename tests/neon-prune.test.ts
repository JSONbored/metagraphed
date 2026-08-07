// Neon-side retention for the rolling windows (src/neon-prune.ts, #9891).
//
// This is the only lane in the migration that DELETES, and it runs hourly with
// nobody watching, so the tests are almost entirely about what it refuses to
// do. The interesting cases are not "does it delete the right rows" -- one
// bounded predicate does that -- but the three ways a delete lane destroys a
// table by being confidently wrong about its own inputs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  MIN_RETENTION_MS,
  NEON_PRUNE_CRON,
  NEON_PRUNE_LANE,
  NEON_PRUNE_PLANS,
  describePrune,
  pruneImpact,
  pruneNeonTable,
  runNeonPrune,
} from "../src/neon-prune.ts";
import { HISTORY_RETENTION_MS } from "../src/health-prober.ts";
import { BURN_HISTORY_RETENTION_MS } from "../src/subnet-burn-history.ts";

const NOW = 1_786_000_000_000;
const ctx = { waitUntil() {} };

/** A Postgres stand-in that answers the impact count and records the DELETE. */
function fakeSql(impact: { doomed: number; survivors: number } | null) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    deletes: () => calls.filter((c) => c.text.startsWith("DELETE")),
    sql: {
      async unsafe(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        if (text.startsWith("SELECT")) return impact === null ? [] : [impact];
        return [];
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
            return { results: [] };
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
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

const PLAN = {
  table: "surface_checks",
  column: "checked_at",
  retentionMs: 30 * 24 * 60 * 60 * 1000,
};

describe("NEON_PRUNE_PLANS", () => {
  test("every retention is the SAME constant D1's prune uses", () => {
    // Not merely equal by value -- imported. A copied number here would be a
    // second source of truth for one window, and when they drift the stores
    // keep different history and parity reports a gap nobody can explain.
    assert.equal(
      NEON_PRUNE_PLANS.surface_checks!.retentionMs,
      HISTORY_RETENTION_MS,
    );
    assert.equal(
      NEON_PRUNE_PLANS.subnet_burn_history!.retentionMs,
      BURN_HISTORY_RETENTION_MS,
    );
  });

  test("the module restates no retention literal of its own", () => {
    // The guard above passes trivially if someone writes the same arithmetic
    // out again, so check the source: no day-scale millisecond literal may
    // appear outside the floor.
    // COMMENTS ARE STRIPPED FIRST. The docstrings quote
    // `30 * 24 * 60 * 60 * 1000` to explain what the floor is protecting
    // against, and a check that forbade the value in prose would push the
    // reasoning out of the file to satisfy a lint. What must not exist is a
    // literal the CODE reads.
    const code = readFileSync("src/neon-prune.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const literals = [
      ...code.matchAll(/\b\d+\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/g),
    ];
    assert.deepEqual(
      literals.map((m) => m[0]),
      [],
      "a retention literal in the code is a second source of truth for a window " +
        "that already has one; import the constant instead",
    );
  });

  test("every plan clears the floor", () => {
    for (const [name, plan] of Object.entries(NEON_PRUNE_PLANS)) {
      assert.ok(
        plan.retentionMs >= MIN_RETENTION_MS,
        `${name} retention is under the floor`,
      );
    }
  });

  test("the cron it dispatches on is actually declared", () => {
    const wrangler = readFileSync("wrangler.data.jsonc", "utf8");
    assert.ok(
      wrangler.includes(`"${NEON_PRUNE_CRON}"`),
      `${NEON_PRUNE_CRON} is not in wrangler.data.jsonc, so this lane never runs`,
    );
  });
});

describe("pruneNeonTable — what it refuses", () => {
  test("it REFUSES when the cutoff would take every row", async () => {
    // The failure this exists for. #9382 is the standing reminder of a seconds
    // value stored where milliseconds were expected: read as ms it lands in
    // 1970, so a cutoff computed in ms is above EVERY row and the DELETE takes
    // the whole table. Survivors-first turns data loss into a refusal.
    const pg = fakeSql({ doomed: 1_349_625, survivors: 0 });
    const out = await pruneNeonTable(pg.sql, PLAN, NOW);
    assert.equal(out.deleted, 0);
    assert.match(out.skipped ?? "", /refused/);
    assert.equal(pg.deletes().length, 0, "it must not have issued a DELETE");
  });

  test("it refuses a retention under the floor", async () => {
    // `30 * 1000` instead of `30 * 24 * 60 * 60 * 1000` is a plausible slip,
    // and would erase everything older than thirty seconds on the next tick.
    const pg = fakeSql({ doomed: 10, survivors: 10 });
    const out = await pruneNeonTable(
      pg.sql,
      { ...PLAN, retentionMs: 30_000 },
      NOW,
    );
    assert.match(out.skipped ?? "", /floor/);
    assert.equal(pg.calls.length, 0, "it must not even have measured");
  });

  test("an unreadable impact is a skip, never a delete", async () => {
    const pg = fakeSql(null);
    const out = await pruneNeonTable(pg.sql, PLAN, NOW);
    assert.match(out.skipped ?? "", /unreadable/);
    assert.equal(pg.deletes().length, 0);
  });

  test("nothing older than the cutoff is a clean no-op, not a skip", async () => {
    const pg = fakeSql({ doomed: 0, survivors: 500 });
    const out = await pruneNeonTable(pg.sql, PLAN, NOW);
    assert.equal(out.deleted, 0);
    assert.equal(out.skipped, undefined);
    assert.equal(pg.deletes().length, 0);
  });
});

describe("pruneNeonTable — what it does", () => {
  test("it deletes below the cutoff, with the boundary BOUND not interpolated", async () => {
    const pg = fakeSql({ doomed: 4_200, survivors: 1_000_000 });
    const out = await pruneNeonTable(pg.sql, PLAN, NOW);
    assert.equal(out.deleted, 4_200);
    const del = pg.deletes()[0]!;
    assert.equal(del.text, "DELETE FROM surface_checks WHERE checked_at < $1");
    assert.deepEqual(del.values, [NOW - PLAN.retentionMs]);
  });

  test("a failed delete is reported, not thrown", async () => {
    const pg = {
      sql: {
        async unsafe(text: string) {
          if (text.startsWith("SELECT")) return [{ doomed: 5, survivors: 5 }];
          throw new Error("connection reset");
        },
      },
    };
    const out = await pruneNeonTable(pg.sql, PLAN, NOW);
    assert.equal(out.deleted, 0);
    assert.match(out.skipped ?? "", /connection reset/);
  });

  test("pruneImpact asks about both sides of the cutoff in ONE statement", async () => {
    // Two round trips could straddle a write and disagree with each other,
    // which for a survivors check is the difference between refusing and not.
    const pg = fakeSql({ doomed: 1, survivors: 1 });
    await pruneImpact(pg.sql, PLAN, NOW);
    assert.equal(pg.calls.length, 1);
    assert.match(pg.calls[0]!.text, /FILTER \(WHERE checked_at < \$1\)/);
    assert.match(pg.calls[0]!.text, /FILTER \(WHERE checked_at >= \$1\)/);
  });
});

describe("runNeonPrune", () => {
  test("it only touches tables the backfill flag actually enables", async () => {
    // A table absent from the flag has an EMPTY Neon copy -- not a window with
    // a tail. Pruning it would be deleting a backfill in progress.
    const pg = fakeSql({ doomed: 10, survivors: 10 });
    const lane = laneSpy();
    const out = await runNeonPrune(
      { HYPERDRIVE: {}, NEON_BACKFILL_LANES: "neuron_daily" },
      ctx,
      { sql: pg.sql, laneHealthDb: lane.db, now: () => NOW },
    );
    assert.equal(out.attempted, true);
    assert.deepEqual(out.outcomes, []);
    assert.equal(pg.deletes().length, 0);
    assert.match(String(lane.written[0]!.detail), /no mirrored window/);
  });

  test("an enabled window is pruned and recorded", async () => {
    const pg = fakeSql({ doomed: 7, survivors: 900 });
    const lane = laneSpy();
    await runNeonPrune(
      { HYPERDRIVE: {}, NEON_BACKFILL_LANES: "surface_checks" },
      ctx,
      { sql: pg.sql, laneHealthDb: lane.db, now: () => NOW },
    );
    assert.equal(pg.deletes().length, 1);
    assert.equal(lane.written[0]!.lane, NEON_PRUNE_LANE);
    assert.equal(lane.written[0]!.verdict, "ok");
    assert.match(String(lane.written[0]!.detail), /surface_checks -7/);
  });

  test("a REFUSAL is stale, not ok", async () => {
    // Silence would make the guard pointless: a plan disagreeing with its own
    // table is exactly the thing somebody has to look at.
    const pg = fakeSql({ doomed: 900, survivors: 0 });
    const lane = laneSpy();
    await runNeonPrune(
      { HYPERDRIVE: {}, NEON_BACKFILL_LANES: "surface_checks" },
      ctx,
      { sql: pg.sql, laneHealthDb: lane.db, now: () => NOW },
    );
    assert.equal(lane.written[0]!.verdict, "stale");
  });

  test("no Hyperdrive means it does not run at all", async () => {
    const out = await runNeonPrune({}, ctx, { now: () => NOW });
    assert.deepEqual(out, { attempted: false });
  });
});

describe("describePrune", () => {
  test("it names the table and the count, or the reason", () => {
    assert.equal(
      describePrune([
        { table: "surface_checks", deleted: 4200 },
        {
          table: "subnet_burn_history",
          deleted: 0,
          skipped: "refused: all rows",
        },
      ]),
      "surface_checks -4200, subnet_burn_history refused: all rows",
    );
  });
});
