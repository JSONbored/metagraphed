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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, test } from "vitest";

/** Spellings SQLite accepts and Postgres does not. */
const SQLITE_ONLY: [RegExp, string][] = [
  [
    /\bINSERT\s+OR\s+(REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\b/i,
    "INSERT OR ... — use ON CONFLICT ... DO UPDATE/DO NOTHING",
  ],
  [/\bAUTOINCREMENT\b/i, "AUTOINCREMENT — Postgres uses GENERATED/serial"],
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

/**
 * DERIVED, not collected: functions SQLite provides that Postgres does not.
 *
 * The rules above grew one incident at a time, each matching the SHAPE that
 * burned us, and #9798 is what that costs. Its scan was asked to catch "the
 * next one" and could not see the three statements it was written for, because
 * `date(MAX(snapshot_date), ?)` differed from the remembered shape in two
 * incidental ways -- a bound placeholder where the memory had a quoted
 * modifier, a nested call where it had a bare column. A green run then means
 * "nothing matched the shapes we remember", which reads identically to
 * "nothing is wrong" and is how three modules kept a dialect-incompatible call
 * behind a passing gate for months.
 *
 * So the unit here is the FUNCTION, which is the thing that actually does or
 * does not exist in Postgres, and every call of one is flagged whatever its
 * arguments look like. A new evasion has to invent a new function name rather
 * than a new argument shape.
 *
 * The value is the portable spelling, because a refusal that does not say what
 * to write instead gets worked around.
 */
const SQLITE_ONLY_FUNCTIONS: Readonly<Record<string, string>> = {
  julianday: "no Postgres equivalent; compute from a timestamp difference",
  strftime: "to_char() / date_trunc()",
  unixepoch: "extract(epoch from ...)",
  ifnull: "COALESCE(), which both engines have",
  group_concat:
    "string_agg(value, separator) -- note SQLite defaults the separator to ',' and string_agg has no default",
  instr: "strpos(), same argument order, also 1-based and 0 when absent",
  json_extract: "->> / #>> / jsonb_extract_path_text",
  json_quote: "to_jsonb()",
  json_group_array: "json_agg() / jsonb_agg()",
  json_group_object: "json_object_agg()",
  json_patch: "|| on jsonb, or jsonb_set() for one path",
  json_insert: "jsonb_set(..., create_if_missing => true)",
  json_set: "jsonb_set()",
  json_replace: "jsonb_set(..., create_if_missing => false)",
  json_remove: "- / #- on jsonb",
  json_type: "json_typeof() / jsonb_typeof()",
  json_valid: "no direct equivalent; validate before storing",
  printf: "format()",
  randomblob: "gen_random_bytes()",
  zeroblob: "repeat()::bytea or decode()",
  unhex: "decode(value, 'hex')",
  soundex: "no Postgres equivalent without fuzzystrmatch",
  last_insert_rowid: "INSERT ... RETURNING",
  total_changes: "no Postgres equivalent",
  sqlite_version: "version()",
  sqlite_source_id: "version()",
  load_extension: "never reachable from a query in Postgres",
  likelihood: "no planner hint of this shape in Postgres",
  likely: "no planner hint of this shape in Postgres",
  unlikely: "no planner hint of this shape in Postgres",
  iif: "CASE WHEN ... THEN ... ELSE ... END",
  glob: "LIKE / SIMILAR TO / ~ (GLOB is also an operator -- see the rules above)",
  unicode: "ascii() for the first character",
};

/**
 * The same derivation for names that are ALSO ordinary English or JavaScript.
 *
 * `typeof(`, `quote(`, `changes(` and `hex(` appear in this tree inside string
 * literals that are prose or code, not SQL, so flagging them everywhere would
 * be noise -- and noise is how a gate stops being read. They are therefore
 * checked only in literals that actually look like SQL, which is a narrowing
 * of WHERE to look and never of what counts as a violation.
 */
const SQLITE_ONLY_IN_SQL_CONTEXT: Readonly<Record<string, string>> = {
  typeof: "pg_typeof()",
  quote: "quote_literal() / quote_ident()",
  changes: "no Postgres equivalent; use INSERT ... RETURNING or ROW_COUNT",
  hex: "encode(value, 'hex')",
  char: "chr(), one code point at a time",
  raise: "RAISE in PL/pgSQL, never in a plain statement",
};

/**
 * A fact the source must still state for an exception's reasoning to hold.
 *
 * A literal substring, deliberately: a marker that needs a regexp to express
 * is usually a guess about the file rather than a quotation from it.
 */
interface Premise {
  /** The file the marker lives in; the exception's own file by default. */
  file?: string;
  marker: string;
  /** What dies if the marker goes. */
  means: string;
}

/**
 * Files the scan skips because they cannot be handed a Postgres runner.
 *
 * AN EXCEPTION LIST IS THE NEXT PLACE THIS CLASS HIDES. Every entry here is a
 * claim about a file, and claims rot: the call gets ported and the line
 * outlives it, or the file gets widened and the line keeps quietly covering
 * it. Two tests below make that loud instead -- an entry that no longer trips
 * any rule is a line to delete, and a declared premise that disappears fails
 * the build naming what it meant.
 *
 * `premise` is owed on every entry and carried by the two added with the
 * function derivation, whose reasoning was established first-hand. The older
 * entries carry the still-needed check only; stating that plainly is better
 * than inventing a premise for reasoning somebody else established, and each
 * gains one as it is next touched.
 */
interface SingleStoreOwner {
  file: string;
  why: string;
  premise?: readonly Premise[];
  /** A known change this exception leaves with, so the line goes too. */
  retiresWith?: string;
}

const SINGLE_STORE_OWNERS: readonly SingleStoreOwner[] = [
  {
    file: "src/sqlite-document-decoder.ts",
    why: "Owns its read-only :memory: DatabaseSync. These fixed statements never accept or execute through a store runner.",
  },
  {
    file: "scripts/generate-export-projection.ts",
    why: "Offline schema generation owns its in-memory SQLite connection; the native runtime imports only its generated static metadata.",
  },
  {
    file: "src/neuron-documents.ts",
    why: "Document-plane SQL for the D1 owner.",
  },
  {
    file: "src/neuron-snapshot-read.ts",
    why: "The native branch has an explicit neurons owner check; the portable branch is exercised by the PostgreSQL route suite.",
  },
  {
    file: "src/subnet-burn-read.ts",
    why: "Latest burn seeks require explicit subnet_burn_history ownership. D1 parity tests reject calls to the portable runner in that branch.",
  },
  {
    file: "src/chain-concentration-rollup.ts",
    why: "The document branch requires explicit neuron_daily D1 ownership; native parity tests also execute the portable rollup branch.",
  },
  { file: "src/axon-transition-d1.ts", why: "D1-dialect axon SQL builders." },
  { file: "src/observations-d1.ts", why: "D1-dialect observations SQL." },
  { file: "src/capture-family-d1.ts", why: "D1-dialect capture-family SQL." },
  { file: "src/ledger-d1.ts", why: "D1-dialect ledger SQL." },
  { file: "src/registry-sync-d1.ts", why: "D1-dialect registry-sync SQL." },
  {
    file: "src/usage-rollup-d1.ts",
    why: "The caller requires explicit api_usage_rollup D1 ownership; native receipt tests cover rollback and committed-reply replay.",
  },
  { file: "src/root-basket-capture-d1.ts", why: "D1-dialect root-basket SQL." },
  { file: "src/d1-state-export.ts", why: "D1-dialect export reads." },
  { file: "src/d1-store.ts", why: "The D1 store itself." },
  {
    file: "src/retained-blocks-sync.ts",
    why: "Dedicated D1 binding and credential; never accepts a generic store runner. Native receiver tests cover atomic source selection.",
  },
  {
    // Found by the function derivation, which flagged its `hex(data)`: correct
    // about the function and wrong about the file.
    file: "src/raw-capture-d1.ts",
    why: 'Takes a `Pick<D1Database, "prepare" | "batch">` -- a D1 binding structurally, never a generic store runner -- and its one call site is reached only when RAW_CAPTURE_STORAGE is "d1".',
    premise: [
      {
        marker: 'Pick<D1Database, "prepare" | "batch">',
        means:
          "the store takes a D1 binding structurally; widened past this, it could receive a Postgres runner and the skip must stop covering it",
      },
      {
        file: "workers/api.ts",
        marker: 'env.RAW_CAPTURE_STORAGE === "d1"',
        means: "the only call site is still gated on the D1 storage mode",
      },
    ],
    // #13187 PAUSED this lane (RAW_CAPTURE_ENABLED=false) and did not delete
    // it -- its watermark persists so re-enabling resumes where it stopped. So
    // this line retires with the D1 plane at cutover, not with that pause.
    retiresWith: 'the D1 plane at cutover (RAW_CAPTURE_STORAGE leaves "d1")',
  },
  {
    file: "scripts/review-treasury-readings.ts",
    why: "Runs through `d1AdminBatch` on a maintainer's D1 management credential -- the same posture as the native D1 migration runner, as its own header says. Its `changes()` was the derivation's other find.",
    premise: [
      {
        marker: "d1AdminBatch",
        means:
          "the script still executes through the D1 management credential rather than a store runner",
      },
    ],
  },
];

/** A literal is SQL if it names a statement or clause keyword. */
const SQL_SHAPED =
  /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|WITH\s+\w+\s+AS|FROM\s+\w|WHERE\s+\w|GROUP\s+BY|ORDER\s+BY|ON\s+CONFLICT)\b/i;

/**
 * Each string literal separately, with `${...}` replaced by a placeholder.
 *
 * Per-literal because the SQL-context tier needs to know which literal a hit
 * is in. Interpolations are stripped because their CONTENTS are TypeScript:
 * `app.${quote(daily)}` is a call to this repo's own `quote` helper, and
 * reading it as SQLite's `quote()` is a false positive that would have had to
 * be silenced by deleting the rule.
 */
function sqlLiteralList(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:])\/\/.*$/gm, "$1 ");
  return [
    ...withoutComments.matchAll(
      /"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`|'([^'\\]*(?:\\.[^'\\]*)*)'/g,
    ),
  ].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ? "));
}

/** Every offending function call in one file's literals. */
function functionOffences(literals: readonly string[]): string[] {
  const out: string[] = [];
  const joined = literals.join("\n");
  for (const [name, portable] of Object.entries(SQLITE_ONLY_FUNCTIONS)) {
    const hit = new RegExp(`\\b${name}\\s*\\(`, "i").exec(joined);
    if (hit)
      out.push(`${hit[0].trim()} — ${name}() is SQLite's; use ${portable}`);
  }
  for (const [name, portable] of Object.entries(SQLITE_ONLY_IN_SQL_CONTEXT)) {
    const pattern = new RegExp(`\\b${name}\\s*\\(`, "i");
    const inSql = literals.some(
      (literal) => SQL_SHAPED.test(literal) && pattern.test(literal),
    );
    if (inSql) out.push(`${name}( — ${name}() is SQLite's; use ${portable}`);
  }
  return out;
}

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
    let scanned = 0;
    let sqlLiterals_ = 0;
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
      if (SINGLE_STORE_OWNERS.some((owner) => owner.file === file)) continue;
      scanned += 1;
      const literals = sqlLiteralList(readFileSync(file, "utf8"));
      sqlLiterals_ += literals.filter((literal) =>
        SQL_SHAPED.test(literal),
      ).length;
      const sql = literals.join("\n");
      for (const [pattern, why] of SQLITE_ONLY) {
        const hit = pattern.exec(sql);
        if (hit) offenders.push(`${file}: ${hit[0].trim()} — ${why}`);
      }
      for (const offence of functionOffences(literals))
        offenders.push(`${file}: ${offence}`);
    }
    // THE REACH, STATED. A gap in this scan used to pass silently; now it has
    // to move a number somebody reads. These are floors, not equalities, so
    // ordinary growth does not fail the build -- but a drop means the scan
    // stopped looking somewhere, which is exactly the failure #9798 had.
    assert.ok(
      scanned > 950,
      `the scan reached only ${scanned} files; it had been reaching over 950`,
    );
    assert.ok(
      sqlLiterals_ > 900,
      `the scan found only ${sqlLiterals_} SQL literals; it had been finding over 900`,
    );
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

  test("every skipped file still has something to skip", () => {
    // DIRECTION ONE OF THE ROT GUARD. An entry whose call was ported or
    // deleted is a line to remove, not to carry: left in place it silently
    // exempts whatever the file grows next. This needs no per-entry reasoning
    // and so covers the whole list -- a file that trips nothing has no reason
    // to be here.
    const stale: string[] = [];
    for (const owner of SINGLE_STORE_OWNERS) {
      if (!existsSync(owner.file)) {
        stale.push(`${owner.file}: file is gone -- delete its entry`);
        continue;
      }
      const literals = sqlLiteralList(readFileSync(owner.file, "utf8"));
      const trips =
        SQLITE_ONLY.some(([pattern]) => pattern.test(literals.join("\n"))) ||
        functionOffences(literals).length > 0;
      if (!trips)
        stale.push(
          `${owner.file}: no SQLite-only SQL left -- its exception has outlived the call${
            owner.retiresWith
              ? ` (expected to retire with ${owner.retiresWith})`
              : ""
          }, delete the entry`,
        );
    }
    assert.deepEqual(stale, [], stale.join("\n"));
  });

  test("every declared premise is still stated by the source", () => {
    // DIRECTION TWO. The reasoning, not the symptom: if raw-capture-d1.ts is
    // widened past its D1 binding, or the treasury script loses its
    // management-credential path, the exception stops being true while still
    // reading as deliberate. The failure names what the marker meant so
    // whoever hits it can tell a rename from a real widening.
    const broken: string[] = [];
    for (const owner of SINGLE_STORE_OWNERS)
      for (const premise of owner.premise ?? []) {
        const file = premise.file ?? owner.file;
        if (!existsSync(file)) {
          broken.push(`${owner.file}: premise file ${file} is gone`);
          continue;
        }
        if (!readFileSync(file, "utf8").includes(premise.marker))
          broken.push(
            `${owner.file}: ${file} no longer states \`${premise.marker}\` -- ${premise.means}`,
          );
      }
    assert.deepEqual(broken, [], broken.join("\n"));
  });

  test("every function in the derivation is provably caught, and the count is stated", () => {
    // THE COVERAGE NUMBER #9798 DID NOT HAVE. An inventory nothing exercises
    // is the same trap one layer up: it would look like 39 functions guarded
    // while a typo in any name guarded none of them. So every entry has to
    // catch a call, and the totals are asserted, which means the next gap
    // moves a number instead of passing silently.
    const names = Object.keys(SQLITE_ONLY_FUNCTIONS);
    const contextNames = Object.keys(SQLITE_ONLY_IN_SQL_CONTEXT);
    assert.equal(names.length, 33, "derived function count changed");
    assert.equal(contextNames.length, 6, "SQL-context function count changed");
    for (const name of names) {
      const offences = functionOffences([`SELECT ${name}(col) FROM t`]);
      assert.equal(
        offences.length,
        1,
        `${name} is in the inventory but catches nothing`,
      );
      assert.match(offences[0]!, /use \S/, `${name} names no portable form`);
    }
    for (const name of contextNames) {
      assert.equal(
        functionOffences([`SELECT ${name}(col) FROM t`]).length,
        1,
        `${name} is not caught inside SQL`,
      );
      // ...and deliberately NOT outside SQL, which is the whole reason this
      // tier exists: `typeof(x)` in a quoted snippet of TypeScript is not a
      // dialect fault.
      assert.deepEqual(
        functionOffences([`the ${name}(x) helper returns a label`]),
        [],
        `${name} fires on prose, which would make this gate noise`,
      );
    }
  });

  test("the two shapes that evaded the date() rule for months", () => {
    // NAMED, because they are the regression cases this gate was missing: the
    // scan #9798 added was green on all three statements it was written for.
    // Byte for byte from src/chain-turnover.ts, src/movers.ts and
    // src/turnover.ts.
    // Wrapped in backticks because `sqlLiterals` extracts SQL FROM SOURCE,
    // which is how the real scan sees it -- testing the bare string would
    // skip the extraction step the hit has to survive.
    const caught = (sql: string) =>
      SQLITE_ONLY.some(([p]) => p.test(sqlLiterals(`\`${sql}\``))) ||
      functionOffences([sql]).length > 0;

    // 1. A BOUND PLACEHOLDER where the rule expected a quoted modifier.
    assert.ok(
      caught(
        "WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), ?) FROM neuron_daily)",
      ),
      "the placeholder-modifier shape is unrecognised again",
    );
    assert.ok(
      caught("SELECT date(MAX(day), $2) FROM t"),
      "the numbered-placeholder shape is unrecognised again",
    );
    // 2. A NESTED CALL as the first argument, whose paren the rule's
    //    character class could not cross to reach the comma.
    assert.ok(
      caught("SELECT date(COALESCE(day, other), '-30 days') FROM t"),
      "a nested first argument hides the modifier again",
    );
    // And the conversion those three received must stay clean.
    assert.ok(
      !caught(
        "SELECT MIN(snapshot_date) AS start_date FROM neuron_daily WHERE netuid = ? AND snapshot_date >= ?",
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
