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
}

/** Whole `r2SqlQuery(env, ...)` calls, template literals joined. */
export function findUnbounded(file: string, source: string): Finding[] {
  const out: Finding[] = [];
  const call =
    /r2SqlQuery\(\s*env,\s*(`(?:[^`\\]|\\.)*`(?:\s*\+\s*`(?:[^`\\]|\\.)*`)*)/gs;
  for (const match of source.matchAll(call)) {
    const query = (match[1] ?? "").replace(/\s+/g, " ");
    // A first pass at this used a 300-char window and reported 62 findings,
    // almost all of them Neon queries and prose. Match the WHOLE call or do not
    // bother: a truncated query is indistinguishable from an unbounded one.
    if (!/FROM\s+(chain|chain_testnet)\./i.test(query)) continue;
    const scattered = SCATTERED.some((c) =>
      new RegExp(`\\b${c}\\b\\s*(=|IN|LIKE)`, "i").test(query),
    );
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
  const stale = Object.keys(UNBOUNDED_BY_DESIGN).filter(
    (file) => !findings.some((f) => f.file === file),
  );

  const problems: string[] = [];
  if (unexpected.length) {
    problems.push(
      `${unexpected.length} lakehouse read(s) filter a scattered key with no bound:\n` +
        unexpected.map((f) => `  ${f.file}\n     ${f.query}`).join("\n") +
        `\n  -> add a predicate on one of: ${PRUNABLE.join(", ")}.` +
        `\n     Without one the engine reads EVERY file: measured 577.5 MB and` +
        `\n     3,480 R2 requests against 0.1 MB and 9 with a time bound.` +
        `\n     If a full scan is genuinely cheap, add the file to` +
        `\n     UNBOUNDED_BY_DESIGN with the measured cost.`,
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
      `bounded (${Object.keys(UNBOUNDED_BY_DESIGN).length} exempt, each measured).\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
