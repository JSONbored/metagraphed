// Every lakehouse table this repo READS must be snapshotted (#11008).
//
// `scripts/refresh-lakehouse-schema.ts` snapshots "every `chain.*` table this
// repo READS, not every table the catalog holds", and its own list carries the
// rule: "add one here the moment a reader does". `subnet_snapshots` was named
// among the tables nothing reads while `src/neuron-daily-cold-tier.ts` was
// joining it -- and not incidentally, since the join prices stake and emission
// in TAO through `s.tao_in_pool_tao / s.alpha_in_pool`. Three columns behind a
// published figure had no snapshot, no generated tuple, no Zod schema and no
// drift coverage.
//
// The rule was right. It was a COMMENT, so nothing checked it. This is the
// same rule, derived from the source both sides already have: the tables named
// in SQL, against the tables named in the list.
//
// Reads the SQL rather than the catalog, deliberately. Asking the catalog what
// exists would report the ten tables other producers write and this repo never
// touches, which is the noise the list exists to exclude.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib.ts";
import { sourceFiles } from "./validate-untyped-db-reads.ts";
import { TABLES } from "./refresh-lakehouse-schema.ts";

/**
 * Every `chain.<table>` a statement in this repo names.
 *
 * Both spellings, because both are in use: the `chainTable("x", network)`
 * helper and a literal `${NAMESPACE}.x` in a hand-written JOIN -- and it was
 * the literal one that escaped. Comments are stripped first: this file's own
 * prose names the tables it is about, and a gate that failed on its own
 * documentation would be fixed by deleting the documentation.
 */
export function tablesReadInSql(files: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Anchored on FROM/JOIN, not on a bare `chain.`: the first draft matched
    // `https://archive.chain.opentensor.ai` and reported `chain.opentensor` as
    // an unsnapshotted table. A hostname is not a table, and a gate that cries
    // wolf on one gets muted.
    for (const match of text.matchAll(
      /chainTable\(\s*["']([a-z_]+)["']|\b(?:FROM|JOIN)\s+(?:\$\{NAMESPACE\}|chain)\.([a-z_]+)/gi,
    )) {
      const table = match[1] ?? match[2];
      if (!table) continue;
      const rel = path.relative(repoRoot, file).split(path.sep).join("/");
      if (!found.has(table)) found.set(table, rel);
    }
  }
  return found;
}

function main(): void {
  const files = sourceFiles(["src", "workers"], repoRoot);
  const read = tablesReadInSql(files);
  const declared = new Set<string>(TABLES);
  const missing = [...read.entries()].filter(([t]) => !declared.has(t));
  if (missing.length > 0) {
    process.stderr.write(
      `lakehouse-readers: ${missing.length} table(s) read but not snapshotted:\n` +
        missing.map(([t, f]) => `  chain.${t} — read by ${f}`).join("\n") +
        `\n\nAdd them to TABLES in scripts/refresh-lakehouse-schema.ts and re-run\n` +
        `\`npm run refresh:lakehouse-schema\`. A table read without a snapshot has\n` +
        `no generated type, no Zod schema and no drift coverage.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `lakehouse-readers: ${read.size} table(s) read across ${files.length} file(s), ` +
      `all snapshotted.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
