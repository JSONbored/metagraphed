// Which routes may be served from Neon (workers/data-api.ts, infra#336).
//
// The gate picks ONE runner and the handler uses it for every query it makes,
// so a route touching two mirrored tables cannot half-move. That is the
// property this file exists to hold, and it is a correction to how #9768
// shipped: the position-history gate checked only `account_position_daily`
// while its handler also read `neurons`, so naming one table silently moved
// both. It was safe -- `neurons` mirrors every producer tick and matched D1 on
// a content checksum -- but safe by luck is not what a gate is for.
//
// The map is also asserted against the handlers' OWN SQL. A map that drifts
// from the queries would gate on the wrong evidence, which is worse than no
// gate: it would report a table as proven while reading one that is not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  NEON_READ_ROUTE_TABLES,
  neonServesRoute,
  POSITION_HISTORY_NEON_LANE,
} from "../workers/data-api.ts";

/** Tables the mirror covers. A route reading one of these is gate-relevant. */
const MIRRORED = [
  "neurons",
  "neuron_daily",
  "account_position_daily",
  "nominator_positions",
  "account_balances",
  "hotkey_alpha",
  "validator_nominator_counts",
];

const ALL = "account_position_daily,neurons,neuron_daily,nominator_positions";

describe("NEON_READ_ROUTE_TABLES", () => {
  test("every entry names only mirrored tables", () => {
    for (const { pattern, tables } of NEON_READ_ROUTE_TABLES) {
      assert.ok(tables.length > 0, `${pattern} declares no tables`);
      for (const table of tables) {
        assert.ok(
          MIRRORED.includes(table),
          `${pattern} names "${table}", which no mirror covers -- a route ` +
            `gated on an unmirrored table would move to a store nothing writes`,
        );
      }
    }
  });

  test("no two entries match the same path", () => {
    // `find` takes the first match, so an overlapping pair would make the
    // second entry dead and its table list silently unenforced.
    const samples = [
      "/api/v1/subnets/movers",
      "/api/v1/chain/turnover",
      "/api/v1/subnets/1/turnover",
      "/api/v1/subnets/1/history",
      "/api/v1/validators",
      "/api/v1/accounts",
      "/api/v1/chain/concentration",
      "/api/v1/chain/concentration/subnets",
      "/api/v1/subnets/1/metagraph",
    ];
    for (const path of samples) {
      const hits = NEON_READ_ROUTE_TABLES.filter((r) => r.pattern.test(path));
      assert.equal(
        hits.length,
        1,
        `${path} matches ${hits.length} entries; expected exactly one`,
      );
    }
  });

  test("each route's declared tables are the ones its handler queries", () => {
    // THE LOAD-BEARING TEST, and it must be PER ROUTE. Checking only that each
    // table appears somewhere in the map would pass a mapping that gates
    // /subnets/movers on `neurons` when it actually reads `neuron_daily` --
    // gating on the wrong evidence, which is worse than no gate.
    //
    // So: split the matcher into its per-route blocks, resolve each block to a
    // concrete path, and compare the mirrored tables its SQL names against
    // what NEON_READ_ROUTE_TABLES declares for that path.
    const src = readFileSync("workers/data-api.ts", "utf8");
    const start = src.indexOf("function matchNeuronsD1Route");
    assert.ok(start > 0, "matchNeuronsD1Route not found");
    const end = src.indexOf("\nfunction ", start + 10);
    const body = src.slice(start, end > 0 ? end : undefined);

    // One block per `if (...) { return async (sql) => ... }` route guard.
    const blocks = body.split(/\n {2}(?=if \()/).slice(1);
    let checked = 0;
    const problems: string[] = [];

    for (const block of blocks) {
      const tables = [
        ...new Set(
          [...block.matchAll(/FROM\s+(\w+)/g)]
            .map((m) => m[1])
            .filter((t) => MIRRORED.includes(t)),
        ),
      ].sort();
      if (tables.length === 0) continue;

      // The literal path this guard matches, when it is a literal.
      const literal = /pathname === "([^"]+)"/.exec(block)?.[1];
      if (!literal) continue;

      const entry = NEON_READ_ROUTE_TABLES.find((r) => r.pattern.test(literal));
      checked += 1;
      if (!entry) {
        problems.push(`${literal} reads [${tables}] but has no entry`);
        continue;
      }
      const declared = [...entry.tables].sort();
      if (JSON.stringify(declared) !== JSON.stringify(tables)) {
        problems.push(
          `${literal} reads [${tables}] but declares [${declared}]`,
        );
      }
    }

    assert.ok(
      checked >= 6,
      `only ${checked} literal routes checked -- the block split stopped ` +
        `working, so this test is passing on nothing`,
    );
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  // THE DIALECT SCAN (#9798). The map's table assertion above answers "is this
  // route's data in Neon". It cannot answer "will this route's SQL RUN on
  // Neon", and that is the question #9784 got wrong: the runners are
  // interface-compatible -- toPositionalPlaceholders rewrites `?` to `$n` --
  // but the FUNCTION LIBRARY is not, and nothing checked it.
  //
  // The cost of missing it is what makes this worth a test rather than a
  // review habit. `date(x, '-30 days')` does not raise on Postgres; the
  // subquery yields nothing, `>=` matches nothing, and the route serves a
  // schema-stable 200 with zero rows. `/subnets/{netuid}/history` went 28 -> 0
  // and `/subnets/movers` 5 -> 0, and only a pre-cutover content baseline
  // caught it. There are 46 tables left to move in #9787; the next one should
  // fail here instead.
  test("no route that may move to Neon uses SQLite-only SQL", () => {
    // Each pattern is anchored to a call, so a bare mention in prose cannot
    // trip it. `date(`/`strftime(` are listed with their opening paren for the
    // same reason -- `snapshot_date` must not match `date(`.
    const SQLITE_ONLY: readonly { pattern: RegExp; why: string }[] = [
      {
        // The one that actually shipped. Postgres spells it
        // `max(snapshot_date)::date - N`, and neither spelling belongs in the
        // SQL at all -- bind the boundary (neuronDailyWindowBounds).
        pattern: /\b(?:date|datetime|julianday)\s*\(/i,
        why: "SQLite date functions; Postgres has no date(x, modifier) -- compute the boundary in TypeScript and bind it",
      },
      {
        pattern: /\bstrftime\s*\(/i,
        why: "SQLite strftime; Postgres uses to_char/date_trunc",
      },
      {
        pattern: /\bifnull\s*\(/i,
        why: "SQLite IFNULL; both dialects have COALESCE",
      },
      {
        pattern: /\bgroup_concat\s*\(/i,
        why: "SQLite GROUP_CONCAT; Postgres uses string_agg",
      },
      {
        pattern: /\bjson_extract\s*\(/i,
        why: "SQLite json_extract; Postgres uses -> / ->>",
      },
      {
        pattern: /\binstr\s*\(/i,
        why: "SQLite INSTR; Postgres uses position()/strpos()",
      },
      {
        pattern: /\bautoincrement\b/i,
        why: "SQLite AUTOINCREMENT",
      },
    ];

    const src = readFileSync("workers/data-api.ts", "utf8");
    const start = src.indexOf("function matchNeuronsD1Route");
    assert.ok(start > 0, "matchNeuronsD1Route not found");
    const end = src.indexOf("\nfunction ", start + 10);
    const body = src.slice(start, end > 0 ? end : undefined);

    // Only the SQL, not the comments around it: this file explains the bug in
    // prose directly above the fix, and a scan that cannot tell those apart
    // would have to be weakened until it stopped working.
    const statements = [...body.matchAll(/sql`([^`]*)`/g)].map((m) => m[1]);
    assert.ok(
      statements.length >= 10,
      `only ${statements.length} tagged statements found -- the extraction ` +
        `stopped working, so this test is passing on nothing`,
    );

    const problems: string[] = [];
    for (const statement of statements) {
      for (const { pattern, why } of SQLITE_ONLY) {
        if (pattern.test(statement)) {
          problems.push(
            `${why}\n    in: ${statement.replace(/\s+/g, " ").trim().slice(0, 120)}`,
          );
        }
      }
    }
    assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}\n`);
  });

  test("the scan actually covers every route the read map may move", () => {
    // The scan reads ONE function. That is only sufficient while every route in
    // NEON_READ_ROUTE_TABLES is dispatched from it -- and the map is the thing
    // that grows as tables move off D1. Without this, adding a route whose
    // handler lives elsewhere silently shrinks the scan's coverage to nothing
    // in particular, and it would still report green.
    const src = readFileSync("workers/data-api.ts", "utf8");
    const start = src.indexOf("function matchNeuronsD1Route");
    const end = src.indexOf("\nfunction ", start + 10);
    const body = src.slice(start, end > 0 ? end : undefined);

    // Compare on a CONCRETE PATH, not on regex source: the dispatcher spells
    // the parameterised routes with capture groups (`(\d+)`) and the map
    // without them, so the two sources never match textually even when they
    // describe the same route.
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
        "the dialect scan does not see their SQL",
    );
  });

  test("the dialect scan would catch the construct that actually shipped", () => {
    // A negative assertion passes on nothing unless the fixture could fail, and
    // this one guards a regex list -- the failure mode is a pattern that
    // matches nothing at all, which looks identical to a clean codebase.
    const shipped =
      "SELECT MIN(snapshot_date) FROM neuron_daily WHERE snapshot_date >= " +
      "(SELECT date(MAX(snapshot_date), '-30 days') FROM neuron_daily)";
    assert.ok(
      /\b(?:date|datetime|julianday)\s*\(/i.test(shipped),
      "the scan no longer matches the exact SQL that emptied two routes",
    );
    // And it must not fire on the column name it is spelled to avoid.
    assert.ok(
      !/\b(?:date|datetime|julianday)\s*\(/i.test(
        "SELECT snapshot_date FROM neuron_daily WHERE netuid = ?",
      ),
      "the scan matches a plain snapshot_date column, which would make it noise",
    );
  });

  test("the position-history route declares BOTH tables it reads", () => {
    // The specific bug this map corrects. #9768 gated it on
    // account_position_daily alone.
    const entry = NEON_READ_ROUTE_TABLES.find((r) =>
      r.pattern.test("/api/v1/accounts/5Abc/subnets/80/history"),
    );
    assert.ok(entry, "position history has no entry");
    assert.deepEqual([...entry.tables].sort(), [
      "account_position_daily",
      "neurons",
    ]);
    assert.ok(entry.tables.includes(POSITION_HISTORY_NEON_LANE));
  });
});

describe("neonServesRoute", () => {
  const url = (p: string) => new URL(`https://api.metagraph.sh${p}`);

  test("serves only when EVERY table the route reads is enabled", () => {
    const path = "/api/v1/accounts/5Abc/subnets/80/history";
    // Both -> served.
    assert.equal(
      neonServesRoute(
        { NEON_READ_LANES: "neurons,account_position_daily" },
        url(path),
      ),
      true,
    );
    // Either one alone -> NOT served. This is #9768's gap, closed.
    assert.equal(
      neonServesRoute({ NEON_READ_LANES: "account_position_daily" }, url(path)),
      false,
    );
    assert.equal(
      neonServesRoute({ NEON_READ_LANES: "neurons" }, url(path)),
      false,
    );
  });

  test("a single-table route needs only its own table", () => {
    assert.equal(
      neonServesRoute(
        { NEON_READ_LANES: "neuron_daily" },
        url("/api/v1/subnets/movers"),
      ),
      true,
    );
    assert.equal(
      neonServesRoute(
        { NEON_READ_LANES: "neurons" },
        url("/api/v1/subnets/movers"),
      ),
      false,
    );
  });

  test("an UNMAPPED route is never served from Neon", () => {
    // The safe default: a route nobody has enumerated the tables of must not
    // ride in on another route's evidence.
    assert.equal(
      neonServesRoute({ NEON_READ_LANES: ALL }, url("/api/v1/blocks")),
      false,
    );
    assert.equal(
      neonServesRoute(
        { NEON_READ_LANES: ALL },
        url("/api/v1/subnets/1/holders"),
      ),
      false,
    );
  });

  test("an empty or absent flag serves nothing", () => {
    for (const env of [undefined, null, {}, { NEON_READ_LANES: "" }]) {
      assert.equal(neonServesRoute(env, url("/api/v1/subnets/movers")), false);
    }
  });
});

describe("the deployed flag", () => {
  const wrangler = readFileSync("wrangler.data.jsonc", "utf8");
  const named = (/"NEON_READ_LANES":\s*"([^"]*)"/.exec(wrangler)?.[1] ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  test("names only tables something writes", () => {
    // #9704 as a rule: a read with no writer behind it serves a frozen store
    // at 200 OK.
    const writes = (
      /"NEON_DUAL_WRITE_LANES":\s*"([^"]*)"/.exec(wrangler)?.[1] ?? ""
    ).split(",");
    const backfills = (
      /"NEON_BACKFILL_LANES":\s*"([^"]*)"/.exec(wrangler)?.[1] ?? ""
    ).split(",");
    const written = new Set(
      [...writes, ...backfills].map((l) => l.trim()).filter(Boolean),
    );
    for (const lane of named) {
      assert.ok(
        written.has(lane),
        `NEON_READ_LANES names "${lane}" but nothing writes it`,
      );
    }
  });

  test("names only tables the route map knows about", () => {
    // A lane enabled for reading that no route declares is dead config -- it
    // reads as a cutover that happened when none did.
    const declared = new Set(NEON_READ_ROUTE_TABLES.flatMap((r) => r.tables));
    for (const lane of named) {
      assert.ok(
        declared.has(lane),
        `NEON_READ_LANES names "${lane}" but no route declares it`,
      );
    }
  });

  test("does NOT name a table whose mirror has never fired", () => {
    // Measured 2026-08-07 and reported by #9772's watchdog: these four have no
    // `neon:` verdict at all, because their producers run on 12h/30h/48h
    // cadences. Naming one moves a read onto an unproven store.
    for (const unproven of [
      "nominator_positions",
      "hotkey_alpha",
      "account_balances",
      "validator_nominator_counts",
    ]) {
      assert.ok(
        !named.includes(unproven),
        `${unproven}'s mirror has never fired -- see #9770/#9772`,
      );
    }
  });
});
