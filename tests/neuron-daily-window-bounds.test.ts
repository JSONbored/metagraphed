// The four query shapes of neuronDailyWindowBounds (#9798).
//
// tests/data-api-neurons-d1.test.ts drives the two shapes today's routes reach,
// end to end against real SQLite. This file covers all four, because the other
// two are unreachable only by accident of the current window maps --
// CHAIN_TURNOVER_WINDOWS and MOVERS_WINDOWS are `Record<string, number>` so a
// chain-wide call cannot carry a null window, while HISTORY_WINDOWS's
// `all: null` makes the per-netuid one. Add `all` to either map and the
// untested shape ships.
//
// It also pins the thing that actually matters after #9792: THE SQL CONTAINS NO
// DIALECT FUNCTION. `date(MAX(snapshot_date), '-30 days')` is SQLite's, Postgres
// has none, and its absence is why these routes can move store at all -- so the
// statements themselves are asserted, not just their results.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { neuronDailyWindowBounds } from "../workers/data-api.ts";

type Call = { text: string; values: unknown[] };

/**
 * A tagged-template `sql` that records what it was asked, and answers from a
 * queue. Deliberately does not parse SQL -- the assertions here are about the
 * statement TEXT and the bound values, which is exactly what a real database
 * cannot tell you (it would happily run either dialect's own spelling).
 */
function fakeSql(responses: Record<string, unknown>[][]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  sql.unsafe = () => Promise.resolve([]);
  return { sql: sql as never, calls };
}

describe("neuronDailyWindowBounds", () => {
  test("chain-wide, windowed: binds the shifted max and names no date function", async () => {
    const { sql, calls } = fakeSql([
      [{ end_date: "2026-08-07" }],
      [{ start_date: "2026-07-09" }],
    ]);
    const bounds = await neuronDailyWindowBounds(sql, 30);
    assert.deepEqual(bounds, {
      startDate: "2026-07-09",
      endDate: "2026-08-07",
    });
    assert.equal(calls.length, 2);
    // The boundary is a BOUND VALUE, computed here: 2026-08-07 minus 30 days.
    assert.deepEqual(calls[1]!.values, ["2026-07-08"]);
    assert.match(calls[1]!.text, /snapshot_date >= \?/);
  });

  test("per-netuid, windowed: scopes BOTH statements to the netuid", async () => {
    const { sql, calls } = fakeSql([
      [{ end_date: "2026-08-07" }],
      [{ start_date: "2026-08-01" }],
    ]);
    const bounds = await neuronDailyWindowBounds(sql, 7, 7);
    assert.equal(bounds.startDate, "2026-08-01");
    // The max must be the NETUID's max, not the table's -- a chain-wide max
    // would shift the window off a subnet that stopped reporting days ago.
    assert.match(calls[0]!.text, /WHERE netuid = \?/);
    assert.deepEqual(calls[0]!.values, [7]);
    assert.deepEqual(calls[1]!.values, [7, "2026-07-31"]);
  });

  test("a null window binds no boundary at all", async () => {
    // `all` in HISTORY_WINDOWS. There is nothing to shift, so the start is the
    // slice's own minimum and no cutoff is bound -- binding null here would
    // match nothing, which is the #9792 failure wearing a different hat.
    const perNetuid = fakeSql([
      [{ end_date: "2026-08-07" }],
      [{ start_date: "2025-01-01" }],
    ]);
    await neuronDailyWindowBounds(perNetuid.sql, null, 7);
    assert.deepEqual(perNetuid.calls[1]!.values, [7]);
    assert.doesNotMatch(perNetuid.calls[1]!.text, /snapshot_date >= /);

    const chainWide = fakeSql([
      [{ end_date: "2026-08-07" }],
      [{ start_date: "2024-06-01" }],
    ]);
    const bounds = await neuronDailyWindowBounds(chainWide.sql, null);
    assert.deepEqual(bounds, {
      startDate: "2024-06-01",
      endDate: "2026-08-07",
    });
    assert.deepEqual(chainWide.calls[1]!.values, []);
  });

  test("an empty table returns nulls and never issues the second query", async () => {
    // Both halves matter: nulls are the signal every caller already branches
    // on, and skipping the second read is what stops an empty store costing
    // two round trips per request.
    const { sql, calls } = fakeSql([[{ end_date: null }]]);
    assert.deepEqual(await neuronDailyWindowBounds(sql, 30), {
      startDate: null,
      endDate: null,
    });
    assert.equal(calls.length, 1);

    const noRow = fakeSql([[]]);
    assert.deepEqual(await neuronDailyWindowBounds(noRow.sql, 30), {
      startDate: null,
      endDate: null,
    });
    assert.equal(noRow.calls.length, 1);
  });

  test("a store that returns no row for the MIN degrades to a null start", async () => {
    // Not reachable through D1 or Postgres, both of which always return a row
    // for a bare aggregate -- which is precisely why it is asserted here rather
    // than left to a runner that happens to behave.
    const { sql } = fakeSql([[{ end_date: "2026-08-07" }], []]);
    assert.deepEqual(await neuronDailyWindowBounds(sql, 30), {
      startDate: null,
      endDate: "2026-08-07",
    });
  });

  test("no statement it issues contains a dialect-specific date function", async () => {
    // The regression guard. Every shape, every statement.
    for (const [days, netuid] of [
      [30, null],
      [7, 7],
      [null, 7],
      [null, null],
    ] as const) {
      const { sql, calls } = fakeSql([
        [{ end_date: "2026-08-07" }],
        [{ start_date: "2026-07-09" }],
      ]);
      await neuronDailyWindowBounds(sql, days, netuid);
      for (const { text } of calls) {
        assert.doesNotMatch(
          text,
          /\b(?:date|datetime|julianday|strftime)\s*\(/i,
          `dialect function in: ${text}`,
        );
      }
    }
  });
});
