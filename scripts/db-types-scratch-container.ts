import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

// Disposable Postgres container lifecycle for Kanel schema introspection
// (types-epic C, #7861). Container name is ALWAYS prefixed
// `metagraphed-dbtypes-scratch-` with a pid+timestamp suffix — never a
// production-shaped name, per this repo's own docker-volume-naming incident
// history (a prod-shaped scratch name has bitten this repo before). No
// volume is created at all: the container is --rm and the schema is
// reapplied fresh every run, so there is nothing to accidentally reuse or
// collide with a real deployment's storage.
const CONTAINER_PREFIX = "metagraphed-dbtypes-scratch-";
const POSTGRES_PASSWORD = "scratch";
const POSTGRES_USER = "postgres";
const POSTGRES_DB = "metagraphed_dbtypes_scratch";
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 500;

export interface ScratchPostgres {
  containerName: string;
  connectionString: string;
}

function run(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

const SCHEMA_APPLY_RETRIES = 10;
const SCHEMA_APPLY_RETRY_DELAY_MS = 500;

async function applySchemaWithRetry(
  containerName: string,
  schemaSql: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SCHEMA_APPLY_RETRIES; attempt += 1) {
    try {
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          containerName,
          "psql",
          "-U",
          POSTGRES_USER,
          "-d",
          POSTGRES_DB,
          "-v",
          "ON_ERROR_STOP=1",
        ],
        {
          input: schemaSql,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, SCHEMA_APPLY_RETRY_DELAY_MS),
      );
    }
  }
  throw lastError;
}

async function waitUntilReady(containerName: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      execFileSync(
        "docker",
        ["exec", containerName, "pg_isready", "-U", POSTGRES_USER],
        { encoding: "utf8", stdio: "pipe" },
      );
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(
          `Scratch Postgres container ${containerName} did not become ready within ${READY_TIMEOUT_MS}ms.`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, READY_POLL_INTERVAL_MS),
      );
    }
  }
}

// Starts a --rm postgres:16-alpine container on a Docker-assigned random
// host port (never a fixed port -- avoids colliding with a real local
// Postgres or a concurrent CI run), applies deploy/postgres/schema.sql
// (the complete, working schema on its own -- see that file's own header;
// the companion schema-timescaledb.sql is an OPTIONAL hypertable upgrade,
// applied separately, and doesn't add tables Kanel would need to see), and
// returns a ready-to-use connection string. Caller MUST call
// stopScratchPostgres(containerName) in a finally block.
export async function startScratchPostgres(): Promise<ScratchPostgres> {
  const containerName = `${CONTAINER_PREFIX}${process.pid}-${Date.now()}`;
  run([
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-e",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${POSTGRES_DB}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);

  try {
    await waitUntilReady(containerName);

    const portMapping = run(["port", containerName, "5432/tcp"]);
    // e.g. "127.0.0.1:54321" -- take the port after the last colon.
    const hostPort = portMapping.split(":").pop();
    if (!hostPort || !/^\d+$/.test(hostPort)) {
      throw new Error(
        `Could not parse the host port Docker assigned to ${containerName} from: ${portMapping}`,
      );
    }

    const schemaPath = path.join(repoRoot, "deploy/postgres/schema.sql");
    const schemaSql = await fs.readFile(schemaPath, "utf8");
    // pg_isready only proves the SERVER accepts connections, not that the
    // postgres image's entrypoint has finished creating the POSTGRES_DB-named
    // database yet -- that's a separate, slightly-later step of the same
    // startup script, so a "database does not exist" FATAL here immediately
    // after a ready server is a real, observed race, not a hypothetical.
    // Retry the actual operation we care about rather than trying to model
    // Postgres's exact startup sequencing.
    await applySchemaWithRetry(containerName, schemaSql);

    const connectionString = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${hostPort}/${POSTGRES_DB}`;
    return { containerName, connectionString };
  } catch (error) {
    stopScratchPostgres(containerName);
    throw error;
  }
}

export function stopScratchPostgres(containerName: string): void {
  try {
    execFileSync("docker", ["stop", "-t", "2", containerName], {
      stdio: "pipe",
    });
  } catch {
    // Container may already be gone (e.g. Docker itself died mid-run) --
    // --rm means `docker stop` also removes it, so there is nothing further
    // to clean up either way; a failed stop here must never mask the REAL
    // error from the caller's own try/finally.
  }
}
