// The account-locks store contract (#13163) -- the native seam the
// /accounts/{ss58}/locks family reads through. Same shape discipline as
// selectedSubnetMechanismsStore: a key ABSENT from the env means "no store",
// which the builders render as the schema-stable decline; a key present with
// the wrong shape is a configuration error worth throwing on, not degrading
// over.

export interface AccountLocksStore {
  /** One coldkey's conviction-lock rows, ordered by (netuid, hotkey, kind). */
  rows(coldkey: string): Promise<Record<string, unknown>[]>;
}

export function selectedAccountLocksStore(
  env: unknown,
): AccountLocksStore | null {
  if (!env || typeof env !== "object" || !("ACCOUNT_LOCKS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).ACCOUNT_LOCKS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).rows !== "function"
  )
    throw new TypeError("Invalid native account locks store");
  return store as AccountLocksStore;
}
