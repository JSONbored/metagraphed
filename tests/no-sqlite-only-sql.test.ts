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
  //
  // `date(MAX(snapshot_date), ?)` -- the shape that sat in three live readers
  // unseen -- needed TWO widenings here, and the pattern above missed it on
  // both counts. Its modifier is a BOUND PLACEHOLDER, so there is no quote
  // and no sign in SOURCE to match; and its first argument is a NESTED CALL,
  // whose `(` the old `[^()]*` could not cross, so the comma was never
  // reached either. Postgres has no two-argument date() at any arity, so a
  // second argument of any kind is SQLite-only -- the modifier shapes are
  // enumerated only to keep English prose like "date (`2026-06-01`, a whole
  // UTC day)" out, and neither a nested call nor a `?` is ever that prose.
  [
    /\bdate\s*\((?:[^()]|\([^()]*\))*,\s*(?:'(?:[+-]|now|unixepoch|localtime|utc|start of|weekday)|\?|\$\d)/i,
    "date(x, modifier) — SQLite date arithmetic; Postgres has no two-argument date(). Read the anchor date, shift it in JS (shiftIsoDate), and bind a YYYY-MM-DD literal",
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
  // json_each is NOT SQLite-only: Postgres has json_each(json) too, and over
  // the json type it is the only iterator that keeps a payload's duplicate
  // keys and their order (the jsonb forms dedupe), which is exactly what the
  // native readings of the decoder's receipts depend on (#13019). So the rule
  // matches the HAZARD rather than the function name.
  //
  // The hazard is the #10179 shape: json_each over a TEXT column with no
  // cast. SQLite accepts it, Postgres answers `function json_each(text) does
  // not exist` at runtime, and the reader's own catch renders that as an
  // empty trail. An explicit `::json` in the argument is what distinguishes
  // the two -- SQLite has no `::` cast, so that spelling can never be the
  // SQLite-only form.
  //
  // `::json` is required with a word boundary, not as a prefix: json_each on
  // a `::jsonb` value is a THIRD broken shape (Postgres has jsonb_each for
  // that, not json_each), so it must keep failing this rule rather than be
  // exempted by a cast that merely starts the same way.
  [
    /\bjson_each\s*\((?![^()\n]*::json\b)/i,
    "json_each() on a value with no explicit ::json cast — SQLite accepts a TEXT argument and Postgres does not (use ::json, which keeps duplicate keys where the jsonb forms drop them)",
  ],
  // BOOLEAN ARITHMETIC. SQLite has no boolean type, so `n + (a > b)` adds 1 or
  // 0; Postgres answers `operator does not exist: integer + boolean`.
  //
  // This is how src/health-sql.ts's percentile picker shipped a SQLite-only
  // expression into every serving read of surface_checks (#10200):
  // `CAST(q*n AS INTEGER) + (q*n > CAST(q*n AS INTEGER))` -- SQLite's ceil,
  // written as trunc-plus-carry because SQLite had no ceil. `storeAll` degrades a
  // read failure to zero rows, so /uptime, /health/percentiles and the
  // per-subnet /health/trends each published an empty card over a table that
  // had rows in it. Both engines have ceil(); use it.
  [
    // Spaces around the operator, and never a shift: `(high >>> 0)` is a JS
    // expression that lives in a string literal in this tree, and an
    // unanchored `[<>]` matched it.
    /[)\w ]\+ \((?:[^()\n]|\([^()\n]*\))*?\s(?<![<>])(?:<=|>=|<>|!=|<|>)(?![<>=])\s(?:[^()\n]|\([^()\n]*\))*?\)/,
    "arithmetic on a comparison — SQLite treats a boolean as 0/1, Postgres does not; use CASE WHEN ... THEN 1 ELSE 0 END, or ceil()/floor() where that is what it spells",
  ],
  // TWO-ARGUMENT ROUND over a float. Postgres has round(numeric, int) and
  // round(double precision), but NOT round(double precision, int). The same
  // #10200 sweep found `ROUND(CAST(SUM(ok_count) AS REAL) / SUM(samples), 4)`
  // in src/analytics-live.ts, one line from the boolean above and failing the
  // same silent way. Cast the value to NUMERIC first; SQLite is happy either
  // way. Anything already naming NUMERIC is exempt.
  [
    /\bROUND\s*\((?!(?:[^()\n]|\((?:[^()\n]|\([^()\n]*\))*\))*?(?:NUMERIC|::numeric))(?:[^()\n]|\((?:[^()\n]|\([^()\n]*\))*\))*?,\s*\d+\s*\)/i,
    "ROUND(x, n) on a non-numeric — Postgres has no round(double precision, integer); CAST the value AS NUMERIC first",
  ],
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
      // Native implementations require complete-family D1 ownership. Their
      // atomic writes are exercised against D1 in the corresponding native
      // tests; shared readers remain dialect-neutral.
      if (
        [
          // Format decoder owns its read-only :memory: DatabaseSync. These
          // fixed statements never accept or execute through a store runner.
          "src/sqlite-document-decoder.ts",
          // Offline schema generation owns its in-memory SQLite connection;
          // the native runtime imports only its generated static metadata.
          "scripts/generate-export-projection.ts",
          "src/neuron-documents.ts",
          // The native branch has an explicit neurons owner check; the
          // portable branch is exercised by the PostgreSQL route suite.
          "src/neuron-snapshot-read.ts",
          // Latest burn seeks require explicit subnet_burn_history ownership.
          // D1 parity tests reject calls to the portable runner in that branch.
          "src/subnet-burn-read.ts",
          // The document branch requires explicit neuron_daily D1 ownership;
          // native parity tests also execute the portable rollup branch.
          "src/chain-concentration-rollup.ts",
          "src/axon-transition-d1.ts",
          "src/observations-d1.ts",
          "src/capture-family-d1.ts",
          "src/ledger-d1.ts",
          "src/registry-sync-d1.ts",
          // The caller requires explicit api_usage_rollup D1 ownership;
          // native receipt tests cover rollback and committed-reply replay.
          "src/usage-rollup-d1.ts",
          "src/root-basket-capture-d1.ts",
          "src/d1-state-export.ts",
          "src/d1-store.ts",
          // Dedicated D1 binding and credential; never accepts a generic
          // store runner. Native receiver tests cover atomic source selection.
          "src/retained-blocks-sync.ts",
        ].includes(file)
      )
        continue;
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
    // The two shapes that got past the rule for months, byte for byte from
    // src/chain-turnover.ts, src/movers.ts and src/turnover.ts: a BOUND
    // PLACEHOLDER modifier (no quote, no sign in source) behind a NESTED CALL
    // (whose `(` the old `[^()]*` could not cross to reach the comma).
    assert.ok(
      SQLITE_ONLY.some(([p]) =>
        p.test(
          sqlLiterals(
            '"WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), ?) FROM neuron_daily)"',
          ),
        ),
      ),
      "the scanner no longer recognises date(MAX(x), ?) -- the shape that answered zero rows on Postgres in three readers (#9792)",
    );
    assert.ok(
      SQLITE_ONLY.some(([p]) =>
        p.test(sqlLiterals('"SELECT date(MAX(day), $2) FROM t"')),
      ),
      "the numbered-placeholder form is being missed",
    );
    // And the conversion those three received must NOT trip it: the anchor is
    // read, shifted in TypeScript, and bound as a literal.
    assert.ok(
      !SQLITE_ONLY.some(([p]) =>
        p.test(
          sqlLiterals(
            '"SELECT MIN(snapshot_date) AS start_date FROM neuron_daily WHERE netuid = ? AND snapshot_date >= ?"',
          ),
        ),
      ),
      "the dialect-neutral anchored window is being reported as SQLite-only",
    );
  });

  test("the json_each rule still catches the uncast read, and the ::json forms it must not", () => {
    // Same proof obligation as the two rules above: narrowing json_each to
    // the uncast argument is only safe if the uncast argument still fails.
    const caught = (sql: string) =>
      SQLITE_ONLY.some(([p]) => p.test(sqlLiterals(sql)));
    assert.ok(
      caught("`SELECT value FROM json_each(axon_values) WHERE key = ?`"),
      "the scanner no longer recognises json_each over an uncast TEXT column",
    );
    assert.ok(
      caught("`CROSS JOIN LATERAL json_each(p.payload_json::jsonb) j`"),
      "json_each over ::jsonb is being exempted by a prefix match; Postgres has jsonb_each for that argument, and the jsonb forms drop the duplicate keys this payload carries",
    );
    assert.ok(
      !caught("`CROSS JOIN LATERAL json_each(p.payload_json::json) j`"),
      "the portable ::json form is being reported as SQLite-only",
    );
  });
});
