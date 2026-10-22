// Physical D1 schema drift, separate from generated/db/schema.json's logical
// row contract. JSON-backed views do not expose their logical numeric types
// through SQLite introspection, so replacing that contract would lose types.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import { d1AdminBatch } from "./lib/d1-admin.ts";
import {
  assertRecordedD1Migrations,
  assertTrackedD1Migrations,
  d1SchemaVerificationFailure,
} from "./lib/d1-migration-ledger.ts";

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

const SQL_PATH = "db/d1-schema.sql";
const JSON_PATH = "generated/db/d1-schema.json";
const MIGRATION_NAME = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function schemaArtifacts(schema: SchemaObject[]) {
  return {
    json: JSON.stringify(schema, null, 2) + "\n",
    sql: schema.map((row) => row.sql + ";").join("\n\n") + "\n",
  };
}

function writeSchema(schema: SchemaObject[], root: string): void {
  const artifacts = schemaArtifacts(schema);
  for (const [name, content] of [
    [JSON_PATH, artifacts.json],
    [SQL_PATH, artifacts.sql],
  ]) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * Expected DDL only. Restore the reviewed physical snapshot in native SQLite,
 * apply only the explicitly selected repository migrations, and use the same
 * serializer as live readback. No credentials, D1 calls, or deployment claims.
 */
export async function projectD1Schema(
  migrations: readonly string[],
  write: boolean,
  root = repoRoot,
) {
  if (
    !migrations.length ||
    migrations.length > 10 ||
    migrations.some((name) => !MIGRATION_NAME.test(name)) ||
    new Set(migrations).size !== migrations.length ||
    migrations.join(",") !== [...migrations].sort().join(",")
  )
    throw new Error(
      "Explicit, unique, ordered D1 migration filenames are required",
    );
  assertTrackedD1Migrations(migrations);
  const migrationRoot = realpathSync(path.join(root, "migrations/d1"));
  const selected = migrations.map((name) => {
    const filename = path.join(migrationRoot, name);
    if (realpathSync(filename) !== filename)
      throw new Error(
        "Projected D1 migrations must be regular repository files",
      );
    return { name, sql: readFileSync(filename, "utf8") };
  });
  const baselineSql = readFileSync(path.join(root, SQL_PATH), "utf8");
  const baselineJson = readFileSync(path.join(root, JSON_PATH), "utf8");
  const rows: unknown = JSON.parse(baselineJson);
  if (!Array.isArray(rows))
    throw new Error("D1 baseline must be a schema array");
  const baseline = normalizeSchema(
    rows.map((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("D1 baseline contained an invalid object");
      return row as Record<string, unknown>;
    }),
  );
  const canonicalBaseline = schemaArtifacts(baseline);
  if (
    !baseline.length ||
    canonicalBaseline.sql !== baselineSql ||
    canonicalBaseline.json !== baselineJson
  )
    throw new Error("D1 baseline SQL and JSON snapshots must match");

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    // Snapshot serialization sorts by type/name, putting indexes before their
    // tables. Restore dependencies first; views may refer forward to views.
    const order: Record<string, number> = {
      table: 0,
      view: 1,
      index: 2,
      trigger: 3,
    };
    for (const object of [...baseline].sort(
      (a, b) => order[a.type]! - order[b.type]!,
    ))
      database.exec(object.sql);
    const inspect = () =>
      normalizeSchema(database.prepare(D1_SCHEMA_SQL).all());
    if (schemaChanges(baseline, inspect()).length)
      throw new Error("Native SQLite did not restore the reviewed D1 baseline");
    database.exec("BEGIN");
    for (const migration of selected) database.exec(migration.sql);
    database.exec("COMMIT");
    const schema = inspect();
    const artifacts = schemaArtifacts(schema);
    if (write) writeSchema(schema, root);
    return {
      mode: "expected-postmigration",
      live_readback: false,
      written: write,
      baseline_sha256: {
        [SQL_PATH]: hash(baselineSql),
        [JSON_PATH]: hash(baselineJson),
      },
      migrations: selected.map(({ name, sql }) => ({
        name,
        sha256: hash(sql),
      })),
      changed_objects: schemaChanges(baseline, schema),
      output_sha256: {
        [SQL_PATH]: hash(artifacts.sql),
        [JSON_PATH]: hash(artifacts.json),
      },
    };
  } finally {
    database.close();
  }
}
/** Verify recorded filenames only; the physical snapshot checks DDL separately. */
export async function verifyD1MigrationLedger(
  batch = d1AdminBatch,
  root = repoRoot,
): Promise<void> {
  const files = readdirSync(path.join(root, "migrations/d1"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assertTrackedD1Migrations(files);
  // One extra row detects an untracked successor without scanning its history.
  const result = await batch([
    {
      sql: "SELECT name FROM d1_migrations ORDER BY name LIMIT ?",
      params: [String(files.length + 1)],
    },
  ]);
  assertRecordedD1Migrations(files, result[0]?.results);
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
  const jsonPath = path.join(root, JSON_PATH);
  const sqlPath = path.join(root, SQL_PATH);
  const { sql } = schemaArtifacts(schema);
  const before = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, "utf8")) as SchemaObject[])
    : [];
  if (write) {
    writeSchema(schema, root);
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
  const project = args[0] === "--project-migrations";
  if (
    project
      ? !args[1] ||
        args.length > 3 ||
        (args[2] !== undefined && args[2] !== "--write")
      : args.some((arg) => !["--write", "--verify-ledger"].includes(arg)) ||
        (args.includes("--write") && args.includes("--verify-ledger"))
  )
    throw new Error(
      "Use --write, --verify-ledger, or --project-migrations filename.sql[,filename.sql] [--write] separately",
    );
  const verify = async () => {
    if (project) {
      console.log(
        JSON.stringify(
          await projectD1Schema(args[1]!.split(","), args.includes("--write")),
        ),
      );
      return;
    }
    if (args.includes("--verify-ledger")) await verifyD1MigrationLedger();
    await snapshotD1Schema(args.includes("--write"));
  };
  verify().catch((error: unknown) => {
    const failure = project
      ? "D1 expected schema projection failed (unclassified)"
      : d1SchemaVerificationFailure(error);
    // Only the fixed classifier enters workflow metadata, never raw errors.
    console.error(
      process.env.GITHUB_ACTIONS === "true" ? `::error::${failure}` : failure,
    );
    process.exitCode = 1;
  });
}
