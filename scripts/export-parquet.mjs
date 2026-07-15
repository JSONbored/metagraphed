// Nightly bulk export of core registry + chain tables to Parquet, uploaded
// to R2 under a dated prefix + a `latest/` alias, with a discovery manifest
// (#2538, successor to #2115's "exporter" half — see that issue's closing
// comment for why this replaced a "Railway cron" plan with a box-side job).
//
// Runs on the box that hosts BOTH source Postgres databases (registry and
// indexer) locally -- see scripts/data-refresh-node-entrypoint.sh's
// export-parquet STEP, which runs this with --network host so
// 127.0.0.1:5432/5433 are reachable. DuckDB's postgres extension reads each
// table directly; nothing is loaded into this process's own memory beyond
// what DuckDB's COPY needs.
//
// R2 upload goes through `wrangler r2 object put --remote`, the same
// mechanism scripts/r2-upload.mjs already uses (CLOUDFLARE_API_TOKEN +
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
// Usage: node scripts/export-parquet.mjs [--dry-run]
import { DuckDBInstance } from "@duckdb/node-api";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Hex, stableStringify } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const BUCKET = "metagraphed-artifacts";
const RUN_PREFIX_ROOT = "metagraph/bulk/parquet";
const SCHEMA_VERSION = 1;

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

function requireEnv(name) {
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
function libpqConnString({ host, port, dbname, user, password }) {
  const esc = (value) => String(value).replace(/([\\'])/g, "\\$1");
  return `host=${esc(host)} port=${esc(port)} dbname=${esc(dbname)} user=${esc(user)} password=${esc(password)}`;
}

// DuckDB's own ATTACH failure errors embed the full connection string --
// password included -- verbatim (confirmed live: a connection-refused error
// during local testing printed the plaintext password to stderr). Never let
// that reach a log/journal: attach with a scrubbed error on failure instead
// of letting DuckDB's own message propagate.
async function attachPostgres(connection, alias, conn) {
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

async function main() {
  const registryConn = {
    host: process.env.REGISTRY_PG_HOST || "127.0.0.1",
    port: Number(process.env.REGISTRY_PG_PORT || 5433),
    dbname: requireEnv("REGISTRY_PG_DB"),
    user: requireEnv("REGISTRY_PG_USER"),
    password: requireEnv("REGISTRY_PG_PASSWORD"),
  };
  const indexerConn = {
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

  const artifacts = [];
  try {
    for (const { table, db } of EXPORTS) {
      const localPath = path.join(workDir, `${table}.parquet`);
      // ZSTD: DuckDB's default is snappy; zstd trades a little CPU for
      // meaningfully smaller files, which matters more than write speed for
      // a once-nightly, R2-egress-conscious export.
      await connection.run(
        `COPY (SELECT * FROM ${db}.${table}) TO '${localPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
      const buffer = await readFile(localPath);
      const { size } = await stat(localPath);
      artifacts.push({
        table,
        source_db: db,
        path: `${table}.parquet`,
        key: `${runPrefix}${table}.parquet`,
        latest_key: `${latestPrefix}${table}.parquet`,
        sha256: sha256Hex(buffer),
        size_bytes: size,
        row_count: await rowCount(connection, db, table),
      });
    }

    const manifest = {
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

async function rowCount(connection, db, table) {
  const reader = await connection.runAndReadAll(
    `SELECT count(*) AS n FROM ${db}.${table}`,
  );
  return Number(reader.getRows()[0][0]);
}

async function writeManifest(manifestPath, manifest) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(manifestPath, `${stableStringify(manifest)}\n`);
}

function uploadToR2(localPath, remoteKey) {
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

function summarize(manifest) {
  return {
    generated_at: manifest.generated_at,
    run_prefix: manifest.run_prefix,
    artifact_count: manifest.artifact_count,
    artifact_size_bytes: manifest.artifact_size_bytes,
  };
}

await main();
