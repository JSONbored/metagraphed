// The coldkey-swaps store contract (#13166) -- the native seam the
// /accounts/pending-coldkey-swaps and /accounts/{ss58}/coldkey-swap family
// reads through for the v2 announce-then-execute swap machinery and the
// key successor lineage. Same shape discipline as selectedAccountLocksStore:
// a key ABSENT from the env means "no store", which the builders render as
// the schema-stable decline; a key present with the wrong shape is a
// configuration error worth throwing on, not degrading over.

export interface ColdkeySwapsStore {
  /** Every in-flight announcement row, soonest execute_at first, store-capped. */
  pending(): Promise<Record<string, unknown>[]>;
  /** One account's announcement row (the chain map holds at most one). */
  announcement(coldkey: string): Promise<Record<string, unknown>[]>;
  /** The newest chain-wide delay capture (at most one row). */
  policy(): Promise<Record<string, unknown>[]>;
  /** One key's successor-lineage rows across both key planes. */
  lineage(key: string): Promise<Record<string, unknown>[]>;
}

export function selectedColdkeySwapsStore(
  env: unknown,
): ColdkeySwapsStore | null {
  if (!env || typeof env !== "object" || !("COLDKEY_SWAPS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).COLDKEY_SWAPS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).pending !== "function" ||
    typeof (store as Record<string, unknown>).announcement !== "function" ||
    typeof (store as Record<string, unknown>).policy !== "function" ||
    typeof (store as Record<string, unknown>).lineage !== "function"
  )
    throw new TypeError("Invalid native coldkey swaps store");
  return store as ColdkeySwapsStore;
}
