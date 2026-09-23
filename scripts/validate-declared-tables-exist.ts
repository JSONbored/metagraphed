// Verify every declared D1 table/view against the physical snapshot checked
// by d1-maintenance. The frozen logical column contract cannot prove that
// deployed SQLite objects exist. A missing object must fail even if its
// migration name was recorded as applied.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import type { SchemaObject } from "./snapshot-d1-schema.ts";

/** `CREATE TABLE/VIEW [IF NOT EXISTS] <name>` across D1 migrations. */
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
      /CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-z_][a-z0-9_]*)["`]?/gi,
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
    readFileSync(path.join(repoRoot, "generated/db/d1-schema.json"), "utf8"),
  ) as SchemaObject[];
  const live = new Set(
    snapshot
      .filter((object) => object.type === "table" || object.type === "view")
      .map((object) => object.name.toLowerCase()),
  );
  if (live.size === 0) {
    console.error(
      "the schema snapshot names no tables -- this check would pass on an " +
        "empty file, which is exactly the silence it exists to break.",
    );
    process.exit(1);
  }
  const migrations = tablesInMigrations(path.join(repoRoot, "migrations/d1"));
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
        "\n\nEither the migration never applied -- check the d1-maintenance " +
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
