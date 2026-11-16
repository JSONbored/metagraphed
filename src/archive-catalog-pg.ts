import type { ArchiveCatalogStore } from "./archive-native-store.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";

/** Manifest publication shares the application's bounded pool. No D1 shim. */
export function createPgArchiveCatalog(
  runtime: Pick<PgStoreRuntime, "producer">,
): ArchiveCatalogStore {
  return {
    read: (keys) =>
      runtime.producer.query(
        "SELECT key,payload FROM app.generated_artifacts WHERE key=ANY(?::text[])",
        [keys],
      ),
    insert: (key, payload) =>
      runtime.producer.query(
        "INSERT INTO app.generated_artifacts(key,payload) VALUES(?,?) ON CONFLICT(key) DO NOTHING RETURNING key",
        [key, payload],
      ),
    replace: (key, previous, payload, updatedAt) =>
      runtime.producer.query(
        "UPDATE app.generated_artifacts SET payload=?,updated_at=? WHERE key=? AND payload=? RETURNING key",
        [payload, updatedAt, key, previous],
      ),
  };
}
