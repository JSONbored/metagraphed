// Re-read the live Neon schema into the committed snapshot (#10261).
//
// The half of the db-types pipeline that needs credentials, split out for
// exactly that reason: `scripts/generate-db-types.ts` is pure, so
// `validate:db-types-drift` can regenerate and diff on any runner, while this
// script runs out of band against a real branch.
//
// WHAT IT PROVES that the drift gate cannot. The gate compares the committed
// types to the committed snapshot -- it catches a hand-edit and nothing else.
// Only this script can catch the case that matters: production grew, dropped or
// retyped a column and the snapshot still describes yesterday's database. The
// old kanel pipeline got that for free from `deploy/postgres/schema.sql`, a file
// this repo edited; the snapshot is generated, so it has to be re-read.
//
// A DIFF IS A FAILURE, not a fix. The script writes nothing: it prints what
// changed and exits non-zero, because a snapshot that silently follows
// production would turn a dropped column into a green build.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { repoRoot } from "./lib.ts";
import { SNAPSHOT_PATH, type ColumnSnapshot } from "./generate-db-types.ts";

const CONNECTION_ENV = "NEON_DATABASE_URL";

const QUERY = `
  SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
  ORDER BY c.table_name, c.column_name
`;

export async function readLiveSchema(
  connectionString: string,
): Promise<ColumnSnapshot[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: string;
    }>(QUERY);
    return rows.map((row) => ({
      table: row.table_name,
      column: row.column_name,
      udt: row.udt_name,
      nullable: row.is_nullable === "YES",
    }));
  } finally {
    await client.end();
  }
}

/** Every column that appears on one side and not the other, or differs. */
export function snapshotDiff(
  committed: ColumnSnapshot[],
  live: ColumnSnapshot[],
): string[] {
  const key = (column: ColumnSnapshot) => `${column.table}.${column.column}`;
  const committedByKey = new Map(committed.map((c) => [key(c), c]));
  const liveByKey = new Map(live.map((c) => [key(c), c]));
  const differences: string[] = [];
  for (const [name, column] of liveByKey) {
    const previous = committedByKey.get(name);
    if (!previous) {
      differences.push(
        `+ ${name} ${column.udt}${column.nullable ? " null" : ""}`,
      );
      continue;
    }
    if (previous.udt !== column.udt) {
      differences.push(`~ ${name} ${previous.udt} -> ${column.udt}`);
    }
    if (previous.nullable !== column.nullable) {
      differences.push(
        `~ ${name} ${previous.nullable ? "nullable" : "not null"} -> ${column.nullable ? "nullable" : "not null"}`,
      );
    }
  }
  for (const name of committedByKey.keys()) {
    if (!liveByKey.has(name)) differences.push(`- ${name}`);
  }
  return differences.sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const connectionString = process.env[CONNECTION_ENV];
  if (!connectionString) {
    console.error(
      `snapshot-neon-schema: ${CONNECTION_ENV} is unset. This script reads a live branch; the drift gate that runs without credentials is validate:db-types-drift.`,
    );
    process.exit(1);
  }
  const committed = JSON.parse(
    readFileSync(path.join(repoRoot, SNAPSHOT_PATH), "utf8"),
  ) as ColumnSnapshot[];
  const live = await readLiveSchema(connectionString);
  const differences = snapshotDiff(committed, live);
  if (differences.length === 0) {
    console.log(
      `snapshot-neon-schema: ${SNAPSHOT_PATH} matches the live schema (${live.length} column(s) across ${new Set(live.map((c) => c.table)).size} table(s)).`,
    );
    process.exit(0);
  }
  if (process.argv.includes("--write")) {
    writeFileSync(
      path.join(repoRoot, SNAPSHOT_PATH),
      `${JSON.stringify(live, null, 2)}\n`,
    );
    console.log(
      `snapshot-neon-schema: rewrote ${SNAPSHOT_PATH} (${differences.length} change(s)). Run \`npm run build:db-types\` and commit both.`,
    );
    process.exit(0);
  }
  console.error(
    `snapshot-neon-schema: the live schema has moved -- ${differences.length} difference(s). Re-run with --write, regenerate the types and commit both:`,
  );
  for (const line of differences) console.error(`  ${line}`);
  process.exit(1);
}
