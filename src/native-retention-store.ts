import type { PruneTableOutcome } from "./neon-prune.ts";

export interface NativeRetentionStore {
  prune(nowMs: number): Promise<PruneTableOutcome[]>;
}

export function selectedNativeRetentionStore(
  env: unknown,
): NativeRetentionStore | null {
  if (!env || typeof env !== "object" || !("NATIVE_RETENTION_STORE" in env))
    return null;
  const store = env.NATIVE_RETENTION_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("prune" in store) ||
    typeof store.prune !== "function"
  )
    throw new TypeError("Native retention capability is incomplete");
  return store as NativeRetentionStore;
}
