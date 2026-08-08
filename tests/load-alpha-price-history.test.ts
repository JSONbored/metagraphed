// The alpha-price history loader reads Neon over a plain `pg` connection. What
// these tests pin is the FAILURE CONTRACT: this loader is allowed to return
// null (the bake then emits null change fields, which is schema-stable), so
// every path that cannot produce real history must return null rather than an
// empty map -- an empty map is a confident "no price moved", and it is
// indistinguishable downstream from the truth.
//
// That confusion has already happened twice. It served null change fields on
// /api/v1/economics for a day after the box wipe, when the loader was still
// asking a destroyed Postgres; and it would have repeated verbatim on the day
// D1 was dropped, when the HTTP door starts answering 404 for a database that
// no longer exists. Both times the loader "failed gracefully" and the graceful
// failure was indistinguishable from an honest answer.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ALPHA_PRICE_HISTORY_LOOKBACK_DAYS,
  alphaPriceHistoryQuery,
  loadAlphaPriceHistoryByNetuid,
  type PgLike,
} from "../scripts/lib/load-alpha-price-history.ts";

const CREDS = { DATABASE_URL: "postgresql://example/db" };

/**
 * A `pg` client that answers with `rows`, recording what it was asked and
 * whether it was closed.
 *
 * `closed` is asserted rather than incidental: a publish run is short-lived,
 * but a socket left open holds the job open behind it.
 */
function pgClient(
  rows: unknown,
  opts: { failOn?: "connect" | "query" } = {},
): {
  factory: (connectionString: string) => PgLike;
  calls: { connectionString: string; sql: string[] };
  state: { closed: boolean };
} {
  const calls = { connectionString: "", sql: [] as string[] };
  const state = { closed: false };
  const factory = (connectionString: string): PgLike => {
    calls.connectionString = connectionString;
    return {
      async connect() {
        if (opts.failOn === "connect") throw new Error("ECONNREFUSED");
      },
      async end() {
        state.closed = true;
      },
      async query(text: string) {
        calls.sql.push(text);
        if (opts.failOn === "query") {
          throw new Error('relation "subnet_snapshots" does not exist');
        }
        return rows as { rows?: unknown[] } | undefined;
      },
    };
  };
  return { factory, calls, state };
}

describe("alphaPriceHistoryQuery", () => {
  // THE INCIDENT THIS PINS. This query has TWO engines behind it -- the D1 HTTP
  // door at build time, and Postgres through readStore in
  // src/live-economics-refresh.ts. It used to carry `date('now','-40 days')`,
  // which is SQLite's spelling and `function date(unknown, unknown) does not
  // exist` on Postgres. The read sits inside refreshLiveEconomics's own try, so
  // the throw took the WHOLE tick: KV `economics:current` stopped advancing
  // while the last good blob kept being served.
  //
  // So what is asserted is the ABSENCE of a dialect, not the presence of one.
  test("carries no date function at all, in either dialect", () => {
    const sql = alphaPriceHistoryQuery();
    assert.ok(!/date\s*\(/i.test(sql), `a date function survived: ${sql}`);
    assert.ok(!sql.includes("INTERVAL"));
    assert.ok(!sql.includes("CURRENT_DATE"));
    assert.match(sql, /ORDER BY netuid ASC, snapshot_date ASC/);
  });

  test("compares against a plain YYYY-MM-DD literal, which both engines parse", () => {
    const sql = alphaPriceHistoryQuery(ALPHA_PRICE_HISTORY_LOOKBACK_DAYS, () =>
      Date.parse("2026-08-08T00:00:00Z"),
    );
    // 40 days before 2026-08-08.
    assert.match(sql, /WHERE snapshot_date >= '2026-06-29'/);
  });

  test("truncates a fractional lookback rather than emitting a broken literal", () => {
    const sql = alphaPriceHistoryQuery(7.9, () =>
      Date.parse("2026-08-08T00:00:00Z"),
    );
    // 7 days, not 7.9 -- a fractional day would land mid-day and shift the
    // boundary by the time of day the build happened to run.
    assert.match(sql, /WHERE snapshot_date >= '2026-08-01'/);
  });
});

describe("loadAlphaPriceHistoryByNetuid", () => {
  test("indexes the rows by netuid, and closes the connection", async () => {
    const { factory, calls, state } = pgClient({
      rows: [
        { netuid: 1, snapshot_date: "2026-08-01", alpha_price_tao: 0.5 },
        { netuid: 1, snapshot_date: "2026-08-02", alpha_price_tao: 0.6 },
        { netuid: 2, snapshot_date: "2026-08-02", alpha_price_tao: 0.1 },
      ],
    });
    const history = await loadAlphaPriceHistoryByNetuid(CREDS, factory);
    assert.ok(history);
    assert.equal(history.size, 2);
    assert.deepEqual(history.get(1), [
      // #9449: captured_at rides along so the window arithmetic downstream
      // measures elapsed time instead of subtracting calendar dates.
      { snapshot_date: "2026-08-01", alpha_price_tao: 0.5, captured_at: null },
      { snapshot_date: "2026-08-02", alpha_price_tao: 0.6, captured_at: null },
    ]);
    assert.equal(calls.connectionString, "postgresql://example/db");
    assert.equal(calls.sql.length, 1);
    assert.equal(calls.sql[0], alphaPriceHistoryQuery());
    assert.equal(state.closed, true, "the connection was left open");
  });

  test("an empty result set is a real answer, not a failure", async () => {
    const { factory } = pgClient({ rows: [] });
    const history = await loadAlphaPriceHistoryByNetuid(CREDS, factory);
    assert.ok(history);
    assert.equal(history.size, 0);
  });

  test("no DATABASE_URL returns null without opening a connection", async () => {
    let opened = false;
    const factory = () => {
      opened = true;
      return {} as PgLike;
    };
    assert.equal(await loadAlphaPriceHistoryByNetuid({}, factory), null);
    assert.equal(opened, false);
  });

  test("a failed connect and a failed query both decline, and still close", async () => {
    // The two shapes the drop will actually produce: the host is gone, or the
    // relation is. Neither may bake a confident "no price moved".
    const refused = pgClient({ rows: [] }, { failOn: "connect" });
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(CREDS, refused.factory),
      null,
    );
    assert.equal(refused.state.closed, true);

    const missing = pgClient({ rows: [] }, { failOn: "query" });
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(CREDS, missing.factory),
      null,
    );
    assert.equal(missing.state.closed, true);
  });

  test("a response with no rows array declines rather than reading as empty", async () => {
    // An empty map would bake confident nulls from a response we failed to
    // parse -- the distinction this whole file exists for.
    for (const shape of [{}, { rows: null }, { rows: "nope" }, undefined]) {
      const { factory } = pgClient(shape);
      assert.equal(
        await loadAlphaPriceHistoryByNetuid(CREDS, factory),
        null,
        `shape ${JSON.stringify(shape)} should decline`,
      );
    }
  });
});
