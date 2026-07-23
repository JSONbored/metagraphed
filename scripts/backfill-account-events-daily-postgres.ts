// One-time (idempotent, safe to re-run) backfill of Postgres's
// account_events_daily rollup for the gap before Postgres's own hourly
// rollup cron (workers/data-api.mjs's handleRollupAccountEventsDaily,
// dispatched by the ACCOUNT_EVENTS_ROLLUP_CRON Worker-native cron --
// formerly a dedicated GitHub Actions workflow, retired) started
// writing on 2026-07-10. Commit 4c3dbbfe ("retire D1 chain-data write
// path", #4772) removed the D1-side rollup call that used to cover this
// range, and METAGRAPH_ACCOUNT_EVENTS_SOURCE has no date-aware fallback --
// so today Postgres silently serves zero /accounts/:ss58/history days for
// 2026-06-22 through 2026-07-09 with no error.
//
// Why this copies D1's frozen precomputed rows instead of recomputing from
// Postgres's own raw `account_events` table: verified directly (via psql)
// that Postgres's raw account_events has real multi-day/multi-hour gaps
// across this exact window -- e.g. nothing at all between 2026-06-24 22:00
// UTC and 2026-06-27 07:00 UTC -- and, on days where rows ARE present,
// diverges sharply from D1's contemporaneous rollup: a fresh Postgres
// recompute of 2026-07-05 yields 6,173 hotkey/netuid pairs / 109,968 events
// vs. D1's precomputed 4,949 / 36,723 for the identical UTC day. That's
// almost certainly downstream of the Postgres-side historical reindex that
// ran during the D1->Postgres chain-indexer migration, which is NOT the
// same population D1's original hourly rollup captured live off the wire.
// D1's account_events_daily rows are the only surviving record of what was
// actually live at the time (D1's write path is now fully retired -- see
// migrations/*.sql), so this script copies them as-is rather than
// re-deriving a different, less trustworthy answer from raw data that
// wasn't complete/consistent for this window.
//
// Source: D1 (metagraphed-health)'s account_events_daily, read via
// `wrangler d1 execute --json` (shelled out -- this script carries no D1
// HTTP API credentials of its own).
// Destination: Postgres's account_events_daily (deploy/postgres/schema.sql),
// upserted on the exact same (hotkey, netuid, day) primary key +
// event_count/event_kinds/first_block/last_block/updated_at column set
// handleRollupAccountEventsDaily itself writes -- re-running this script is
// always safe and always converges on D1's exact numbers for the range.
//
// Refuses by default to touch any day >= POSTGRES_ROLLUP_LIVE_SINCE
// (2026-07-10, the day Postgres's own cron took over): Postgres's
// self-computed rows there are already complete and MORE accurate than
// D1's frozen numbers (D1's own last day, 2026-07-10, is a partial day --
// the D1 rollup call was removed mid-day by #4772, so D1 only has 1,846 of
// the 6,570 hotkey/netuid pairs Postgres itself later computed for that
// day). Pass --allow-live-day-overwrite to lift that guard.
//
// Usage:
//   node scripts/backfill-account-events-daily-postgres.ts [options]
//
//   --from YYYY-MM-DD         first UTC day to backfill, inclusive (default 2026-06-22)
//   --to YYYY-MM-DD           last UTC day to backfill, inclusive (default 2026-07-09)
//   --database NAME           D1 database name for `wrangler d1 execute` (default metagraphed-health)
//   --out FILE                where to write the idempotent upsert SQL (default .output/account-events-daily-backfill.sql)
//   --chunk-size N            rows per multi-row upsert statement (default 500)
//   --apply                   also connect directly to Postgres and run the upserts now
//   --database-url URL        Postgres connection string for --apply (default: $DATABASE_URL)
//   --allow-live-day-overwrite  lift the POSTGRES_ROLLUP_LIVE_SINCE guard above
//
// Without --apply this only writes a SQL file -- land it in production via
// the docker cp + psql -f pattern (printed at the end of a run), e.g.:
//   scp .output/account-events-daily-backfill.sql \
//     <indexer-ssh-target>:/tmp/account-events-daily-backfill.sql
//   ssh <indexer-ssh-target> \
//     "sudo -n docker cp /tmp/account-events-daily-backfill.sql <postgres-container>:/tmp/x.sql && \
//      sudo -n docker exec <postgres-container> psql -U <postgres-user> -d <postgres-database> -v ON_ERROR_STOP=1 -f /tmp/x.sql"
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./lib.ts";

type Row = Record<string, unknown>;

const TABLE = "account_events_daily";
const INSERT_COLUMNS = [
  "hotkey",
  "netuid",
  "day",
  "event_count",
  "event_kinds",
  "first_block",
  "last_block",
  "updated_at",
];
// The day Postgres's own hourly rollup cron started writing this table --
// see this file's header comment for why days on/after this are off-limits
// by default.
const POSTGRES_ROLLUP_LIVE_SINCE = "2026-07-10";
const DEFAULT_FROM = "2026-06-22";
const DEFAULT_TO = "2026-07-09";
const DEFAULT_D1_DATABASE = "metagraphed-health";
const DEFAULT_OUT = path.join(
  repoRoot,
  ".output/account-events-daily-backfill.sql",
);
const DEFAULT_CHUNK_SIZE = 500;
// The full 18-day gap is ~25MB of JSON over the wire -- generous headroom
// over that for a wrangler CLI stdout capture.
const WRANGLER_MAX_BUFFER_BYTES = 300 * 1024 * 1024;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface BackfillOptions {
  from: string;
  to: string;
  database: string;
  out: string;
  chunkSize: number;
  apply: boolean;
  databaseUrl: string;
  allowLiveDayOverwrite: boolean;
}

function parseArgs(argv: string[]): BackfillOptions {
  const opts: BackfillOptions = {
    from: DEFAULT_FROM,
    to: DEFAULT_TO,
    database: DEFAULT_D1_DATABASE,
    out: DEFAULT_OUT,
    chunkSize: DEFAULT_CHUNK_SIZE,
    apply: false,
    databaseUrl: process.env.DATABASE_URL || "",
    allowLiveDayOverwrite: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from":
        opts.from = argv[++i];
        break;
      case "--to":
        opts.to = argv[++i];
        break;
      case "--database":
        opts.database = argv[++i];
        break;
      case "--out":
        opts.out = path.resolve(argv[++i] ?? "");
        break;
      case "--chunk-size":
        opts.chunkSize = Number(argv[++i]);
        break;
      case "--apply":
        opts.apply = true;
        break;
      case "--database-url":
        opts.databaseUrl = argv[++i];
        break;
      case "--allow-live-day-overwrite":
        opts.allowLiveDayOverwrite = true;
        break;
      default:
        throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return opts;
}

function assertValidOptions(opts: BackfillOptions): void {
  if (!DAY_PATTERN.test(opts.from) || !DAY_PATTERN.test(opts.to)) {
    throw new Error("--from/--to must be YYYY-MM-DD");
  }
  if (opts.from > opts.to) {
    throw new Error(
      `--from (${opts.from}) must not be after --to (${opts.to})`,
    );
  }
  if (opts.to >= POSTGRES_ROLLUP_LIVE_SINCE && !opts.allowLiveDayOverwrite) {
    throw new Error(
      `--to (${opts.to}) reaches into Postgres's own live rollup range ` +
        `(>= ${POSTGRES_ROLLUP_LIVE_SINCE}); those rows are already ` +
        `complete/authoritative -- pass --allow-live-day-overwrite if you ` +
        `really mean to overwrite them with D1's frozen numbers.`,
    );
  }
  if (!opts.database) throw new Error("--database must not be empty");
  if (!Number.isInteger(opts.chunkSize) || opts.chunkSize < 1) {
    throw new Error("--chunk-size must be a positive integer");
  }
}

// Shells out to `wrangler d1 execute --json` (no shell interpolation --
// spawnSync passes argv directly to execve) rather than opening a D1 HTTP
// API connection of its own, matching how this repo's other one-off
// operational scripts read D1 (see the task-runner scripts under scripts/
// that already assume an authenticated `wrangler` in PATH).
function fetchD1Rows({
  database,
  from,
  to,
}: Pick<BackfillOptions, "database" | "from" | "to">): Row[] {
  const sql =
    `SELECT ${INSERT_COLUMNS.join(", ")} FROM ${TABLE} ` +
    `WHERE day >= '${from}' AND day <= '${to}' ORDER BY day, hotkey, netuid;`;
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--command",
      sql,
      "--json",
    ],
    {
      encoding: "utf8",
      maxBuffer: WRANGLER_MAX_BUFFER_BYTES,
      cwd: repoRoot,
    },
  );
  if (result.error) {
    throw new Error(`failed to spawn wrangler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  const first: Row = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first?.success) {
    throw new Error(`D1 query did not report success: ${result.stdout}`);
  }
  return (first.results as Row[]) || [];
}

function sqlString(value: unknown): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return sqlString(value);
}

function rowToTuple(row: Row): string {
  return `(${INSERT_COLUMNS.map((col) => sqlLiteral(row[col])).join(", ")})`;
}

// Mirrors handleRollupAccountEventsDaily's own ON CONFLICT clause
// (workers/data-api.mjs) exactly -- same columns, same upsert shape --
// just fed from D1's frozen rows instead of a fresh GROUP BY over
// Postgres's own account_events.
function buildUpsertStatements(rows: Row[], chunkSize: number): string[] {
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = chunk.map(rowToTuple).join(",\n  ");
    statements.push(
      `INSERT INTO ${TABLE} (${INSERT_COLUMNS.join(", ")})\n` +
        `VALUES\n  ${values}\n` +
        `ON CONFLICT (hotkey, netuid, day) DO UPDATE SET\n` +
        `  event_count = EXCLUDED.event_count,\n` +
        `  event_kinds = EXCLUDED.event_kinds,\n` +
        `  first_block = EXCLUDED.first_block,\n` +
        `  last_block = EXCLUDED.last_block,\n` +
        `  updated_at = EXCLUDED.updated_at;`,
    );
  }
  return statements;
}

async function writeSqlFile(
  rows: Row[],
  opts: BackfillOptions,
): Promise<number> {
  const statements = buildUpsertStatements(rows, opts.chunkSize);
  const contents =
    [
      `-- Idempotent backfill of Postgres ${TABLE} from D1's frozen`,
      `-- precomputed rows, range ${opts.from}..${opts.to} (${rows.length} row(s)).`,
      `-- Generated by scripts/backfill-account-events-daily-postgres.ts -- safe to re-run.`,
      `-- Run with: psql -v ON_ERROR_STOP=1 -f <this file>`,
    ].join("\n") +
    "\n\n" +
    statements.join("\n\n") +
    "\n";
  await mkdir(path.dirname(opts.out), { recursive: true });
  await writeFile(opts.out, contents, "utf8");
  return statements.length;
}

async function applyDirect(
  rows: Row[],
  opts: BackfillOptions,
): Promise<number> {
  if (!opts.databaseUrl) {
    throw new Error(
      "--apply requires --database-url or DATABASE_URL to be set",
    );
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(opts.databaseUrl, {
    max: 1,
    prepare: false,
    fetch_types: false,
  });
  try {
    let written = 0;
    for (let i = 0; i < rows.length; i += opts.chunkSize) {
      const chunk = rows.slice(i, i + opts.chunkSize);
      // TABLE is a fixed in-repo constant, never user input -- inlined
      // directly (matching handleRollupAccountEventsDaily's own literal
      // `INSERT INTO account_events_daily` in workers/data-api.mjs) rather
      // than routed through postgres.js's identifier helper.
      await sql`
        INSERT INTO account_events_daily ${sql(chunk, ...(INSERT_COLUMNS as ["hotkey", "netuid", "day", "event_count", "event_kinds", "first_block", "last_block", "updated_at"]))}
        ON CONFLICT (hotkey, netuid, day) DO UPDATE SET
          event_count = EXCLUDED.event_count,
          event_kinds = EXCLUDED.event_kinds,
          first_block = EXCLUDED.first_block,
          last_block = EXCLUDED.last_block,
          updated_at = EXCLUDED.updated_at`;
      written += chunk.length;
    }
    return written;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  assertValidOptions(opts);

  console.log(
    `fetching D1 ${TABLE} rows for ${opts.from}..${opts.to} from ${opts.database}`,
  );
  const rows = fetchD1Rows(opts);
  console.log(`fetched ${rows.length} row(s)`);

  if (rows.length === 0) {
    console.log("nothing to backfill for this range");
    return;
  }

  const statementCount = await writeSqlFile(rows, opts);
  console.log(`wrote ${statementCount} upsert statement(s) to ${opts.out}`);

  if (opts.apply) {
    const written = await applyDirect(rows, opts);
    console.log(`applied ${written} row(s) directly to Postgres`);
    return;
  }

  console.log(
    "land it in production via the docker cp + psql -f pattern, e.g.:\n" +
      `  scp ${opts.out} <indexer-ssh-target>:/tmp/account-events-daily-backfill.sql\n` +
      `  ssh <indexer-ssh-target> "sudo -n docker cp /tmp/account-events-daily-backfill.sql <postgres-container>:/tmp/x.sql && sudo -n docker exec <postgres-container> psql -U <postgres-user> -d <postgres-database> -v ON_ERROR_STOP=1 -f /tmp/x.sql"`,
  );
}

await main();
