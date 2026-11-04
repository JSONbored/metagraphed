import type { ReadStoreDb } from "./read-store.ts";

export interface RootBasketStore {
  write(
    input: unknown,
    acceptedAtMs: number,
  ): Promise<{ capture_id: string; content_sha256: string; replayed: boolean }>;
  read: ReadStoreDb;
}

export function selectedRootBasketStore(env: unknown): RootBasketStore | null {
  if (!env || typeof env !== "object" || !("ROOT_BASKET_STORE" in env))
    return null;
  const store = env.ROOT_BASKET_STORE as Partial<RootBasketStore> | null;
  if (
    !store ||
    typeof store.write !== "function" ||
    typeof store.read?.query !== "function" ||
    typeof store.read?.first !== "function"
  )
    throw new Error(
      "ROOT_BASKET_STORE requires write, query and first",
    );
  return store as RootBasketStore;
}
