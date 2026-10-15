// Physical D1 schema drift, separate from generated/db/schema.json's logical
// row contract. JSON-backed views do not expose their logical numeric types
// through SQLite introspection, so replacing that contract would lose types.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import { d1AdminBatch } from "./lib/d1-admin.ts";
import { migrationSequenceErrors } from "./validate-migrations.ts";

export interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}
export const D1_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
export function normalizeSchema(
  rows: Record<string, unknown>[],
): SchemaObject[] {
  return rows
    .filter((row) => !String(row.name).startsWith("_cf_"))
    .map((row) => {
      if (
        !["table", "view", "index", "trigger"].includes(String(row.type)) ||
        [row.name, row.tbl_name, row.sql].some(
          (value) => typeof value !== "string" || !value,
        )
      )
        throw new Error("D1 schema contained an invalid object");
      return {
        type: String(row.type),
        name: String(row.name),
        tbl_name: String(row.tbl_name),
        sql: String(row.sql)
          .split("\n")
          .map((line) => line.trimEnd())
          .join("\n")
          .trim()
          .replace(/;$/, ""),
      };
    })
    .sort(
      (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
    );
}
export function schemaChanges(
  before: SchemaObject[],
  after: SchemaObject[],
): string[] {
  const old = new Map(before.map((row) => [row.name, row]));
  const current = new Map(after.map((row) => [row.name, row]));
  return [...new Set([...old.keys(), ...current.keys()])]
    .sort()
    .filter(
      (name) =>
        JSON.stringify(old.get(name)) !== JSON.stringify(current.get(name)),
    );
}
/** Verify recorded filenames only; the physical snapshot checks DDL separately. */
export async function verifyD1MigrationLedger(
  batch = d1AdminBatch,
  root = repoRoot,
): Promise<void> {
  const files = readdirSync(path.join(root, "migrations/d1"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (!files.length || migrationSequenceErrors(files).length)
    throw new Error("Tracked D1 migrations are empty or invalid");
  // One extra row detects an untracked successor without scanning its history.
  const result = await batch([
    {
      sql: "SELECT name FROM d1_migrations ORDER BY name LIMIT ?",
      params: [String(files.length + 1)],
    },
  ]);
  const rows = result[0]?.results;
  if (!rows) throw new Error("D1 migration ledger response is unavailable");
  const names = rows.map((row) => row.name);
  if (
    names.some((name) => typeof name !== "string") ||
    migrationSequenceErrors(names as string[]).length
  )
    throw new Error("D1 migration ledger contains invalid or duplicate names");
  const recorded = new Set(names);
  const tracked = new Set(files);
  const missing = files.filter((file) => !recorded.has(file));
  const extra = names.filter((name) => !tracked.has(name as string));
  if (missing.length || extra.length)
    throw new Error(
      `D1 migration ledger differs: ${missing.length} missing, ${extra.length} untracked. No migrations were applied.`,
    );
  console.log(`D1 migration ledger verified: ${files.length} recorded files`);
}
export async function snapshotD1Schema(
  write: boolean,
  batch = d1AdminBatch,
  root = repoRoot,
): Promise<void> {
  const result = await batch([{ sql: D1_SCHEMA_SQL }]);
  const schema = normalizeSchema(result[0]!.results);
  if (!schema.length)
    throw new Error("D1 schema is empty; refusing a snapshot");
  const jsonPath = path.join(root, "generated/db/d1-schema.json");
  const sqlPath = path.join(root, "db/d1-schema.sql");
  const json = JSON.stringify(schema, null, 2) + "\n";
  const sql = schema.map((row) => row.sql + ";").join("\n\n") + "\n";
  const before = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, "utf8")) as SchemaObject[])
    : [];
  if (write) {
    mkdirSync(path.dirname(jsonPath), { recursive: true });
    mkdirSync(path.dirname(sqlPath), { recursive: true });
    writeFileSync(jsonPath, json);
    writeFileSync(sqlPath, sql);
    console.log(`D1 physical schema captured: ${schema.length} objects`);
    return;
  }
  const changes = schemaChanges(before, schema);
  if (
    changes.length ||
    !existsSync(sqlPath) ||
    readFileSync(sqlPath, "utf8") !== sql
  )
    throw new Error(
      `D1 physical schema drift: ${changes.join(", ") || "SQL snapshot differs"}. Review snapshot:d1-schema -- --write output in a pull request.`,
    );
  console.log(`D1 physical schema verified: ${schema.length} objects`);
}
if (process.argv[1]?.endsWith("snapshot-d1-schema.ts")) {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !["--write", "--verify-ledger"].includes(arg)) ||
    (args.includes("--write") && args.includes("--verify-ledger"))
  )
    throw new Error("Use --write or --verify-ledger separately");
  const verify = async () => {
    if (args.includes("--verify-ledger")) await verifyD1MigrationLedger();
    await snapshotD1Schema(args.includes("--write"));
  };
  verify().catch(() => {
    console.error(
      "D1 schema verification failed; run the credentialed snapshot command and review its diff",
    );
    process.exitCode = 1;
  });
}
