// The gamma-deposits store contract (#13164) -- the native seam the
// /gamma/deposits card reads through. Same shape discipline as
// selectedSubnetGammaStore: a key ABSENT from the env means "no store",
// which the builder renders as the schema-stable decline; a key present with
// the wrong shape is a configuration error worth throwing on, not degrading
// over.

export interface GammaDepositsStore {
  /** The chain's Gamma deposit rows, largest balance first, store-capped. */
  rows(): Promise<Record<string, unknown>[]>;
}

export function selectedGammaDepositsStore(
  env: unknown,
): GammaDepositsStore | null {
  if (!env || typeof env !== "object" || !("GAMMA_DEPOSITS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).GAMMA_DEPOSITS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).rows !== "function"
  )
    throw new TypeError("Invalid native gamma deposits store");
  return store as GammaDepositsStore;
}
