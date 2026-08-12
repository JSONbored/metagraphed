// Every table a reader gates on must be created by a Neon migration.
//
// This guard grew up twice. #10135 caught NEON_SOLE_STORE_TABLES naming
// `lane_health` while no migration created it -- rows going nowhere, with the
// one mechanism that could have complained (lane verdicts) being the broken
// mechanism. #10264 caught the reader side: a lane gating on a table the flag
// did not declare read `undefined` forever, invisible from both ends. The flag
// is gone (#10051 -- it answered "is D1 behind this?" about a deleted
// database), so the two halves collapse into the direct question the flag was
// standing between: does every table the READERS name exist in the migrations
// that create Neon's schema? Writers need no twin here -- every write module's
// tables are exercised against the pglite double, which runs the real Neon
// schema, so a written-but-uncreated table fails its own suite.
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

describe("every table a reader gates on exists in Neon", () => {
  const gated = tablesReadStoreGatesOn();
  const created = tablesInNeonMigrations();

  test("no reader names a table the migrations do not create", () => {
    const missing = [...gated.keys()].filter((t) => !created.has(t)).sort();
    assert.deepEqual(
      missing,
      [],
      missing.map((t) => `${t} (read by ${gated.get(t)![0]})`).join(", ") +
        " is read through readStore but created by no Neon migration -- " +
        "that caller reads a table that does not exist, which surfaces as " +
        "an empty answer, not an error (#10264's failure shape).",
    );
  });

  test("the migration scan actually finds tables, and ignores prose", () => {
    assert.ok(created.size > 40, `only found ${created.size} created tables`);
    assert.ok(created.has("lane_health"), "the #10135 table must be created");
  });

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
