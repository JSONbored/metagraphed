// A lakehouse read that filters a SCATTERED key must bound its scan (#11132).
//
// MEASURED, not assumed. On `chain.account_events` (455M rows, 51 files):
//
//   WHERE hotkey = X                        577.5 MB   3,480 R2 requests
//   WHERE hotkey = X AND observed_at > T      0.1 MB       9 R2 requests
//
// A hotkey/coldkey/account value is scattered across every data file, so file
// statistics cannot prune on it and the engine reads all of them. A predicate
// on a column the statistics DO order -- observed_at, block_number, day,
// captured_at -- makes the same query roughly 5,800x cheaper.
//
// WHY NOT PARTITION INSTEAD. Because it was tried and it does not pay. A
// bucket(16, hotkey) copy of one real day (1.2M rows, 7,218 hotkeys) against a
// flat copy of the same rows:
//
//   flat      filter by hotkey    0.58 MB    6 files     7 requests
//   bucketed  filter by hotkey    0.42 MB   21 files    51 requests
//
// Bucketing cut bytes by 28% and multiplied requests by 7. R2 SQL has a real
// per-file cost, and splitting a table into buckets trades bytes for requests
// at a bad rate. So the fix is the predicate, not the layout -- and a 455M-row
// rewrite would have been an expensive way to make things slower.
//
// Every reader satisfies this today. That is exactly when a rule is worth
// writing down: a new cold-tier read that forgets the bound would be four
// orders of magnitude more expensive and would look completely ordinary in
// review.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { repoRoot } from "./lib.ts";

/** Columns whose values are spread across every file, so statistics cannot prune. */
const SCATTERED = ["hotkey", "coldkey", "account", "surface_id", "surface_key"];

/** Columns the writers order by, so file statistics DO prune on them. */
const PRUNABLE = [
  "observed_at",
  "block_number",
  "captured_at",
  "snapshot_date",
  "recorded_at",
  "computed_at",
  "updated_at",
  "first_seen",
  "day",
];

/**
 * Reads allowed to scan unbounded, each with the cost that makes it fine.
 *
 * Measured, not asserted -- an exemption without a number is a guess that
 * outlives the thing it was guessing about. These are small tables where a full
 * scan is genuinely cheaper than the index-shaped alternative.
 */
export const UNBOUNDED_BY_DESIGN: Readonly<Record<string, string>> = {
  "src/account-identity-cold-tier.ts":
    "chain.account_identity is ~515 rows; a full scan measured 0.08 MB",
  "src/nominator-positions-cold-tier.ts":
    "chain.nominator_positions is ~123k rows; a full scan measured 1.67 MB",
};

export interface Finding {
  file: string;
  query: string;
  /** The predicate is interpolated, so this gate cannot read it from source. */
  unreadable?: boolean;
}

/**
 * Files whose WHERE is assembled at runtime, each naming the test that captures
 * the SQL the reader ACTUALLY emits and asserts the bound on it.
 *
 * This is the honest form of the exemption. A static gate cannot read
 * `WHERE ${where.join(" AND ")}`, and before #11131 it silently skipped every
 * such call -- which was all four unbounded reads on `chain.account_events`.
 * Pointing at a runtime test is the only way to actually cover them; pointing
 * at nothing is how the gate reported "every reader satisfies this today" while
 * the route it was protecting was timing out in production.
 */
export const INTERPOLATED_PREDICATES: Readonly<Record<string, string>> = {
  "src/account-feeds-cold-tier.ts":
    "tests/account-feeds-cold-tier.test.ts + tests/account-summary-cold-tier.test.ts capture the emitted SQL",
  "src/events-cold-tier.ts":
    "tests/events-cold-tier.test.ts asserts the windowed block bound",
  "src/chain-events-cold-tier.ts":
    "tests/chain-events-cold-tier.test.ts asserts the required window",
  "src/r2-sql-blocks.ts":
    "tests/blocks-cold-tier.test.ts asserts the block range on every read",
};

/**
 * Whole `r2SqlQuery(...)` calls, template literals joined.
 *
 * TWO WAYS THIS WENT BLIND, both found by #11131 and both fixed here.
 *
 * 1. THE GENERIC. The pattern required `r2SqlQuery(env,` literally, so every
 *    `r2SqlQuery<AccountEventsRow>(env, ...)` was invisible -- 16 of the 61 call
 *    sites in `src/`, including all four unbounded reads on
 *    `chain.account_events`. The type argument is now optional in the match.
 *
 * 2. THE INTERPOLATED PREDICATE. A query assembled as
 *    `WHERE ${where.join(" AND ")}` carries neither its scattered key nor its
 *    bound in the literal source, so the scattered test failed and the call was
 *    skipped as out of scope -- silently, which is the worst way for a gate to
 *    not apply. That is how essentially every cold-tier reader is written.
 *
 * The second one cannot be fixed by a better regex: the predicate does not
 * exist until runtime. So an interpolated WHERE is reported as UNKNOWN rather
 * than passed, and a file gets into `INTERPOLATED_PREDICATES` only by naming the
 * test that captures its real SQL and asserts the bound. A gate that cannot see
 * a query must say so.
 *
 * NARROWLY, THOUGH. Only a file that builds a scattered-key predicate ANYWHERE
 * in its source can be hiding one in an interpolated WHERE. Without that
 * condition this reports the netuid-filtered history readers too, and #11133's
 * own lesson is that a gate crying wolf gets muted -- its first sweep reported
 * 62 findings of which 3 were real.
 */
export function findUnbounded(file: string, source: string): Finding[] {
  const out: Finding[] = [];
  // Does this file build a scattered-key predicate at all? `hotkey = '${addr}'`
  // in a where-array push looks exactly like this, wherever it sits.
  const buildsScattered = SCATTERED.some((c) =>
    new RegExp(`\\b${c}\\b\\s*(=|IN|LIKE)`, "i").test(source),
  );
  const call =
    /r2SqlQuery(?:<[^>]*>)?\(\s*\w+,\s*(`(?:[^`\\]|\\.)*`(?:\s*\+\s*`(?:[^`\\]|\\.)*`)*)/gs;
  for (const match of source.matchAll(call)) {
    const query = (match[1] ?? "").replace(/\s+/g, " ");
    // A first pass at this used a 300-char window and reported 62 findings,
    // almost all of them Neon queries and prose. Match the WHOLE call or do not
    // bother: a truncated query is indistinguishable from an unbounded one.
    if (!/FROM\s+(chain|chain_testnet)\./i.test(query)) continue;
    const scattered = SCATTERED.some((c) =>
      new RegExp(`\\b${c}\\b\\s*(=|IN|LIKE)`, "i").test(query),
    );
    // An interpolated WHERE hides both halves of the question. Unreadable is
    // not the same as safe.
    if (!scattered && buildsScattered && /WHERE\s*\$\{/.test(query)) {
      if (INTERPOLATED_PREDICATES[file]) continue;
      out.push({ file, query: query.slice(0, 160), unreadable: true });
      continue;
    }
    if (!scattered) continue;
    if (PRUNABLE.some((c) => new RegExp(`\\b${c}\\b`, "i").test(query)))
      continue;
    out.push({ file, query: query.slice(0, 160) });
  }
  return out;
}

function main(): void {
  const dir = path.join(repoRoot, "src");
  const findings: Finding[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const file = `src/${name}`;
    findings.push(
      ...findUnbounded(file, readFileSync(path.join(dir, name), "utf8")),
    );
  }

  const unexpected = findings.filter((f) => !UNBOUNDED_BY_DESIGN[f.file]);
  const staleInterpolated = Object.keys(INTERPOLATED_PREDICATES).filter(
    (file) => !readdirSync(dir).some((name) => `src/${name}` === file),
  );
  const stale = Object.keys(UNBOUNDED_BY_DESIGN).filter(
    (file) => !findings.some((f) => f.file === file),
  );

  const problems: string[] = [];
  if (unexpected.length) {
    problems.push(
      `${unexpected.length} lakehouse read(s) filter a scattered key with no bound:\n` +
        unexpected
          .map(
            (f) =>
              `  ${f.file}${f.unreadable ? "  (predicate interpolated -- UNREADABLE from source)" : ""}\n     ${f.query}`,
          )
          .join("\n") +
        `\n  -> add a predicate on one of: ${PRUNABLE.join(", ")}.` +
        `\n     Without one the engine reads EVERY file: measured 577.5 MB and` +
        `\n     3,480 R2 requests against 0.1 MB and 9 with a time bound.` +
        `\n     If a full scan is genuinely cheap, add the file to` +
        `\n     UNBOUNDED_BY_DESIGN with the measured cost.`,
    );
  }
  if (staleInterpolated.length) {
    problems.push(
      `${staleInterpolated.length} INTERPOLATED_PREDICATES entr(ies) name a file that is gone:\n  ` +
        staleInterpolated.join("\n  ") +
        `\n  -> remove them; the exemption would otherwise cover whatever` +
        `\n     takes that path next.`,
    );
  }
  if (stale.length) {
    problems.push(
      `${stale.length} UNBOUNDED_BY_DESIGN entr(ies) no longer match any read:\n  ` +
        stale.join("\n  ") +
        `\n  -> remove them; an exemption for a read that no longer exists` +
        `\n     silently covers the next one added to that file.`,
    );
  }

  if (problems.length) {
    process.stderr.write(`r2-sql-scan-bounds:\n${problems.join("\n\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `r2-sql-scan-bounds: every lakehouse read filtering a scattered key is ` +
      `bounded (${Object.keys(UNBOUNDED_BY_DESIGN).length} exempt, each measured; ` +
      `${Object.keys(INTERPOLATED_PREDICATES).length} covered by runtime SQL capture).\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
