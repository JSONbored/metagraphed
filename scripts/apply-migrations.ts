// Applies migrations/*.sql to a live Postgres in filename order, tracking
// what's already been applied in a schema_migrations table (created on
// first run) -- fixes the schema-apply gap behind three separate live
// incidents (#5348/#5353): deploy/postgres/schema.sql only runs on a
// Postgres container's FIRST init against an empty data directory (the
// official Postgres image's own docker-entrypoint-initdb.d behavior), so
// any CREATE TABLE added to migrations/ after the box's first boot never
// reaches production without a manual, easy-to-forget `psql -f`. Missing
// `chain_alert_triggers`/`featured_validators` broke #4984's alerter epic
// outright (every alert-create call 502'd); missing `nominator_positions`
// (migration 0044) broke the nominator-positions-sync box-cron job the
// same way, 2026-07-14.
//
// NOT idempotent-by-construction: several existing migrations use bare
// `ALTER TABLE ... ADD COLUMN` (no `IF NOT EXISTS`) or a genuinely one-time
// temp-table rename dance (0006_surface_key_rekey.sql) -- re-running an
// already-applied migration's SQL directly would fail or, worse, silently
// re-run something meant to execute exactly once. schema_migrations is
// therefore load-bearing, not just a nice-to-have audit trail: correctness
// depends on never re-executing a recorded version's SQL.
//
// Usage:
//   node scripts/apply-migrations.ts [--dry-run] [--database-url URL]
//   node scripts/apply-migrations.ts --bootstrap-through 0044 [--database-url URL]
//
//   --dry-run              list what would be applied; touches nothing
//   --database-url URL     Postgres connection string (default: $DATABASE_URL)
//   --bootstrap-through NNNN
//       Records every migration up to and including NNNN as already
//       applied WITHOUT running its SQL -- for adopting this script against
//       a box whose schema already reflects those migrations by some other
//       means (the original docker-entrypoint-initdb.d schema.sql bootstrap,
//       or an earlier ad-hoc manual `psql -f`). This is a one-time,
//       explicit, human-verified operation, not an auto-detected guess --
//       confirm the target tables/columns genuinely exist before using it.
//       Refuses to run if schema_migrations already has any rows (use the
//       normal apply path from then on).
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib.ts";

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
}

interface ApplyMigrationsOptions {
  dryRun: boolean;
  databaseUrl?: string;
  bootstrapThrough?: string;
}

export function parseArgs(argv: string[]): ApplyMigrationsOptions {
  const opts: ApplyMigrationsOptions = {
    dryRun: false,
    databaseUrl: process.env.DATABASE_URL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--database-url") opts.databaseUrl = argv[++i];
    else if (arg === "--bootstrap-through") opts.bootstrapThrough = argv[++i];
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return opts;
}

export async function loadMigrationFiles(
  migrationsRoot: string = path.join(repoRoot, "migrations"),
): Promise<MigrationFile[]> {
  const names = (await fs.readdir(migrationsRoot))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      version: name.slice(0, 4),
      name,
      sql: await fs.readFile(path.join(migrationsRoot, name), "utf8"),
    })),
  );
}

// The idempotency guard: the migrations whose version isn't already recorded in
// schema_migrations, preserving loadMigrationFiles' order. Applying twice is a
// no-op because the second run sees every version already applied and returns
// []. Pulled out of main() as a pure function so the "what runs on this pass"
// decision is testable without a live database.
export function pendingMigrations(
  migrations: MigrationFile[],
  appliedVersions: string[],
): MigrationFile[] {
  const applied = new Set(appliedVersions);
  return migrations.filter((m) => !applied.has(m.version));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.databaseUrl) {
    throw new Error(
      "DATABASE_URL required (or pass --database-url) -- refusing to guess a connection target",
    );
  }

  const migrations = await loadMigrationFiles();

  const { default: postgres } = await import("postgres");
  const sql = postgres(opts.databaseUrl, {
    max: 1,
    prepare: false,
    fetch_types: false,
    // Routine "already exists, skipping" NOTICEs from the IF NOT EXISTS
    // guards below are expected noise on every run after the first, not
    // something an operator running this script needs to see.
    onnotice: () => {},
  });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT   PRIMARY KEY,
        name        TEXT   NOT NULL,
        applied_at  BIGINT NOT NULL
      )`;

    if (opts.bootstrapThrough) {
      const existing =
        await sql`SELECT count(*)::int AS n FROM schema_migrations`;
      if (existing[0].n > 0) {
        throw new Error(
          "--bootstrap-through refuses to run: schema_migrations already has rows " +
            "(this box has already been adopted onto the tracked apply path -- " +
            "use the normal, no-flag apply instead)",
        );
      }
      const toBootstrap = migrations.filter(
        (m) => m.version <= (opts.bootstrapThrough as string),
      );
      if (opts.dryRun) {
        console.log(
          `[dry-run] would mark ${toBootstrap.length} migration(s) applied without running their SQL: ` +
            toBootstrap.map((m) => m.name).join(", "),
        );
        return;
      }
      const now = Date.now();
      await sql`
        INSERT INTO schema_migrations ${sql(
          toBootstrap.map((m) => ({
            version: m.version,
            name: m.name,
            applied_at: now,
          })),
          "version",
          "name",
          "applied_at",
        )}`;
      console.log(
        `Bootstrapped schema_migrations with ${toBootstrap.length} migration(s) through ${opts.bootstrapThrough} (recorded only, not executed).`,
      );
      return;
    }

    const appliedRows = await sql`SELECT version FROM schema_migrations`;
    const pending = pendingMigrations(
      migrations,
      appliedRows.map((r) => r.version),
    );

    if (pending.length === 0) {
      console.log(
        `Nothing to apply -- all ${migrations.length} migration(s) already recorded in schema_migrations.`,
      );
      return;
    }

    if (opts.dryRun) {
      console.log(
        `[dry-run] would apply ${pending.length} migration(s): ` +
          pending.map((m) => m.name).join(", "),
      );
      return;
    }

    for (const migration of pending) {
      console.log(`Applying ${migration.name}...`);
      await sql.begin(async (sql) => {
        await sql.unsafe(migration.sql);
        await sql`
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (${migration.version}, ${migration.name}, ${Date.now()})`;
      });
      console.log(`  done.`);
    }
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await sql.end();
  }
}

// Only run the apply when invoked as a CLI (node scripts/apply-migrations.ts),
// not when imported for unit testing — importing must not open a DB connection.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
