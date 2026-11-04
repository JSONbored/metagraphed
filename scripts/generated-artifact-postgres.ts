import { createPgGeneratedArtifactStore } from "../src/generated-artifact-pg.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";

/** A build owns this short-lived, read-only use of the shared store boundary. */
export async function readGeneratedArtifactPostgres(
  key: string,
  connectionString: string,
  timeoutMs: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 2) {
    throw new RangeError(
      "Artifact read timeout must be a positive millisecond budget",
    );
  }
  const phaseTimeout = Math.floor(timeoutMs / 2);
  const runtime = createPgStoreRuntime({
    connectionString,
    maxConnections: 1,
    connectionTimeoutMillis: phaseTimeout,
    idleTimeoutMillis: phaseTimeout,
    statementTimeoutMillis: phaseTimeout,
    onIdleError: () => {},
  });
  try {
    return await createPgGeneratedArtifactStore(runtime).get(key);
  } finally {
    await runtime.close();
  }
}
