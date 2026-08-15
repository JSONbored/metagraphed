// Lakehouse reads that still take the default row type -- a ceiling that only
// falls.
//
// THE NEON SIDE ALREADY HAS THIS, and the lakehouse needed its own rather than
// a share of it. scripts/validate-untyped-db-reads.ts counts the ESCAPE HATCH:
// #10311 removed the default from the Postgres runners, so an untyped read has
// to write `sql<Record<string, unknown>>` and can be counted. That inversion is
// not available here. `r2SqlQuery`'s row parameter DEFAULTS, deliberately --
// removing it would have meant touching 38 call sites in the same change that
// made typing them possible at all, and 30 of them read aggregates or column
// subsets that need a `Pick<>` nobody has written yet.
//
// So this counts the ABSENCE of a type argument instead. Same ratchet, opposite
// polarity, and it must be a separate number: the Neon counter matches
// `<Record<string, unknown>>(`, which an escape hatch here would satisfy, so
// folding the two together would let lakehouse work push a ceiling that is
// supposed to only fall.
//
// A RATCHET, NOT A PASS/FAIL ON ZERO. Zero is not reachable today and
// pretending otherwise would mean an allowlist, which is worse -- an exemption
// list stops being read the moment it is longer than a screen. Same shape and
// same reasoning as the Neon counter it sits beside.
//
// ## What is NOT derivable, and therefore not a failure of this gate
//
// A read whose SQL is `SELECT ${<TABLE>_COLUMNS} FROM …` returns exactly the
// generated row type, and those are typed. A read that selects `count(*)`,
// `MAX(observed_at)`, or a hand-written column subset does not, and guessing
// there would replace a hand-written assumption with a generated one that is
// equally wrong and now looks authoritative. Those stay untyped until an author
// writes the projection type.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib.ts";
import { sourceFiles } from "./validate-untyped-db-reads.ts";

/**
 * The most untyped lakehouse reads allowed. THE CEILING ONLY FALLS.
 *
 * 31 when this landed: 39 `r2SqlQuery` call sites, of which 8 select a full
 * generated column tuple and carry the matching row type. Lower it whenever a
 * read is given one.
 *
 * 30 (#11000). The extrinsics feed -- the read that produced `Memory limit
 * exceeded before EOF` -- now carries both halves: the generated row TYPE and
 * the generated row SCHEMA from schemas-src/lakehouse.ts, so the claim
 * is checked at runtime rather than asserted at compile time.
 */
// Annotated `number` rather than left as the literal so the "none left" branch
// below stays reachable code as the ceiling falls to zero.
export const MAX_UNTYPED_LAKEHOUSE_READS: number = 25;

/** Where a read can live. `scripts/` is excluded: it does not serve traffic. */
const SOURCE_DIRS = ["src", "workers"];

/**
 * A call with NO type argument -- `r2SqlQuery(` rather than `r2SqlQuery<Row>(`.
 *
 * The negative lookahead is what makes this a count of untyped reads rather
 * than of all reads. Whitespace-tolerant for the same reason the Neon counter
 * is: prettier splits long calls across lines, and a matcher written against
 * the single-line spelling undercounts -- which is the direction that quietly
 * lowers a ratchet.
 */
const UNTYPED_READ = /\br2SqlQuery\s*\(/g;
/** Any call at all, typed or not, so the two can be differenced. */
const ANY_READ = /\br2SqlQuery\s*[<(]/g;

/**
 * Comment lines, dropped before counting.
 *
 * Prose about this gate names the very pattern it counts -- the docblock above
 * writes `r2SqlQuery(` more than once. Counting those would make this file its
 * own regression. Only WHOLE comment lines are dropped, never a trailing
 * `// ...` after code: stripping to end-of-line would also eat anything after a
 * `https://` inside a string, which is a silent UNDERCOUNT.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

export function countUntypedLakehouseReads(source: string): number {
  const code = source
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");
  // An import or a type position (`typeof r2SqlQuery`) is not a read.
  const withoutRefs = code
    .replace(/import[^;]*?from\s*"[^"]*r2-sql\.ts";/gs, "")
    .replace(/typeof\s+r2SqlQuery/g, "");
  return [...withoutRefs.matchAll(UNTYPED_READ)].length;
}

/** Typed + untyped, for the report line. */
export function countLakehouseReads(source: string): number {
  const code = source
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n")
    .replace(/import[^;]*?from\s*"[^"]*r2-sql\.ts";/gs, "")
    .replace(/typeof\s+r2SqlQuery/g, "");
  return [...code.matchAll(ANY_READ)].length;
}

export function main(): number {
  const files = sourceFiles(SOURCE_DIRS, repoRoot);
  const byFile: [string, number][] = [];
  let untyped = 0;
  let total = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const n = countUntypedLakehouseReads(source);
    total += countLakehouseReads(source);
    if (n === 0) continue;
    untyped += n;
    byFile.push([path.relative(repoRoot, file), n]);
  }

  if (untyped > MAX_UNTYPED_LAKEHOUSE_READS) {
    console.error(
      `validate-untyped-lakehouse-reads: ${untyped} reads take the default row ` +
        `type, ceiling is ${MAX_UNTYPED_LAKEHOUSE_READS}.\n` +
        `Give the new read a row type from generated/lakehouse/types.ts, or a ` +
        `Pick<> of one when it selects a subset:`,
    );
    for (const [file, n] of byFile.sort((a, b) => b[1] - a[1])) {
      console.error(`  ${n}  ${file}`);
    }
    return 1;
  }

  if (untyped < MAX_UNTYPED_LAKEHOUSE_READS) {
    console.log(
      `validate-untyped-lakehouse-reads: ${untyped} of ${total} untyped, ` +
        `below the ceiling of ${MAX_UNTYPED_LAKEHOUSE_READS}. LOWER IT to ${untyped}.`,
    );
    return 0;
  }

  console.log(
    untyped === 0
      ? `validate-untyped-lakehouse-reads: none left -- every read names its row.`
      : `validate-untyped-lakehouse-reads: ${untyped} of ${total} untyped, at the ceiling.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
