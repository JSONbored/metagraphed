// Database reads that still say `Record<string, unknown>` -- a ceiling that
// only falls (#10311).
//
// #10261 generated a row type for all 52 Neon tables and made the runners
// generic, but the row type DEFAULTED to `Record<string, unknown>`. Five call
// sites opted in; the other ~120 did not, and nothing stopped the next read
// from being untyped either. A migration that opts sites in one at a time
// decays: the 125th read gets written untyped and nobody notices. Measured over
// one day while working this issue, the population moved 84 -> 87 tagged reads
// and 1,198 -> 1,238 `Record<string, unknown>` occurrences, with one new
// opt-in. The default was losing.
//
// Removing the default inverts it. An untyped read now has to SAY
// `sql<Record<string, unknown>>`, which is a declared escape hatch that can be
// counted and driven down, instead of a silent default that cannot. This file
// is the count.
//
// A RATCHET, not a pass/fail on zero. Zero is not reachable today and
// pretending otherwise would mean an allowlist, which is worse -- an exemption
// list stops being read the moment it is longer than a screen, and it hides
// exactly the thing it names. Same shape as
// scripts/validate-ui-route-coverage.ts, for the same reason.
//
// ## What is NOT derivable, and therefore not a failure of this gate
//
// A literal single-table `SELECT` can become `Pick<T, …>` mechanically. Joins,
// aliased expressions (`count(*) AS n`), dynamic column lists
// (`${NEURON_COLUMNS}`) and the `unsafe` calls whose text is assembled at run
// time cannot. Guessing there would replace a hand-written assumption with a
// generated one that is equally wrong and now looks authoritative, so those
// stay escape hatches until an author types them.
//
// ## Why there is no separate correctness check
//
// A heuristic validator comparing `row.<column> as <type>` against the schema
// by column name was tried and rejected: it reported 17 disagreements and the
// two checked by hand were both false positives, because column-name matching
// cannot know a row's provenance. TYPING THE READ is what gives it provenance,
// after which `tsc` reports the disagreement with full context and no separate
// gate is needed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib.ts";

/**
 * The most untyped reads allowed. THE CEILING ONLY FALLS.
 *
 * 105 at the inversion (#10311): 104 in `workers/data-api.ts` and one D1
 * `.all<Record<string, unknown>>()` in `src/subnet-burn-coverage-watchdog.ts`.
 * Lower it whenever a read is given a real row type.
 */
// Annotated `number` rather than left as the literal so the "none left"
// message below stays reachable code as the ceiling falls to zero.
export const MAX_UNTYPED_READS: number = 104;

/** Where a read can live. `scripts/` is excluded: it does not serve traffic. */
const SOURCE_DIRS = ["src", "workers"];

/**
 * A read that declares the escape hatch.
 *
 * Written against the TYPE ARGUMENT rather than the runner's identifier, so it
 * covers every shape a read takes here without a list to maintain: `sql` and
 * the `historySql` alias two handlers use, as a tagged template or an `unsafe`
 * call, and D1's `.all<Record<string, unknown>>()`. That breadth is not
 * incidental -- an identifier-keyed matcher missed the D1 read while this one
 * found it, which is the same lesson the runner default taught.
 *
 * WHITESPACE-TOLERANT, and not optionally. Prettier splits a long read across
 * lines --
 *
 *     await sql<
 *       Record<string, unknown>
 *     >`DELETE FROM chain_alert_triggers WHERE id = ${id}`;
 *
 * -- at 16 sites in `workers/data-api.ts`. A matcher written against the
 * single-line spelling counted 92 of 105 and reported the difference as an
 * IMPROVEMENT, which is the worst direction for a ratchet to be wrong in: it
 * would have invited lowering the ceiling to a number no one had earned, and
 * the next reformat would have "regressed" it back.
 */
const UNTYPED_READ = /<\s*Record\s*<\s*string\s*,\s*unknown\s*>\s*>\s*[`(]/g;

/**
 * The runners must not reintroduce a default row type.
 *
 * This is the half that makes the count mean something: with a default back in
 * place the escape hatches could all be deleted and the reads would still
 * compile, untyped and uncounted. Checked as source text because the whole
 * point is that TypeScript cannot see the difference.
 */
const RUNNER_FILES = ["src/pg-sql.ts", "workers/data-api.ts"];
const DEFAULTED_ROW = /<Row\s*=\s*Record<string, unknown>>/;

export function sourceFiles(dirs: readonly string[], root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith(".ts") && !full.endsWith(".d.ts")) found.push(full);
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  return found.sort();
}

/**
 * Comment lines, dropped before counting.
 *
 * Prose about this gate names the very pattern it counts -- the docblock above
 * writes ``sql<Record<string, unknown>>`` and the closing markdown backtick
 * makes it look exactly like a tagged read. Counting it turned a clean tree
 * into a "regression" of one, in this file, on its own explanation.
 *
 * Only WHOLE comment lines are dropped, never a trailing `// ...` after code:
 * stripping to end-of-line would also eat anything after a `https://` inside a
 * string, which is a silent UNDERCOUNT, and undercounting is the direction that
 * quietly lowers a ratchet.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

export function countUntypedReads(source: string): number {
  const code = source
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");
  return [...code.matchAll(UNTYPED_READ)].length;
}

export function runnersWithDefaultRow(
  files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
  return files
    .filter(({ source }) => DEFAULTED_ROW.test(source))
    .map(({ file }) => file);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

function main(): void {
  const defaulted = runnersWithDefaultRow(
    RUNNER_FILES.map((file) => ({
      file,
      source: readFileSync(path.join(repoRoot, file), "utf8"),
    })),
  );
  if (defaulted.length > 0) {
    console.error(
      `A database runner declares a DEFAULT row type again: ${defaulted.join(", ")}.\n` +
        `That makes an untyped read compile silently, so the count below stops ` +
        `measuring anything (#10311). Remove the default and let the call site ` +
        `name its row -- \`sql<Record<string, unknown>>\` if it genuinely cannot.`,
    );
    process.exit(1);
  }

  const byFile = new Map<string, number>();
  for (const file of sourceFiles(SOURCE_DIRS, repoRoot)) {
    const count = countUntypedReads(readFileSync(file, "utf8"));
    if (count > 0) byFile.set(path.relative(repoRoot, file), count);
  }
  const total = [...byFile.values()].reduce((sum, n) => sum + n, 0);

  if (total > MAX_UNTYPED_READS) {
    console.error(
      `Untyped database reads regressed: ${total} read(s) say \`Record<string, unknown>\`, ` +
        `ceiling is ${MAX_UNTYPED_READS}.\n` +
        `A new read must name what it returns, or the debt grows one PR at a time ` +
        `-- which is how #10261's five opt-ins became 124 untyped reads.\n` +
        [...byFile]
          .map(([file, count]) => `  ${String(count).padStart(4)}  ${file}`)
          .join("\n"),
    );
    process.exit(1);
  }

  if (total < MAX_UNTYPED_READS) {
    console.error(
      `Untyped database reads improved: ${total}, ceiling is ${MAX_UNTYPED_READS}. ` +
        `Lower MAX_UNTYPED_READS in scripts/validate-untyped-db-reads.ts to ${total} ` +
        `so the gain is locked in -- a ceiling nobody lowers stops being a ratchet.`,
    );
    process.exit(1);
  }

  console.log(
    MAX_UNTYPED_READS === 0
      ? `Untyped database reads: none -- every read names the row it returns.`
      : `Untyped database reads: ${total} declared escape hatch(es) at the ceiling, ` +
          `across ${byFile.size} file(s); neither runner defaults its row type.`,
  );
}
