import { applyRegistrySyncInTransaction } from "./registry-sync-neon.ts";
import type { RegistrySyncStore } from "./registry-sync-store.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";

/** Registry state and provenance commit in the same process-owned transaction. */
export function createPgRegistrySyncStore(
  runtime: Pick<PgStoreRuntime, "transaction">,
  newId: () => string = () => crypto.randomUUID(),
): RegistrySyncStore {
  return {
    apply: (payload) =>
      runtime.transaction(
        async (transaction) => {
          await transaction.run(
            "SET LOCAL search_path = pg_catalog, app, pg_temp",
          );
          // Match D1's serialized batch ownership. Otherwise simultaneous new
          // surfaces can record the losing proposed ID in provenance history.
          await transaction.query<{ locked: unknown }>(
            "SELECT pg_advisory_xact_lock(hashtextextended('metagraphed/registry-sync/v1',0)) AS locked",
          );
          return applyRegistrySyncInTransaction(
            {
              query: async (text, values) => ({
                rows: await transaction.query(text, values),
              }),
            },
            payload,
            newId,
          );
        },
        { isolation: "read committed" },
      ),
  };
}
