// Every table Neon SOLELY owns must be created by a Neon migration (#10135).
//
// ## The failure this exists to stop
//
// #10127 added `lane_health` to NEON_SOLE_STORE_TABLES. Neon had no such table:
// 0005's header lists it as one that migration deliberately excludes, so no
// migration was ever written for it. The flag pointed at nothing.
//
// Nothing reported it, and could not have. lane_health is the sink every
// watchdog writes to, and recordLaneVerdict swallows its own errors BY DESIGN --
// a watchdog whose alarm-recording broke its alarm would be worse than the bug
// it watches for. So every verdict was dropped with the one mechanism that
// could have complained being the mechanism that was broken. D1's copy went on
// filling from Workers that had not redeployed, which made the two stores look
// merely out of step rather than one of them empty.
//
// ## Why this is the guard that matters before D1 is deleted
//
// Sole-store means "D1 is no longer written for this table". If the table does
// not exist in Neon either, the rows are going nowhere, and DELETING D1 turns a
// recoverable gap into permanent loss. This check is cheap and static; the
// alternative is finding out by querying production, which is how the last one
// was found.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "vitest";

/** Tables created by every migration under migrations/neon/. */
function tablesInNeonMigrations(): Set<string> {
  const created = new Set<string>();
  for (const file of readdirSync("migrations/neon").filter((f) =>
    f.endsWith(".sql"),
  )) {
    const sql = readFileSync(`migrations/neon/${file}`, "utf8");
    // Comments are stripped first: 0005 NAMES lane_health in its header while
    // deliberately not creating it, and a scan that read prose would have
    // called this migration sufficient -- which is precisely the mistake.
    const code = sql.replace(/--[^\n]*/g, "");
    for (const m of code.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi,
    )) {
      created.add(m[1]);
    }
  }
  return created;
}

function soleStoreTables(config: string): string[] {
  const source = readFileSync(config, "utf8");
  return (/"NEON_SOLE_STORE_TABLES":\s*"([^"]*)"/.exec(source)?.[1] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

describe("every sole-store table exists in Neon", () => {
  const created = tablesInNeonMigrations();

  for (const config of ["wrangler.data.jsonc", "wrangler.jsonc"]) {
    test(`${config} names no table Neon migrations do not create`, () => {
      const missing = soleStoreTables(config).filter((t) => !created.has(t));
      assert.deepEqual(
        missing,
        [],
        `${config}: NEON_SOLE_STORE_TABLES names ${missing.join(", ")}, which no ` +
          `migration under migrations/neon/ creates. Sole-store means D1 is not ` +
          `written -- if Neon has no table either, those rows go nowhere, and ` +
          `deleting D1 makes it permanent.`,
      );
    });
  }

  test("the scan actually finds tables, and ignores prose", () => {
    // A scanner that matched nothing would make the checks above pass on an
    // empty set forever -- the exact shape of the bug they exist to catch.
    assert.ok(created.size > 20, `only found ${created.size} tables`);
    assert.ok(created.has("lane_health"), "0006 must create lane_health");
    // 0005 MENTIONS lane_health in its header without creating it. If comments
    // were not stripped, that prose alone would satisfy the check.
    const raw = readFileSync(
      "migrations/neon/0005_remaining_d1_tables.sql",
      "utf8",
    );
    assert.ok(
      raw.includes("lane_health"),
      "0005 should still mention it in prose -- that is the trap being handled",
    );
    assert.ok(
      !/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?lane_health/i.test(
        raw.replace(/--[^\n]*/g, ""),
      ),
      "0005 must not create it; 0006 does",
    );
  });
});

// ---------------------------------------------------------------------------
// The other direction (#10263).
//
// The block above asks "is every DECLARED table real". This one asks "is every
// table we READ declared" -- and nothing asked that until #10264 shipped a lane
// that could never run.
//
// `readStore` is ALL-OR-NOTHING: it returns `undefined` unless
// NEON_SOLE_STORE_TABLES contains EVERY table the caller names. #10264 added
// `readStore(env, ["neurons", "subnet_lifecycle"])` and no wrangler config
// declared `subnet_lifecycle`, so the call answered `undefined`, the lane
// returned "no store bound" BEFORE it could record a verdict, and the failure
// was invisible from both ends: `subnet_lifecycle` had 0 rows and `lane_health`
// had no `subnet-lifecycle` row to explain why. Measured on production after
// the merge -- exactly the "find out by querying production" outcome the block
// above was written to prevent, arriving through the door it left open.
//
// The tests passed because `pgMockEnv(tables)` DECLARES whatever it is handed.
// A suite naming its own tables always satisfies the gate it is exercising, so
// only a static check against wrangler can catch this.

/** Every .ts file under the given roots. */
function sourceFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** Table names any caller gates a Neon read on.
 *
 * Two shapes, because both are in use: an inline literal array at the
 * `readStore(...)` call site (the common one), and the named constants in
 * `src/read-store-tables.ts` that the inline form was factored out into. A scan
 * covering only the first would miss every route whose tables were hoisted. */
function tablesReadStoreGatesOn(): Map<string, string[]> {
  const byTable = new Map<string, string[]>();
  const note = (table: string, where: string) => {
    const seen = byTable.get(table);
    if (seen) seen.push(where);
    else byTable.set(table, [where]);
  };

  for (const file of sourceFiles(["src", "workers"])) {
    // read-store.ts DEFINES readStore; its own signature is not a call site.
    if (file.endsWith("src/read-store.ts")) continue;
    const source = readFileSync(file, "utf8").replace(/\/\/[^\n]*/g, "");

    if (file.endsWith("src/read-store-tables.ts")) {
      // This file is nothing but table lists, so every quoted string in an
      // exported array is a table name.
      for (const block of source.matchAll(
        /export const (\w+)[^=]*=\s*\[([^\]]*)\]/g,
      )) {
        for (const name of block[2]!.matchAll(/"(\w+)"/g)) {
          note(name[1]!, `read-store-tables.ts ${block[1]}`);
        }
      }
      continue;
    }

    for (const call of source.matchAll(/readStore\([^,]*,\s*\[([^\]]*)\]/g)) {
      for (const name of call[1]!.matchAll(/"(\w+)"/g)) note(name[1]!, file);
    }
  }
  return byTable;
}

describe("every table a reader gates on is declared", () => {
  const gated = tablesReadStoreGatesOn();

  for (const config of [
    "wrangler.data.jsonc",
    "wrangler.jsonc",
    "wrangler.registry.jsonc",
  ]) {
    test(`${config} declares every table readStore gates on`, () => {
      const declared = new Set(soleStoreTables(config));
      const undeclared = [...gated.keys()]
        .filter((t) => !declared.has(t))
        .sort();
      assert.deepEqual(
        undeclared,
        [],
        `${config}: ${undeclared
          .map((t) => `${t} (read by ${gated.get(t)![0]})`)
          .join(", ")} is read through readStore but not in ` +
          `NEON_SOLE_STORE_TABLES. readStore is all-or-nothing -- it returns ` +
          `undefined unless EVERY named table is declared -- so that caller ` +
          `silently reads nothing on this deployment.`,
      );
    });
  }

  test("the scan finds real call sites in both shapes", () => {
    // Same reasoning as the sibling self-check: a regex that matched nothing
    // would make the three tests above pass against an empty set forever.
    assert.ok(gated.size > 20, `only found ${gated.size} gated tables`);
    assert.ok(
      gated
        .get("subnet_lifecycle")
        ?.some((w) => w.includes("subnet-lifecycle")),
      "the inline-array shape must be found (src/subnet-lifecycle.ts)",
    );
    assert.ok(
      gated
        .get("subnet_hyperparams_history")
        ?.some((w) => w.includes("read-store-tables")),
      "the hoisted-constant shape must be found (read-store-tables.ts)",
    );
  });
});
