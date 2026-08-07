// No route the Neon read map may move is allowed to use SQLite-only SQL
// (#9791).
//
// ## What this exists to have caught
//
// #9784 shipped a per-route map of which TABLES each route reads, and moved
// fifteen routes onto Neon on the strength of it. Nothing checked whether the
// QUERIES were portable. Three of them anchored a window with
// `date(MAX(snapshot_date), '-30 days')`, which Postgres does not have.
//
// The failure did not throw. The subquery yielded nothing, `>=` matched
// nothing, and the routes returned schema-stable empty results at 200 OK:
//
//     /api/v1/subnets/movers              5 rows -> 0
//     /api/v1/subnets/{netuid}/history   28 rows -> 0
//     /api/v1/validators                  5 rows -> 0   (fell back to an
//                                                        empty artifact, so
//                                                        even the shape looked
//                                                        normal)
//
// Two rollbacks. `NEON_READ_LANES` is down to one table. This test is the gate
// that has to exist before anything goes back in.
//
// ## Why a deny-list and not a parser
//
// A real SQL parser would be more precise and is the wrong trade here: the
// query text is assembled from template literals with interpolations, so it is
// not parseable without evaluating it. A deny-list of constructs that are
// SQLite-only is checkable on the raw text, cheap, and fails in the direction
// that matters -- a false positive costs a rewrite, a false negative costs a
// silent empty route.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { NEON_READ_ROUTE_TABLES } from "../workers/data-api.ts";

/**
 * Constructs that are valid SQLite and NOT valid Postgres.
 *
 * Each entry names the Postgres equivalent, because the useful failure message
 * is the one that says what to write instead.
 */
const SQLITE_ONLY: readonly {
  pattern: RegExp;
  what: string;
  instead: string;
}[] = [
  {
    pattern: /\bdate\s*\([^;]*?,\s*[`'"][-+]?\d/i,
    what: "date(x, 'modifier') — SQLite date arithmetic",
    instead:
      "compute the boundary in TypeScript and bind it (see src/portable-date-window.ts)",
  },
  {
    pattern: /\bdatetime\s*\([^;]*?,\s*[`'"][-+]?\d/i,
    what: "datetime(x, 'modifier')",
    instead: "compute it in TypeScript and bind it",
  },
  {
    pattern: /\bstrftime\s*\(/i,
    what: "strftime()",
    instead: "to_char(), or format it in TypeScript",
  },
  {
    pattern: /\bjulianday\s*\(/i,
    what: "julianday()",
    instead: "date subtraction in TypeScript",
  },
  {
    pattern: /\bunixepoch\s*\(/i,
    what: "unixepoch()",
    instead: "extract(epoch from …), or bind Date.now()",
  },
  {
    pattern: /\bifnull\s*\(/i,
    what: "IFNULL()",
    instead: "COALESCE(), which both accept",
  },
  {
    pattern: /\bgroup_concat\s*\(/i,
    what: "GROUP_CONCAT()",
    instead: "STRING_AGG()",
  },
  {
    pattern: /\bjson_extract\s*\(/i,
    what: "json_extract()",
    instead: "-> / ->> operators",
  },
  {
    pattern: /\bjson_each\s*\(/i,
    what: "json_each()",
    instead: "jsonb_array_elements()",
  },
  {
    pattern: /\binstr\s*\(/i,
    what: "INSTR()",
    instead: "POSITION(… IN …) or STRPOS()",
  },
  {
    pattern: /\bLIMIT\s+-1\b/i,
    what: "LIMIT -1",
    instead: "omit the LIMIT",
  },
  {
    pattern: /\bAUTOINCREMENT\b/i,
    what: "AUTOINCREMENT",
    instead: "GENERATED … AS IDENTITY",
  },
];

/** The matcher body, which is where every gate-able route's SQL lives. */
function matcherSource(): string {
  const src = readFileSync("workers/data-api.ts", "utf8");
  const start = src.indexOf("function matchNeuronsD1Route");
  assert.ok(start > 0, "matchNeuronsD1Route not found");
  const end = src.indexOf("\nfunction ", start + 10);
  return src.slice(start, end > 0 ? end : undefined);
}

/**
 * Comments removed.
 *
 * A comment DESCRIBING a banned construct is not a use of it -- and the
 * comments here necessarily name them, because they explain why the code no
 * longer uses them. Scanning raw text flagged /api/v1/chain/turnover for the
 * note recording what it was ported away from.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Per-route blocks, keyed by the literal path each guard matches. */
function routeBlocks(): { path: string; block: string }[] {
  const out: { path: string; block: string }[] = [];
  for (const block of matcherSource()
    .split(/\n {2}(?=if \()/)
    .slice(1)) {
    const literal = /pathname === "([^"]+)"/.exec(block)?.[1];
    if (literal) out.push({ path: literal, block: stripComments(block) });
  }
  return out;
}

describe("Neon-movable routes use portable SQL", () => {
  test("the block split still finds routes", () => {
    // Without this, every assertion below passes on an empty list -- which is
    // exactly how a scanning check stops checking.
    const blocks = routeBlocks();
    assert.ok(
      blocks.length >= 6,
      `only ${blocks.length} literal routes found in matchNeuronsD1Route; the ` +
        `split broke and this suite is testing nothing`,
    );
  });

  test("no route the read map may move contains SQLite-only SQL", () => {
    // THE GATE. A route in NEON_READ_ROUTE_TABLES is one the flag can send to
    // Postgres, so its SQL has to run there.
    const problems: string[] = [];
    for (const { path, block } of routeBlocks()) {
      const movable = NEON_READ_ROUTE_TABLES.some((r) => r.pattern.test(path));
      if (!movable) continue;
      for (const { pattern, what, instead } of SQLITE_ONLY) {
        if (pattern.test(block)) {
          problems.push(`${path}: uses ${what} — use ${instead}`);
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      "these routes can be sent to Neon by NEON_READ_LANES but their SQL is " +
        "SQLite-only. On Postgres they do not error -- they return an EMPTY " +
        `result at 200 OK (#9791):\n${problems.join("\n")}`,
    );
  });

  test("the deny-list actually matches the construct that caused #9791", () => {
    // Proving the fixture can fail. A deny-list that matches nothing would
    // pass this suite forever.
    const offending =
      "SELECT MIN(snapshot_date) FROM neuron_daily " +
      "WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), '-30 days') FROM neuron_daily)";
    const hit = SQLITE_ONLY.find((r) => r.pattern.test(offending));
    assert.ok(hit, "the date(x, modifier) rule no longer matches #9791's SQL");
    assert.match(hit.what, /date\(/);
  });

  test("the deny-list does not flag portable SQL", () => {
    // A false positive costs a needless rewrite, so the rules have to be
    // narrow. `date` as a COLUMN name, and single-argument date(), are fine.
    const portable =
      "SELECT snapshot_date, MAX(captured_at) FROM neuron_daily " +
      "WHERE snapshot_date >= $1 AND COALESCE(stake_tao, 0) > 0 GROUP BY snapshot_date";
    for (const { pattern, what } of SQLITE_ONLY) {
      assert.ok(
        !pattern.test(portable),
        `${what} matched portable SQL: ${portable}`,
      );
    }
  });
});
