// Nightly bulk export of core registry + chain tables to Parquet, uploaded
// to R2 under a dated prefix + a `latest/` alias, with a discovery manifest
// (#2538, successor to #2115's "exporter" half — see that issue's closing
// comment for why this replaced a "Railway cron" plan with a box-side job).
//
// Runs on the box that hosts BOTH source Postgres databases (registry and
// indexer) locally -- REGISTRY_PG_HOST/INDEXER_PG_HOST default to
// 127.0.0.1 for local/tunnel-based testing, but production sets them to the
// containers' own names (reachable once the wrapper script joins this
// container to their docker-compose networks -- see
// scripts/data-refresh-node-entrypoint.sh's export-parquet STEP). DuckDB's
// postgres extension reads each table directly; nothing is loaded into this
// process's own memory beyond what DuckDB's COPY needs.
//
// R2 upload goes through `wrangler r2 object put --remote`, the same
// mechanism scripts/r2-upload.ts already uses (CLOUDFLARE_API_TOKEN +
// CLOUDFLARE_ACCOUNT_ID env vars) -- there is no S3-compatible credential
// anywhere in this codebase, and this doesn't introduce one.
//
// Retention: dated runs (metagraph/bulk/parquet/{date}/) are NOT pruned by
// this script -- `wrangler r2 object` has no list/delete-by-prefix command
// (confirmed: only get/put/delete-by-exact-key), so automated pruning would
// need direct calls to Cloudflare's R2 REST API rather than the wrangler CLI
// this job otherwise relies on. Deliberately deferred rather than rushed: a
// delete-capable path against a public bucket deserves its own careful pass,
// not a bolt-on here. `metagraph/bulk/parquet/latest/` (overwritten every
// run) is the primary, bounded-size discovery point for downloaders in the
// meantime; dated history accumulates until a follow-up adds pruning.
//
// Usage: node scripts/export-parquet.ts [--dry-run]
import { DuckDBInstance } from "@duckdb/node-api";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Hex, stableStringify } from "./lib.mjs";
import { initSentry, endSessionAndFlush } from "./observability.ts";

initSentry("export-parquet");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const BUCKET = "metagraphed-artifacts";
const RUN_PREFIX_ROOT = "metagraph/bulk/parquet";
const SCHEMA_VERSION = 1;
// `wrangler r2 object put` hard-caps single-file uploads at 300 MiB
// (confirmed live: extrinsics.parquet came out to 602 MiB and failed --
// #2538's first real deploy run). DuckDB's own COPY ... FILE_SIZE_BYTES is a
// per-row-group target, not an exact cutoff -- verified live against the
// real extrinsics table: a 200MB target produced parts up to 231MB (only
// 23% headroom under 300MB) and a 150MB target still hit 200MB (33%
// overshoot). 100MB tops out at 123MB in the same test -- comfortable
// margin that should hold as this table only grows (growth adds more
// parts, not bigger ones, since each part is bounded by row-group size
// independent of total table size).
const MAX_PART_BYTES = 100 * 1024 * 1024;

// (table, source database) pairs -- matches #2538's explicit scope (subnets,
// economics, endpoints, neurons/metagraph, blocks, extrinsics, chain-events
// daily rollups). Deliberately the DAILY ROLLUP tables, not the raw
// high-volume hypertables (account_events is 40M+ rows, chain_events 17M+ --
// a full nightly dump of those would be a fundamentally different,
// incremental-export design, not what this issue scoped).
const EXPORTS = [
  { table: "subnets", db: "registry" },
  { table: "providers", db: "registry" },
  { table: "surfaces", db: "registry" },
  { table: "subnet_snapshots", db: "indexer" },
  { table: "neurons", db: "indexer" },
  { table: "neuron_daily", db: "indexer" },
  { table: "blocks", db: "indexer" },
  { table: "extrinsics", db: "indexer" },
  { table: "account_events_daily", db: "indexer" },
];

interface PgConn {
  host: string;
  port: number;
  dbname: string;
  user: string;
  password: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var required`);
  return value;
}

// DuckDB's postgres extension ATTACH takes a single libpq connection string
// (not named sub-options, and ATTACH doesn't support $-parameter binding the
// way a SELECT/INSERT literal would) -- built here, in-process, and only
// ever passed to connection.run() directly, never through a subprocess/shell.
// Minimal libpq escaping (backslash, single-quote) for robustness; this
// project's generated passwords are alphanumeric-only in practice, but the
// escaping costs nothing.
export function libpqConnString({
  host,
  port,
  dbname,
  user,
  password,
}: PgConn): string {
  const esc = (value: unknown) => String(value).replace(/([\\'])/g, "\\$1");
  return `host=${esc(host)} port=${esc(port)} dbname=${esc(dbname)} user=${esc(user)} password=${esc(password)}`;
}

interface RunnableConnection {
  run(sql: string): Promise<unknown>;
}

// DuckDB's own ATTACH failure errors embed the full connection string --
// password included -- verbatim (confirmed live: a connection-refused error
// during local testing printed the plaintext password to stderr). Never let
// that reach a log/journal: attach with a scrubbed error on failure instead
// of letting DuckDB's own message propagate.
export async function attachPostgres(
  connection: RunnableConnection,
  alias: string,
  conn: PgConn,
): Promise<void> {
  try {
    await connection.run(
      `ATTACH '${libpqConnString(conn)}' AS ${alias} (TYPE postgres, READ_ONLY)`,
    );
  } catch {
    throw new Error(
      `failed to attach ${alias} Postgres at ${conn.host}:${conn.port}/${conn.dbname} (credentials redacted)`,
    );
  }
}

interface Artifact {
  table: string;
  source_db: string;
  path: string;
  key: string;
  latest_key: string;
  sha256: string;
  size_bytes: number;
  row_count: number;
  part_count: number;
}

interface Manifest {
  schema_version: number;
  generated_at: string;
  bucket_name: string;
  run_prefix: string;
  latest_prefix: string;
  artifact_count: number;
  artifact_size_bytes: number;
  artifacts: Artifact[];
}

async function main(): Promise<void> {
  const registryConn: PgConn = {
    host: process.env.REGISTRY_PG_HOST || "127.0.0.1",
    port: Number(process.env.REGISTRY_PG_PORT || 5433),
    dbname: requireEnv("REGISTRY_PG_DB"),
    user: requireEnv("REGISTRY_PG_USER"),
    password: requireEnv("REGISTRY_PG_PASSWORD"),
  };
  const indexerConn: PgConn = {
    host: process.env.INDEXER_PG_HOST || "127.0.0.1",
    port: Number(process.env.INDEXER_PG_PORT || 5432),
    dbname: requireEnv("INDEXER_PG_DB"),
    user: requireEnv("INDEXER_PG_USER"),
    password: requireEnv("INDEXER_PG_PASSWORD"),
  };

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run("INSTALL postgres; LOAD postgres;");

  await attachPostgres(connection, "registry", registryConn);
  await attachPostgres(connection, "indexer", indexerConn);

  const workDir = await mkdtemp(path.join(tmpdir(), "export-parquet-"));
  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);
  const runPrefix = `${RUN_PREFIX_ROOT}/${date}/`;
  const latestPrefix = `${RUN_PREFIX_ROOT}/latest/`;

  const artifacts: Artifact[] = [];
  try {
    for (const { table, db } of EXPORTS) {
      const tableDir = path.join(workDir, table);
      // Writes to a DIRECTORY, not a single file: DuckDB splits output into
      // FILE_SIZE_BYTES-targeted parts (data_0.parquet, data_1.parquet, ...)
      // -- small tables still just produce one part, so this is uniform
      // across every table rather than special-cased for the large ones.
      // ZSTD: DuckDB's default is snappy; zstd trades a little CPU for
      // meaningfully smaller files, which matters more than write speed for
      // a once-nightly, R2-egress-conscious export.
      await connection.run(
        `COPY (SELECT * FROM ${db}.${table}) TO '${tableDir}' (FORMAT PARQUET, COMPRESSION ZSTD, FILE_SIZE_BYTES ${MAX_PART_BYTES})`,
      );
      const tableRowCount = await rowCount(connection, db, table);
      const partFiles = (await readdir(tableDir)).sort();
      for (const fileName of partFiles) {
        const localPath = path.join(tableDir, fileName);
        const buffer = await readFile(localPath);
        const { size } = await stat(localPath);
        artifacts.push({
          table,
          source_db: db,
          path: `${table}/${fileName}`,
          key: `${runPrefix}${table}/${fileName}`,
          latest_key: `${latestPrefix}${table}/${fileName}`,
          sha256: sha256Hex(buffer),
          size_bytes: size,
          // Table-level fact, duplicated on every part -- callers reading
          // one part shouldn't need to cross-reference the others to know
          // what the whole table represents.
          row_count: tableRowCount,
          part_count: partFiles.length,
        });
      }
    }

    const manifest: Manifest = {
      schema_version: SCHEMA_VERSION,
      generated_at: generatedAt,
      bucket_name: BUCKET,
      run_prefix: runPrefix,
      latest_prefix: latestPrefix,
      artifact_count: artifacts.length,
      artifact_size_bytes: artifacts.reduce((sum, a) => sum + a.size_bytes, 0),
      artifacts,
    };
    const manifestPath = path.join(workDir, "bulk-manifest.json");
    await writeManifest(manifestPath, manifest);

    if (dryRun) {
      console.log(stableStringify({ dry_run: true, ...summarize(manifest) }));
      return;
    }

    for (const artifact of artifacts) {
      const localPath = path.join(workDir, artifact.path);
      uploadToR2(localPath, `${BUCKET}/${artifact.key}`);
      uploadToR2(localPath, `${BUCKET}/${artifact.latest_key}`);
    }
    uploadToR2(manifestPath, `${BUCKET}/${runPrefix}bulk-manifest.json`);
    uploadToR2(manifestPath, `${BUCKET}/${latestPrefix}bulk-manifest.json`);

    console.log(stableStringify(summarize(manifest)));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function rowCount(
  connection: RunnableConnection & {
    runAndReadAll(sql: string): Promise<{ getRows(): unknown[][] }>;
  },
  db: string,
  table: string,
): Promise<number> {
  const reader = await connection.runAndReadAll(
    `SELECT count(*) AS n FROM ${db}.${table}`,
  );
  return Number(reader.getRows()[0][0]);
}

async function writeManifest(
  manifestPath: string,
  manifest: Manifest,
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(manifestPath, `${stableStringify(manifest)}\n`);
}

function uploadToR2(localPath: string, remoteKey: string): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      remoteKey,
      `--file=${localPath}`,
      "--remote",
    ],
    { stdio: "inherit" },
  );
}

function summarize(manifest: Manifest) {
  return {
    generated_at: manifest.generated_at,
    run_prefix: manifest.run_prefix,
    artifact_count: manifest.artifact_count,
    artifact_size_bytes: manifest.artifact_size_bytes,
  };
}

// Only auto-run when invoked as the CLI entry point, not when imported by the unit
// tests (which exercise the exported libpqConnString / attachPostgres directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
  await endSessionAndFlush();
}
