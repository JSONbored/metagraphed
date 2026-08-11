// Every table the repo DECLARES must actually exist in Neon.
//
// THE GAP THIS CLOSES. A table reaches production through four independent
// steps: a file in `migrations/neon/`, an entry in three wrangler configs, a
// set in `src/read-store-tables.ts`, and an actual `CREATE TABLE` having run.
// Only the last one makes the table exist, and nothing checked it. A lane can
// be fully wired -- migration written, tables declared sole-store, loader
// reading them -- against a table that was never created, and every read comes
// back empty. Which is indistinguishable from a table that exists and is empty.
//
// That is the same shape as #10566 and #10680: a correct-looking answer
// standing in for a read that never happened.
//
// ## Why this runs where it does
//
// Against the LIVE schema, in `.github/workflows/refresh-neon-schema.yml`,
// immediately after that workflow re-snapshots Neon. Not in `npm run validate`:
// a PR that adds a migration legitimately has a snapshot without its table yet,
// so a per-PR gate would fail on correct work. Here the snapshot is seconds old
// and any absence is real.
//
// It also catches #9867's class from the other side: a migration recorded as
// applied whose DDL never took.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

export interface ColumnRow {
  table: string;
}

/** `CREATE TABLE [IF NOT EXISTS] <name>` across every migration. */
export function tablesInMigrations(dir: string): Map<string, string> {
  const byTable = new Map<string, string>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    // Comments first: several migrations discuss tables they do not create,
    // and a scanner that read prose would demand tables nobody declared.
    const code = sql
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*--.*$/gm, " ");
    for (const m of code.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-z_][a-z0-9_]*)["`]?/gi,
    )) {
      const table = m[1]!.toLowerCase();
      if (!byTable.has(table)) byTable.set(table, file);
    }
  }
  return byTable;
}

/** Every table named by a `*_TABLES` constant, with the constant that names it. */
export function tablesInReadStoreSets(source: string): Map<string, string> {
  const byTable = new Map<string, string>();
  for (const m of source.matchAll(
    /export const ([A-Z0-9_]+_TABLES)\s*=\s*\[([^\]]*)\]/g,
  )) {
    const constant = m[1]!;
    for (const t of m[2]!.matchAll(/"([a-z_][a-z0-9_]*)"/g)) {
      const table = t[1]!;
      if (!byTable.has(table)) byTable.set(table, constant);
    }
  }
  return byTable;
}

export interface Missing {
  table: string;
  declaredBy: string;
  source: "migration" | "read-store-tables";
}

export function findMissing(
  live: Set<string>,
  migrations: Map<string, string>,
  readSets: Map<string, string>,
): Missing[] {
  const out: Missing[] = [];
  for (const [table, file] of migrations) {
    if (!live.has(table)) {
      out.push({ table, declaredBy: file, source: "migration" });
    }
  }
  for (const [table, constant] of readSets) {
    // Only report a table once: a missing table declared in both places is one
    // problem, and listing it twice makes the report look worse than it is.
    if (!live.has(table) && !migrations.has(table)) {
      out.push({ table, declaredBy: constant, source: "read-store-tables" });
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

function main(): void {
  const snapshot = JSON.parse(
    readFileSync(path.join(repoRoot, "generated/db/schema.json"), "utf8"),
  ) as ColumnRow[];
  const live = new Set(snapshot.map((c) => String(c.table).toLowerCase()));
  if (live.size === 0) {
    console.error(
      "the schema snapshot names no tables -- this check would pass on an " +
        "empty file, which is exactly the silence it exists to break.",
    );
    process.exit(1);
  }
  const migrations = tablesInMigrations(path.join(repoRoot, "migrations/neon"));
  const readSets = tablesInReadStoreSets(
    readFileSync(path.join(repoRoot, "src/read-store-tables.ts"), "utf8"),
  );
  const missing = findMissing(live, migrations, readSets);
  if (missing.length > 0) {
    console.error(
      `${missing.length} declared table(s) do not exist in the live schema:\n` +
        missing
          .map((m) => `  - ${m.table} (declared by ${m.declaredBy})`)
          .join("\n") +
        "\n\nEither the migration never applied -- check the neon-migrate " +
        "workflow, and see #9867 for how a file can be recorded as applied " +
        "while its DDL failed -- or the table was renamed without its " +
        "declarations following.",
    );
    process.exit(1);
  }
  console.log(
    `every declared table exists (${migrations.size} from migrations, ` +
      `${readSets.size} named by read-store sets, ${live.size} live).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
