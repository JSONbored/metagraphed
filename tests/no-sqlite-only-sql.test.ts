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
  // TWO-ARGUMENT date(), which is the one that got through (#10179).
  //
  // The list already had datetime('now') and stopped there, so
  // `date('now','-40 days')` in scripts/lib/load-alpha-price-history.ts sailed
  // past -- and that query has two engines behind it. Postgres answers
  // `function date(unknown, unknown) does not exist`, the read sits inside
  // refreshLiveEconomics's own try, and the whole economics tick died with the
  // last good KV blob still being served.
  //
  // Matched on the SHAPE OF THE MODIFIER, not merely on the arity: `date(x)`
  // alone is legitimate, and a bare two-argument match also hits English prose
  // that happens to read "date (`2026-06-01`, a whole UTC day)". SQLite's
  // modifiers are a closed set, so requiring one keeps this precise.
  //
  // The sign alternative is `'[+-]` with no digit after it, deliberately: the
  // statement that broke was built by interpolation -- `'-${days} days'` -- so
  // the character after the sign in SOURCE is `$`, not a digit. Requiring a
  // digit here would pass the scanner on exactly the file it was extended for.
  [
    /\bdate\s*\([^()]*,\s*'(?:[+-]|now|unixepoch|localtime|utc|start of|weekday)/i,
    "date(x, modifier) — SQLite date arithmetic; compute the cutoff in JS and bind or inline a YYYY-MM-DD literal",
  ],
  [/\bLIMIT\s+\d+\s*,\s*\d+/i, "LIMIT a, b — Postgres needs LIMIT b OFFSET a"],
  [/\bPRAGMA\b/i, "PRAGMA — SQLite only"],
  // json_extract / json_each, which is how src/surface-history.ts nearly
  // shipped an empty trail for every subnet (#10179): the column is TEXT
  // holding JSON, the reader wraps its own read in a catch, and a thrown
  // "function json_extract does not exist" renders as "nothing has changed
  // here" -- a real answer for a stable subnet, so indistinguishable.
  [
    /\bjson_extract\s*\(/i,
    "json_extract() — Postgres uses ->> / jsonb_extract_path_text",
  ],
  [/\bjson_each\s*\(/i, "json_each() — Postgres uses jsonb_array_elements"],
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
    // Everything shipped, AND scripts/ (#10179).
    //
    // scripts/ was outside this walk, which is half of why
    // `date('now','-40 days')` survived: it lives in
    // scripts/lib/load-alpha-price-history.ts and is imported by
    // src/live-economics-refresh.ts, so the statement was built in an unscanned
    // file and executed against Postgres in a scanned one. A query does not
    // become store-neutral by being defined somewhere the scanner does not
    // look.
    for (const file of [
      ...walk("src"),
      ...walk("workers"),
      ...walk("scripts"),
    ]) {
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

  test("the scanner would catch the date() arithmetic that broke economics", () => {
    // The second real statement this file exists for (#10179). Same shape of
    // proof as above: the pattern set has to recognise the byte-for-byte
    // original, or a green run means nothing.
    const real =
      "const sql = `WHERE snapshot_date >= date('now','-${days} days') ORDER BY netuid`;";
    assert.ok(
      SQLITE_ONLY.some(([p]) => p.test(sqlLiterals(real))),
      "the scanner no longer recognises the date('now', ...) that froze economics:current",
    );
    // The unixepoch form too -- the same function, the other modifier.
    assert.ok(
      SQLITE_ONLY.some(([p]) =>
        p.test(sqlLiterals("`date(captured_at / 1000, 'unixepoch')`")),
      ),
      "the scanner no longer recognises date(x, 'unixepoch')",
    );
    // And the replacement must NOT trip it: a bound or inlined YYYY-MM-DD
    // literal has no date function left for two dialects to disagree about.
    assert.ok(
      !SQLITE_ONLY.some(([p]) =>
        p.test(sqlLiterals("`WHERE snapshot_date >= '2026-06-29' ORDER BY x`")),
      ),
      "the portable date literal is being reported as SQLite-only",
    );
    // Nor may it trip on ordinary English prose that mentions a date, which a
    // bare two-argument match does.
    assert.ok(
      !SQLITE_ONLY.some(([p]) =>
        p.test(
          sqlLiterals(
            '"an ISO-8601 date (`2026-06-01`, a whole UTC day) or date-time"',
          ),
        ),
      ),
      "the date() rule is matching prose",
    );
  });
});
