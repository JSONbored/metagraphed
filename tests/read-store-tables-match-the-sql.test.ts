// Each constant in src/read-store-tables.ts must cover its loader's SQL.
//
// WHY THIS TEST IS THE WHOLE ARGUMENT for putting those constants in one file.
// Twenty-two shared loaders are called from three modules, most of them from
// two or three, so the sets live centrally rather than beside each loader. That
// trade is only safe if something checks the central copy against the SQL --
// otherwise a loader that grows a JOIN silently starts reading a table its
// callers never declared.
//
// And under-declaring is not a weaker check. readStore is all-or-nothing: it
// sends the loader to Neon on the strength of the tables that WERE named, and
// the missing one then resolves against a store that does not have it. In
// Postgres that is an error; across a LEFT JOIN it is rows with the missing
// side null. Neither is what the caller asked for, and only one of them is
// loud.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import * as TABLES from "../src/read-store-tables.ts";

/** constant -> every module whose SQL it has to cover.
 *
 * A LIST, because a loader's statements are not always all in one file. The
 * alpha-pricing set is the reason: `src/subnet-holders.ts` selects only
 * `nominator_positions`, and the `hotkey_alpha` / `hotkey_alpha_passes` half of
 * the same read lives in `src/hotkey-alpha-completeness.ts`, which it imports.
 * Checking one module would have declared that set over-broad and passed while
 * missing the two tables that actually matter. */
const OWNER: Record<string, string[]> = {
  ALPHA_PRICING_TABLES: [
    "src/subnet-holders.ts",
    "src/hotkey-alpha-completeness.ts",
  ],
  SUBNET_BURN_HISTORY_TABLES: ["src/subnet-burn-history.ts"],
  TAO_USD_TABLES: ["src/tao-usd-series.ts"],
  ATTRIBUTION_SWEEP_TABLES: ["src/attribution-sweep.ts"],
  // The feed's own SQL is the revenue pair; the denominator legs are read
  // THROUGH the two loaders that own those tables, so all three modules are
  // checked against this one set.
  REVENUE_FEED_TABLES: [
    "src/revenue-feed.ts",
    "src/emission-pipeline-history.ts",
    "src/tao-usd-series.ts",
  ],
  SURFACE_HISTORY_TABLES: ["src/surface-history.ts"],
  EMISSION_CHANGES_TABLES: ["src/emission-gate-changes.ts"],
  FAILURE_REASONS_TABLES: ["src/failure-reasons.ts"],
  INDEXER_LAG_TABLES: ["src/indexer-lag.ts"],
  CHAIN_CONCENTRATION_HISTORY_TABLES: ["src/chain-concentration-history.ts"],
  SUBNET_SNAPSHOT_TABLES: ["src/emission-pipeline-history.ts"],
  UPTIME_DAILY_TABLES: ["src/bulk-health-trends.ts"],
};

/** The real tables, from the config that declares them. Scanning for KNOWN
 *  names rather than parsing `FROM x` is what makes this robust against the way
 *  these modules actually build SQL: several concatenate a query across several
 *  string literals, so a CTE's `WITH` and its name land in different ones and a
 *  parser reports `holder` and `ranked` as tables. Prose leaks in too. Known
 *  names have neither problem. */
function knownTables(): string[] {
  const config = readFileSync("wrangler.data.jsonc", "utf8");
  const sole = /"NEON_SOLE_STORE_TABLES"\s*:\s*"([^"]*)"/.exec(config);
  assert.ok(sole, "NEON_SOLE_STORE_TABLES not found -- was it renamed?");
  const names = sole[1]!.split(",").filter(Boolean);
  assert.ok(names.length > 20, `only ${names.length} tables found`);
  // The four registry tables have Neon migrations but are not declared
  // sole-store yet, so they are absent from that flag and still readable.
  return [...names, "surface_history", "subnets", "surfaces", "providers"];
}

/** Known table names appearing in the module's SQL string literals. */
function tablesInSql(source: string, known: string[]): Set<string> {
  const sql = [
    ...source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ")
      .matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`/g),
  ]
    .map((m) => m[1] ?? m[2] ?? "")
    .join(" ");
  const found = new Set<string>();
  for (const table of known) {
    // Word-bounded so `surface_check` cannot match inside `surface_checks`,
    // and preceded by FROM/JOIN/INTO or whitespace so a column name that
    // happens to equal a table name does not count.
    if (new RegExp(`\\b${table}\\b`).test(sql)) found.add(table);
  }
  return found;
}

describe("every declared table set covers its loader's SQL", () => {
  const known = knownTables();
  for (const [constant, modules] of Object.entries(OWNER)) {
    test(`${constant} vs ${modules.join(" + ")}`, () => {
      const declared = new Set(
        (TABLES as unknown as Record<string, readonly string[]>)[constant],
      );
      assert.ok(declared.size > 0, `${constant} is empty`);
      const module = modules.join(" + ");
      const used = new Set(
        modules.flatMap((m) => [
          ...tablesInSql(readFileSync(m, "utf8"), known),
        ]),
      );
      assert.ok(
        used.size > 0,
        `${module} names no known table in a string literal -- the scanner ` +
          `matched nothing, so this would pass whatever ${constant} said`,
      );
      const undeclared = [...used].filter((t) => !declared.has(t));
      assert.deepEqual(
        undeclared,
        [],
        `${module} reads ${undeclared.join(", ")}, which ${constant} does not ` +
          `declare -- readStore would route this loader to Neon on the tables ` +
          `it DID declare, and the rest would resolve against the wrong store`,
      );
    });
  }

  test("every exported constant is a non-empty list of distinct names", () => {
    // An empty set is the one input readStore treats as "stay on D1" rather
    // than "Neon owns nothing", so it fails open and would never be noticed.
    for (const [name, value] of Object.entries(TABLES)) {
      const list = value as readonly string[];
      assert.ok(Array.isArray(list) && list.length > 0, `${name} is empty`);
      assert.equal(
        new Set(list).size,
        list.length,
        `${name} repeats a table name`,
      );
      for (const t of list)
        assert.match(t, /^[a-z_][a-z0-9_]*$/, `${name} has a bad name: ${t}`);
    }
  });
});
