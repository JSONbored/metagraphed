import type {
  RegistrySyncPayload,
  RegistrySyncSummary,
} from "./registry-sync-neon.ts";

export interface RegistrySyncStore {
  apply(payload: RegistrySyncPayload): Promise<RegistrySyncSummary>;
}

export function selectedRegistrySyncStore(
  env: unknown,
): RegistrySyncStore | null {
  if (!env || typeof env !== "object" || !("REGISTRY_SYNC_STORE" in env))
    return null;
  const store = env.REGISTRY_SYNC_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("apply" in store) ||
    typeof store.apply !== "function"
  )
    throw new TypeError("Native registry sync capability is incomplete");
  return store as RegistrySyncStore;
}
