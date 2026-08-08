// Apply pending migrations/neon/*.sql to Neon, once each, in order.
//
// WHY THIS EXISTS. `neuron_daily` and the six tables beside it were "created
// in Neon by hand", and that sentence is the whole problem: nothing in the
// repo said what their schema WAS, nothing re-applied it to a fresh branch,
// and the one written record of it -- a comment in wrangler.data.jsonc --
// had drifted to claim SMALLINT for columns that information_schema reports
// as BOOLEAN. A hand-applied schema is a schema nobody can verify.
//
// So the schema moves into the repo and this applies it. It is deliberately
// NOT a data lane: it runs on a merge to main, not on a timer, and the
// no-Actions rule this repo holds is about producers that write rows on a
// schedule -- a second writer racing the first. Applying DDL once per merge
// is the opposite of that, and doing it from a Worker cron would put DDL in a
// hot path and delay it to an arbitrary tick.
//
// ## Properties
//
// - TRACKED. `schema_migrations` records each filename. Re-running is a no-op,
//   which is what makes it safe to run on every push to main.
// - EACH MIGRATION MUST BE RE-RUNNABLE. The property above holds only while
//   every file is either recorded here or safe to apply twice, and #9867 is
//   what happens when neither is true: 0010's constraints were applied BY HAND
//   before this runner first saw the file, so the ALTER failed on
//   `already exists`, the bookkeeping row was never written, and the same file
//   was retried on every later merge -- wedging the lane and everything queued
//   behind it. "Applied" and "recorded" are independent facts, and only the
//   migration itself can close the gap. Postgres has no
//   ADD CONSTRAINT IF NOT EXISTS, so guard with
//   `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
//   CREATE TABLE/INDEX take IF NOT EXISTS directly.
// - ORDERED. Lexical by filename, so `0001_` precedes `0002_`.
// - ATOMIC PER FILE. Each migration and its bookkeeping row commit together,
//   so a failure halfway through leaves the file unrecorded and re-runnable
//   rather than half-applied and marked done.
// - HALTS ON FAILURE. A later migration may depend on an earlier one, so
//   continuing past an error would apply it against a schema that does not
//   exist yet.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const DIR = "migrations/neon";

/** The bookkeeping table, created by this script rather than by a migration --
 * it has to exist before the first one can be recorded. */
const TRACKING = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

export function pendingMigrations(
  all: readonly string[],
  applied: ReadonlySet<string>,
): string[] {
  return all
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !applied.has(f))
    .sort();
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Not a warning. A migration runner that "succeeds" without a database is
    // how a schema silently stops being applied.
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(TRACKING);
    const done = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const applied = new Set(done.rows.map((r) => r.filename));
    const pending = pendingMigrations(readdirSync(DIR), applied);

    if (pending.length === 0) {
      console.log(`neon: schema up to date (${applied.size} applied)`);
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(join(DIR, file), "utf8");
      console.log(`neon: applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        // Rethrow rather than continue: a later migration may build on this
        // one, and applying it against a schema that never landed turns one
        // clear failure into a confusing second one.
        throw new Error(`${file} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    console.log(`neon: applied ${pending.length} migration(s)`);
  } finally {
    await client.end();
  }
}

// Only when run directly, so the pure helper above stays importable by tests.
if (process.argv[1]?.endsWith("neon-migrate.ts")) {
  main().catch((error: unknown) => {
    console.error(String(error));
    process.exit(1);
  });
}
