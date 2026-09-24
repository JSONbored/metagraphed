import type { ArtifactStoreEnv } from "./projection-store.ts";
import { type HistoryReadEnv } from "./history-readers.ts";

/** An enabled native history owner remains configured without a SQL token.
 * An artifact bucket alone can contain only registry/build artifacts. */
export function hasRetainedHistoryStore(
  env: (HistoryReadEnv & ArtifactStoreEnv) | null | undefined,
): boolean {
  return env?.NATIVE_PROJECTIONS === "enabled";
}
