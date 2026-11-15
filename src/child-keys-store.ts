// The child-keys store contract (#13166) -- the native seam the
// /accounts/{ss58}/children and /parents routes read through for the stored
// child-key detail beside their live-RPC graph: the per-hotkey take
// (SubtensorModule.ChildkeyTake), the pending relation queue
// (PendingChildKeys), the parent-keyed threshold bookkeeping
// (ChildkeyThresholdChecks / ChildkeyThresholdSuspended) and the ChildKeys
// capture history. Same shape discipline as selectedColdkeySwapsStore: a key
// ABSENT from the env means "no store", which the builders render as the
// schema-stable decline; a key present with the wrong shape is a
// configuration error worth throwing on, not degrading over.

export interface ChildKeysStore {
  /** One hotkey's per-subnet take rows, ordered by netuid. */
  takes(hotkey: string): Promise<Record<string, unknown>[]>;
  /** One parent's pending relation rows, ordered by (netuid, child). */
  pending(parent: string): Promise<Record<string, unknown>[]>;
  /** One parent's threshold row (at most one). */
  threshold(parent: string): Promise<Record<string, unknown>[]>;
  /** One parent's relation history, newest capture first, store-capped. */
  historyByParent(parent: string): Promise<Record<string, unknown>[]>;
  /** One child's relation history, newest capture first, store-capped. */
  historyByChild(child: string): Promise<Record<string, unknown>[]>;
}

export function selectedChildKeysStore(env: unknown): ChildKeysStore | null {
  if (!env || typeof env !== "object" || !("CHILD_KEYS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).CHILD_KEYS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).takes !== "function" ||
    typeof (store as Record<string, unknown>).pending !== "function" ||
    typeof (store as Record<string, unknown>).threshold !== "function" ||
    typeof (store as Record<string, unknown>).historyByParent !== "function" ||
    typeof (store as Record<string, unknown>).historyByChild !== "function"
  )
    throw new TypeError("Invalid native child keys store");
  return store as ChildKeysStore;
}
