// No SQL that a Neon read flag can reach is allowed to be store-specific
// (#9791).
//
// ## What this exists to have caught
//
// #9784 shipped a per-route map of which TABLES each route reads, and moved
// fifteen routes onto Neon on the strength of it. Nothing checked whether the
// QUERIES could run there. Two separate incompatibilities were waiting, and
// each one cost a rollback:
//
//   #9792  `date(MAX(snapshot_date), '-30 days')` -- a SQLite FUNCTION that
//          Postgres does not have.       /subnets/movers      5 rows -> 0
//                                        /subnets/{n}/history 28 rows -> 0
//   #9802  `validator_permit = 1` -- a TYPING mismatch. D1 stores the column
//          INTEGER 0/1; Neon declares it BOOLEAN, because the mirror writes
//          real JS booleans. Postgres rejects `boolean = integer`.
//                                        /validators          5 rows -> 0
//
// NEITHER FAILURE THREW ANYTHING A CALLER COULD SEE. The first yielded a NULL
// boundary so `>=` matched nothing; the second errored into a
// `?? buildGlobalValidators([])` fallback. Both returned a schema-stable 200
// with zero rows -- the one shape indistinguishable from "no data yet". Only a
// row-count baseline caught them, twice, after they were already live.
//
// This file is the gate that has to hold before anything goes back in.
//
// ## Why a deny-list and not a parser
//
// A real SQL parser would be more precise and is the wrong trade here: the
// query text is assembled from template literals with interpolations, so it is
// not parseable without evaluating it. A deny-list is checkable on raw text,
// cheap, and fails in the direction that matters -- a false positive costs a
// rewrite, a false negative costs a silently empty route in production.
//
// ## Why it scans loader modules and not just the matcher
//
// The route that broke worst did not hold its own SQL. /validators is served
// by loadGlobalValidators in src/metagraph-neurons.ts, reached through an
// injected runner that createPgD1Runner can swap for a Postgres one. Scanning
// only matchNeuronsD1Route would have declared #9802 impossible while it was
// live. Anything a movable route can reach is in scope.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { NEON_READ_ROUTE_TABLES } from "../workers/data-api.ts";

interface Rule {
  pattern: RegExp;
  what: string;
  instead: string;
}

/**
 * Constructs that are valid SQLite and NOT valid Postgres.
 *
 * Each entry names the Postgres equivalent, because the useful failure message
 * is the one that says what to write instead.
 */
const SQLITE_ONLY: readonly Rule[] = [
  {
    pattern: /\bdate\s*\([^;]*?,\s*[`'"][-+]?\d/i,
    what: "date(x, 'modifier') — SQLite date arithmetic",
    instead:
      "compute the boundary in TypeScript and bind it (see neuronDailyWindowBounds / src/iso-date-window.ts)",
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
  { pattern: /\bLIMIT\s+-1\b/i, what: "LIMIT -1", instead: "omit the LIMIT" },
  {
    pattern: /\bAUTOINCREMENT\b/i,
    what: "AUTOINCREMENT",
    instead: "GENERATED … AS IDENTITY",
  },
];

/**
 * Columns D1 stores as INTEGER 0/1 and Neon declares BOOLEAN.
 *
 * This is NOT a dialect difference -- both stores would accept both spellings
 * against a column of the matching type. It is a SCHEMA difference, and the
 * authority for the list is the mirror itself: `NEON_BACKFILL_PLANS[*].booleans`
 * in src/neon-backfill.ts names exactly the columns it converts with
 * `Boolean(value)` on the way in, which is why Neon's side of them is BOOLEAN.
 *
 * Kept in sync by a test below rather than by hand.
 */
const BOOLEAN_COLUMNS = [
  "validator_permit",
  "active",
  "is_immunity_period",
] as const;

/** Comparisons and aggregates that only work against ONE of the two schemas. */
const BOOLEAN_MISUSE: readonly Rule[] = BOOLEAN_COLUMNS.flatMap((column) => [
  {
    // `col = 1` / `col = 0`: Postgres rejects `boolean = integer` outright.
    pattern: new RegExp(`\\b${column}\\s*=\\s*[01]\\b`, "i"),
    what: `${column} = 0/1 — Postgres has this column as BOOLEAN`,
    instead: `${column} = TRUE / = FALSE, which SQLite also accepts (it aliases TRUE to 1)`,
  },
  {
    // SUM over the raw column: Postgres has no SUM(boolean) at all.
    pattern: new RegExp(`\\bSUM\\s*\\(\\s*${column}\\s*\\)`, "i"),
    what: `SUM(${column}) — Postgres cannot sum a boolean`,
    instead: `SUM(CASE WHEN ${column} THEN 1 ELSE 0 END), which is portable`,
  },
]);

const ALL_RULES: readonly Rule[] = [...SQLITE_ONLY, ...BOOLEAN_MISUSE];

/**
 * Modules whose SQL a movable route can execute through an injected runner.
 *
 * These hold the loaders the analytics routes delegate to. `createPgD1Runner`
 * makes them store-agnostic by construction -- which is exactly why their SQL
 * has to be portable, and why #9802 lived here rather than in the matcher.
 */
const REACHABLE_LOADERS = [
  "src/metagraph-neurons.ts",
  "src/movers.ts",
  "src/chain-turnover.ts",
  "src/concentration.ts",
  "src/subnet-yield.ts",
  "src/subnet-performance.ts",
  "src/live-economics-refresh.ts",
];

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

/** The matcher body, which is where the inline route SQL lives. */
function matcherSource(): string {
  const src = readFileSync("workers/data-api.ts", "utf8");
  const start = src.indexOf("function matchNeuronsD1Route");
  assert.ok(start > 0, "matchNeuronsD1Route not found");
  const end = src.indexOf("\nfunction ", start + 10);
  return src.slice(start, end > 0 ? end : undefined);
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

function violations(source: string, rules: readonly Rule[]): string[] {
  return rules
    .filter((r) => r.pattern.test(source))
    .map((r) => `uses ${r.what} — use ${r.instead}`);
}

describe("Neon-movable SQL is portable", () => {
  test("the block split still finds routes", () => {
    // Without this, the per-route assertion below passes on an empty list --
    // which is exactly how a scanning check stops checking.
    const blocks = routeBlocks();
    assert.ok(
      blocks.length >= 6,
      `only ${blocks.length} literal routes found in matchNeuronsD1Route; the ` +
        `split broke and this suite is testing nothing`,
    );
  });

  test("no route the read map may move contains store-specific SQL", () => {
    // THE GATE. A route in NEON_READ_ROUTE_TABLES is one the flag can send to
    // Postgres, so its SQL has to run there.
    const problems: string[] = [];
    for (const { path, block } of routeBlocks()) {
      if (!NEON_READ_ROUTE_TABLES.some((r) => r.pattern.test(path))) continue;
      for (const v of violations(block, ALL_RULES))
        problems.push(`${path}: ${v}`);
    }
    assert.deepEqual(
      problems,
      [],
      "these routes can be sent to Neon by NEON_READ_LANES but their SQL is " +
        "store-specific. On Postgres they do not error visibly -- they return " +
        `an EMPTY result at 200 OK (#9791):\n${problems.join("\n")}`,
    );
  });

  test("every tagged statement in the matcher is portable", () => {
    // The same scan at STATEMENT granularity rather than block granularity.
    // Block-level scanning reports the route; this reports the query, which is
    // the difference between "something in /subnets/movers is wrong" and a
    // line you can go fix. Both are kept because they fail on different
    // things: a statement built by concatenation is invisible here and caught
    // above, and a construct in a comment-adjacent block is caught here.
    const statements = [...matcherSource().matchAll(/sql`([^`]*)`/g)].map(
      (m) => m[1]!,
    );
    assert.ok(
      statements.length >= 10,
      `only ${statements.length} tagged statements found -- the extraction ` +
        `stopped working, so this assertion is passing on nothing`,
    );
    const problems: string[] = [];
    for (const statement of statements) {
      for (const v of violations(statement, ALL_RULES)) {
        problems.push(
          `${v}\n    in: ${statement.replace(/\s+/g, " ").trim().slice(0, 120)}`,
        );
      }
    }
    assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}\n`);
  });

  test("the loaders a movable route reaches are portable too", () => {
    // #9802 lived in src/metagraph-neurons.ts, not in the matcher, and it was
    // built by string concatenation rather than a tagged template -- so BOTH
    // of the scans above are blind to it. A gate that only read the matcher
    // would have called that regression impossible while it was serving an
    // empty leaderboard in production.
    const problems: string[] = [];
    for (const file of REACHABLE_LOADERS) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const v of violations(source, ALL_RULES))
        problems.push(`${file}: ${v}`);
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  test("the scan actually covers every route the read map may move", () => {
    // The matcher scans ONE function. That is only sufficient while every
    // route in NEON_READ_ROUTE_TABLES is dispatched from it -- and the map is
    // the thing that grows as tables move off D1 (#9787 has 46 to go).
    // Without this, adding a route whose handler lives elsewhere silently
    // shrinks the scan's coverage to nothing in particular, and it would still
    // report green.
    //
    // Compare on a CONCRETE PATH, not on regex source: the dispatcher spells
    // the parameterised routes with capture groups (`(\d+)`) and the map
    // without them, so the two sources never match textually even when they
    // describe the same route.
    const body = matcherSource();
    const guards = [
      // `if (url.pathname === "...")`
      ...[...body.matchAll(/pathname === "([^"]+)"/g)].map(
        (m) => (path: string) => path === m[1],
      ),
      // `url.pathname.match(/^\/api\/v1\/.../)`
      ...[...body.matchAll(/pathname\.match\(\s*(\/\^[^\n]*?\$\/)/g)].map(
        (m) => {
          const re = new RegExp(m[1]!.slice(1, -1));
          return (path: string) => re.test(path);
        },
      ),
    ];
    assert.ok(
      guards.length >= 12,
      `only ${guards.length} route guards extracted -- the extraction stopped ` +
        `working, so this test is passing on nothing`,
    );

    const uncovered = NEON_READ_ROUTE_TABLES.filter(({ pattern }) => {
      const path = pattern.source
        .replace(/^\^|\$$/g, "")
        .replace(/\\\//g, "/")
        .replace(/\[\^\/\]\+/g, "5Abc")
        .replace(/\\d\+/g, "7");
      return !guards.some((matches) => matches(path));
    });
    assert.deepEqual(
      uncovered.map((u) => u.pattern.source),
      [],
      "these read-map routes are not dispatched from the scanned function, so " +
        "the portability scan does not see their SQL",
    );
  });
});

describe("the deny-list is honest", () => {
  test("it matches the construct that caused #9792", () => {
    // Proving the fixture can fail. A deny-list that matches nothing would
    // pass this suite forever.
    const offending =
      "SELECT MIN(snapshot_date) FROM neuron_daily " +
      "WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), '-30 days') FROM neuron_daily)";
    const hit = SQLITE_ONLY.find((r) => r.pattern.test(offending));
    assert.ok(hit, "the date(x, modifier) rule no longer matches #9792's SQL");
    assert.match(hit.what, /date\(/);
  });

  test("it matches both constructs that caused #9802", () => {
    for (const offending of [
      "SELECT netuid, uid FROM neurons WHERE validator_permit = 1 AND hotkey IS NOT NULL",
      "SELECT netuid, SUM(validator_permit) AS validator_count FROM neuron_daily GROUP BY netuid",
    ]) {
      assert.ok(
        BOOLEAN_MISUSE.some((r) => r.pattern.test(offending)),
        `no boolean rule matches #9802's SQL: ${offending}`,
      );
    }
  });

  test("it does not flag the portable spellings", () => {
    // A false positive costs a needless rewrite, so the rules have to be
    // narrow: `date` as a COLUMN name, single-argument date(), `= TRUE`, and
    // the CASE form all have to pass.
    const portable =
      "SELECT snapshot_date, MAX(captured_at), " +
      "SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count " +
      "FROM neuron_daily WHERE snapshot_date >= $1 AND validator_permit = TRUE " +
      "AND COALESCE(stake_tao, 0) > 0 GROUP BY snapshot_date";
    for (const { pattern, what } of ALL_RULES) {
      assert.ok(!pattern.test(portable), `${what} matched portable SQL`);
    }
  });

  test("BOOLEAN_COLUMNS is the set the mirror actually converts", () => {
    // The authority is src/neon-backfill.ts: the columns it wraps in
    // Boolean() are precisely the ones Neon declares BOOLEAN. If a plan gains
    // one and this list does not, the new column is unguarded -- so derive the
    // expectation from that file rather than trusting the copy above.
    const source = readFileSync("src/neon-backfill.ts", "utf8");
    const declared = new Set<string>();
    for (const m of source.matchAll(/booleans:\s*\[([^\]]*)\]/g)) {
      for (const q of m[1]!.matchAll(/["']([^"']+)["']/g)) declared.add(q[1]!);
    }
    assert.ok(declared.size > 0, "no `booleans:` plan entries found");
    assert.deepEqual(
      [...declared].sort(),
      [...BOOLEAN_COLUMNS].sort(),
      "NEON_BACKFILL_PLANS names a different set of boolean columns than this " +
        "deny-list guards",
    );
  });
});
