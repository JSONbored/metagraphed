import type { GeneratedArtifactStore } from "./generated-artifact-store.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";

/** The existing generated snapshot contract over the shared PostgreSQL source. */
export function createPgGeneratedArtifactStore(
  runtime: Pick<PgStoreRuntime, "read" | "producer">,
): GeneratedArtifactStore {
  return {
    async get(key, maxBytes) {
      if (
        maxBytes !== undefined &&
        (!Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > 25 * 1024 * 1024)
      )
        throw new RangeError("Generated snapshot read limit is invalid");
      try {
        const row = await runtime.read.first<{ payload: string | null }>(
          maxBytes === undefined
            ? "SELECT payload FROM app.generated_artifacts WHERE key=$1"
            : "SELECT CASE WHEN octet_length(payload)<=$2 THEN payload ELSE NULL END AS payload FROM app.generated_artifacts WHERE key=$1",
          maxBytes === undefined ? [key] : [key, maxBytes],
        );
        return typeof row?.payload === "string"
          ? (JSON.parse(row.payload) as unknown)
          : null;
      } catch {
        return null;
      }
    },
    async put(key, payload) {
      const row = await runtime.producer.first<{ key: string }>(
        `INSERT INTO app.generated_artifacts(key,payload,updated_at) VALUES($1,$2,$3)
        ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at
        RETURNING key`,
        [key, payload, new Date().toISOString()],
      );
      if (row?.key !== key)
        throw new Error("Generated artifact write was not acknowledged");
    },
  };
}
