// The tao-usd-oracle store contract (#13164) -- the native seam the
// /network/tao-usd card's on-chain oracle block reads through. Same shape
// discipline as selectedSubnetGammaStore: a key ABSENT from the env means
// "no store", which the builder renders as the schema-stable decline
// (oracle: null); a key present with the wrong shape is a configuration
// error worth throwing on, not degrading over.

export interface TaoUsdOracleStore {
  /** The on-chain feed history, newest block first, store-capped. */
  rows(): Promise<Record<string, unknown>[]>;
}

export function selectedTaoUsdOracleStore(
  env: unknown,
): TaoUsdOracleStore | null {
  if (!env || typeof env !== "object" || !("TAO_USD_ORACLE_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).TAO_USD_ORACLE_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).rows !== "function"
  )
    throw new TypeError("Invalid native tao usd oracle store");
  return store as TaoUsdOracleStore;
}
