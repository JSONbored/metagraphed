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
