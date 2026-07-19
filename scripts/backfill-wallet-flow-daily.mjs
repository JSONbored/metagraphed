// One-off (idempotent, safe to re-run) historical backfill of Postgres's
// wallet_flow_daily rollup (#6886/#6887) for the range before this table
// existed. Unlike scripts/backfill-account-events-daily-postgres.mjs (which
// copies frozen D1 rows for a gap Postgres itself can no longer recompute),
// this table has no prior D1 equivalent and no gap in its source: account_events
// has been the live, continuously-written Postgres record of every StakeAdded/
// StakeRemoved event since indexer-rs started, so this recomputes directly
// from that table -- no cross-database copy, no wrangler/D1 dependency.
//
// One INSERT...SELECT...GROUP BY covering the whole [--from, --to) range (not
// a day-by-day loop like the forward rollup, which only ever re-rolls the
// active UTC day(s) and has no reason to batch) -- Postgres groups by
// (coldkey, day) itself. ON CONFLICT keeps this safe to re-run over a range
// that overlaps what the forward rollup (workers/data-api.mjs's
// handleRollupAccountEventsDaily) has already covered.
//
// Usage:
//   node scripts/backfill-wallet-flow-daily.mjs --from YYYY-MM-DD --to YYYY-MM-DD [options]
//
//   --from YYYY-MM-DD    first UTC day to backfill, inclusive (required)
//   --to YYYY-MM-DD      last UTC day to backfill, exclusive upper bound is
//                        --to + 1 day (i.e. --to itself is included whole)
//   --database-url URL   Postgres connection string (default: $DATABASE_URL)
//   --dry-run            print the row count that would be written; touches nothing
import path from "node:path";
import {
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../src/chain-stake-flow.mjs";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseArgs(argv) {
  const opts = {
    from: null,
    to: null,
    databaseUrl: process.env.DATABASE_URL || "",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--from") opts.from = argv[++i];
    else if (arg === "--to") opts.to = argv[++i];
    else if (arg === "--database-url") opts.databaseUrl = argv[++i];
    else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return opts;
}

export function assertValidOptions(opts) {
  if (!opts.from || !opts.to) {
    throw new Error("--from and --to are required (YYYY-MM-DD)");
  }
  if (!DAY_PATTERN.test(opts.from) || !DAY_PATTERN.test(opts.to)) {
    throw new Error("--from/--to must be YYYY-MM-DD");
  }
  if (opts.from > opts.to) {
    throw new Error(
      `--from (${opts.from}) must not be after --to (${opts.to})`,
    );
  }
  if (!opts.databaseUrl) {
    throw new Error(
      "DATABASE_URL required (or pass --database-url) -- refusing to guess a connection target",
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  assertValidOptions(opts);

  const fromMs = Date.parse(`${opts.from}T00:00:00.000Z`);
  // Exclusive upper bound: the day AFTER --to, so --to's own full UTC day is included.
  const toMs = Date.parse(`${opts.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  const runAt = Date.now();

  const { default: postgres } = await import("postgres");
  const sql = postgres(opts.databaseUrl, {
    max: 1,
    prepare: false,
    fetch_types: false,
  });

  try {
    if (opts.dryRun) {
      const [{ n }] = await sql`
        SELECT COUNT(DISTINCT (coldkey, to_timestamp(observed_at / 1000.0)::date)) AS n
        FROM account_events
        WHERE coldkey IS NOT NULL AND event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND})
          AND observed_at >= ${fromMs} AND observed_at < ${toMs}`;
      console.log(
        `[dry-run] would upsert ${n} wallet_flow_daily row(s) for ${opts.from}..${opts.to}`,
      );
      return;
    }

    const result = await sql`
      INSERT INTO wallet_flow_daily (coldkey, day, net_flow_tao, gross_in_tao, gross_out_tao, updated_at)
      SELECT
        coldkey,
        to_timestamp(observed_at / 1000.0)::date AS day,
        COALESCE(SUM(CASE WHEN event_kind = ${STAKE_ADDED_KIND} THEN amount_tao WHEN event_kind = ${STAKE_REMOVED_KIND} THEN -amount_tao ELSE 0 END), 0) AS net_flow_tao,
        COALESCE(SUM(CASE WHEN event_kind = ${STAKE_ADDED_KIND} THEN amount_tao ELSE 0 END), 0) AS gross_in_tao,
        COALESCE(SUM(CASE WHEN event_kind = ${STAKE_REMOVED_KIND} THEN amount_tao ELSE 0 END), 0) AS gross_out_tao,
        ${runAt} AS updated_at
      FROM account_events
      WHERE coldkey IS NOT NULL AND event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND})
        AND observed_at >= ${fromMs} AND observed_at < ${toMs}
      GROUP BY (coldkey), to_timestamp(observed_at / 1000.0)::date
      ON CONFLICT (coldkey, day) DO UPDATE SET
        net_flow_tao = EXCLUDED.net_flow_tao,
        gross_in_tao = EXCLUDED.gross_in_tao,
        gross_out_tao = EXCLUDED.gross_out_tao,
        updated_at = EXCLUDED.updated_at`;
    console.log(
      `Upserted ${result.count} wallet_flow_daily row(s) for ${opts.from}..${opts.to}.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  await main();
}
