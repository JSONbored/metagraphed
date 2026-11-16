// The account-proxies store contract (#13166) -- the native seam the
// /accounts/{ss58}/proxies family reads through for the Proxy pallet's
// delegation state. Same shape discipline as selectedChildKeysStore: a key
// ABSENT from the env means "no store", which the builders render as the
// schema-stable decline; a key present with the wrong shape is a
// configuration error worth throwing on, not degrading over.

export interface AccountProxiesStore {
  /** One delegating account's proxy rows, ordered by (delegate, proxy_type, delay). */
  rows(delegator: string): Promise<Record<string, unknown>[]>;
}

export function selectedAccountProxiesStore(
  env: unknown,
): AccountProxiesStore | null {
  if (!env || typeof env !== "object" || !("ACCOUNT_PROXIES_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).ACCOUNT_PROXIES_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).rows !== "function"
  )
    throw new TypeError("Invalid native account proxies store");
  return store as AccountProxiesStore;
}
