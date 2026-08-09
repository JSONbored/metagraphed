// Re-read the live Neon schema into the two committed artifacts (#10261).
//
// The half of the db-types pipeline that needs credentials, split out for
// exactly that reason: `scripts/generate-db-types.ts` is pure, so
// `validate:db-types-drift` can regenerate and diff on any runner in
// milliseconds, while this script runs out of band against a real branch. No
// database in CI -- that is what made the old pipeline slow.
//
// TWO ARTIFACTS, ONE READ:
//
//   db/schema.sql              a pg_dump the way the repo used to carry one.
//                              For a HUMAN: a column added or retyped shows up
//                              as a diff in review, with its constraints,
//                              defaults and indexes.
//   generated/db/schema.json   the same schema as data, for the type generator.
//                              Deterministic and sorted, so CI can regenerate
//                              from it without parsing SQL.
//
// WHAT IT PROVES that the drift gate cannot. The gate compares the committed
// types to the committed snapshot -- it catches a hand-edit and nothing else.
// Only this script can catch the case that matters: production grew, dropped or
// retyped a column and both committed files still describe yesterday's
// database.
//
// A DIFF IS A FAILURE, not a fix. Without `--write` the script prints what
// changed and exits non-zero, because a snapshot that silently followed
// production would turn a dropped column into a green build.
//
// THIS IS NOT A RUNTIME PATH TO NEON, and it is the only place in the repo that
// connects to one directly. Every Worker reaches Neon through HYPERDRIVE, which
// holds the pool across Cloudflare's network -- see src/pg-sql.ts's header for
// why stacking a second driver on that is wrong. This is a build/ops tool that
// runs on a schedule, off the request path, and nothing under `src/` or
// `workers/` gains a direct connection from it.
//
// THE CONNECTION STRING NEVER ENTERS THE REPO. It is read from
// `NEON_DATABASE_URL` at run time and passed straight to the driver; it is not
// written to either artifact, not echoed, and not defaulted to anything. A dump
// taken with `--no-owner --no-privileges` carries no role, grant or password
// either, and `npm run scan:public-safety` reads `db/schema.sql` like every
// other committed file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { repoRoot } from "./lib.ts";
import { SNAPSHOT_PATH, type ColumnSnapshot } from "./generate-db-types.ts";

const CONNECTION_ENV = "NEON_DATABASE_URL";
export const SCHEMA_SQL_PATH = "db/schema.sql";

/**
 * `pg_dump` REFUSES A SERVER NEWER THAN ITSELF, and Neon runs 18.4 -- a 17
 * client aborts with "server version mismatch". So the binary is resolved
 * explicitly and its absence is an error with the fix in it, rather than a
 * dump silently taken by whatever `pg_dump` is first on PATH.
 */
const PG_DUMP_CANDIDATES = [
  process.env.PG_DUMP_BIN,
  "/opt/homebrew/opt/postgresql@18/bin/pg_dump",
  "/usr/lib/postgresql/18/bin/pg_dump",
  "/usr/pgsql-18/bin/pg_dump",
].filter((candidate): candidate is string => Boolean(candidate));

function resolvePgDump(): string {
  for (const candidate of PG_DUMP_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `no pg_dump 18 found (looked at ${PG_DUMP_CANDIDATES.join(", ")}). Neon runs Postgres 18 and pg_dump refuses a newer server, so a 17 client cannot take this dump. Install postgresql@18 or set PG_DUMP_BIN.`,
  );
}

/**
 * Strip everything about a dump that changes between two dumps of the SAME
 * schema.
 *
 * pg_dump 18 opens with `\restrict <random>` and closes with the matching
 * `\unrestrict`, and the token is a fresh nonce every run -- so an unnormalised
 * dump differs from itself, and a gate over it would fail on every invocation
 * while proving nothing. The version banner carries the server's build hash and
 * the client's build, which move when Neon upgrades or a contributor's Homebrew
 * does; neither is a schema change.
 */
export function normalizeDump(dump: string): string {
  return dump
    .split("\n")
    .filter(
      (line) =>
        !/^\\(un)?restrict\s/.test(line) &&
        !/^-- Dumped (from|by)\b/.test(line),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n");
}

export function dumpSchema(connectionString: string): string {
  const stdout = execFileSync(
    resolvePgDump(),
    [
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
      "--schema=public",
      connectionString,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return normalizeDump(stdout);
}

const COLUMNS_SQL = `
  SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
  ORDER BY c.table_name, c.column_name
`;

export async function readLiveColumns(
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
    }>(COLUMNS_SQL);
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
      `snapshot-neon-schema: ${CONNECTION_ENV} is unset. This script reads a live branch; the gate that runs without credentials is validate:db-types-drift.`,
    );
    process.exit(1);
  }
  const write = process.argv.includes("--write");
  const columnsPath = path.join(repoRoot, SNAPSHOT_PATH);
  const sqlPath = path.join(repoRoot, SCHEMA_SQL_PATH);

  const live = await readLiveColumns(connectionString);
  const liveSql = dumpSchema(connectionString);
  const committed = JSON.parse(
    readFileSync(columnsPath, "utf8"),
  ) as ColumnSnapshot[];
  const committedSql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf8") : "";

  const differences = snapshotDiff(committed, live);
  const sqlChanged = committedSql !== liveSql;

  if (differences.length === 0 && !sqlChanged) {
    console.log(
      `snapshot-neon-schema: both artifacts match the live schema (${live.length} column(s) across ${new Set(live.map((c) => c.table)).size} table(s)).`,
    );
    process.exit(0);
  }

  if (write) {
    mkdirSync(path.dirname(columnsPath), { recursive: true });
    mkdirSync(path.dirname(sqlPath), { recursive: true });
    writeFileSync(columnsPath, `${JSON.stringify(live, null, 2)}\n`);
    writeFileSync(sqlPath, liveSql);
    console.log(
      `snapshot-neon-schema: rewrote ${SNAPSHOT_PATH} and ${SCHEMA_SQL_PATH} (${differences.length} column change(s)${sqlChanged ? ", DDL changed" : ""}). Run \`npm run build:db-types\` and commit all three.`,
    );
    process.exit(0);
  }

  console.error(
    `snapshot-neon-schema: the live schema has moved. Re-run with --write, regenerate the types and commit all three:`,
  );
  for (const line of differences) console.error(`  ${line}`);
  if (sqlChanged && differences.length === 0) {
    console.error(
      `  (no column changed -- ${SCHEMA_SQL_PATH} differs in a constraint, default or index)`,
    );
  }
  process.exit(1);
}
