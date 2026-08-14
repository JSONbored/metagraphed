// A coverage rule's numerator and denominator must span the same window
// (#11199).
//
// TWICE NOW, the same defect. A watchdog scoped what a pass COVERED to that
// pass, and scoped what it was measured AGAINST to a whole table that never
// prunes -- so a complete pass could not reach the floor by construction:
//
//   hotkey-alpha (#11170)          covered  = rows in the newest pass window
//                                  referenced = DISTINCT (hotkey, netuid) over
//                                  ALL of nominator_positions
//
//   subnet-burn-coverage (#11195)  covered  = netuids at MAX(observed_at)
//                                  expected = DISTINCT netuid over ALL of
//                                  subnet_hyperparams
//
// The first alarmed for hours on complete passes. The second had not fired only
// because no netuid has ever been removed -- pure luck, and it would have
// started the day one was.
//
// ## THE RULE, AND WHY `total` IS EXEMPT
//
// Not every unwindowed aggregate is a bug. Several of these queries carry a
// whole-table `COUNT(*) AS total` deliberately: it tells an operator how much
// older data sits underneath a partial pass, and it is NEVER what the rule
// compares against -- those compare `covered` to a floor derived from a
// declared population.
//
// So the convention this gate enforces is: an aggregate that is unwindowed must
// be called `total`, and `total` must not be a denominator. Anything else
// feeding the rule -- `covered`, `expected`, `referenced` -- has to carry a
// stamp bound. Naming the exemption is what makes the rest checkable.
//
// READS THE ASSEMBLED CONSTANTS, not the source text. These queries are built by
// concatenating string literals across several lines, so a regex over the file
// would see fragments and go blind the first time someone reflowed them.
// Importing gives the final SQL exactly as the driver receives it.
import { fileURLToPath } from "node:url";
import { ACCOUNT_BALANCES_COVERAGE_SQL } from "../src/account-balances-staleness-watchdog.ts";
import { HOTKEY_ALPHA_COVERAGE_SQL } from "../src/hotkey-alpha-staleness-watchdog.ts";
import { NEURONS_COVERAGE_SQL } from "../src/neurons-staleness-watchdog.ts";
import { NOMINATOR_POSITIONS_COVERAGE_SQL } from "../src/nominator-positions-staleness-watchdog.ts";
import { SUBNET_BURN_COVERAGE_SQL } from "../src/subnet-burn-coverage-watchdog.ts";
import { VALIDATOR_NOMINATOR_COUNTS_COVERAGE_SQL } from "../src/validator-nominator-counts-staleness-watchdog.ts";

/** Every coverage read, by the lane it belongs to. */
export const COVERAGE_QUERIES: Readonly<Record<string, string>> = {
  "account-balances": ACCOUNT_BALANCES_COVERAGE_SQL,
  "hotkey-alpha": HOTKEY_ALPHA_COVERAGE_SQL,
  neurons: NEURONS_COVERAGE_SQL,
  "nominator-positions": NOMINATOR_POSITIONS_COVERAGE_SQL,
  "subnet-burn-coverage": SUBNET_BURN_COVERAGE_SQL,
  "validator-nominator-counts": VALIDATOR_NOMINATOR_COUNTS_COVERAGE_SQL,
};

/**
 * Aliases that may be unwindowed.
 *
 * `total` by the convention above. `latest` is a bare `MAX(stamp)` -- it reports
 * WHEN, not HOW MANY, so there is no population for it to be scoped against.
 */
const UNSCOPED_ALLOWED = new Set(["total", "latest"]);

/** Aggregates whose result is a count of a population. */
const AGGREGATE = /\b(COUNT|SUM)\s*\(/i;

/**
 * A stamp bound: either a window comparison or an equality against a MAX().
 *
 * Both forms appear -- `captured_at >= (SELECT MAX(captured_at) ...) - ?` on the
 * window-based lanes, `observed_at = (SELECT MAX(observed_at) ...)` on the
 * exact-stamp ones -- and either is a scoping, so both count.
 */
const STAMP_BOUND = /\b\w*_?at\s*(>=|=)\s*\(?\s*(SELECT\s+)?MAX\s*\(/i;

/**
 * Strip a trailing `FROM ...` that belongs to the OUTER query.
 *
 * Depth-aware, and that is the whole point: a naive strip from the first
 * ` FROM ` eats the inner FROM of a subselect and carries the `AS <alias>` away
 * with it, so the alias is never seen and the expression is silently skipped.
 * That is not hypothetical -- it is how the first cut of this gate passed on
 * both queries it was written to catch.
 */
export function stripOuterFrom(part: string): string {
  let depth = 0;
  for (let i = 0; i < part.length; i += 1) {
    const ch = part[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /\s/.test(ch)) {
      if (/^\s+FROM\s/i.test(part.slice(i))) return part.slice(0, i);
    }
  }
  return part;
}

/** Split a select list on top-level commas, ignoring those inside parens. */
export function topLevelParts(sql: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of sql) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

export interface ScopingProblem {
  lane: string;
  alias: string;
  expression: string;
}

export function problemsIn(lane: string, sql: string): ScopingProblem[] {
  // Only the select list; a trailing FROM/WHERE belongs to the outer query and
  // its own scoping is judged through whichever alias it qualifies.
  const selectList = sql.replace(/^\s*SELECT\s+/i, "");
  const out: ScopingProblem[] = [];
  for (const part of topLevelParts(selectList)) {
    const alias = /\bAS\s+(\w+)\s*$/i.exec(stripOuterFrom(part).trim());
    if (!alias) continue;
    const name = alias[1]!.toLowerCase();
    if (UNSCOPED_ALLOWED.has(name)) continue;
    if (!AGGREGATE.test(part)) continue;
    if (STAMP_BOUND.test(part)) continue;
    out.push({ lane, alias: name, expression: part.trim().slice(0, 120) });
  }
  return out;
}

function main(): void {
  const problems: ScopingProblem[] = [];
  for (const [lane, sql] of Object.entries(COVERAGE_QUERIES)) {
    problems.push(...problemsIn(lane, sql));
  }
  if (problems.length) {
    process.stderr.write(
      `coverage-scoping: ${problems.length} aggregate(s) feed a rule without a stamp bound:\n` +
        problems
          .map((p) => `  ${p.lane}: "${p.alias}" -> ${p.expression}`)
          .join("\n") +
        `\n  -> a coverage rule must measure the numerator and the denominator over\n` +
        `     the SAME window. hotkey-alpha (#11170) compared one pass against all\n` +
        `     history and alarmed on complete passes for hours; subnet-burn (#11195)\n` +
        `     had the same shape and had simply not been unlucky yet.\n` +
        `     An aggregate that is deliberately whole-table must be aliased "total"\n` +
        `     and must not be what the rule compares against.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `coverage-scoping: ${Object.keys(COVERAGE_QUERIES).length} coverage read(s), every rule-feeding aggregate bounded to a pass.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
