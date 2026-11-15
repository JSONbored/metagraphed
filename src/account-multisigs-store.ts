// The account-multisigs store contract (#13166) -- the native seam the
// /accounts/{ss58}/multisigs family reads through for the Multisig pallet's
// resolved compositions. Same shape discipline as selectedAccountProxiesStore.

export interface AccountMultisigsStore {
  /** Every multisig the account belongs to -- as the multisig account itself
   * or as a signatory -- ordered by multisig address, store-capped. */
  byMember(ss58: string): Promise<Record<string, unknown>[]>;
}

export function selectedAccountMultisigsStore(
  env: unknown,
): AccountMultisigsStore | null {
  if (!env || typeof env !== "object" || !("ACCOUNT_MULTISIGS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).ACCOUNT_MULTISIGS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).byMember !== "function"
  )
    throw new TypeError("Invalid native account multisigs store");
  return store as AccountMultisigsStore;
}
