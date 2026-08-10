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
// - ATOMIC PER FILE, EXCEPT WHERE POSTGRES FORBIDS IT. Each migration and its
//   bookkeeping row commit together, so a failure halfway through leaves the
//   file unrecorded and re-runnable rather than half-applied and marked done.
//   `CREATE INDEX CONCURRENTLY` cannot run inside a transaction at all, so a
//   file needing it declares `-- neon:no-transaction` and gives up atomicity;
//   see NO_TRANSACTION_MARKER below for why that is opt-in and gated.
//
//   #10365 is what the absence of this cost. 0011 uses CONCURRENTLY seven
//   times and says so in its own header -- "why this file is not
//   idempotent-by-transaction" -- while this runner unconditionally opened
//   one. Neither was wrong alone; they were never checked against each other.
//   The runner then retried 0011 on every push for two days and never reached
//   0012-0015, while the schema moved by hand and `schema_migrations` stayed
//   at 0010. A ledger that stops describing the database is worse than a
//   failure that stops the line.
// - HALTS ON FAILURE. A later migration may depend on an earlier one, so
//   continuing past an error would apply it against a schema that does not
//   exist yet.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const DIR = "migrations/neon";

/**
 * A migration declares it must run OUTSIDE a transaction with this line.
 *
 * EXPLICIT, not sniffed from the SQL. The obvious shortcut is to look for
 * "CONCURRENTLY" in the file, and it is wrong in both directions: 0011's own
 * header discusses CONCURRENTLY in prose, so a text scan matches files that
 * merely talk about it, and a future statement with the same constraint and a
 * different keyword would be missed. A marker says what the file NEEDS rather
 * than guessing from what it mentions.
 */
export const NO_TRANSACTION_MARKER = "-- neon:no-transaction";

/**
 * A CONCURRENTLY statement, as opposed to the word appearing in a comment.
 *
 * Used only to REFUSE a file that needs the marker and does not carry one --
 * so the failure is "0011 needs -- neon:no-transaction" rather than Postgres'
 * "cannot run inside a transaction block", which names the symptom and leaves
 * the reader to discover the runner wraps everything.
 */
const CONCURRENTLY_STATEMENT =
  /^\s*(?:CREATE|DROP|REINDEX)\b[^;]*\bCONCURRENTLY\b/im;

/**
 * Split SQL into statements on top-level semicolons.
 *
 * NEEDED ONLY FOR THE NO-TRANSACTION PATH, and it is not optional there:
 * node-postgres sends a multi-statement string over the SIMPLE QUERY protocol,
 * which Postgres executes as ONE IMPLICIT TRANSACTION. Deleting the explicit
 * BEGIN/COMMIT is therefore not enough on its own -- the statements have to
 * arrive separately or CONCURRENTLY fails exactly as before.
 *
 * Aware of the three things that make a semicolon not a separator: quoted
 * strings, dollar-quoted blocks (`$$ ... $$`, which the DO/EXCEPTION guard in
 * these migrations uses), and comments.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === ";") {
      out.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += sql[i];
    i += 1;
  }
  out.push(current);
  // A "statement" of only comments and whitespace is what trails the final
  // semicolon and what sits between statements; sending it would be an error.
  return out.filter((s) => s.replace(/--[^\n]*/g, "").trim() !== "");
}

/** Whether this file must be applied without a wrapping transaction. */
export function runsOutsideTransaction(sql: string): boolean {
  return sql.includes(NO_TRANSACTION_MARKER);
}

/**
 * The reason this file cannot be applied, or null.
 *
 * A GATE RATHER THAN A GUESS. A file with a CONCURRENTLY statement and no
 * marker is the #10365 contradiction, and refusing it here names the fix.
 */
export function migrationRefusal(file: string, sql: string): string | null {
  if (CONCURRENTLY_STATEMENT.test(sql) && !runsOutsideTransaction(sql)) {
    return (
      `${file} has a CONCURRENTLY statement but no \`${NO_TRANSACTION_MARKER}\` ` +
      `marker. Postgres cannot run it inside a transaction and this runner ` +
      `wraps every file in one, so it would fail on every push. Add the marker ` +
      `on its own line, and make every statement idempotent -- a file applied ` +
      `outside a transaction can fail half-done.`
    );
  }
  return null;
}

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

    // Refuse the whole run before applying ANYTHING if any pending file is
    // malformed. Checking up front rather than per file means a bad migration
    // three deep does not leave the two before it applied and the run red.
    for (const file of pending) {
      const refusal = migrationRefusal(
        file,
        readFileSync(join(DIR, file), "utf8"),
      );
      if (refusal) throw new Error(refusal);
    }

    for (const file of pending) {
      const sql = readFileSync(join(DIR, file), "utf8");
      const outside = runsOutsideTransaction(sql);
      console.log(
        `neon: applying ${file}${outside ? " (outside a transaction)" : ""}`,
      );
      if (outside) {
        // NO BEGIN/COMMIT, and one statement per round trip -- a multi-statement
        // string would be an implicit transaction and fail identically. There is
        // no rollback to offer: a failure here leaves the earlier statements
        // applied, which is why the gate above requires them to be idempotent.
        // The bookkeeping row goes last, so a partial apply stays unrecorded and
        // is retried rather than marked done.
        try {
          for (const statement of splitStatements(sql)) {
            await client.query(statement);
          }
          await client.query(
            "INSERT INTO schema_migrations (filename) VALUES ($1)",
            [file],
          );
        } catch (error) {
          throw new Error(`${file} failed: ${(error as Error).message}`, {
            cause: error,
          });
        }
        continue;
      }
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
