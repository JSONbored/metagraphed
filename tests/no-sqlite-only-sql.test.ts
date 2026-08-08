// No SQLite-only SQL in a path that can be handed a Postgres runner (#10172).
//
// THE OUTAGE THIS EXISTS TO STOP, exactly as it happened. The subnet-burn
// capture wrote its batch with
//
//   INSERT OR REPLACE INTO subnet_burn_history (...) VALUES (?, ?, ?)
//
// which is correct, idempotent SQLite and a SYNTAX ERROR in Postgres. Nothing
// changed in that file. What changed was underneath it: subnet_burn_history
// became sole-store on Neon, `producerStore` started handing the lane a
// Postgres runner, and every write began failing.
//
// It failed INVISIBLY, which is what made it expensive. captureSubnetBurnHistory
// never throws -- a capture lane that could take down its own cron would be
// worse than a gap -- so the failure came back as `{ ok: false, reason }` that
// the cron dispatch discarded, and the lane had no lane_health verdict. The
// series sat frozen for five hours in BOTH stores and every signal read green.
//
// A dialect review could not have found it either: the statement is not
// "D1-flavoured", it is valid SQL that one engine happens not to accept. So
// this scans for the spellings that are SQLite's alone, in the files that can
// now reach either store.
//
// The equivalent that works on both is `ON CONFLICT (...) DO UPDATE` -- SQLite
// has supported it since 3.24, so there is no reason to reach for the
// SQLite-only form at all.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "vitest";

/** Spellings SQLite accepts and Postgres does not. */
const SQLITE_ONLY: [RegExp, string][] = [
  [
    /\bINSERT\s+OR\s+(REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\b/i,
    "INSERT OR ... — use ON CONFLICT ... DO UPDATE/DO NOTHING",
  ],
  [/\bAUTOINCREMENT\b/i, "AUTOINCREMENT — Postgres uses GENERATED/serial"],
  [/\bstrftime\s*\(/i, "strftime() — Postgres uses to_char/date_trunc"],
  [/\bjulianday\s*\(/i, "julianday() — no Postgres equivalent"],
  [/\bdatetime\s*\(\s*'now'/i, "datetime('now') — Postgres uses now()"],
  [/\bLIMIT\s+\d+\s*,\s*\d+/i, "LIMIT a, b — Postgres needs LIMIT b OFFSET a"],
  [/\bPRAGMA\b/i, "PRAGMA — SQLite only"],
];

/** SQL lives in string literals; the prose around it does not. Scanning raw
 *  source reports every one of these from the comments that EXPLAIN them --
 *  including this repo's own notes about the bug above. */
function sqlLiterals(source: string): string {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:])\/\/.*$/gm, "$1 ");
  return [
    ...withoutComments.matchAll(
      /"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`|'([^'\\]*(?:\\.[^'\\]*)*)'/g,
    ),
  ]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
    .join("\n");
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

describe("store-neutral SQL", () => {
  test("no file that can reach either store uses SQLite-only syntax", () => {
    const offenders: string[] = [];
    // Everything shipped. The `*-d1-write.ts` modules are exempt only while
    // they exist: they are D1's by name and are being deleted with it, and a
    // file that is deleted cannot be handed a Postgres runner.
    for (const file of [...walk("src"), ...walk("workers")]) {
      if (/-d1-write\.ts$/.test(file) || /\/observations-d1\.ts$/.test(file)) {
        continue;
      }
      const sql = sqlLiterals(readFileSync(file, "utf8"));
      for (const [pattern, why] of SQLITE_ONLY) {
        const hit = pattern.exec(sql);
        if (hit) offenders.push(`${file}: ${hit[0].trim()} — ${why}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "SQLite-only SQL in a path that may be handed a Postgres runner:\n" +
        offenders.join("\n"),
    );
  });

  test("the scanner would actually catch the statement that broke", () => {
    // A negative assertion passes on nothing. This proves the pattern set
    // recognises the real statement, byte for byte, so a green run above means
    // "no offenders" rather than "the scanner matched nothing".
    const real =
      "const insert = db.prepare(`INSERT OR REPLACE INTO ${T} (netuid, observed_at, burn_tao) VALUES (?, ?, ?)`);";
    const sql = sqlLiterals(real);
    assert.ok(
      SQLITE_ONLY.some(([p]) => p.test(sql)),
      "the scanner no longer recognises the INSERT OR REPLACE that caused #10172",
    );
    // And the replacement must NOT trip it.
    const fixed =
      "db.prepare(`INSERT INTO ${T} (netuid, observed_at, burn_tao) VALUES (?, ?, ?) ON CONFLICT (netuid, observed_at) DO UPDATE SET burn_tao = EXCLUDED.burn_tao`)";
    assert.ok(
      !SQLITE_ONLY.some(([p]) => p.test(sqlLiterals(fixed))),
      "the portable form is being reported as SQLite-only",
    );
  });
});
