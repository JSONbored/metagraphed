import type { ArtifactStoreEnv } from "./projection-store.ts";
import { isR2SqlConfigured, type R2SqlEnv } from "./r2-sql.ts";

/** An enabled native history owner remains configured without a SQL token.
 * An artifact bucket alone can contain only registry/build artifacts. */
export function hasRetainedHistoryStore(
  env: (R2SqlEnv & ArtifactStoreEnv) | null | undefined,
): boolean {
  return env?.NATIVE_PROJECTIONS === "enabled" || isR2SqlConfigured(env);
}
