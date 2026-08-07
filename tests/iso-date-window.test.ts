// The window boundary that replaced a dialect function (#9798).
//
// This exists because `date(MAX(snapshot_date), '-30 days')` -- SQLite's, with
// no Postgres equivalent -- silently emptied `/subnets/{netuid}/history` and
// `/subnets/movers` the moment #9784 moved them to Neon: the subquery yielded
// nothing, `>=` matched nothing, and both served a schema-stable 200 with zero
// rows. Doing the shift here is what removes the dialect from the question, so
// the arithmetic is worth pinning on its own.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { shiftIsoDate } from "../src/iso-date-window.ts";

describe("shiftIsoDate", () => {
  test("shifts backwards, which is the only direction the routes use", () => {
    assert.equal(shiftIsoDate("2026-08-07", -30), "2026-07-08");
    assert.equal(shiftIsoDate("2026-08-07", -1), "2026-08-06");
    assert.equal(shiftIsoDate("2026-08-07", -7), "2026-07-31");
  });

  test("crosses month, year and leap-day boundaries", () => {
    // The arithmetic is on epoch ms, so these are not special cases in the
    // implementation -- they are the cases a hand-rolled y/m/d subtraction
    // would get wrong, which is why it is not hand-rolled.
    assert.equal(shiftIsoDate("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftIsoDate("2024-03-01", -1), "2024-02-29", "leap year");
    assert.equal(shiftIsoDate("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftIsoDate("2026-01-15", -365), "2025-01-15");
  });

  test("a zero or forward shift is arithmetic, not a special case", () => {
    assert.equal(shiftIsoDate("2026-08-07", 0), "2026-08-07");
    assert.equal(shiftIsoDate("2026-08-07", 30), "2026-09-06");
  });

  test("truncates a fractional day rather than emitting a time", () => {
    // A window constant should always be whole days, but the output is BOUND
    // INTO SQL and compared against 'YYYY-MM-DD' -- so a value carrying hours
    // would silently match nothing, which is the failure mode this whole
    // module exists to end.
    assert.equal(shiftIsoDate("2026-08-07", -1.9), "2026-08-06");
    assert.equal(shiftIsoDate("2026-08-07", 1.9), "2026-08-08");
  });

  test("returns null for a value that is not an ISO date", () => {
    // These arrive FROM THE STORE. An empty table yields SQL NULL, and the
    // caller must see the same "no window" signal the NULL subquery produced
    // rather than bind the string "Invalid Date" into a query.
    assert.equal(shiftIsoDate(null, -30), null);
    assert.equal(shiftIsoDate(undefined, -30), null);
    assert.equal(shiftIsoDate("", -30), null);
    assert.equal(shiftIsoDate(20260807, -30), null, "a number is not a date");
    assert.equal(shiftIsoDate("2026-08-07T00:00:00Z", -30), null, "not bare");
    assert.equal(shiftIsoDate("07/08/2026", -30), null);
    assert.equal(shiftIsoDate("2026-8-7", -30), null, "unpadded");
  });

  test("returns null for a well-SHAPED date the calendar rejects", () => {
    // The regex counts digits, not calendars, so this branch is genuinely
    // reachable -- verified against Date.parse rather than assumed.
    assert.equal(shiftIsoDate("2026-13-01", -1), null, "month 13");
    assert.equal(shiftIsoDate("2026-01-32", -1), null, "day 32");
    assert.equal(shiftIsoDate("2026-00-10", -1), null, "month 0");
    // And the one Date.parse does NOT reject, pinned so the comment in the
    // module stays honest: it rolls over rather than failing.
    assert.equal(shiftIsoDate("2026-02-31", 0), "2026-03-03");
  });

  test("returns null when the shift itself is not a number", () => {
    assert.equal(shiftIsoDate("2026-08-07", Number.NaN), null);
    assert.equal(shiftIsoDate("2026-08-07", Number.POSITIVE_INFINITY), null);
    assert.equal(shiftIsoDate("2026-08-07", Number.NEGATIVE_INFINITY), null);
  });
});
