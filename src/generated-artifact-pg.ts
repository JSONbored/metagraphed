import type { GeneratedArtifactStore } from "./generated-artifact-store.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";

/** Mutable snapshots share the process pool and retain their original JSON text. */
export function createPgGeneratedArtifactStore(
  runtime: Pick<PgStoreRuntime, "producer">,
): GeneratedArtifactStore {
  return {
    async get(key) {
      try {
        const row = await runtime.producer.first<{ payload: string }>(
          "SELECT payload FROM app.generated_artifacts WHERE key=?",
          [key],
        );
        return row ? (JSON.parse(row.payload) as unknown) : null;
      } catch {
        return null;
      }
    },
    async put(key, payload) {
      const row = await runtime.producer.first<{ key: string }>(
        "INSERT INTO app.generated_artifacts(key,payload,updated_at) VALUES(?,?,?) " +
          "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at RETURNING key",
        [key, payload, new Date().toISOString()],
      );
      if (row?.key !== key) {
        throw new Error("Generated artifact write was not acknowledged");
      }
    },
  };
}
